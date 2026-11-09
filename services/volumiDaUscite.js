// services/volumiDaUscite.js
//
// La RISERVA di AnimeClick per «quanti volumi sono usciti in Italia».
//
// AnimeClick ha una verifica anti-bot (403 anche da Render, 09/11/2026) e
// il controllo dei volumi andava in errore su tutte le serie. Le uscite
// però si archiviano già in `uscite_manga` leggendo gli articoli
// settimanali di Fumettologica (Planet Manga, J-Pop, Star Comics): l'ultimo
// volume uscito di una serie è il numero più alto con data già passata.
//
// Differenze da AnimeClick, tutte dette qui perché cambiano come ci si fida:
// - copre solo gli editori di Fumettologica (`fonteDi`); gli altri restano
//   in errore, come prima;
// - sa solo ciò che è stato archiviato: per questo `riempiArchivio` rilegge
//   i mesi passati. Un archivio incompleto può dare un numero troppo BASSO,
//   mai troppo alto, e le regole di `decidiAggiornamento` non lo fanno
//   scendere né lo accettano sotto i volumi che hai in casa;
// - non dice se una serie è conclusa (gli articoli non hanno un campo di
//   stato), quindi con la riserva il passaggio a «conclusa» non scatta.

const { ossa, edizioneDi, stessoEditore, piuGiorni, oggiInItalia, salvaUscite } = require("./usciteManga");
const { fonteDi, usciteDellaRivista, senzaNumero } = require("./usciteFumettologica");

// Quanto può essere più avanti la riserva di quello che si sapeva. L'archivio
// copre un anno: uno scarto più grande non è una serie rimasta indietro, è
// quasi sempre un'altra cosa con lo stesso nome (la light novel di Sword Art
// Online sta a 24, il manga a 2). Oltre questo tetto si chiede a una persona.
const SCARTO_MASSIMO = 12;

/**
 * Il titolo del volume è davvero «la serie + il suo numero»?
 * «CHAINSAW MAN 22 – MONSTERS 32» è un'edizione abbinata (il 22 con un
 * altro libro), non il volume 32; «GACHIAKUTA 15 – JANKU 27» idem. Fra il
 * nome della serie e il numero finale non devono esserci altre cifre;
 * un sottotitolo senza numeri («Frieren – Oltre la fine del viaggio 12») va bene.
 */
function titoloRegolare(titoloVolume, titoloSerie) {
  if (!titoloVolume) return true; // senza titolo non si può dire: non si scarta
  const base = ossa(titoloSerie);
  const intero = ossa(senzaNumero(titoloVolume));

  return !intero.startsWith(base) || !/\d/.test(intero.slice(base.length));
}

// Un articolo copre una settimana e la richiesta ne porta al massimo 40:
// finestre da 26 settimane restano sotto il tetto per ogni rivista.
const SETTIMANE_PER_FINESTRA = 26;

/**
 * Rilegge gli articoli dei mesi passati per le serie date e li archivia.
 * Sicuro da ripetere: `salvaUscite` non duplica e non tocca le date di
 * AnimeClick. Un errore di una rivista non ferma le altre.
 *
 * @returns {{ lette: number, nuove: number, errori: string[], uscite: object[] }}
 */
async function riempiArchivio(pool, serie, { mesi = 12, oggi = oggiInItalia(), scrivi = true } = {}) {
  const perRivista = new Map();

  for (const s of serie) {
    const rivista = fonteDi(s.Editore);

    if (!rivista) continue;
    if (!perRivista.has(rivista)) perRivista.set(rivista, []);

    perRivista.get(rivista).push(s);
  }

  const risultato = { lette: 0, nuove: 0, errori: [], uscite: [] };
  const inizio = piuGiorni(oggi, -Math.round(mesi * 30.5));

  for (const [rivista, delleSerie] of perRivista) {
    for (let fino = oggi; fino > inizio; ) {
      const dopo = piuGiorni(fino, -SETTIMANE_PER_FINESTRA * 7);

      try {
        const { uscite, lette } = await usciteDellaRivista(rivista, delleSerie, {
          dopo: dopo < inizio ? inizio : dopo,
          fino
        });

        risultato.lette += lette;
        risultato.uscite.push(...uscite);

        // In prova non si scrive: le uscite restano in memoria e basta.
        if (scrivi) risultato.nuove += await salvaUscite(pool, uscite, "fumettologica");
      } catch (e) {
        risultato.errori.push(`${rivista}: ${e.message}`);
      }

      fino = dopo;
    }
  }

  return risultato;
}

/**
 * L'ultimo volume GIÀ USCITO di questa serie, o null se l'archivio non ne ha.
 * Serie ed edizione devono coincidere e l'editore non deve contraddire:
 * la stessa regola con cui le uscite si abbinano alla collezione.
 */
async function ultimoVolumeUscito(pool, serie, { oggi = oggiInItalia(), extra = [] } = {}) {
  const { rows } = await pool.query(
    `SELECT serie, titolo, edizione, editore, numero
       FROM uscite_manga
      WHERE data <= $1::date`,
    [oggi]
  );

  const tutte = [...rows, ...extra.filter((u) => u.data <= oggi)];
  const chiave = ossa(serie.Titolo);
  const edizione = edizioneDi(serie.Edizione);
  let massimo = null;

  for (const r of tutte) {
    if (ossa(r.serie) !== chiave) continue;
    if (edizioneDi(r.edizione) !== edizione) continue;
    if (!stessoEditore(serie.Editore, r.editore)) continue;
    if (!titoloRegolare(r.titolo, serie.Titolo)) continue;

    if (massimo === null || r.numero > massimo) massimo = r.numero;
  }

  return massimo;
}

module.exports = { riempiArchivio, ultimoVolumeUscito, titoloRegolare, SCARTO_MASSIMO };
