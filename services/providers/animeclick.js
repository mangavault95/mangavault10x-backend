// AnimeClick — quanti volumi di una serie sono usciti IN ITALIA.
//
// Perché serve, e perché proprio qui: `"VolumiTotali"` arriva da
// AniList, che quel numero non lo pubblica finché la serie è in corso
// (`volumes: null`, `status: RELEASING`), e quando lo pubblica è
// comunque il totale giapponese. Google Books è stato provato e
// scartato: sulle stesse 28 serie, a pochi minuti di distanza,
// rispondeva numeri diversi (Hunter x Hunter 38 e poi niente, Sword
// Art Online 1 e poi 19) — vedi ROADMAP.
//
// AnimeClick non ha un'API pubblica, quindi si legge la pagina delle
// edizioni. Due cose la rendono una scelta ragionevole invece di uno
// scraping alla cieca:
//
//   1. Il loro robots.txt vieta solo `/app.php/`: queste pagine no.
//   2. Il job gira una volta al mese su poche decine di serie. È il
//      traffico di una persona che sfoglia il sito, non uno scraping.
//
// Resta una dipendenza dall'HTML altrui, che un giorno cambierà. È
// una scelta consapevole: quando succede si aggiusta il parser, non
// è una cosa di tutti i giorni.

const { volumeNumber } = require("./googleBooks");

// Un'intestazione che dice chi siamo: se dà fastidio, chi gestisce il
// sito sa chi bloccare senza dover indovinare.
const USER_AGENT =
  "MangaVault/1.0 (collezione personale; +https://mangavault10x-frontend.vercel.app)";

// Le ristampe ripetono volumi già contati, e le edizioni speciali
// raccolgono più volumi in uno: il loro numero più alto è più basso
// del vero e falserebbe il conto verso il basso.
const RISTAMPA = /ristampa/i;

// `gazzetta` e `pack` non sono ipotesi: la scheda di Pokémon elenca
// "Pokémon - La grande avventura (La Gazzetta dello Sport)" con 55
// volumi accanto ai 26 dell'edizione in fumetteria, e quella di Rent
// a Girlfriend ha un "Reiji Miyajima Pack" che è un cofanetto misto
// con un'altra serie dentro.
//
// `box\s*set`, non `box` da solo: una serie si chiama proprio "Blue
// Box", e la parola nuda bastava a farla scartare — ogni riga
// buttata via, compresa quella giusta. La stessa cautela vale per le
// altre parole qui sotto: vanno abbastanza specifiche da non
// coincidere con un titolo vero.
const MARCHI_EDIZIONE =
  /\b(variant|discovery|deluxe|instant|perfect|ultimate|complete|gold|silver|omnibus|box\s*set|cofanetto|anniversary|kanzenban|bunko|new\s+edition|reloaded|collection|gazzetta|pack)\b/i;

function testoDi(html) {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * L'indirizzo di una scheda: solo l'ID conta davvero, lo slug è
 * decorativo — `/manga/9553/x/edizioni` risponde come quello giusto.
 * Ma `/manga/9553` da solo dà 404, e `/manga/9553/edizioni` legge
 * "edizioni" come slug e restituisce un'altra pagina: il segmento in
 * mezzo ci vuole.
 */
function urlEdizioni(animeClickId) {
  return `https://www.animeclick.it/manga/${animeClickId}/-/edizioni`;
}

/**
 * Le righe della tabella si agganciano per FORMA, non per posizione:
 * la data è l'unica cella scritta gg/mm/aaaa e il titolo l'unica che
 * finisce con un numero. Se un giorno aggiungono una colonna, un
 * parser che contava gli indici si romperebbe in silenzio — questo no.
 */
function leggiRiga(trHtml) {
  const celle = (trHtml.match(/<td[\s\S]*?<\/td>/gi) || []).map(testoDi);

  if (!celle.length) return null;

  const data = celle.find((c) => /^\d{2}\/\d{2}\/\d{4}$/.test(c));

  // Lo SPAZIO prima del numero non è un dettaglio: senza, il prezzo
  // "19,90" passa per un titolo di volume — succede sulle righe dove
  // la cella del titolo non finisce con un numero, perché la ricerca
  // prosegue e trova il prezzo.
  const titolo = celle.find((c) => /\D\s+\d{1,3}$/.test(c) && !/^[\d.,]+$/.test(c));

  return { celle, data, titolo, riga: celle.join(" ") };
}

function dataItaliana(gg_mm_aaaa) {
  const [gg, mm, aaaa] = gg_mm_aaaa.split("/");
  const d = new Date(`${aaaa}-${mm}-${gg}T00:00:00Z`);

  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Il volume più alto GIÀ USCITO dell'edizione che ho in collezione.
 *
 * La data di uscita è ciò che rende il numero onesto: i volumi
 * annunciati ma non ancora in libreria sono già in tabella con una
 * data futura, e contarli farebbe risultare la collezione indietro.
 */
async function volumiUsciti(animeClickId, { edizione = null, oggi = new Date(), fetchImpl = fetch } = {}) {
  const url = urlEdizioni(animeClickId);

  const risposta = await fetchImpl(url, {
    headers: { "User-Agent": USER_AGENT, "Accept-Language": "it-IT,it;q=0.9" },
    signal: AbortSignal.timeout(20000)
  });

  if (!risposta.ok) throw new Error(`AnimeClick HTTP ${risposta.status} su ${url}`);

  const html = await risposta.text();
  const tbody = (html.match(/<tbody[\s\S]*?<\/tbody>/i) || [])[0];

  // Tutta la tabella è già nell'HTML: quel DataTables impagina lato
  // client (`serverSide: false`), quindi una GET basta e non serve
  // eseguire JavaScript né sfogliare le pagine.
  if (!tbody) throw new Error(`AnimeClick: tabella delle edizioni non trovata su ${url}`);

  const righe = tbody.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  const etichetta = edizione ? String(edizione).trim() : null;

  const scartati = { ristampa: 0, altraEdizione: 0, futuri: 0, illeggibili: 0 };
  const numeri = new Set();
  let ultimaUscita = null;

  for (const tr of righe) {
    const r = leggiRiga(tr);

    if (!r || !r.titolo || !r.data) { scartati.illeggibili++; continue; }
    if (RISTAMPA.test(r.riga)) { scartati.ristampa++; continue; }

    const nomeEdizione = r.titolo.replace(/\s*\d{1,3}\s*$/, "").trim();

    // Con un'etichetta in tabella tengo solo chi la nomina; senza,
    // la serie è l'edizione normale e chi nomina un'edizione speciale
    // va scartato.
    const suaEdizione = etichetta
      ? nomeEdizione.toLowerCase().includes(etichetta.toLowerCase())
      : !MARCHI_EDIZIONE.test(nomeEdizione);

    if (!suaEdizione) { scartati.altraEdizione++; continue; }

    const quando = dataItaliana(r.data);

    if (!quando) { scartati.illeggibili++; continue; }
    if (quando > oggi) { scartati.futuri++; continue; }

    const n = volumeNumber(r.titolo);

    if (!n) { scartati.illeggibili++; continue; }

    numeri.add(n);

    if (!ultimaUscita || quando > ultimaUscita.quando) ultimaUscita = { numero: n, quando, testo: r.data };
  }

  const ordinati = [...numeri].sort((a, b) => a - b);
  const massimo = ordinati.length ? ordinati[ordinati.length - 1] : null;

  // Se i numeri vanno da 1 a N senza buchi, il conto si spiega da
  // solo e ci si può fidare. Con dei buchi il massimo resta valido —
  // un volume in mezzo può mancare in scheda — ma vale la pena
  // saperlo, così il rapporto lo può dire.
  const completo = Boolean(massimo) && ordinati.length === massimo && ordinati[0] === 1;

  return {
    massimo,
    quanti: ordinati.length,
    completo,
    mancanti: massimo ? Array.from({ length: massimo }, (_, i) => i + 1).filter((n) => !numeri.has(n)) : [],
    ultimaUscita: ultimaUscita ? ultimaUscita.testo : null,
    righeTotali: righe.length,
    scartati,
    url
  };
}

module.exports = { volumiUsciti, urlEdizioni, USER_AGENT };
