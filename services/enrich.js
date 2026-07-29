// Unisce le due fonti in una scheda sola.
//
// Divisione dei compiti:
//   AniList      → cover HD, generi, autore/disegnatore, volumi,
//                  stato serie, titolo originale
//   Google Books → trama IN ITALIANO, editore italiano, ISBN,
//                  prezzo di copertina
//
// Se Google Books non è configurato o non trova nulla, si ripiega
// sulla trama di AniList (in inglese): meglio di niente, e la scheda
// resta segnalata come da completare.

const anilist = require("./providers/anilist");
const googleBooks = require("./providers/googleBooks");
const translate = require("./providers/translate");

/**
 * Sceglie il primo valore utile fra quelli passati.
 * Tratta stringhe vuote e zeri come "mancante".
 */
function firstUseful(...values) {
  for (const v of values) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string" && v.trim() === "") continue;
    if (typeof v === "number" && Number.isNaN(v)) continue;
    return v;
  }
  return null;
}

/**
 * @param {string} titolo
 * @param {string} [autore]
 * @param {{traduci?: boolean}} [opzioni] traduci:false salta la traduzione
 *   quando la trama non serve (es. aggiornamento delle sole copertine):
 *   risparmia quota del traduttore.
 */
async function enrich(titolo, autore, opzioni = {}) {
  const traduci = opzioni.traduci !== false;

  if (!titolo || !String(titolo).trim()) {
    throw new Error("Titolo mancante");
  }

  // Le due fonti sono indipendenti: le interrogo in parallelo e
  // un fallimento dell'una non deve azzerare l'altra.
  const [anilistResult, booksResult] = await Promise.allSettled([
    anilist.search(titolo, autore),
    googleBooks.search(titolo, autore)
  ]);

  const al = anilistResult.status === "fulfilled" ? anilistResult.value : null;
  const gb = booksResult.status === "fulfilled" ? booksResult.value : null;

  const errors = [];
  if (anilistResult.status === "rejected") errors.push(`AniList: ${anilistResult.reason.message}`);
  if (booksResult.status === "rejected") errors.push(`Google Books: ${booksResult.reason.message}`);

  if (!al && !gb) {
    return {
      trovato: false,
      errori: errors.length ? errors : ["Nessun risultato"]
    };
  }

  // Ordine di preferenza per la trama:
  //   1. italiano nativo da Google Books (edizione italiana reale)
  //   2. trama AniList tradotta e riscritta in italiano
  //   3. trama AniList originale in inglese
  let tramaItaliana = gb?.trama || null;
  let origineTrama = tramaItaliana ? "google_books" : null;

  if (traduci && !tramaItaliana && al?.trama) {
    try {
      const tradotta = await translate.traduciInItaliano(al.trama, titolo);

      if (tradotta) {
        tramaItaliana = tradotta.testo;
        origineTrama = `tradotta_${tradotta.motore}`;
      }
    } catch (err) {
      // La quota esaurita riguarda tutte le schede successive, non solo
      // questa: la propago così il caricamento in blocco può fermarsi.
      if (err.quotaEsaurita) throw err;

      errors.push(`Traduzione: ${err.message}`);
    }
  }

  return {
    trovato: true,

    titoloOriginale: al?.titoloOriginale ?? null,
    autore: firstUseful(al?.autore, autore),
    disegnatore: al?.disegnatore ?? null,
    genere: al?.genere ?? null,

    trama: firstUseful(tramaItaliana, al?.trama),
    tramaInItaliano: Boolean(tramaItaliana),
    origineTrama: origineTrama || (al?.trama ? "anilist_inglese" : null),

    coverurl: al?.coverurl ?? null,
    volumitotali: al?.volumitotali ?? null,
    statoSerie: al?.statoSerie ?? null,

    editore: gb?.editore ?? null,
    isbn: gb?.isbn ?? null,
    prezzoCopertina: gb?.prezzoCopertina ?? null,

    annoInizio: firstUseful(al?.annoInizio, gb?.annoInizio),

    fonti: {
      anilist: Boolean(al),
      googleBooks: Boolean(gb),
      googleBooksAttivo: googleBooks.isEnabled(),
      motoreTraduzione: translate.motoreAttivo()
    },
    errori: errors
  };
}

module.exports = { enrich };
