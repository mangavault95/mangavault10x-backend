// AnimeClick, lato anime — la fonte della Videoteca.
//
// Tre pagine, tre mestieri:
//   /ricerca/anime            trovare la scheda giusta partendo dal titolo
//   /anime/<id>/-/            l'anagrafica: trama, generi, stato, dove si vede
//   /anime/<id>/-/episodi     l'elenco delle puntate, con i titoli italiani
//   /calendario-anime         quando esce il prossimo episodio IN ITALIA
//
// Perché tutto da qui e (quasi) niente da AniList: AnimeClick scrive
// già in italiano ogni cosa che finisce sullo schermo — titolo, trama,
// generi, titoli degli episodi, perfino "15:30 su Crunchyroll". AniList
// direbbe le stesse cose in inglese e con l'orario giapponese. Gli
// resta un mestiere solo, la copertina ad alta risoluzione, che è
// un'immagine e non ha lingua.
//
// La numerazione degli episodi qui è CONTINUA su tutto il franchise
// (L'attacco dei giganti = 89 puntate in un elenco solo, non quattro
// stagioni separate), ed è la ragione per cui la Videoteca tiene una
// riga per scheda: vedi i commenti di sql/013_videoteca.sql.
//
// La cortesia verso il sito è la stessa del provider dei manga, di cui
// questo file riusa la sessione, il fetch con ritentativo e la lettura
// dell'HTML: se un giorno cambiano le regole, cambiano in un posto solo.

const {
  BASE,
  prendi,
  testoDi,
  tabellaScheda,
  cercaGrezzo,
  senzaAccenti
} = require("./animeclick");

// --------------------------------------------------
// Lettura dell'HTML
// --------------------------------------------------

/** I testi dei link dentro un pezzo di HTML: i generi e i distributori sono link. */
function linkTesti(html) {
  return [...String(html || "").matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)]
    .map((m) => testoDi(m[1]))
    .filter(Boolean);
}

/** Il contenuto di un <meta property="og:…">, che è dove stanno titolo e copertina. */
function meta(html, proprieta) {
  const trovato = String(html).match(
    new RegExp(`<meta[^>]*property="og:${proprieta}"[^>]*content="([^"]*)"`, "i")
  );

  return trovato ? testoDi(trovato[1]) : null;
}

/** Le coppie del <dl> della scheda, per etichetta. */
function vociScheda(html) {
  const dl = tabellaScheda(html);
  const voci = {};

  for (const [, dt, dd] of dl.matchAll(/<dt>([\s\S]*?)<\/dt>\s*<dd>([\s\S]*?)<\/dd>/g)) {
    const etichetta = testoDi(dt).replace(/:$/, "");

    if (etichetta) voci[etichetta] = { testo: testoDi(dd), html: dd };
  }

  return voci;
}

/**
 * L'etichetta cercata anche quando AnimeClick la scrive con un accento
 * che l'HTML rende in modo diverso ("Nazionalità" arriva come
 * "Nazionalit "). Si cerca per inizio, che è la parte che non cambia.
 */
function voce(voci, inizio) {
  const chiave = Object.keys(voci).find((k) =>
    k.toLowerCase().startsWith(inizio.toLowerCase())
  );

  return chiave ? voci[chiave] : null;
}

// --------------------------------------------------
// Normalizzazioni: da come lo scrive AnimeClick a come lo scriviamo noi
// --------------------------------------------------

const TIPI = [
  [/serie\s*tv/i, "serie_tv"],
  [/film|movie/i, "film"],
  [/oav|ova/i, "ova"],
  [/ona|web/i, "ona"],
  [/special|corto|speciale/i, "special"]
];

function tipoDa(categoria) {
  const trovato = TIPI.find(([forma]) => forma.test(categoria || ""));

  return trovato ? trovato[1] : "serie_tv";
}

/**
 * Lo stato della serie in patria.
 *
 * "completato" e non "concluso": è il modo in cui AnimeClick dice che
 * un'opera è finita, ed è già costato una volta (vedi la memoria del
 * bot). "in pausa" è una condizione vera degli anime — fra una
 * stagione e l'altra passano anni — e non va confusa con "interrotta",
 * che vuol dire cancellata.
 */
const STATI = [
  [/completat|conclus|finit/i, "conclusa"],
  [/in\s*pausa|sospes/i, "in_pausa"],
  [/in\s*corso|in\s*produzione/i, "in_corso"],
  [/annunciat|inedit|non\s*ancora/i, "inedita"],
  [/interrott|cancellat/i, "interrotta"]
];

function statoDa(testo) {
  const trovato = STATI.find(([forma]) => forma.test(testo || ""));

  return trovato ? trovato[1] : "in_corso";
}

/**
 * Il primo intero di una stringa come "12+2" o "38".
 *
 * Chainsaw Man dichiara «12+2»: dodici episodi più due special. Il
 * numero che serve alla barra di avanzamento è il primo; il testo
 * intero si conserva a fianco (`episodi_dichiarati`), perché senza di
 * quello il 12 non si sa più da dove venga.
 */
function primoNumero(testo) {
  const trovato = String(testo || "").match(/\d+/);

  return trovato ? Number(trovato[0]) : null;
}

/** "2013 - 2023" → { inizio: 2013, fine: 2023 }; "2022" → { inizio: 2022, fine: null }. */
function anniDa(testo) {
  const anni = [...String(testo || "").matchAll(/\d{4}/g)].map((m) => Number(m[0]));

  return { inizio: anni[0] ?? null, fine: anni.length > 1 ? anni[anni.length - 1] : null };
}

/**
 * I distributori, ripuliti dal negozio.
 *
 * La voce "Disponibilità" scrive "Crunchyroll ( compralo su Amazon.it )":
 * il link ad Amazon è pubblicità del sito, non un posto dove si guarda
 * la serie, e finirebbe fra le piattaforme come se lo fosse.
 */
const NON_PIATTAFORME = /amazon|compralo|acquista|ebay/i;

function piattaformeDa(html) {
  return [...new Set(linkTesti(html).filter((t) => !NON_PIATTAFORME.test(t)))];
}

// --------------------------------------------------
// 1. LA RICERCA
// --------------------------------------------------

/**
 * Quanto un risultato risponde a quello che si è scritto.
 *
 * Ha un punteggio suo invece di riusare quello dei manga per una
 * ragione verificata dal vivo: quello dei manga vale zero appena il
 * titolo non contiene alla lettera ciò che si è cercato, e chi chiama
 * scarta gli zero. Ma la ricerca di AnimeClick guarda TUTTI i titoli di
 * una scheda — italiano, originale, inglese — mentre in lista ne
 * pubblica uno solo. Il 22/08/2026: «shingeki no kyojin» riporta 12
 * schede fra cui «L'attacco dei giganti», e il filtro dei manga ne
 * lasciava passare 2; «sousou no frieren» riporta Frieren, e ne
 * lasciava passare zero. La ricerca sembrava rotta e invece stava
 * funzionando: era il punteggio a cestinare le risposte giuste.
 *
 * Quindi qui non si scarta niente. Si mette in ordine, e chi non
 * somiglia a niente resta in fondo — perché se AnimeClick l'ha
 * restituito, un motivo che noi non vediamo ce l'ha.
 *
 * La lunghezza pesa poco ma pesa: fra «Chainsaw Man» e «Chainsaw Man -
 * Il Film: La storia di Reze», chi ha scritto "chainsaw man" cercava il
 * primo.
 */
function punteggioAnime(cercato, trovato) {
  const a = senzaAccenti(cercato);
  const b = senzaAccenti(trovato);

  if (!a || !b) return 0;

  const penalita = Math.min(20, Math.max(0, b.length - a.length) * 0.2);

  if (a === b) return 100;
  if (b.startsWith(a)) return 85 - penalita;
  if (b.includes(a)) return 70 - penalita;

  // Le parole tutte presenti ma in un altro ordine, o con qualcosa in
  // mezzo: «attacco giganti» contro «L'attacco dei giganti». È il modo
  // in cui si scrive quando si cerca in fretta, ed è esattamente quello
  // che una ricerca che si aggiorna mentre scrivi riceve di continuo.
  const parole = a.split(" ").filter(Boolean);
  const presenti = parole.filter((p) => b.includes(p)).length;

  if (presenti === parole.length) return 55 - penalita;
  if (presenti > 0) return 15 + (25 * presenti) / parole.length;

  // Nessuna parola in comune con il titolo che si vede, eppure
  // AnimeClick l'ha trovata: l'ha riconosciuta da un titolo che in
  // lista non compare. Vale poco, ma non vale zero.
  return 5;
}

/**
 * I titoli che rispondono a quello cercato, dal più probabile in giù.
 *
 * ⚠️ Non sceglie: chi chiama deve far confermare. La ricerca di
 * AnimeClick ordina per titolo e non per pertinenza, e "one piece"
 * restituisce come primo risultato "Dream 9: Toriko & One Piece &
 * Dragon Ball Z" — agganciare il primo della lista riempirebbe la
 * videoteca di schede sbagliate.
 *
 * Funziona in italiano, in originale e in inglese: la ricerca del sito
 * guarda tutti e tre, e questo è il motivo per cui il punteggio qui
 * ordina invece di scartare.
 */
async function cercaAnime(titolo, { quanti = 5, modo = "contiene", fetchImpl = fetch } = {}) {
  const trovate = await cercaGrezzo(
    {
      "search_manga[title]": titolo,
      "search_manga[titleOption]": modo === "esatto" ? "3" : "0"
    },
    { fetchImpl, tipo: "anime" }
  );

  return trovate
    .map((s) => ({ ...s, punteggio: punteggioAnime(titolo, s.titolo) }))
    .sort((a, b) => b.punteggio - a.punteggio)
    .slice(0, quanti);
}

// --------------------------------------------------
// 1-bis. LA RADICE DI UN TITOLO — cosa fa di due schede la stessa serie
// --------------------------------------------------

/**
 * Il titolo ridotto al nome della serie, senza il pezzo che distingue
 * una stagione dall'altra.
 *
 *   «Mushoku Tensei: Jobless Reincarnation III»          → mushoku tensei
 *   «Chainsaw Man - Il Film: La storia di Reze»          → chainsaw man
 *   «Demon Slayer: Kimetsu no Yaiba - Il Castello…»      → demon slayer
 *
 * Serve a due cose che sembrano diverse e sono la stessa: mettere in
 * una riga sola i risultati della ricerca che sono la stessa serie, e
 * riconoscere una stagione quando AnimeClick si dimentica di scrivere
 * che lo è (succede spesso — vedi `eStessaSerie`).
 *
 * Si taglia al primo separatore forte e si toglie il numero in coda.
 * Se resta un moncone si tiene il titolo intero: «Steins;Gate 0» non è
 * «Steins;Gate», ma una radice lunga due lettere non è niente.
 */
function radiceTitolo(titolo) {
  const primaParte = String(titolo || "").split(/\s*[:–—]\s+|\s+[-–—]\s+/)[0];

  const senzaNumero = primaParte
    .replace(/[\s:.–-]+(?:stagione\s*|season\s*|parte\s*|part\s*)?(?:\d+|i{1,3}|iv|vi{0,3}|ix|xi{0,3})$/i, "")
    .trim();

  const radice = senzaAccenti(senzaNumero.length >= 3 ? senzaNumero : primaParte);

  return radice.length >= 3 ? radice : senzaAccenti(titolo);
}

/**
 * Due titoli parlano della stessa serie?
 *
 * Vero quando la radice di uno è l'inizio dell'altra: «Demon Slayer»
 * contro «Demon Slayer: Kimetsu no Yaiba - Il Quartiere dei Piaceri».
 * Si confrontano tutti i titoli che una scheda ha — italiano, originale
 * e inglese — perché AnimeClick mescola le lingue fra una stagione e
 * l'altra: la prima di Demon Slayer si chiama così, le sue parti si
 * chiamano «Kimetsu no Yaiba: …».
 *
 * ⚠️ È un indizio, non una prova, e da solo non basta ad accorpare:
 * chi lo usa lo incrocia con quello che AnimeClick dice del legame e
 * con il tipo dell'opera. Vedi `services/franchise.js`.
 */
function stessaRadice(titoli, altro) {
  const b = radiceTitolo(altro);

  return titoli.filter(Boolean).some((t) => {
    const a = radiceTitolo(t);

    return a.startsWith(b) || b.startsWith(a);
  });
}

// --------------------------------------------------
// 2. LA SCHEDA
// --------------------------------------------------

/** L'indirizzo di una scheda: come per i manga, solo l'id conta, lo slug è decorativo. */
function urlScheda(animeClickId) {
  return `${BASE}/anime/${animeClickId}/-/`;
}

/**
 * L'anagrafica della serie, già nella forma della tabella `anime`.
 *
 * `stato_italia` si conserva com'è scritto ("Doppiaggio in pausa,
 * Sottotitoli completato") invece di ridurlo a una parola: doppiaggio
 * e sottotitoli viaggiano separati, e quella frase è già la risposta
 * alla domanda che uno si fa davvero — posso guardarlo in italiano?
 */
async function scheda(animeClickId, { fetchImpl = fetch } = {}) {
  const risposta = await prendi(urlScheda(animeClickId), {}, fetchImpl);
  const html = await risposta.text();

  const voci = vociScheda(html);

  if (Object.keys(voci).length === 0) {
    // La stessa trappola già pagata sui manga: la pagina arriva, il
    // taglio è lungo zero e la serie nascerebbe senza niente dentro,
    // come se AnimeClick non sapesse nulla. Meglio un errore.
    throw new Error(`AnimeClick: scheda anime ${animeClickId} letta ma vuota`);
  }

  const anni = anniDa(voce(voci, "Anno")?.testo);
  const disponibilita = voce(voci, "Disponibilit");
  const distributori = voce(voci, "Distributori");

  const trama = html.match(/<div id="trama-div"[^>]*>([\s\S]*?)<\/div>/i);

  return {
    animeclick_id: Number(animeClickId),

    titolo: meta(html, "title"),
    titolo_originale: voce(voci, "Titolo originale")?.testo || null,
    titolo_inglese: voce(voci, "Titolo inglese")?.testo || null,

    tipo: tipoDa(voce(voci, "Categoria")?.testo),

    anno_inizio: anni.inizio,
    anno_fine: anni.fine,
    stagioni: voce(voci, "Stagioni")?.testo || null,

    episodi_totali: primoNumero(voce(voci, "Episodi")?.testo),
    episodi_dichiarati: voce(voci, "Episodi")?.testo || null,

    stato: statoDa(voce(voci, "Stato in patria")?.testo),
    stato_italia: voce(voci, "Stato in Italia")?.testo || null,

    generi: linkTesti(voce(voci, "Genere")?.html),

    // Le due voci dicono la stessa cosa in due modi: "Distributori"
    // elenca chi la trasmette, "Disponibilità" dove la si guarda oggi.
    // Si prendono tutte e due perché nessuna delle due c'è sempre.
    distributori: [
      ...new Set([
        ...piattaformeDa(distributori?.html),
        ...piattaformeDa(disponibilita?.html)
      ])
    ],

    trama: trama ? testoDi(trama[1]).replace(/^Trama:\s*/i, "") : null,
    cover_url: meta(html, "image"),

    url: urlScheda(animeClickId)
  };
}

// --------------------------------------------------
// 3. GLI EPISODI
// --------------------------------------------------

/**
 * L'elenco delle puntate con i titoli italiani.
 *
 * Le righe stanno in una tabella `id="table-episodi"` già tutta
 * nell'HTML: una GET basta, niente paginazione. Il numero è scritto
 * "Ep.&nbsp;01" e il titolo è il link a /episodio/<id>/.
 *
 * ⚠️ Le serie fiume sono pesanti: la pagina di One Piece sono 2 MB e
 * 1197 righe. Va letta una volta e conservata, mai a ogni apertura
 * della scheda.
 *
 * Gli special senza numero AnimeClick li marca tutti "Ep. 0", e infatti
 * l'unicità in tabella li ammette (indice parziale su numero > 0).
 */
async function episodi(animeClickId, { fetchImpl = fetch } = {}) {
  const risposta = await prendi(`${BASE}/anime/${animeClickId}/-/episodi`, {}, fetchImpl);
  const html = await risposta.text();

  const inizio = html.indexOf('id="table-episodi"');

  if (inizio < 0) return [];

  const fine = html.indexOf("</table>", inizio);
  const tabella = fine < 0 ? html.slice(inizio) : html.slice(inizio, fine);

  const righe = [];

  for (const riga of tabella.split(/<tr[^>]*>/).slice(1)) {
    const numero = riga.match(/Ep\.(?:&nbsp;?|\s)*(\d+)/i);

    if (!numero) continue;

    const link = riga.match(/<a\b[^>]*href="\/episodio\/(\d+)\/[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    const durata = riga.match(/>\s*(\d+)\s*(?:&#39;|')/);

    righe.push({
      numero: Number(numero[1]),
      titolo: link ? testoDi(link[2]) : null,
      durata: durata ? Number(durata[1]) : null,
      animeclick_id: link ? Number(link[1]) : null
    });
  }

  return righe;
}

// --------------------------------------------------
// 3-bis. LE RELAZIONI — chi è la stagione di chi
// --------------------------------------------------

/**
 * Le altre opere legate a questa, lette da `/anime/<id>/-/relazioni`.
 *
 * È la risposta al disordine che si vede in videoteca: AnimeClick non
 * è coerente con sé stessa. Frieren tiene due stagioni in una scheda
 * sola e numera 1→38; Isekai Farming apre una scheda per stagione
 * (42643 e 67685) e riparte da 1. Senza questa pagina non c'è modo di
 * sapere che quelle due schede sono la stessa serie, e in videoteca
 * finiscono come due copertine diverse.
 *
 * La pagina è una linguetta caricata a parte: risponde con un pezzo di
 * HTML invece che con la scheda intera. Dentro, le opere sono divise
 * per tipo — Animazione, Fumetti, Novel — e ognuna porta scritto CHE
 * COSA è: «Opera precedente», «Opera successiva», «Spin-off». Qui
 * interessa solo l'animazione: il legame col manga in collezione passa
 * da un'altra strada (`anime.manga_id`).
 */
async function relazioni(animeClickId, { fetchImpl = fetch } = {}) {
  const risposta = await prendi(
    `${BASE}/anime/${animeClickId}/-/relazioni`,
    { headers: { "X-Requested-With": "XMLHttpRequest" } },
    fetchImpl
  );

  const html = await risposta.text();
  const opere = [];

  // `media-opera-animazione` marca i riquadri degli anime: fumetti e
  // novel hanno la loro classe, e non vanno raccolti per sbaglio.
  for (const pezzo of html.split(/(?=<div class="d-flex media-opera media-opera-)/).slice(1)) {
    if (!/media-opera-animazione/.test(pezzo)) continue;

    const id = pezzo.match(/href="\/anime\/(\d+)\//i);
    const titolo = pezzo.match(/<span itemprop="name">([\s\S]*?)<\/span>/i);
    const legame = pezzo.match(/opera-tipo-relazione"[^>]*>([\s\S]*?)<\/span>/i);
    const anno = pezzo.match(/Anno:\s*(\d{4})/i);
    const copertina = pezzo.match(/<img[^>]*src="([^"]+)"/i);

    if (!id) continue;

    // Il riquadro dice anche CHE COSA è l'opera — «Serie TV», «Film»,
    // «Serie OAV», «Special», «Web, Corto» — in uno <span> senza classe
    // dentro la descrizione. È la notizia che rende possibile decidere
    // da soli: senza, per sapere se un'opera legata è una stagione o un
    // riassunto bisognerebbe aprirne la scheda, cioè una richiesta per
    // ognuna delle dodici opere che AnimeClick elenca sotto Demon
    // Slayer. Si prende l'ultimo <span> senza classe che non parla di
    // anno: gli altri sono la relazione (che ha la sua classe) e l'anno.
    const descrizione = pezzo.match(/<div class="description">([\s\S]*?)<\/div>/i);

    const tipoTesto = descrizione
      ? [...descrizione[1].matchAll(/<span(?![^>]*class)[^>]*>([\s\S]*?)<\/span>/gi)]
          .map((m) => testoDi(m[1]))
          .filter((t) => t && !/^anno\s*:/i.test(t))
          .pop() || null
      : null;

    opere.push({
      id: Number(id[1]),
      titolo: titolo ? testoDi(titolo[1]) : null,
      // «Opera precedente», «Opera successiva», «Spin-off», «Storia
      // parallela»: si conserva la parola di AnimeClick invece di
      // ridurla a un codice nostro. È già italiano leggibile, e
      // l'elenco delle forme possibili non lo decidiamo noi.
      legame: legame ? testoDi(legame[1]) : null,
      anno: anno ? Number(anno[1]) : null,
      tipo_testo: tipoTesto,
      tipo: tipoTesto ? tipoDa(tipoTesto) : null,
      // Un corto non è mai una stagione, e AnimeClick lo scrive solo
      // qui: «Web, Corto» sono i mini-episodi comici che ogni serie di
      // successo si porta dietro (Frieren ne ha una serie intera). Il
      // tipo normalizzato li chiamerebbe `ona`, cioè una serie vera.
      corto: /corto/i.test(tipoTesto || ""),
      copertina: copertina ? new URL(copertina[1], BASE).href : null
    });
  }

  return opere;
}

/**
 * Le relazioni che fanno di due schede la stessa serie.
 *
 * Le parole non sono simmetriche, ed è la prima trappola: la scheda
 * della seconda stagione dice «Opera precedente», quella della prima
 * dice «Sequel». Vanno riconosciute tutte e due, o il legame si vede
 * da un lato solo.
 *
 * Sequel e prequel sì, pellicole comprese: il film che continua la
 * serie è la stessa serie, e sta nello stesso pannello. Spin-off,
 * storie parallele e riassunti no — sono opere diverse, e infilarle
 * nello stesso gruppo vorrebbe dire una copertina che promette una
 * cosa e una scheda che ne contiene un'altra.
 *
 * ⚠️ Non copre tutto, perché AnimeClick non compila sempre il campo:
 * «Chainsaw Man: Assassins Arc» è elencato senza nessuna parola di
 * relazione, pur essendo la seconda stagione. Per quei casi resta la
 * mano, dalla pagina Gestione della videoteca.
 */
function eStessaSerie(legame) {
  return /^(opera\s+(precedente|successiva)|sequel|prequel)$/i.test(
    String(legame || "").trim()
  );
}

/**
 * Le relazioni che dicono il contrario: è un'altra opera.
 *
 * Non è l'opposto della funzione qui sopra, ed è per questo che sono
 * due. Fra le due c'è il caso che conta di più: il legame VUOTO.
 * AnimeClick lo lascia in bianco molto più spesso di quanto si
 * creda — verificato il 22/08/2026: la terza stagione di Mushoku
 * Tensei, la seconda di Chainsaw Man e le stagioni 2, 3 e 4 di Demon
 * Slayer sono tutte elencate senza una parola di relazione. Dire
 * «vuoto = altra opera» vorrebbe dire non accorpare quasi niente.
 *
 * Queste parole invece sono una notizia vera, e negativa: «Opera
 * derivata» è Attack on Titan: Junior High (i personaggi alle medie),
 * «Remake» sono i film che rimontano la serie. Stanno nel franchise ma
 * non nella serie, e infilarle nella stessa scheda vorrebbe dire una
 * copertina che promette otto stagioni e un elenco che ne contiene
 * quattro più quattro riassunti.
 */
function eAltraOpera(legame) {
  return /^(opera\s+(derivata|originale)|spin[\s-]*off|storia\s+parallela|remake|riassunto|adattamento|altro)$/i.test(
    String(legame || "").trim()
  );
}

// --------------------------------------------------
// 4. IL CALENDARIO — quando esce, in Italia
// --------------------------------------------------

const MESI = [
  "gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno",
  "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"
];

/**
 * L'istante vero di "21 agosto 2026, 15:30 a Roma".
 *
 * Il calendario scrive l'ora italiana senza dire che è italiana, e
 * salvarla come se fosse UTC farebbe uscire gli episodi due ore prima
 * in estate. Si calcola lo scarto del fuso di Roma per quel giorno e
 * lo si toglie. (Al confine dell'ora legale, per un'ora l'anno, lo
 * scarto usato è quello del giorno prima: un episodio non si perde per
 * questo.)
 */
function istanteItaliano(anno, mese, giorno, ore, minuti) {
  const comeSeFosseUtc = Date.UTC(anno, mese - 1, giorno, ore, minuti);

  const parti = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Rome",
    hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit"
  })
    .formatToParts(new Date(comeSeFosseUtc))
    .reduce((acc, p) => ({ ...acc, [p.type]: Number(p.value) }), {});

  const aRoma = Date.UTC(parti.year, parti.month - 1, parti.day, parti.hour % 24, parti.minute);

  return new Date(comeSeFosseUtc - (aRoma - comeSeFosseUtc));
}

/**
 * Le uscite in streaming in Italia, con giorno, ora, piattaforma e
 * titolo italiano della puntata.
 *
 * `quando` è quello che il sito chiama `paging`: senza, la pagina
 * mostra da oggi a fine mese; "next-month" e "today" spostano la
 * finestra.
 *
 * ⚠️ `next-week` risponde **500** sul loro server (verificato il
 * 21/08/2026, sia da browser sia da qui): è rotto dalla loro parte,
 * non c'è niente da riprovare. Per guardare più avanti si usa
 * "next-month".
 *
 * Le card non linkano la scheda della serie ma solo l'episodio: per
 * sapere a quale serie appartiene una riga bisogna aprire la pagina
 * /episodio/<id>/, che rimanda a /anime/<id>/. Non lo si fa qui e non
 * lo si fa per tutte: 130 card vorrebbero dire 130 richieste. Chi
 * chiama abbina prima per titolo le serie che segue, e apre solo
 * quelle poche.
 */
async function calendario({ quando = null, fetchImpl = fetch } = {}) {
  const url = quando ? `${BASE}/calendario-anime?paging=${quando}` : `${BASE}/calendario-anime`;

  const risposta = await prendi(url, {}, fetchImpl);
  const html = await risposta.text();

  // L'anno sta solo nell'intestazione del mese: le righe dicono
  // "21 agosto venerdì" e basta.
  const intestazione = html.match(/<div class="calendario-mese">[\s\S]*?<h2>([\s\S]*?)<\/h2>/i);
  const testoIntestazione = intestazione ? testoDi(intestazione[1]) : "";
  const annoTitolo = Number((testoIntestazione.match(/\d{4}/) || [])[0]) || new Date().getFullYear();
  const meseTitolo = MESI.findIndex((m) => new RegExp(m, "i").test(testoIntestazione)) + 1;

  const uscite = [];
  let giornoCorrente = null;

  // Il documento è una sequenza piatta: un separatore di data, poi le
  // card di quel giorno, poi il separatore successivo. Si scorre in
  // ordine tenendo da parte l'ultima data vista.
  const pezzi = html.split(/<div class="col-12 date-separator">/i);

  for (const pezzo of pezzi.slice(1)) {
    const giorno = testoDi((pezzo.match(/<div class="date">([\s\S]*?)<\/div>/i) || [])[1]);
    const mese = testoDi((pezzo.match(/<div class="month">([\s\S]*?)<\/div>/i) || [])[1]);

    const numeroMese = MESI.findIndex((m) => m === mese.toLowerCase()) + 1;

    if (!giorno || !numeroMese) continue;

    // Dicembre → gennaio: se il mese della riga viene prima di quello
    // scritto in cima, siamo passati all'anno dopo.
    const anno = meseTitolo && numeroMese < meseTitolo ? annoTitolo + 1 : annoTitolo;

    giornoCorrente = { anno, mese: numeroMese, giorno: Number(giorno) };

    for (const card of pezzo.split(/<div class="card panel-evento-calendario/i).slice(1)) {
      const link = card.match(/href="\/episodio\/(\d+)\/[^"]*"/i);
      const quandoDove = testoDi((card.match(/<h4 class="episodio">([\s\S]*?)<\/h4>/i) || [])[1]);
      const serie = testoDi((card.match(/<h5>([\s\S]*?)<\/h5>/i) || [])[1]);
      const puntata = testoDi((card.match(/<h3>([\s\S]*?)<\/h3>/i) || [])[1]);

      const ora = quandoDove.match(/(\d{1,2}):(\d{2})/);
      const piattaforma = quandoDove.replace(/^.*?\bsu\s+/i, "").trim() || null;

      // Il titolo della card comincia sempre con il numero, ma il
      // numero è scritto in tre modi diversi:
      //   "08 Il Signore di Frontiera e la Battaglia…"  → puntata 8
      //   "4x91 Morte e scomparsa"                      → puntata 91
      //   "20"                                          → puntata 20, senza titolo
      // Nella forma stagione×episodio il numero che conta è il secondo:
      // il primo dice a quale stagione appartiene, e noi contiamo di
      // fila su tutta la serie.
      const numerata = puntata.match(/^(?:\d+x)?(\d+)\s*([\s\S]*)$/);

      uscite.push({
        quando: istanteItaliano(
          giornoCorrente.anno,
          giornoCorrente.mese,
          giornoCorrente.giorno,
          ora ? Number(ora[1]) : 0,
          ora ? Number(ora[2]) : 0
        ),
        piattaforma,
        serie: serie || null,
        numero: numerata ? Number(numerata[1]) : null,
        titolo: (numerata ? numerata[2] : puntata).trim() || null,
        episodio_animeclick_id: link ? Number(link[1]) : null
      });
    }
  }

  return uscite;
}

/**
 * A quale serie appartiene un episodio del calendario.
 *
 * Una richiesta a testa: si usa solo sulle card che somigliano a una
 * serie già in videoteca, mai su tutte.
 */
async function serieDellEpisodio(episodioId, { fetchImpl = fetch } = {}) {
  const risposta = await prendi(`${BASE}/episodio/${episodioId}/-/`, {}, fetchImpl);
  const html = await risposta.text();

  const link = html.match(/href="\/anime\/(\d+)\//i);

  return link ? Number(link[1]) : null;
}

module.exports = {
  cercaAnime,
  scheda,
  episodi,
  relazioni,
  eStessaSerie,
  eAltraOpera,
  radiceTitolo,
  stessaRadice,
  punteggioAnime,
  calendario,
  serieDellEpisodio,
  urlScheda,
  // Esportate per le prove: sono le regole di traduzione fra il modo
  // di scrivere di AnimeClick e il nostro, ed è lì che si sbaglia.
  tipoDa,
  statoDa,
  primoNumero,
  anniDa,
  istanteItaliano
};
