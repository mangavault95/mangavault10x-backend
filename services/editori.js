// services/editori.js
//
// Il nome di un editore, scritto sempre allo stesso modo.
//
// Le varianti dello stesso nome arrivano da fuori. Google Books scrive
// «Panini S.p.A.» e «Edizioni BD S.r.l.», AnimeClick un'altra versione, e
// scritte così in collezione diventano editori diversi: due voci nel filtro,
// il logo che manca a una delle due. Il sito le ricomponeva solo al momento
// di MOSTRARle (`src/dati/generi.js` nel frontend); questo le ferma quando
// si SCRIVONO, così il database resta pulito e non serve ricomporle ogni volta.
//
// Due regole, entrambe da fatti e non da ipotesi:
//
//   1. la forma societaria in coda (S.p.A., S.r.l.) non fa parte del nome di
//      un marchio: «Panini S.p.A.» e «Panini» sono lo stesso editore;
//   2. i nomi già in collezione e i sinonimi di marchio visti davvero, qui sotto.
//
// Il resto passa com'è, a parte spazi in testa, in coda e doppi: NON si
// indovina la maiuscola giusta di un nome mai visto, e non si fondono nomi che
// somigliano soltanto (non si sa se «Panini Comics» sia un'altra cosa).
//
// ⚠️ gemella: `editoreCanonico` in mangavault10x-bot/src/editori.js. I casi
// condivisi stanno in fixtures/editori/casi.json, uguale nei due repository.

// Gli editori che ci sono già in collezione, scritti come si scrivono qui
// (dall'elenco del database, 14/11/2026). Servono per la maiuscola: «star comics»
// e «J-Pop» tornano «Star Comics» e «J-POP» invece di diventare due voci nuove.
// Un editore che non è in questa lista passa com'è scritto: la lista non limita,
// ripara. Si allunga quando in collezione ne entra uno nuovo con un nome da fissare.
const NOTI = [
  "Canicola Edizioni",
  "Coconino Press",
  "Dynit",
  "Edizioni BD",
  "Fabbri",
  "Flashbook Edizioni",
  "Goen",
  "GP",
  "Granata Press",
  "Hikari",
  "J-POP",
  "Panini",
  "Play Press",
  "Star Comics",
  "Toshokan"
];

// Sinonimi di marchio che si sono visti davvero. La chiave è in minuscolo e
// senza forma societaria.
const SINONIMI = {
  // Il file del logo è `gp.jpg` (frontend, src/assets/editori): per l'app questo
  // editore si chiama «GP», e «GP Manga» (la sua collana di manga) restava senza logo.
  "gp manga": "GP"
};

// Una Map e non un oggetto: su un oggetto, un nome come «constructor» o «toString»
// troverebbe la funzione dell'oggetto invece di non trovare niente.
const DA_MINUSCOLO = new Map([...NOTI.map((n) => [n.toLowerCase(), n]), ...Object.entries(SINONIMI)]);

const FORMA_SOCIETARIA = /\s+(?:s\s?\.?\s?p\s?\.?\s?a\s?\.?|s\s?\.?\s?r\s?\.?\s?l\s?\.?)\s*$/i;

/** Il nome canonico di un editore, o `null` se non c'è niente di scritto. */
function editoreCanonico(grezzo) {
  if (typeof grezzo !== "string") return null;

  const pulito = grezzo.replace(/\s+/g, " ").trim();

  if (!pulito) return null;

  const senzaForma = pulito.replace(FORMA_SOCIETARIA, "").trim() || pulito;

  return DA_MINUSCOLO.get(senzaForma.toLowerCase()) ?? senzaForma;
}

module.exports = { editoreCanonico };
