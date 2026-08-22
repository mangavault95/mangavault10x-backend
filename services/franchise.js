// Tutto quello che riguarda una serie, prima di metterlo in videoteca.
//
// È la risposta a una fatica precisa: per avere Mushoku Tensei in
// videoteca bisognava cercare «Mushoku Tensei», poi «Mushoku Tensei
// II», poi «Mushoku Tensei III», e aggiungerle una per una sperando
// che si accorpassero. Da qui in poi si cerca il nome della serie, e
// questo file va a vedere da solo quante parti ha.
//
// COSA FA E COSA NON FA
//
// Non aggiunge niente: legge AnimeClick e prepara una PROPOSTA — le
// parti che compongono la serie, ognuna col suo ruolo (stagione, film,
// OAV, materiale in più) e con scritto se conviene prenderla. Chi
// aggiunge davvero è `services/videoteca.js`.
//
// Perché una proposta e non un aggancio cieco: la pagina delle
// relazioni di AnimeClick è un sacco, non un elenco di stagioni. Sotto
// Demon Slayer, il 22/08/2026, ci sono le quattro stagioni vere, due
// film veri, tre film che sono riassunti della prima stagione e una
// serie di corti comici. Prenderli tutti vorrebbe dire una scheda che
// promette una serie e ne mostra un'altra; prenderne solo quelli con
// la parola giusta vorrebbe dire perdere metà delle stagioni, perché
// AnimeClick quella parola la scrive quando gli va (Mushoku Tensei III
// e Chainsaw Man: Assassins Arc non ce l'hanno).
//
// Quindi si decide con tre indizi insieme:
//   1. la parola di relazione, quando c'è   («Sequel», «Opera derivata»)
//   2. la radice del titolo                 (Demon Slayer ⊂ Demon Slayer: …)
//   3. il tipo dell'opera                   (Serie TV, Film, Web-Corto)
//
// e quello che resta in dubbio si mostra lo stesso, spento, con
// scritto perché. Una cosa che si vede e si accende con un tocco è
// meglio di una cosa presa di nascosto e di una cosa nascosta.

const ac = require("./providers/animeclickAnime");

// --------------------------------------------------
// Il ruolo di un'opera legata
// --------------------------------------------------

/**
 * Che parte è questa, dentro la serie.
 *
 *   stagione   una stagione della serie          → si prende
 *   film       un film che continua la storia    → si prende
 *   oav        gli OAV                           → si prende
 *   extra      corti, special, riassunti         → si mostra, spento
 *   fuori      un'altra opera dello stesso mondo → si mostra, spento
 */
function ruoloDa(tipo, corto) {
  if (corto) return "extra";

  switch (tipo) {
    case "film":
      return "film";
    case "ova":
      return "oav";
    case "special":
      return "extra";
    default:
      return "stagione";
  }
}

/**
 * Il verdetto su un'opera legata: che parte è, se conviene prenderla,
 * e in una frase perché.
 *
 * Il `motivo` non è decorazione: è quello che permette a chi guarda di
 * capire in un secondo se il sito ha sbagliato. «AnimeClick dice che è
 * il seguito» e «Non c'è scritto come è legata» portano allo stesso
 * riquadro ma a due gesti diversi.
 */
function giudica(opera, titoliDellaSerie) {
  const legame = opera.legame || null;

  if (ac.eAltraOpera(legame)) {
    return {
      ruolo: "fuori",
      consigliato: false,
      motivo: `AnimeClick la chiama «${legame}»: stesso mondo, altra opera.`
    };
  }

  const dichiarata = ac.eStessaSerie(legame);
  const imparentata = ac.parentela(titoliDellaSerie, opera.titolo);

  if (!dichiarata && !imparentata) {
    return {
      ruolo: "fuori",
      consigliato: false,
      motivo: "Titolo diverso e nessun legame dichiarato."
    };
  }

  const ruolo = ruoloDa(opera.tipo, opera.corto);

  if (ruolo === "extra") {
    return {
      ruolo,
      consigliato: false,
      // I corti e gli special stanno nel franchise ma non nel racconto:
      // la serie di corti di Frieren è la stessa serie per AnimeClick e
      // non lo è per nessuno che la guardi.
      motivo: opera.corto
        ? "Corti: fanno parte della serie, ma non sono una stagione."
        : "Special: si aggiunge solo se lo si vuole spuntare."
    };
  }

  if (dichiarata) {
    return {
      ruolo,
      consigliato: true,
      motivo: `AnimeClick la dichiara «${legame}».`
    };
  }

  // Legame in bianco. Una serie TV che porta lo stesso nome è una
  // stagione nove volte su dieci — è così che si presentano Mushoku
  // Tensei III, Chainsaw Man: Assassins Arc e le stagioni 2, 3 e 4 di
  // Demon Slayer. Un film senza nessuna parola di relazione no: può
  // essere il seguito come può essere il riassunto della prima
  // stagione, e i riassunti di Demon Slayer sono esattamente così.
  if (ruolo === "stagione") {
    return {
      ruolo,
      consigliato: true,
      // Le due parentele si dicono diverse perché sono diverse da
      // controllare a occhio. «Stesso nome» si verifica leggendo il
      // titolo; «nome di famiglia» vuol dire che i due titoli hanno in
      // comune solo un pezzo in mezzo — Bakemonogatari e
      // Owarimonogatari — ed è lì che vale la pena dare un'occhiata.
      motivo:
        imparentata === "nome"
          ? "Porta il nome di famiglia della serie: AnimeClick non scrive il legame."
          : "Stessa serie, stesso nome: AnimeClick non scrive il legame."
    };
  }

  return {
    ruolo,
    consigliato: false,
    motivo: "Non c'è scritto come è legata: potrebbe essere un riassunto."
  };
}

// --------------------------------------------------
// L'esplorazione
// --------------------------------------------------

/**
 * Quante pagine di relazioni si è disposti ad aprire oltre la prima.
 *
 * Una basta quasi sempre: verificato il 22/08/2026 che partendo da una
 * stagione qualunque di Mushoku Tensei, Chainsaw Man o Demon Slayer si
 * vede tutta la famiglia. Le altre due servono alle catene lunghe, dove
 * ogni scheda elenca solo le vicine: si aprono quella più vecchia e
 * quella più nuova, perché è agli estremi che una catena continua.
 */
const ALTRE_PAGINE = 2;

/** Le opere legate a una scheda, o niente se la pagina non risponde. */
async function legateA(animeclickId, fetchImpl) {
  try {
    return await ac.relazioni(animeclickId, { fetchImpl });
  } catch {
    // Una linguetta muta non deve poter far fallire un'aggiunta: quel
    // che si è già trovato vale, il resto si fa a mano dalla Gestione.
    return [];
  }
}

/**
 * Tutte le parti della serie a cui appartiene questa scheda.
 *
 * Restituisce `{ capo, parti }`: `capo` è la scheda da cui si è
 * partiti (quella scelta nella ricerca), `parti` sono tutte le opere
 * legate, capo compreso, in ordine di anno.
 *
 * Non aggiunge niente e non tocca il database: è una lettura.
 */
async function esplora(animeclickId, { fetchImpl = fetch } = {}) {
  const scheda = await ac.scheda(animeclickId, { fetchImpl });

  // I tre titoli della scheda madre sono il metro con cui si misura la
  // parentela di tutte le altre. Servono tutti e tre perché AnimeClick
  // cambia lingua fra una stagione e l'altra: la prima si chiama «Demon
  // Slayer», le sue parti «Kimetsu no Yaiba: …».
  const titoli = [scheda.titolo, scheda.titolo_originale, scheda.titolo_inglese];

  const trovate = new Map();

  for (const opera of await legateA(animeclickId, fetchImpl)) {
    if (opera.id !== Number(animeclickId)) trovate.set(opera.id, opera);
  }

  // Il secondo giro, agli estremi della catena. Si guardano solo le
  // opere che il primo giro ha già riconosciuto come parte della serie:
  // aprire le relazioni di uno spin-off vorrebbe dire tirarsi dentro il
  // franchise di quello.
  const famiglia = [...trovate.values()]
    .filter((o) => giudica(o, titoli).ruolo !== "fuori")
    .sort((a, b) => (a.anno || 0) - (b.anno || 0));

  const estremi = [...new Set([famiglia[0], famiglia[famiglia.length - 1]].filter(Boolean))].slice(
    0,
    ALTRE_PAGINE
  );

  for (const parente of estremi) {
    for (const opera of await legateA(parente.id, fetchImpl)) {
      if (opera.id !== Number(animeclickId) && !trovate.has(opera.id)) {
        trovate.set(opera.id, opera);
      }
    }
  }

  const parti = [
    {
      animeclick_id: Number(animeclickId),
      titolo: scheda.titolo,
      anno: scheda.anno_inizio,
      tipo: scheda.tipo,
      legame: null,
      copertina: scheda.cover_url,
      capo: true,
      ruolo: ruoloDa(scheda.tipo, false),
      consigliato: true,
      motivo: "È la scheda che hai cercato."
    },
    ...[...trovate.values()].map((opera) => ({
      animeclick_id: opera.id,
      titolo: opera.titolo,
      anno: opera.anno,
      tipo: opera.tipo || "serie_tv",
      legame: opera.legame,
      copertina: opera.copertina,
      capo: false,
      ...giudica(opera, titoli)
    }))
  ];

  // In ordine di uscita, che è l'ordine in cui si guardano. Le opere
  // senza anno in fondo: sono quelle annunciate e non ancora uscite —
  // «Chainsaw Man: Assassins Arc» non ne ha uno — e sono le ultime
  // proprio per quello.
  parti.sort((a, b) => (a.anno || 9999) - (b.anno || 9999) || a.animeclick_id - b.animeclick_id);

  return {
    capo: {
      animeclick_id: Number(animeclickId),
      titolo: scheda.titolo,
      titolo_originale: scheda.titolo_originale,
      cover_url: scheda.cover_url,
      trama: scheda.trama,
      generi: scheda.generi,
      // Il nome della serie intera, non della stagione da cui si è
      // partiti: è quello che finirà scritto sotto la copertina in
      // videoteca, e «Mushoku Tensei II» sarebbe sbagliato per due
      // stagioni su tre.
      nome: nomeDellaSerie(parti)
    },
    parti
  };
}

/**
 * Come si chiama la serie, viste tutte le sue parti.
 *
 * Il titolo della parte più vecchia, tolto il numero di stagione:
 * quello è il nome che una persona userebbe parlando della serie
 * intera. Si guarda solo fra le parti consigliate — un riassunto o uno
 * spin-off possono essere usciti prima e non danno il nome a niente.
 */
function nomeDellaSerie(parti) {
  const buone = parti.filter((p) => p.consigliato);
  const prima = buone[0] || parti[0];

  if (!prima) return null;

  // Non si può usare `radiceTitolo`: quella restituisce lettere
  // minuscole senza accenti né segni, che va bene per confrontare due
  // titoli e non per scriverne uno sotto una copertina. Qui si taglia
  // il titolo VERO allo stesso punto — il primo separatore forte —
  // lasciandolo come AnimeClick lo scrive.
  const nome = String(prima.titolo).split(/\s*[:–—]\s+|\s+[-–—]\s+/)[0].trim();

  // Se il taglio lascia un moncone, il titolo intero è meglio di
  // niente: una serie che si chiama «K» esiste, un nome lungo due
  // lettere ricavato per sbaglio no.
  return nome.length >= 3 ? nome : String(prima.titolo).trim();
}

// --------------------------------------------------
// La memoria breve
// --------------------------------------------------

/**
 * Le esplorazioni fatte da poco.
 *
 * Un'esplorazione costa da due a quattro pagine di AnimeClick, e
 * capita di rifarla subito: si apre la proposta, si torna indietro, si
 * riapre. Dieci minuti bastano a coprire quel giro senza tenersi in
 * casa notizie vecchie di un giorno.
 */
const ricordate = new Map();
const DURATA = 10 * 60 * 1000;
const QUANTE = 60;

async function esploraConMemoria(animeclickId, opzioni = {}) {
  const chiave = Number(animeclickId);
  const ricordata = ricordate.get(chiave);

  if (ricordata && Date.now() - ricordata.quando < DURATA) return ricordata.esito;

  const esito = await esplora(chiave, opzioni);

  // Prima si toglie e poi si rimette: una Map ricorda l'ordine di
  // inserimento, e senza il `delete` una chiave riscritta resterebbe
  // vecchia quanto la prima volta che ci è entrata.
  ricordate.delete(chiave);
  ricordate.set(chiave, { esito, quando: Date.now() });

  while (ricordate.size > QUANTE) ricordate.delete(ricordate.keys().next().value);

  return esito;
}

module.exports = {
  esplora: esploraConMemoria,
  // Senza memoria e senza rete, per le prove: sono le regole di lettura
  // di una pagina altrui, ed è lì che si sbaglia.
  senzaMemoria: esplora,
  giudica,
  ruoloDa,
  nomeDellaSerie
};
