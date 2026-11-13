/**
 * La ricerca del 7 — cosa è uscito delle tue serie in corso.
 *
 * AnimeClick non si può più leggere in automatico (verifica anti-bot di
 * Cloudflare sul calendario). Finché non ci sarà un accesso concordato,
 * il 7 di ogni mese si cerca ALTROVE, solo per le serie in corso della
 * collezione, i volumi usciti dall'8 del mese scorso all'8 di questo
 * mese. Se un volume si trova lo si scrive in `uscite_manga` (e il
 * riepilogo dell'8 lo racconta); se non si trova non si scrive niente.
 *
 * La fonte è Fumettologica, che ogni settimana pubblica l'elenco dei
 * volumi in uscita di Planet Manga (Panini), J-Pop e Star Comics: vedi
 * `services/usciteFumettologica.js` per come si legge e per cosa significa
 * «la data è quella della settimana».
 *
 * Cosa NON si controlla, e il giro lo dice a voce alta invece di tacere:
 *   - le serie di un editore che Fumettologica non copre
 *     (`nonControllate` nell'esito);
 *   - un editore coperto di cui non si è trovato nessun articolo nella
 *     finestra (`senzaArticoli`): vuol dire «non ho potuto guardare», non
 *     «non è uscito niente».
 *
 * Con `prova: true` fa tutto tranne scrivere, e racconta per ogni serie
 * cosa ha trovato: è il modo di giudicare la fonte prima di fidarsene.
 */

const { salvaUscite, oggiInItalia, piuGiorni } = require("./usciteManga");
const { giornoDelMesePrima, GIORNO_RIEPILOGO, dueCifre } = require("./riepilogoUscite");
const { fonteDi, usciteDellaRivista } = require("./usciteFumettologica");

const FONTE = "fumettologica";

const nomeSerie = (s) => String(s.Titolo).trim() + (s.Edizione ? ` · ${s.Edizione}` : "");

/** La ricerca del 7: dall'8 del mese scorso all'8 di questo. `oggi` (AAAA-MM-GG) serve alle prove. */
function cercaUsciteDelMese(pool, { prova = false, oggi = null } = {}) {
  const giorno = oggi || oggiInItalia();

  return cercaNellaFinestra(pool, {
    prova,
    dopo: giornoDelMesePrima(giorno),
    fino: `${giorno.slice(0, 7)}-${dueCifre(GIORNO_RIEPILOGO)}`
  });
}

/**
 * La ricerca settimanale: due settimane indietro e due avanti da oggi.
 *
 * Tiene aggiornata la home («Esce questa settimana») e la pagina Uscite:
 * Fumettologica pubblica l'elenco di una settimana in quella settimana
 * (Star Comics il lunedì, Planet Manga a metà settimana), quindi il giro
 * mensile da solo vedrebbe le uscite di dopo giorni. Due settimane
 * indietro perché un giro saltato non lasci buchi; avanti non si sa di più
 * di quello che già hanno pubblicato, e va bene così.
 */
function cercaUsciteSettimana(pool, { prova = false, oggi = null } = {}) {
  const giorno = oggi || oggiInItalia();

  return cercaNellaFinestra(pool, { prova, dopo: piuGiorni(giorno, -14), fino: piuGiorni(giorno, 14) });
}

async function cercaNellaFinestra(pool, { prova, dopo, fino }) {
  const { rows: serie } = await pool.query(
    `SELECT "ID", "Titolo", "Edizione", "Editore"
       FROM "Manga"
      WHERE "StatoSerie" = 'in_corso'
        -- Una serie smessa (026) non si cerca nemmeno: un articolo letto
        -- in meno, e niente righe che poi nessuno guarderebbe.
        AND "SmessaIl" IS NULL
      ORDER BY "Titolo"`
  );

  const esito = {
    periodo: { dopo, fino },
    serie: serie.length,
    trovate: 0,
    scritte: 0,
    errori: 0,
    prova,
    uscite: [],
    nonControllate: [],
    senzaArticoli: []
  };

  // Le serie si raggruppano per rivista: un articolo si legge una volta
  // sola per tutte le serie dello stesso editore.
  const perRivista = new Map();

  for (const s of serie) {
    const rivista = fonteDi(s.Editore);

    if (!rivista) {
      esito.nonControllate.push(`${nomeSerie(s)} (${s.Editore || "editore sconosciuto"})`);
      continue;
    }

    if (!perRivista.has(rivista)) perRivista.set(rivista, []);

    perRivista.get(rivista).push(s);
  }

  const tutte = [];

  for (const [rivista, delleSerie] of perRivista) {
    try {
      const { uscite, lette } = await usciteDellaRivista(rivista, delleSerie, { dopo, fino });

      if (lette === 0) esito.senzaArticoli.push(rivista);

      tutte.push(...uscite);

      esito.uscite.push(
        ...uscite.map((u) => ({
          serie: `${u.serie}${u.edizione ? ` · ${u.edizione}` : ""}`,
          numero: u.numero,
          data: u.data,
          titolo: u.titolo,
          settimana: u.settimana
        }))
      );
    } catch (err) {
      esito.errori += 1;
      esito.senzaArticoli.push(`${rivista} (${err.message})`);
    }

    // Una pausa tra una rivista e l'altra: sono richieste verso un sito di altri.
    await new Promise((r) => setTimeout(r, 400));
  }

  esito.trovate = tutte.length;

  if (!prova) esito.scritte = await salvaUscite(pool, tutte, FONTE);

  return esito;
}

module.exports = { cercaUsciteDelMese, cercaUsciteSettimana };
