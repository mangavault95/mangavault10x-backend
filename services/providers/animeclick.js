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
  // Un tentativo in più, una volta sola: AnimeClick ogni tanto risponde
  // 520 o 502 per qualche secondo, e su un giro lungo quel singolo
  // inciampo diventava "serie non trovata" — una bugia, scritta in
  // tabella come se fosse un fatto.
  for (let tentativo = 0; ; tentativo++) {
    const risposta = await fetchImpl(url, {
      redirect: "follow",
      ...opzioni,
      headers: { ...INTESTAZIONI, ...(opzioni.headers || {}) },
      signal: AbortSignal.timeout(20000)
    });

    if (risposta.ok) return risposta;

    if (risposta.status < 500 || tentativo >= 1) {
      throw new Error(`AnimeClick HTTP ${risposta.status} su ${url}`);
    }

    await new Promise((r) => setTimeout(r, 3000));
  }
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
// Il token CSRF e il cookie di sessione valgono per più ricerche:
// tenerli da parte dimezza le richieste al sito, perché una ricerca
// torna a costarne una invece di due. Dieci minuti è prudente — la
// sessione dura molto di più, e se scade la POST fallisce e il giro
// dopo se ne prende una nuova.
// Una sessione per tipo di ricerca: i due moduli stanno a due
// indirizzi diversi (`/ricerca/manga` e `/ricerca/anime`) e ognuno
// pubblica il suo token. Che poi il modulo degli anime si chiami
// ancora `search_manga` è una stranezza loro, verificata: i nomi dei
// campi sono identici, cambia solo dove si spedisce.
const sessioni = new Map();
const DURATA_SESSIONE = 10 * 60 * 1000;

async function apriSessione(fetchImpl, tipo = "manga") {
  const sessione = sessioni.get(tipo);

  if (sessione && Date.now() - sessione.quando < DURATA_SESSIONE) return sessione;

  const modulo = await prendi(`${BASE}/ricerca/${tipo}`, {}, fetchImpl);

  const cookie = (modulo.headers.get("set-cookie") || "")
    .split(",")
    .map((c) => c.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");

  const html = await modulo.text();
  const token = html.match(/name="search_manga\[_token\]"[^>]*value="([^"]+)"/);

  if (!token) throw new Error(`AnimeClick: token della ricerca ${tipo} non trovato`);

  const nuova = { cookie, token: token[1], quando: Date.now() };

  sessioni.set(tipo, nuova);

  return nuova;
}

async function cercaGrezzo(campi, { fetchImpl = fetch, tipo = "manga" } = {}) {
  const { cookie, token } = await apriSessione(fetchImpl, tipo);

  // I campi del modulo vanno mandati tutti, anche quelli che nessuno
  // tocca, con il valore che avrebbero a schermo.
  const corpo = new URLSearchParams({
    "search_manga[title]": "",
    "search_manga[titleOption]": "0", // 0 = contiene
    "search_manga[anno]": "-1",
    "search_manga[ordinamento]": "titolo",
    "search_manga[versoOrdinamento]": "1",
    ...campi,
    "search_manga[_token]": token
  });

  const risposta = await prendi(
    `${BASE}/ricerca/${tipo}`,
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

  // Ogni risultato è un blocco "thumbnail": si taglia lì invece di
  // contare l'annidamento dei div, che con una regex non si conta.
  //
  // ⚠️ Si cerca il PEZZO della classe, non la classe intera, ed è la
  // stessa lezione del <dl> della scheda: il 21/08/2026 le classi dei
  // risultati sono passate da `thumbnail` e `caption` ad `ac-thumbnail`
  // e `ac-caption`, e cercandole alla lettera la ricerca rispondeva
  // "nessun risultato" a qualunque cosa — perfino a "Berserk" — mentre
  // AnimeClick stava rispondendo "Ci sono 4 titoli in database".
  // Un guasto silenzioso: nessun errore, solo il vuoto.
  for (const grezzo of String(frammento).split(/<div class="[^"]*thumbnail[^"]*"/i).slice(1)) {
    // Il tooltip che compare passando sopra la copertina è un pezzo di
    // HTML dentro un attributo, con dentro un altro <h5> e un'altra
    // immagine: va tolto prima di leggere, o si finisce per prendere i
    // suoi al posto di quelli veri.
    const blocco = grezzo.replace(/data-bs-content="[\s\S]*?"/i, " ");

    // Lo slug non è fatto solo di lettere e trattini — "kaiju-no.8" ha
    // un punto — e l'espressione più stretta faceva sparire in silenzio
    // proprio la serie madre, lasciando in lista i suoi spin-off.
    const link = blocco.match(new RegExp(`href="/${tipo}/(\\d+)/([^"]*)"`, "i"));
    const didascalia = blocco.match(/<div class="[^"]*caption[^"]*"[\s\S]*?<h5>([\s\S]*?)<\/h5>/i);

    if (!link || !didascalia) continue;

    const nome = testoDi(didascalia[1]);

    if (!nome) continue;

    const copertina = blocco.match(/src="([^"]+)"/);

    // L'anno stava in un `.pull-right` accanto al titolo; da quando i
    // risultati hanno il tooltip, è finito lì dentro accanto
    // all'icona del calendario. Si cercano tutti e due i posti, così
    // il giorno che ne cambia uno l'altro regge.
    const anno =
      blocco.match(/<div class="pull-right">\s*(\d{4})\s*<\/div>/) ||
      grezzo.match(/fa-calendar[^>]*>[\s\S]{0,80}?(\d{4})/i);

    trovate.push({
      id: Number(link[1]),
      titolo: nome,
      anno: anno ? Number(anno[1]) : null,
      // Le miniature sono indirizzi relativi al sito, e il ponte delle
      // copertine sa scaricare solo indirizzi interi.
      copertina: copertina ? new URL(copertina[1], BASE).href : null,
      url: `${BASE}/${tipo}/${link[1]}/${link[2] || "-"}`
    });
  }

  return trovate;
}

/**
 * I titoli che somigliano a quello cercato, dal più probabile in giù.
 *
 * `modo` non è un dettaglio ma la differenza fra trovare la serie e
 * trovare un suo spin-off. La ricerca "contiene" restituisce una pagina
 * sola di risultati in ordine alfabetico, e su un titolo diffuso la
 * serie madre non ci entra: cercando "Demon Slayer" tornano dodici
 * derivati e non l'opera, cercando "Monster" tornano "Gogo Monster" e
 * "Hatsukoi Monster" ma non Monster. Con "esatto" il problema non si
 * pone, ed è per questo che chi identifica una serie prova prima così.
 *
 * Non decide niente: chi chiama sceglie, e su AnimeClick gli omonimi
 * sono la norma.
 */
async function cerca(
  titolo,
  { quanti = 3, modo = "contiene", autore = null, tipo = "manga", fetchImpl = fetch } = {}
) {
  const trovate = await cercaGrezzo(
    {
      "search_manga[title]": titolo,
      "search_manga[titleOption]": modo === "esatto" ? "3" : "0",
      // Il filtro per autore è la scorciatoia più forte che ha questa
      // ricerca: restringe a una manciata di opere e garantisce la firma
      // senza aprire nemmeno una scheda.
      ...(autore ? { "search_manga[staff]": autore } : {})
    },
    { fetchImpl, tipo }
  );

  return trovate
    .map((s) => ({ ...s, punteggio: somiglianza(titolo, s.titolo) }))
    .filter((s) => s.punteggio > 0)
    .sort((a, b) => b.punteggio - a.punteggio)
    .slice(0, quanti);
}

/**
 * Il titolo tagliato al suo nocciolo, per l'ultimo tentativo.
 *
 * In collezione i titoli portano spesso una coda che AnimeClick scrive
 * diversamente o non scrive affatto — "Death Note - Black Edition", "Il
 * mostro - Frankestein e altre storie" — e a volte è la parte lunga a
 * essere scritta in modo diverso ("Dededede Destruction" contro
 * "Dededededestruction"). Tagliando al primo trattino, o alle prime tre
 * parole, resta la parte su cui le due fonti sono d'accordo.
 */
function nocciolo(titolo) {
  const primaParte = String(titolo).split(/\s+[-–:]\s+/)[0].trim();
  const parole = primaParte.split(/\s+/);

  return parole.slice(0, 3).join(" ");
}

/**
 * Il <dl> in cima alla scheda: la tabella "etichetta → valore" da cui
 * si leggono autori, categoria, editore, anno.
 *
 * La classe si cerca per pezzo (`dl-horizontal`) e non per intero:
 * quel <dl> si chiamava `class="dl-horizontal"` e oggi si chiama
 * `class="ac-dl-horizontal"`. Cercarlo alla lettera lo faceva
 * sparire in silenzio — la scheda continuava ad arrivare, la tabella
 * risultava vuota, e "nessun autore" sembrava un fatto invece che un
 * parser rotto.
 *
 * La chiusura si cerca DOPO l'apertura: il primo `</dl>` della pagina
 * può stare prima, e allora la fetta sarebbe vuota comunque.
 */
function tabellaScheda(html) {
  const inizio = String(html).search(/<dl[^>]*dl-horizontal[^>]*>/i);

  if (inizio < 0) return "";

  const fine = html.indexOf("</dl>", inizio);

  return fine < 0 ? html.slice(inizio) : html.slice(inizio, fine);
}

/** Chi ha scritto e disegnato, letto dal <dl> della scheda. */
async function autoriDi(animeClickId, { fetchImpl = fetch } = {}) {
  const risposta = await prendi(`${BASE}/manga/${animeClickId}/-/`, {}, fetchImpl);
  const html = await risposta.text();

  const dl = tabellaScheda(html);
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
 * Tre tentativi, in quest'ordine, e l'ordine è tutto:
 *
 *   1. titolo ESATTO. In collezione i titoli sono già quelli italiani,
 *      quindi di solito basta questo — e soprattutto è l'unico modo di
 *      pescare la serie madre invece dei suoi derivati (vedi `cerca`).
 *   2. titolo che CONTIENE, per le differenze di coda ("Dr.Slump" da
 *      loro è "Dr. Slump e Arale").
 *   3. il NOCCIOLO del titolo, quando nemmeno quello basta.
 *
 * Poi la firma. Gli omonimi sono la trappola vera — "I fiori del male"
 * restituisce tre opere diverse, e quella di Oshimi è la seconda —
 * quindi quando c'è un autore da confrontare si apre la scheda e si
 * guarda chi l'ha scritta, in ordine di somiglianza, fino alla prima
 * che torna. Se nessuna firma corrisponde, meglio niente consigli che i
 * consigli del fumetto sbagliato.
 */
async function trovaOpera({ titolo, autore = null, fetchImpl = fetch }) {
  const ridotto = nocciolo(titolo);

  if (autore) {
    // Tutte le sue opere in una richiesta, e il confronto dei titoli lo
    // facciamo noi. È il contrario di quello che verrebbe naturale —
    // filtrare anche per titolo e lasciar cercare loro — ma il loro
    // confronto è letterale, virgole e spazi compresi: "Bentornato
    // Alice" non trova "Bentornato, Alice", e "Kaiju No. 8" non trova
    // la propria serie madre. La nostra normalizzazione sì.
    const sue = (await cercaGrezzo({ "search_manga[staff]": autore }, { fetchImpl }))
      .map((c) => ({ ...c, punteggio: Math.max(somiglianza(titolo, c.titolo), somiglianza(ridotto, c.titolo)) }))
      .filter((c) => c.punteggio > 0)
      .sort((a, b) => b.punteggio - a.punteggio);

    if (sue.length) {
      // Fra i suoi titoli che si somigliano tutti — "Demon Slayer -
      // Kimetsu no Yaiba", "Campus Kimetsu!", "Another Story" — vince il
      // più vecchio: i derivati vengono sempre dopo l'opera che li ha
      // generati. Il punteggio da solo non basterebbe, perché premia i
      // titoli corti e lo spin-off spesso lo è.
      const vicini = sue.filter((c) => c.punteggio >= sue[0].punteggio - 8);
      const scelta = [...vicini].sort((a, b) => (a.anno ?? 9999) - (b.anno ?? 9999))[0];

      return {
        ...scelta,
        firmaVerificata: true,
        // Quando i candidati vicini erano più d'uno la scelta è stata
        // una regola, non un fatto: chi scrive in tabella deve saperlo.
        ambigua: vicini.length > 1,
        alternative: vicini.filter((c) => c.id !== scelta.id).slice(0, 3)
      };
    }
  }

  // Senza autore, o quando il filtro per autore non ha trovato niente
  // (la loro grafia del nome può essere diversa dalla nostra): si torna
  // alla ricerca per solo titolo, e la firma si verifica scheda per
  // scheda.
  let candidate = await cerca(titolo, { quanti: 3, modo: "esatto", fetchImpl });

  if (!candidate.length) candidate = await cerca(titolo, { quanti: 5, fetchImpl });

  if (!candidate.length) return null;

  // Un solo risultato, e combacia parola per parola: non c'è nessun
  // omonimo da distinguere, e la scheda non vale una richiesta in più.
  const senzaOmonimi = candidate.length === 1 && candidate[0].punteggio === 100;

  if (!autore || senzaOmonimi) {
    return { ...candidate[0], firmaVerificata: false, ambigua: candidate.length > 1 };
  }

  for (const c of candidate) {
    const firme = await autoriDi(c.id, { fetchImpl }).catch(() => []);

    if (firme.some((f) => stessoNome(f, autore))) {
      return { ...c, autori: firme, firmaVerificata: true };
    }
  }

  return null;
}

/**
 * Le opere di una persona, con scritto quali sono uscite in Italia.
 *
 * La ricerca ha un campo `staff` a testo libero e un filtro
 * "Disponibilità" il cui valore `Varia` vuol dire "editi in Italia":
 * insieme rispondono alla domanda che serve, che è "cosa di suo posso
 * comprare" e non "cosa ha disegnato in vita sua". Di Inio Asano il
 * catalogo intero conta quattordici opere, quelle arrivate qui dodici.
 *
 * Si chiedono però tutte e due le liste, non solo la filtrata, perché
 * quel filtro qualche buco ce l'ha: la scheda di Kaiju No. 8 non risulta
 * "disponibile" benché la serie sia in edicola da anni. Chi riceve la
 * risposta può così tenersi le opere che possiede comunque, invece di
 * vedersele sparire per una casella non compilata sul sito altrui.
 */
async function opereDiAutore(nome, { fetchImpl = fetch } = {}) {
  if (!nome) return [];

  const tutte = await cercaGrezzo({ "search_manga[staff]": nome }, { fetchImpl });

  const italiane = await cercaGrezzo(
    { "search_manga[staff]": nome, "search_manga[disponibilita]": "Varia" },
    { fetchImpl }
  );

  const inItalia = new Set(italiane.map((o) => o.id));

  return tutte.map((o) => ({ ...o, editoInItalia: inItalia.has(o.id) }));
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
    // Lo slug non è fatto solo di lettere e trattini — "kaiju-no.8" ha
    // un punto — e l'espressione più stretta faceva sparire in silenzio
    // proprio la serie madre, lasciando in lista i suoi spin-off.
    const link = blocco.match(/href="\/manga\/(\d+)\/([^"]*)"/i);
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


/**
 * Il pubblico a cui la serie è stata scritta: shonen, seinen, shojo...
 *
 * Sulla scheda si chiama "Categoria" ed è una lista di link, non una
 * parola sola: "Seinen", ma anche "Seinen" e "Pubblico Adulto"
 * insieme. La seconda voce non è un pubblico diverso, è un
 * avvertimento sui contenuti — quindi vale solo quando è l'unica cosa
 * scritta.
 *
 * AniList questo dato non ce l'ha in nessuna forma: i suoi `genres`
 * dicono di cosa parla l'opera, mai per chi è stata scritta. È il
 * motivo per cui anche qui la fonte è quella italiana.
 */
const CATEGORIE = [
  [/kodomo/i, "kodomo"],
  [/sh(o|ō|ou)nen/i, "shonen"],
  [/sh(o|ō|ou)(jo|ujo)/i, "shojo"],
  [/seinen/i, "seinen"],
  [/josei/i, "josei"]
];

function categoriaDa(voci) {
  for (const voce of voci) {
    const trovata = CATEGORIE.find(([forma]) => forma.test(voce));

    if (trovata) return trovata[1];
  }

  // Nessun pubblico dichiarato, ma il sito avverte che è roba per
  // grandi: è quanto di più preciso si possa dire di quella scheda.
  if (voci.some((v) => /pubblico\s+adulto/i.test(v))) return "adulto";

  return null;
}

async function categoriaDi(animeClickId, { fetchImpl = fetch } = {}) {
  const risposta = await prendi(`${BASE}/manga/${animeClickId}/-/`, {}, fetchImpl);
  const html = await risposta.text();

  const dl = tabellaScheda(html);

  for (const [, dt, dd] of dl.matchAll(/<dt>([\s\S]*?)<\/dt>\s*<dd>([\s\S]*?)<\/dd>/g)) {
    if (!/^categoria/i.test(testoDi(dt))) continue;

    // Le voci le separano i link: "Seinen" e "Pubblico Adulto" sono
    // due <a> distinti, e sul testo intero sarebbero una frase sola.
    const voci = linkDi(dd);

    return categoriaDa(voci.length ? voci : [testoDi(dd)]);
  }

  return null;
}

module.exports = {
  volumiUsciti,
  urlEdizioni,
  USER_AGENT,
  BASE,
  cerca,
  // Esportati per il provider degli anime (`animeclickAnime.js`): è lo
  // stesso sito con le stesse regole di cortesia, e riscrivergli
  // accanto un secondo modo di leggere l'HTML significherebbe doverli
  // correggere tutti e due il giorno che AnimeClick cambia.
  prendi,
  testoDi,
  tabellaScheda,
  somiglianza,
  autoriDi,
  trovaOpera,
  categoriaDi,
  consigli,
  opereDiAutore
};
