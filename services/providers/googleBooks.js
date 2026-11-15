// Google Books — edizioni ITALIANE: trama in italiano, editore,
// ISBN e prezzo di copertina.
//
// Richiede GOOGLE_BOOKS_API_KEY: senza chiave l'API risponde 429
// quasi sempre. La chiave è gratuita (1000 richieste/giorno):
// console.cloud.google.com → API e servizi → Books API.

const ENDPOINT = "https://www.googleapis.com/books/v1/volumes";

const API_KEY = process.env.GOOGLE_BOOKS_API_KEY;

function isEnabled() {
  return Boolean(API_KEY);
}

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * I titoli dei manga su Google Books contengono il numero di volume:
 * "Naruto. Vol. 3", "Bleach 12", "One piece: 5".
 * Per confrontarli con la serie devo toglierlo.
 */
function stripVolume(title) {
  return String(title || "")
    .replace(/[.:\-–—]?\s*(vol\.?|volume|n\.?|#)\s*\d+.*$/i, "")
    .replace(/\s+\d+\s*$/, "")
    .trim();
}

/**
 * Estrae il numero di volume dal titolo, se c'è.
 * Serve perché le trame su Google Books sono PER VOLUME: quella
 * del volume 1 descrive la serie, quelle successive raccontano
 * spezzoni di trama che come descrizione della serie sarebbero
 * fuorvianti (e pieni di spoiler).
 */
function volumeNumber(title) {
  const t = String(title || "");

  const explicit = t.match(/(?:vol\.?|volume|n\.?|#)\s*(\d+)/i);
  if (explicit) return Number(explicit[1]);

  const trailing = t.match(/\s(\d{1,3})\s*$/);
  if (trailing) return Number(trailing[1]);

  return null;
}

function pickIsbn(identifiers = []) {
  const isbn13 = identifiers.find((i) => i.type === "ISBN_13");
  const isbn10 = identifiers.find((i) => i.type === "ISBN_10");
  return isbn13?.identifier || isbn10?.identifier || null;
}

/**
 * Fra tutti i volumi della serie prende quello più utile:
 * privilegia chi ha una trama, poi chi ha editore e prezzo.
 */
function scoreItem(item, target) {
  const info = item?.volumeInfo || {};
  const sale = item?.saleInfo || {};

  // langRestrict di Google è solo un suggerimento, non un filtro:
  // restituisce comunque edizioni inglesi. Qui scarto sul serio.
  if (info.language !== "it") return -1;

  const titleMatch = normalize(stripVolume(info.title));
  let score = 0;

  if (titleMatch === target) score += 10;
  else if (titleMatch.startsWith(target) || target.startsWith(titleMatch)) score += 6;
  else return -1; // "Boruto - Naruto Next Generations" non è "Naruto"

  // Il volume 1 introduce la serie: è l'unico la cui trama
  // descrive l'opera invece di un singolo episodio.
  const vol = volumeNumber(info.title);
  if (vol === 1) score += 9;
  else if (vol === null) score += 7;

  if (info.description && info.description.length > 80) score += 4;
  if (info.publisher) score += 2;
  if (sale.listPrice?.amount) score += 2;

  return score;
}

// Frasi che tradiscono un testo promozionale o una scheda che non
// descrive la storia: meglio nessuna trama che una trama sbagliata.
const RUMORE = [
  /versione digitale/i,
  /disponibile in (ebook|digitale)/i,
  /questo (libro|volume) è (la tua )?guida/i,
  /guida culturale/i,
  /\bartbook\b/i,
  /cofanetto/i,
  /edizione da collezione/i
];

/**
 * Le trame su Google Books sono per singolo volume. Solo quella del
 * volume 1 descrive la serie; le altre raccontano un pezzo di storia
 * a metà, spesso con spoiler. Accetto la descrizione solo quando
 * sono ragionevolmente sicuro che parli dell'opera nel suo insieme.
 */
function descrizioneAffidabile(info, target) {
  const testo = info.description?.replace(/\s+/g, " ").trim();

  if (!testo || testo.length < 80) return null;

  const vol = volumeNumber(info.title);
  const titoloEsatto = normalize(stripVolume(info.title)) === target;

  // Volume 1, oppure volume unico con titolo che coincide.
  const parlaDellaSerie = vol === 1 || (vol === null && titoloEsatto);
  if (!parlaDellaSerie) return null;

  if (RUMORE.some((r) => r.test(testo))) return null;

  return testo;
}

async function fetchVolumes(query) {
  const params = new URLSearchParams({
    q: query,
    langRestrict: "it",
    country: "IT",
    maxResults: "20",
    printType: "books",
    key: API_KEY
  });

  const res = await fetch(`${ENDPOINT}?${params}`, { signal: AbortSignal.timeout(12000) });

  if (res.status === 429) {
    throw new Error("Google Books: quota giornaliera esaurita");
  }

  if (!res.ok) {
    throw new Error(`Google Books HTTP ${res.status}`);
  }

  const json = await res.json();
  return json?.items || [];
}

async function search(title, author) {
  if (!isEnabled()) return null;

  // Provo dalla ricerca più precisa alla più larga: con l'autore
  // il risultato è più affidabile, ma per molte edizioni italiane
  // l'autore è assente o scritto in ordine inverso.
  const tentativi = [];

  if (author) {
    tentativi.push(`intitle:${title} inauthor:${author.split(",")[0].trim()}`);
  }

  tentativi.push(`intitle:${title}`);

  const target = normalize(title);
  let best = null;

  for (const query of tentativi) {
    const items = await fetchVolumes(query);

    const candidato = items
      .map((item) => ({ item, score: scoreItem(item, target) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)[0];

    if (candidato) {
      best = candidato;
      break;
    }
  }

  if (!best) return null;

  const info = best.item.volumeInfo || {};
  const sale = best.item.saleInfo || {};

  return {
    trama: descrizioneAffidabile(info, target),
    editore: info.publisher || null,
    isbn: pickIsbn(info.industryIdentifiers),
    prezzoCopertina: sale.listPrice?.amount ?? null,
    annoInizio: info.publishedDate
      ? Number(String(info.publishedDate).slice(0, 4)) || null
      : null
  };
}

/**
 * Un volume dal suo codice a barre. Serve alla scansione (`services/isbn.js`):
 * qui non si sceglie il «migliore» fra tanti, si risponde a una domanda precisa.
 * Restituisce null se Google non conosce il codice (o la chiave manca).
 *
 * Il numero di volume sta a volte nel titolo («Berserk. Vol. 12») e a volte nel
 * sottotitolo («Vol. 12», o «New edition»): si guardano tutti e due, e
 * `titoloIntero` li tiene insieme per chi deve riconoscere l'edizione.
 */
async function perIsbn(isbn13) {
  // Senza chiave Google rifiuta quasi sempre: va detto, non scambiato per «non lo conosco».
  if (!isEnabled()) throw new Error("Google Books: chiave non configurata (GOOGLE_BOOKS_API_KEY)");

  const chiedi = async (q) => {
    const params = new URLSearchParams({ q, country: "IT", maxResults: "10", key: API_KEY });
    const res = await fetch(`${ENDPOINT}?${params}`, { signal: AbortSignal.timeout(12000) });

    if (res.status === 429) throw new Error("Google Books: quota giornaliera esaurita");
    if (!res.ok) throw new Error(`Google Books HTTP ${res.status}`);

    return (await res.json())?.items || [];
  };

  // Prima la domanda precisa. Se non trova niente, la stessa cifra come testo libero: per
  // alcune edizioni l'indice `isbn:` è vuoto ma il codice sta comunque nella scheda. Lì però
  // Google restituisce anche libri che c'entrano poco: si tiene solo chi ha DAVVERO quel codice.
  const voce = scegliVoce(await chiedi(`isbn:${isbn13}`), isbn13, false) || scegliVoce(await chiedi(isbn13), isbn13, true);

  return voce ? daVolume(voce) : null;
}

/** La voce giusta fra quelle tornate. `soloSeCombacia`: tiene solo chi dichiara proprio quel codice. */
function scegliVoce(voci, isbn13, soloSeCombacia) {
  const codici = (voce) => (voce?.volumeInfo?.industryIdentifiers || []).map((i) => String(i.identifier || "").replace(/[^0-9X]/gi, ""));
  // L'ISBN-10 che corrisponde a un 978…: le nove cifre in mezzo, la decima è di controllo.
  const dieci = isbn13.startsWith("978") ? isbn13.slice(3, 12) : null;
  const combacia = (voce) => codici(voce).some((c) => c === isbn13 || (dieci && c.length === 10 && c.startsWith(dieci)));

  return voci.find(combacia) || (soloSeCombacia ? null : voci[0]) || null;
}

/** Da una voce di Google Books alla forma che usa la scansione. A parte per poterla provare. */
function daVolume(item) {
  const info = item?.volumeInfo || {};
  const sale = item?.saleInfo || {};

  if (!info.title) return null;

  const titoloIntero = [info.title, info.subtitle].filter(Boolean).join(". ");
  const numeroNelTitolo = volumeNumber(info.title);
  // Google scrive spesso il titolo della serie e basta («Blue box»), e il numero altrove:
  // nel sottotitolo, a volte nudo («4»), o nella scheda della serie (`seriesInfo`).
  const numeroNudo = (testo) => (/^\s*#?\s*(\d{1,3})\s*$/.exec(String(testo ?? "")) || [])[1];
  const daSerie = info.seriesInfo?.bookDisplayNumber ?? info.seriesInfo?.volumeSeries?.[0]?.orderNumber;
  const altrove = [volumeNumber(info.subtitle), numeroNudo(info.subtitle), numeroNudo(daSerie)]
    .map(Number)
    .find((n) => Number.isInteger(n) && n > 0 && n < 1000);

  return {
    fonte: "google",
    titolo: titoloIntero,
    titoloIntero,
    // Se il numero è nel titolo lo si toglie da lì; se è nel sottotitolo il titolo è già la serie.
    serie: stripVolume(info.title) || info.title,
    numero: numeroNelTitolo ?? altrove ?? null,
    editore: info.publisher || null,
    lingua: info.language || null,
    autori: info.authors || [],
    copertina: (info.imageLinks?.thumbnail || "").replace(/^http:/, "https:") || null,
    prezzoCopertina: sale.listPrice?.amount ?? null
  };
}

// `normalize`, `stripVolume` e `volumeNumber` servono anche a
// services/volumiItaliani.js, che conta i volumi usciti in Italia:
// meglio esporli che tenerne due copie che col tempo divergono.
module.exports = { search, perIsbn, daVolume, scegliVoce, isEnabled, normalize, stripVolume, volumeNumber };
