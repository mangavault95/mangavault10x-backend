/**
 * «Domani esce il vol. 12» — l'avviso del giorno prima, come notifica push.
 *
 * Per i volumi esisteva solo il riepilogo del mese (`riepilogoUscite.js`, l'8 su
 * Telegram): dice cosa è uscito e ti manca, ma a cose fatte. Questo guarda in
 * avanti di UN giorno: i volumi che escono domani per le serie della collezione,
 * così la sera prima si sa che domani, passando dalla fumetteria, c'è qualcosa da
 * prendere.
 *
 * Il giro parte da GitHub Actions (`avviso-volumi-domani.yml`), che chiama
 * `POST /api/manga/uscite/domani`, come per gli altri avvisi: qui c'è solo cosa
 * mandare e a chi. I dati sono quelli di `uscite_manga`, che il giro quotidiano
 * del calendario riempie già.
 *
 * ------------------------------------------------------------
 * DI QUALI VOLUMI SI PARLA
 *
 * Solo di quelli che NON hai già (`stato !== "gia"`): dirti che domani esce un
 * volume che hai in casa è rumore. Dei due casi che restano, uno è il più utile
 * dell'altro: «il prossimo che ti serve» (comprarlo completa la serie fin lì) e
 * «prima te ne mancano N», dove comprare questo senza gli altri è proprio
 * l'errore da evitare.
 *
 * ------------------------------------------------------------
 * A CHI
 *
 * La collezione è in comune, quindi a ogni persona che ha un dispositivo
 * iscritto E accesso alla biblioteca (come il riepilogo del mese). Chi la
 * collezione non la vede non riceve avvisi su di lei.
 *
 * ------------------------------------------------------------
 * ORDINE DELLE OPERAZIONI
 *
 * Come per gli avvisi delle puntate: si SEGNA prima e si MANDA dopo, e se non
 * parte si disdice (`services/avvisi.js` spiega perché). Il registro è
 * `push_volumi_inviati`, con la DATA nella chiave: se un'uscita si sposta, il
 * nuovo giorno merita un avviso nuovo.
 */

const push = require("./push");
const { usciteTra, piuGiorni, oggiInItalia } = require("./usciteManga");
const { haBiblioteca } = require("./utenti");

/** Quante righe di elenco in una notifica: oltre, non si leggono. */
const RIGHE = 4;

function nomeSerie(serie) {
  return serie.edizione ? `${serie.titolo} · ${serie.edizione}` : serie.titolo;
}

/** «prima te ne manca 1», «prima te ne mancano 3». */
function primaTeNeMancano(n) {
  return n === 1 ? "Prima te ne manca 1." : `Prima te ne mancano ${n}.`;
}

/** Il messaggio push per UNA persona: i volumi di domani che non ha. */
function messaggioVolumi(volumi, domani) {
  if (volumi.length === 1) {
    const v = volumi[0];

    return {
      titolo: `Domani esce il vol. ${v.numero}`,
      corpo: [
        nomeSerie(v.serie),
        v.stato === "manca" ? primaTeNeMancano(v.mancanti) : "È il prossimo che ti serve."
      ].join("\n"),
      url: `/serie/${v.serie.id}`,
      tag: `volumi-${domani}`
    };
  }

  const visibili = volumi.slice(0, RIGHE);
  const altri = volumi.length - visibili.length;

  return {
    titolo: `Domani escono ${volumi.length} volumi`,
    corpo: [
      ...visibili.map((v) => `${nomeSerie(v.serie)} ${v.numero}${v.stato === "manca" ? " ⚠️" : ""}`),
      ...(altri > 0 ? [`e altri ${altri}`] : [])
    ].join("\n"),
    url: "/uscite",
    tag: `volumi-${domani}`
  };
}

/** Chi riceve: persone attive con almeno un dispositivo e accesso alla biblioteca. */
async function destinatari(pool, haAccesso) {
  const { rows } = await pool.query(
    `SELECT u.id, u.nickname, u.proprietario
       FROM utenti u
      WHERE u.stato = 'attivo'
        AND EXISTS (SELECT 1 FROM push_sottoscrizioni s WHERE s.utente_id = u.id)
      ORDER BY u.id`
  );

  const risultato = [];

  for (const r of rows) {
    if (r.proprietario || (await haAccesso(r.id))) risultato.push(r);
  }

  return risultato;
}

/** Segna i volumi come annunciati e restituisce quelli segnati davvero. */
async function segna(pool, utenteId, volumi) {
  const { rows } = await pool.query(
    `
    INSERT INTO push_volumi_inviati (utente_id, manga_id, numero, data)
    SELECT $1, x.manga_id, x.numero, x.data
      FROM UNNEST($2::bigint[], $3::int[], $4::date[]) AS x(manga_id, numero, data)
    ON CONFLICT DO NOTHING
    RETURNING manga_id, numero
    `,
    [utenteId, volumi.map((v) => v.serie.id), volumi.map((v) => v.numero), volumi.map((v) => v.data)]
  );

  const presi = new Set(rows.map((r) => `${r.manga_id}:${r.numero}`));

  return volumi.filter((v) => presi.has(`${v.serie.id}:${v.numero}`));
}

async function disdici(pool, utenteId, volumi) {
  await pool.query(
    `
    DELETE FROM push_volumi_inviati
     WHERE utente_id = $1
       AND (manga_id, numero, data) IN (
         SELECT x.manga_id, x.numero, x.data
           FROM UNNEST($2::bigint[], $3::int[], $4::date[]) AS x(manga_id, numero, data)
       )
    `,
    [utenteId, volumi.map((v) => v.serie.id), volumi.map((v) => v.numero), volumi.map((v) => v.data)]
  );
}

/**
 * Il lavoro intero.
 *
 * `prova: true` dice cosa manderebbe, e a chi, senza segnare né mandare.
 * `oggi` (AAAA-MM-GG) serve alle prove; `leggiUscite` e `haAccesso` si possono
 * sostituire per lo stesso motivo.
 *
 * Con il push spento risponde `{ spento: true }` e basta: è un lavoro che gira
 * ogni giorno, e un fallimento quotidiano per una funzione che non si è scelto di
 * accendere sarebbe solo rumore.
 */
async function avvisaVolumi(pool, { prova = false, oggi = null, leggiUscite = usciteTra, haAccesso = haBiblioteca } = {}) {
  if (!push.configurato()) return { spento: true, inviati: 0, persone: 0, falliti: 0, dettaglio: [] };

  const giorno = oggi || oggiInItalia();
  const domani = piuGiorni(giorno, 1);

  // `dopo` escluso e `fino` incluso: la finestra è il solo giorno di domani.
  const uscite = await leggiUscite(pool, { dopo: giorno, fino: domani, soloMie: true });
  const daAvvisare = uscite.filter((u) => u.stato !== "gia" && u.serie);

  const esito = { domani, volumi: daAvvisare.length, persone: 0, inviati: 0, falliti: 0, dettaglio: [] };

  if (daAvvisare.length === 0) return esito;

  const persone = await destinatari(pool, haAccesso);

  esito.persone = persone.length;

  for (const persona of persone) {
    const volumi = prova ? daAvvisare : await segna(pool, persona.id, daAvvisare);

    if (volumi.length === 0) continue;

    const messaggio = messaggioVolumi(volumi, domani);

    if (prova) {
      esito.dettaglio.push({ a: persona.nickname, volumi: volumi.length, messaggio });
      continue;
    }

    const consegnati = await push.inviaAPersona(pool, persona.id, messaggio);

    if (consegnati > 0) {
      esito.inviati++;
      esito.dettaglio.push({ a: persona.nickname, volumi: volumi.length, dispositivi: consegnati });
      continue;
    }

    await disdici(pool, persona.id, volumi);

    esito.falliti++;
    esito.dettaglio.push({ a: persona.nickname, volumi: volumi.length, errore: "nessun dispositivo ha ricevuto" });

    console.error(`🔔 Avviso volumi a ${persona.nickname} non partito`);
  }

  return esito;
}

module.exports = { avvisaVolumi, messaggioVolumi };
