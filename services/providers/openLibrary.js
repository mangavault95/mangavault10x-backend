// Open Library — il secondo catalogo a cui chiedere un codice a barre.
//
// Serve solo alla scansione (`services/isbn.js`), e solo quando Google Books non conosce
// il codice. È gratuito e senza chiave: https://openlibrary.org/dev/docs/api/books
// Delle edizioni italiane dei manga ne conosce poche, ma non costa niente chiedere, e una
// risposta su dieci è una ricerca a mano in meno.
//
// Una richiesta per codice, mai in ciclo, con la firma dichiarata del sito: è il modo in
// cui Open Library chiede di essere usata.

const { stripVolume, volumeNumber } = require("./googleBooks");

const FIRMA = "MangaVault/1.0";

async function perIsbn(isbn13) {
  const res = await fetch(`https://openlibrary.org/isbn/${encodeURIComponent(isbn13)}.json`, {
    headers: { "User-Agent": FIRMA, Accept: "application/json" },
    signal: AbortSignal.timeout(8000)
  });

  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Open Library HTTP ${res.status}`);

  return daEdizione(await res.json());
}

/** Da un'edizione di Open Library alla forma che usa la scansione. A parte per poterla provare. */
function daEdizione(edizione) {
  if (!edizione?.title) return null;

  const titoloIntero = [edizione.title, edizione.subtitle].filter(Boolean).join(". ");

  return {
    fonte: "openlibrary",
    titolo: titoloIntero,
    titoloIntero,
    serie: stripVolume(edizione.title) || edizione.title,
    numero: volumeNumber(edizione.title) ?? volumeNumber(edizione.subtitle) ?? volumeNumber(edizione.edition_name),
    editore: Array.isArray(edizione.publishers) ? edizione.publishers[0] || null : null,
    // Niente copertina: quelle di Open Library stanno su un dominio che il ponte delle copertine
    // (`routes/cover.js`) non ammette, e non vale la pena ammetterlo per un riquadro. Se la serie è
    // fra le vostre si vede la sua; altrimenti resta il riquadro vuoto.
    copertina: null,
    prezzoCopertina: null
  };
}

module.exports = { perIsbn, daEdizione };
