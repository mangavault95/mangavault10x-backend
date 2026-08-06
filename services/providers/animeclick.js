// AnimeClick — la fonte italiana: volumi usciti qui, e i titoli che i
// lettori italiani accostano a una serie.
//
// Due mestieri diversi nello stesso file perché è lo stesso sito, con
// le stesse regole di cortesia e lo stesso modo di leggere l'HTML.
// Sotto, dopo il conteggio dei volumi, la sezione "CONSIGLI".
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

// Le entità numeriche vanno sciolte, non buttate: nei titoli sono
// apostrofi ("Takopi&#039;s Original Sin"), e sostituirle con uno
// spazio spezza la parola in due.
const ENTITA = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&quot;": '"',
  "&apos;": "'",
  "&egrave;": "è",
  "&agrave;": "à",
  "&eacute;": "é",
  "&igrave;": "ì",
  "&ograve;": "ò",
  "&ugrave;": "ù"
};

function testoDi(html) {
  return String(html || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&[a-z]+;/gi, (e) => ENTITA[e.toLowerCase()] ?? " ")
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

/* ==================================================
   CONSIGLI
   ==================================================

   Sotto ogni scheda di AnimeClick c'è "Consiglia Simile": chi ha letto
   quel fumetto ne indica un altro a chi l'ha amato. Sono raccomandazioni
   di lettori italiani, sui titoli usciti in Italia e con i nomi con cui
   li conosciamo qui — un punto di vista che AniList non ha e non può
   avere.

   La pagina è `/manga/<id>/-/consigli`, un pannello a schede dove i
   consigli sono già nell'HTML (nessun JavaScript da eseguire) e
   ordinati per quante persone li hanno segnalati.

   Il costo di una risposta è alto — ricerca, verifica dell'autore e
   pagina dei consigli sono richieste separate, e AnimeClick impiega
   secondi — quindi chi chiama tiene i risultati in cache e il sito
   mostra intanto quello che ha già.  */

const BASE = "https://www.animeclick.it";

const INTESTAZIONI = {
  "User-Agent": USER_AGENT,
  "Accept-Language": "it-IT,it;q=0.9"
};

async function prendi(url, opzioni = {}, fetchImpl = fetch) {
  const risposta = await fetchImpl(url, {
    redirect: "follow",
    ...opzioni,
    headers: { ...INTESTAZIONI, ...(opzioni.headers || {}) },
    signal: AbortSignal.timeout(20000)
  });

  if (!risposta.ok) throw new Error(`AnimeClick HTTP ${risposta.status} su ${url}`);

  return risposta;
}

/** I testi dei singoli <a>: autori e generi sono liste di link, non frasi. */
function linkDi(html) {
  return [...String(html || "").matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)]
    .map((m) => testoDi(m[1]))
    .filter(Boolean);
}

function senzaAccenti(testo) {
  return String(testo || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Quanto un risultato somiglia a quello che si cercava.
 *
 * ⚠️ Gemella di quella in `mangavault10x-bot/src/animeclick.js`: stesso
 * sito, stessa ricerca letterale. Se una va corretta, vanno corrette
 * tutte e due.
 */
function somiglianza(cercato, trovato) {
  const a = senzaAccenti(cercato);
  const b = senzaAccenti(trovato);

  if (!a || !b) return 0;
  if (a === b) return 100;
  if (b.startsWith(a)) return 80 - (b.length - a.length) * 0.2;
  if (b.includes(a)) return 60 - (b.length - a.length) * 0.2;

  return 0;
}

/**
 * La ricerca di AnimeClick, che risponde solo se interrogata come fa
 * il loro JavaScript: POST con `X-Requested-With: XMLHttpRequest`,
 * token CSRF preso dal modulo e cookie di sessione rimandato indietro.
 * Da lì le due richieste per una ricerca sola.
 *
 * `anno: -1` ("qualunque anno") non è pignoleria: senza, la ricerca
 * risponde "Ci sono 0 titoli in database" perfino a "one piece".
 */
async function cerca(titolo, { quanti = 3, fetchImpl = fetch } = {}) {
  const modulo = await prendi(`${BASE}/ricerca/manga`, {}, fetchImpl);

  const cookie = (modulo.headers.get("set-cookie") || "")
    .split(",")
    .map((c) => c.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");

  const html = await modulo.text();
  const token = html.match(/name="search_manga\[_token\]"[^>]*value="([^"]+)"/);

  if (!token) throw new Error("AnimeClick: token della ricerca non trovato");

  const corpo = new URLSearchParams({
    "search_manga[title]": titolo,
    "search_manga[titleOption]": "0", // 0 = contiene
    "search_manga[anno]": "-1",
    "search_manga[ordinamento]": "titolo",
    "search_manga[versoOrdinamento]": "1",
    "search_manga[_token]": token[1]
  });

  const risposta = await prendi(
    `${BASE}/ricerca/manga`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "XMLHttpRequest",
        Cookie: cookie
      },
      body: corpo.toString()
    },
    fetchImpl
  );

  const json = await risposta.json();
  const frammento = json?.data?.html;

  if (!frammento) return [];

  const trovate = [];

  // Ogni risultato è un blocco .thumbnail: si taglia lì invece di
  // contare l'annidamento dei div, che con una regex non si conta.
  for (const blocco of String(frammento).split(/<div class="thumbnail/).slice(1)) {
    const link = blocco.match(/href="\/manga\/(\d+)\/([a-z0-9-]*)"/i);
    const didascalia = blocco.match(/<div class="caption[\s\S]*?<h5>([\s\S]*?)<\/h5>/i);

    if (!link || !didascalia) continue;

    const nome = testoDi(didascalia[1]);

    if (!nome) continue;

    trovate.push({
      id: Number(link[1]),
      titolo: nome,
      url: `${BASE}/manga/${link[1]}/${link[2] || "-"}`,
      punteggio: somiglianza(titolo, nome)
    });
  }

  return trovate
    .filter((s) => s.punteggio > 0)
    .sort((a, b) => b.punteggio - a.punteggio)
    .slice(0, quanti);
}

/** Chi ha scritto e disegnato, letto dal <dl> della scheda. */
async function autoriDi(animeClickId, { fetchImpl = fetch } = {}) {
  const risposta = await prendi(`${BASE}/manga/${animeClickId}/-/`, {}, fetchImpl);
  const html = await risposta.text();

  const dl = html.slice(html.indexOf('<dl class="dl-horizontal">'), html.indexOf("</dl>"));
  const nomi = [];

  for (const [, dt, dd] of dl.matchAll(/<dt>([\s\S]*?)<\/dt>\s*<dd>([\s\S]*?)<\/dd>/g)) {
    if (/storia|disegni/i.test(testoDi(dt))) nomi.push(...linkDi(dd));
  }

  return [...new Set(nomi)];
}

/**
 * Vero se due nomi sono la stessa persona.
 *
 * Basta il cognome: AnimeClick e il nostro database romanizzano allo
 * stesso modo ("Shuzo Oshimi" in tutti e due), ma l'ordine dei nomi
 * cambia da scheda a scheda, e un confronto sull'intera stringa
 * perderebbe "Asano Inio" contro "Inio Asano".
 */
function stessoNome(uno, altro) {
  const parole = (n) => new Set(senzaAccenti(n).split(" ").filter((p) => p.length >= 3));
  const a = parole(uno);

  if (!a.size) return false;

  return [...parole(altro)].some((p) => a.has(p));
}

/**
 * Quale scheda di AnimeClick è la serie che ho in mano.
 *
 * La ricerca è letterale sul titolo italiano, che è esattamente come
 * la serie è registrata in collezione: quasi sempre il primo risultato
 * combacia parola per parola. Ma gli omonimi esistono e sono la trappola
 * vera — "I fiori del male" restituisce tre opere diverse, e quella di
 * Oshimi è la seconda — quindi quando c'è un autore da confrontare si
 * apre la scheda e si guarda la firma, in ordine di somiglianza, fino
 * alla prima che torna. Se nessuna firma corrisponde, meglio niente
 * consigli che i consigli del fumetto sbagliato.
 */
async function trovaOpera({ titolo, autore = null, fetchImpl = fetch }) {
  const candidate = await cerca(titolo, { quanti: 3, fetchImpl });

  if (!candidate.length) return null;

  // Un solo risultato, e combacia parola per parola: non c'è nessun
  // omonimo da distinguere, e la scheda non vale una richiesta in più.
  const senzaOmonimi = candidate.length === 1 && candidate[0].punteggio === 100;

  if (!autore || senzaOmonimi) return candidate[0];

  for (const c of candidate) {
    const firme = await autoriDi(c.id, { fetchImpl }).catch(() => []);

    if (firme.some((f) => stessoNome(f, autore))) return { ...c, autori: firme };
  }

  return null;
}

/**
 * I titoli che i lettori accostano a questa scheda, dal più segnalato
 * in giù.
 *
 * Il pannello dei consigli sta dentro `id="consigli"` e finisce dove
 * comincia la scheda successiva: si taglia lì, perché la stessa pagina
 * contiene anche "Ultima uscita" e le news, piene di altri link a
 * /manga/ che non c'entrano niente.
 */
async function consigli(animeClickId, { quanti = 12, fetchImpl = fetch } = {}) {
  const risposta = await prendi(`${BASE}/manga/${animeClickId}/-/consigli`, {}, fetchImpl);
  const html = await risposta.text();

  const inizio = html.indexOf('id="consigli"');

  if (inizio < 0) return [];

  let pannello = html.slice(inizio);
  const fine = pannello.indexOf('role="tabpanel"');

  if (fine > 0) pannello = pannello.slice(0, fine);

  const trovati = [];

  for (const blocco of pannello.split("media media-opera").slice(1)) {
    const link = blocco.match(/href="\/manga\/(\d+)\/([a-z0-9-]*)"/i);
    const titolo = blocco.match(/media-heading[^>]*>([\s\S]*?)<\/h5>/i);

    if (!link || !titolo) continue;

    const nome = testoDi(titolo[1]);

    if (!nome) continue;

    const copertina = blocco.match(/src="([^"]+)"/);
    const quanteVolte = blocco.match(/n-suggerimenti[^>]*>\s*(\d+)/);

    trovati.push({
      id: Number(link[1]),
      titolo: nome,
      url: `${BASE}/manga/${link[1]}/${link[2] || "-"}`,
      // Le miniature sono indirizzi relativi al sito, e il ponte delle
      // copertine sa scaricare solo indirizzi interi.
      copertina: copertina ? new URL(copertina[1], BASE).href : null,
      segnalazioni: quanteVolte ? Number(quanteVolte[1]) : 0
    });
  }

  return trovati.slice(0, quanti);
}

module.exports = {
  volumiUsciti,
  urlEdizioni,
  USER_AGENT,
  cerca,
  autoriDi,
  trovaOpera,
  consigli
};
