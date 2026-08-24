// «Se ti è piaciuto questo» — i consigli in fondo alla scheda di un anime.
//
// La domanda a cui risponde non è «che altro c'è di questo genere», ed
// è la ragione per cui non si guardano i generi. Due serie possono
// essere tutt'e due «Azione, Soprannaturale» e non avere niente da
// spartire: è il difetto con cui era nata la sezione gemella dei
// fumetti (`frontend/src/dati/simili.js`), che accostava un thriller di
// Urasawa a uno shonen di mazzate. Qui la somiglianza esce da due
// segnali che parlano della STORIA, non dello scaffale:
//
//   1. Le raccomandazioni votate su AniList. Qualcuno ha guardato
//      questa serie e ha scritto «se ti è piaciuta, guarda quest'altra»;
//      altri hanno votato l'accostamento. È un giudizio umano su ritmo
//      e atmosfera, la cosa più vicina a «stesse vibrazioni» che esista
//      in un database.
//   2. I consigli scritti dai lettori italiani su AnimeClick, che
//      ragionano su quello che è uscito qui e coi nomi con cui lo
//      conosciamo qui.
//
// ⚠️ LE DUE FONTI NON PESANO UGUALE, ed è il contrario del lato manga.
// Misurato su Dandadan il 24/08/2026: AniList accosta Mob Psycho 100
// con 539 voti, AnimeClick dà Zom 100 segnalato da DUE persone. Sui
// fumetti è rovesciato — Berserk ha 166 consigli italiani. Quindi qui
// NON si alternano una a una come fa `intreccia()` di là: alternarle
// darebbe a due voti lo stesso posto in fila che a cinquecento. Si
// mettono in un mucchio solo e si ordinano, e l'italiano conta come
// CONFERMA (vedi `ACCORDO` più sotto) invece che come turno.
//
// LA COSA PIÙ UTILE CHE FA, però, non è consigliare: è ricordare.
// Il catalogo di casa ha 249 serie, e su Dandadan DIECI dei quattordici
// consigli di AniList erano già dentro. Una sezione che scrive «ce
// l'hai» dieci volte su quattordici non è una scoperta, è un
// inventario. Perciò i consigli escono divisi in due mucchi:
//
//   · DA SCOPRIRE — quello che in videoteca non c'è. La scoperta vera.
//   · RIPRENDILE  — quello che c'è ma è rimasto a metà o non è mai
//                   partito. «Somiglia a quella che stai guardando e
//                   l'avevi lasciata in pausa alla 7» è il consiglio
//                   migliore che questo sito possa dare, perché è
//                   l'unico che nessun altro sito può dare.
//
// E due cose non si mostrano affatto: quello che hai già finito (si
// conta e si dice in una riga, senza occupare posti) e quello che hai
// mollato. Consigliare a qualcuno una serie che ha droppato è il
// contrario di un consiglio.

const { consigli } = require("./providers/animeclick");
const ac = require("./providers/animeclickAnime");
const anilist = require("./providers/anilistAnime");
const { traduci } = require("./temiItaliani");

/** Quanto vale che TUTT'E DUE le fonti accostino la stessa opera. */
const ACCORDO = 0.35;

/** Quanto vale un tema in comune, e quanti se ne contano al massimo. */
const PESO_TEMA = 0.2;
const TEMI_AL_MASSIMO = 3;

/**
 * Da dove parte un consiglio che viene solo dai lettori italiani.
 *
 * Sopra lo zero, così un'opera che AniList non nomina affatto non
 * finisce sempre in fondo per il solo fatto di venire dalla fonte
 * magra: su Dandadan è la differenza fra vedere Gleipnir e non vederlo
 * mai. Ma BASSO, e la prima prova ha detto quanto: a 0,28 le tre schede
 * dei Cavalieri dello Zodiaco segnalate da UNA persona scavalcavano
 * Tengoku Daimakyo, che su AniList ha settanta voti. Un consiglio
 * italiano isolato è un indizio, non un verdetto.
 */
const BASE_ITALIANA = 0.2;

function normalizza(testo) {
  return String(testo || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * L'indice del catalogo, per riconoscere un consiglio che è già in casa.
 *
 * Tre chiavi, perché le fonti chiamano la stessa opera in tre modi:
 * l'identificativo AnimeClick (esatto, quando il consiglio viene da
 * lì), quello AniList (esatto, per le schede a cui è stato agganciato
 * tagliando le stagioni) e il titolo normalizzato in tutte le lingue
 * che la scheda porta. L'ultima è quella che lavora di più: su Dandadan
 * aggancia dieci consigli su quattordici, e senza il titolo originale
 * ne aggancerebbe la metà — AniList dice «Jujutsu Kaisen», noi «JUJUTSU
 * KAISEN», AnimeClick «I Cavalieri dello Zodiaco» dove AniList dice
 * «Saint Seiya».
 */
function indiceCatalogo(catalogo) {
  const perAnimeClick = new Map();
  const perAniList = new Map();
  const perTitolo = new Map();

  for (const riga of catalogo || []) {
    if (riga.animeclick_id) perAnimeClick.set(Number(riga.animeclick_id), riga);
    if (riga.anilist_id) perAniList.set(Number(riga.anilist_id), riga);

    for (const t of [riga.titolo, riga.titolo_originale, riga.titolo_inglese]) {
      const chiave = normalizza(t);

      // Chi arriva primo vince: le stagioni successive di una serie
      // condividono spesso il titolo originale, e la prima è quella a
      // cui ha senso mandare chi clicca.
      if (chiave && !perTitolo.has(chiave)) perTitolo.set(chiave, riga);
    }
  }

  return (candidato) =>
    (candidato.animeclickId && perAnimeClick.get(candidato.animeclickId)) ||
    (candidato.anilistId && perAniList.get(candidato.anilistId)) ||
    [candidato.titolo, candidato.titoli?.romaji, candidato.titoli?.inglese, candidato.titoli?.nativo]
      .map(normalizza)
      .filter(Boolean)
      .map((k) => perTitolo.get(k))
      .find(Boolean) ||
    null;
}

/** I titoli con cui una scheda si presenta, per riconoscere i suoi parenti. */
function titoliDi(anime) {
  return [anime.titolo, anime.titolo_originale, anime.titolo_inglese].filter(Boolean);
}

/**
 * Le due fonti, ridotte alla stessa forma.
 *
 * Non è un dettaglio di comodo: finché restano due forme diverse, ogni
 * regola più in giù va scritta due volte, e prima o poi una delle due
 * copie si dimentica.
 */
function daAniList(opere) {
  return opere.map((o) => ({
    fonte: "anilist",
    anilistId: o.anilistId,
    animeclickId: null,
    // L'inglese prima del romaji perché è quello che si riconosce:
    // «Attack on Titan» dice più di «Shingeki no Kyojin» a chi non
    // mastica il giapponese. Se la serie è in catalogo questo titolo
    // viene comunque sostituito da quello italiano.
    titolo: o.titoli.inglese || o.titoli.romaji,
    titoli: o.titoli,
    copertina: o.copertina,
    anno: o.anno,
    episodi: o.episodi,
    formato: o.formato,
    votoFonte: o.voto,
    temi: o.temi,
    voti: o.voti,
    segnalazioni: 0,
    collegamento: `https://anilist.co/anime/${o.anilistId}`
  }));
}

function daAnimeClick(opere) {
  return opere.map((o) => ({
    fonte: "animeclick",
    anilistId: null,
    animeclickId: o.id,
    titolo: o.titolo,
    titoli: { romaji: null, inglese: null, nativo: null },
    // Le miniature dei consigli sono da 64 pixel: in una griglia di
    // copertine si vedrebbe la differenza. Togliere «-thumb» dà lo
    // stesso file a dimensione piena — provato il 24/08/2026, Zom 100
    // passa da 50 kB a 133 kB — e l'estensione resta quella giusta
    // perché la si eredita dal nome della miniatura invece di
    // indovinarla.
    copertina: o.copertina ? o.copertina.replace(/-thumb(\.[a-z0-9]+)$/i, "$1") : null,
    anno: null,
    episodi: null,
    formato: null,
    votoFonte: null,
    temi: [],
    voti: 0,
    segnalazioni: o.segnalazioni || 0,
    collegamento: o.url
  }));
}

/**
 * Un mucchio solo, senza doppioni.
 *
 * Due candidati sono la stessa opera quando finiscono sulla stessa
 * scheda del catalogo — ed è lì che l'incontro fra le fonti diventa
 * possibile, perché il catalogo tiene insieme «Saint Seiya» e «I
 * Cavalieri dello Zodiaco» che per titolo non si somiglierebbero mai.
 * Fuori dal catalogo resta il confronto per titolo, che è il meglio che
 * si possa fare al buio.
 *
 * Quando si incontrano si fondono invece di scartarsi: il risultato
 * tiene i voti di AniList E le segnalazioni italiane, e `accordo` segna
 * che le due fonti sono d'accordo — che è un segnale più forte di
 * qualunque punteggio preso da solo.
 *
 * ⚠️ UN LIMITE NOTO, scritto perché non venga «scoperto» ogni volta da
 * capo: due fonti possono nominare la stessa opera con nomi che non si
 * somigliano affatto, e se quell'opera NON è in catalogo non c'è modo
 * di accorgersene. Il caso vero è Frieren, dove escono due carte per lo
 * stesso anime — AniList lo chiama «Delicious in Dungeon», AnimeClick
 * «Dungeon Food». Non è risolvibile con le lettere: il pezzo in comune
 * è «dungeon», sette caratteri, sotto la soglia degli otto che tiene
 * fuori «Kimetsu no Yaiba» dalla sua parodia — e abbassarla per
 * guadagnare questo caso ne romperebbe di peggiori. Servirebbe un ponte
 * fra gli identificativi dei due siti, che AnimeClick non pubblica.
 * Costo: una carta doppia ogni tanto, sempre e solo fra opere che non
 * si hanno. Si accetta.
 */
function unisci(gruppi, riconosci) {
  const uniti = [];
  const perChiave = new Map();

  for (const candidato of gruppi.flat()) {
    const inCasa = riconosci(candidato);

    const chiave = inCasa
      ? `casa:${inCasa.id}`
      : candidato.anilistId
        ? `al:${candidato.anilistId}`
        : `t:${normalizza(candidato.titolo)}`;

    const gemello = perChiave.get(chiave) || (!inCasa && perChiave.get(`t:${normalizza(candidato.titolo)}`));

    if (gemello) {
      // «Accordo» vuol dire che due fonti DIVERSE dicono la stessa
      // cosa, ed è per quello che vale un bonus. Due schede di
      // AnimeClick che finiscono sulla stessa serie del catalogo — le
      // stagioni separate, che capita spesso — non sono una conferma:
      // è la stessa voce che parla due volte.
      if (gemello.fonte !== candidato.fonte) gemello.accordo = true;

      gemello.voti = Math.max(gemello.voti, candidato.voti);
      gemello.segnalazioni = Math.max(gemello.segnalazioni, candidato.segnalazioni);
      gemello.anilistId ??= candidato.anilistId;
      gemello.animeclickId ??= candidato.animeclickId;
      gemello.copertina ||= candidato.copertina;
      gemello.anno ??= candidato.anno;
      gemello.episodi ??= candidato.episodi;
      if (!gemello.temi.length) gemello.temi = candidato.temi;
      continue;
    }

    const voce = { ...candidato, accordo: false, inCasa };

    perChiave.set(chiave, voce);
    if (!inCasa) perChiave.set(`t:${normalizza(candidato.titolo)}`, voce);

    uniti.push(voce);
  }

  return uniti;
}

/**
 * L'ordine in cui mostrarli.
 *
 * I voti si normalizzano sul massimo del gruppo e non si usano grezzi:
 * una serie famosa raccoglie centinaia di accostamenti e una di nicchia
 * cinque, ma dentro la stessa lista contano le proporzioni. Ai temi in
 * comune si dà un peso vero perché sono il motivo per cui la sezione
 * esiste — senza, tornerebbe in cima l'opera più popolare fra quelle
 * accostate, che è un'altra classifica e la sanno fare tutti.
 *
 * ⚠️ La proporzione è LOGARITMICA, e non è un vezzo matematico: i voti
 * degli accostamenti hanno una coda lunghissima. Su Dandadan il primo
 * ne ha 539 e il decimo 44, e dividendo per il massimo quel decimo
 * valeva 0,08 — cioè meno di una serie segnalata da una sola persona su
 * AnimeClick, che era esattamente il difetto visto alla prima prova.
 * Col logaritmo 44 voti valgono 0,6 invece di 0,08: la distanza fra
 * «quasi nessuno» e «parecchi» resta, quella fra «parecchi» e
 * «moltissimi» si comprime, che è come la legge una persona.
 */
function ordina(candidati) {
  const massimoVoti = Math.max(1, ...candidati.map((c) => c.voti || 0));
  const massimoSegnalazioni = Math.max(1, ...candidati.map((c) => c.segnalazioni || 0));
  const scala = Math.log(1 + massimoVoti);

  return [...candidati]
    .map((c) => {
      const daVoti = c.voti > 0 ? Math.log(1 + c.voti) / scala : 0;

      const daItalia = c.voti
        ? 0
        : BASE_ITALIANA + ((c.segnalazioni || 0) / massimoSegnalazioni) * 0.25;

      return {
        ...c,
        punteggio:
          daVoti +
          daItalia +
          (c.accordo ? ACCORDO : 0) +
          PESO_TEMA * Math.min(c.temiInComune.length, TEMI_AL_MASSIMO)
      };
    })
    .sort((a, b) => b.punteggio - a.punteggio || (b.votoFonte ?? 0) - (a.votoFonte ?? 0));
}

/**
 * Una saga sola, una carta sola.
 *
 * AnimeClick consiglia le stagioni come schede separate, e senza questo
 * passaggio Dandadan mostrava TRE carte dei Cavalieri dello Zodiaco —
 * Sanctuary, Inferno ed Elisio — che sono tre pezzi della stessa cosa.
 * Tre carte per una saga non sono tre consigli: sono un consiglio che
 * ruba il posto ad altri due.
 *
 * L'ordine conta: si scorre la lista già ordinata e vince chi arriva
 * prima, cioè il pezzo con l'accostamento più forte. E si parte con i
 * titoli di quello che è già stato visto, perché se i Cavalieri li hai
 * finiti nemmeno i loro capitoli vanno riproposti come scoperta.
 */
function unaPerSaga(ordinati, titoliGiaVisti = []) {
  const tenuti = [];
  const nomi = [...titoliGiaVisti];

  for (const c of ordinati) {
    const nome = nomeDi(c);

    if (nomi.some((visto) => ac.parentela([visto], nome))) continue;

    nomi.push(nome);
    tenuti.push(c);
  }

  return tenuti;
}

/**
 * Perché questa carta è qui, in una riga.
 *
 * Ogni fonte sa rispondere a modo suo e nessuna sa rispondere come
 * l'altra: mostrare il motivo che la fonte ha davvero è più onesto che
 * inventarne uno uguale per tutti. I temi in comune, quando ci sono,
 * vengono prima — dicono qualcosa sulla serie, mentre un numero dice
 * solo che tante persone sono d'accordo.
 */
function motivoDi(c, titoloBase) {
  if (c.accordo) return "accostata a questa da tutt'e due le fonti";

  if (c.voti > 0) {
    return c.voti === 1
      ? `una persona l'ha accostata a «${titoloBase}»`
      : `in ${c.voti} l'hanno accostata a «${titoloBase}»`;
  }

  if (c.segnalazioni > 0) {
    return c.segnalazioni === 1
      ? "segnalata da un lettore italiano"
      : `segnalata da ${c.segnalazioni} lettori italiani`;
  }

  return null;
}

/** Come si chiama, in italiano se lo sappiamo. */
function nomeDi(c) {
  return c.inCasa?.titolo || c.titolo;
}

/**
 * I consigli per una scheda.
 *
 * `anime` è la riga aperta, `catalogo` sono le schede su cui
 * riconoscere quello che è già in casa, con dentro lo stato di chi
 * guarda (`stato_visione`, `ultimo_visto`, `episodi_disponibili`).
 *
 * Le due fonti si chiedono INSIEME e con `allSettled`: sono due siti
 * esterni, e uno che non risponde non deve portarsi via anche l'altro.
 * Se cadono tutt'e due esce un risultato vuoto, che chi mostra
 * interpreta facendo sparire la sezione — un consiglio è un di più, e
 * un riquadro d'errore in fondo alla pagina peserebbe più di quanto
 * valga la cosa che non è arrivata.
 */
async function similiDi(anime, { catalogo = [], quanti = 12, fetchImpl = fetch } = {}) {
  const [risAniList, risAnimeClick] = await Promise.allSettled([
    anilist.raccomandazioni(
      { anilistId: anime.anilist_id || null, titoli: [anime.titolo_originale, anime.titolo_inglese, anime.titolo] },
      { fetchImpl }
    ),
    anime.animeclick_id
      ? consigli(anime.animeclick_id, { tipo: "anime", quanti: 16, fetchImpl })
      : Promise.resolve([])
  ]);

  const daAL = risAniList.status === "fulfilled" ? risAniList.value : { temi: [], opere: [] };
  const daAC = risAnimeClick.status === "fulfilled" ? risAnimeClick.value : [];

  const temiBase = daAL.temi || [];
  const nomiTemiBase = new Set(temiBase.map((t) => t.nome));

  const riconosci = indiceCatalogo(catalogo);
  const miei = titoliDi(anime);

  const candidati = unisci([daAniList(daAL.opere || []), daAnimeClick(daAC)], riconosci)
    // Se stessa e i suoi parenti: AnimeClick consiglia volentieri le
    // altre stagioni della serie che stai già guardando (su Dandadan
    // infila quattro schede dei Cavalieri dello Zodiaco), e AniList
    // rimanda ai propri seguiti. Non è un consiglio, è un'eco.
    .filter((c) => {
      if (c.inCasa && Number(c.inCasa.id) === Number(anime.id)) return false;
      if (anime.gruppo_id && c.inCasa?.gruppo_id === anime.gruppo_id) return false;

      return !ac.stessaRadice(miei, nomeDi(c));
    })
    // Quello che hai mollato non si consiglia. È l'unica esclusione
    // basata su un giudizio già dato, e vale più di qualunque punteggio.
    .filter((c) => c.inCasa?.stato_visione !== "droppata")
    .map((c) => ({
      ...c,
      temiInComune: traduci(c.temi.filter((t) => nomiTemiBase.has(t.nome)))
    }));

  const ordinati = ordina(candidati);

  // Le finite si contano e si dicono in una riga: occupano un posto in
  // griglia per dire una cosa che non serve a niente («ce l'hai, e
  // l'hai vista»), mentre il numero da solo racconta quanto il
  // consiglio ha colto nel segno.
  //
  // «Finita» però non è solo quella dichiarata tale. Su dati veri
  // Jujutsu Kaisen risultava `in_visione` con 59 puntate segnate su 59:
  // sarebbe finita in «riprendile» con scritto di riprendere dalla 60,
  // che non esiste. Chi ha spuntato tutto ha finito, comunque lo abbia
  // dichiarato.
  const tutteViste = (c) =>
    c.inCasa?.episodi_disponibili > 0 &&
    Number(c.inCasa.ultimo_visto || 0) >= Number(c.inCasa.episodi_disponibili);

  const finita = (c) => c.inCasa?.stato_visione === "completa" || tutteViste(c);

  const finite = ordinati.filter(finita);

  // Le saghe già viste bloccano i loro stessi capitoli: se i Cavalieri
  // dello Zodiaco li hai finiti, «Hades Chapter - Inferno» non è una
  // scoperta.
  const restanti = unaPerSaga(
    ordinati.filter((c) => !finita(c)),
    finite.map(nomeDi)
  );

  const daScoprire = restanti.filter((c) => !c.inCasa);
  const riprendile = restanti.filter((c) => c.inCasa);

  const carta = (c) => ({
    chiave: c.anilistId ? `al-${c.anilistId}` : `ac-${c.animeclickId}`,
    titolo: nomeDi(c),
    copertina: c.inCasa?.cover_url || c.copertina,
    anno: c.anno,
    episodi: c.episodi,
    voto: c.votoFonte,
    temiInComune: c.temiInComune,
    motivo: motivoDi(c, anime.titolo),
    accordo: c.accordo,
    animeclickId: c.animeclickId,
    anilistId: c.anilistId,
    collegamento: c.collegamento,
    // Quando è in casa si manda alla scheda interna e si dice a che
    // punto era rimasta: è tutto quello che serve per riprenderla.
    inVideoteca: c.inCasa
      ? {
          id: Number(c.inCasa.id),
          stato: c.inCasa.stato_visione || null,
          ultimoVisto: c.inCasa.ultimo_visto ?? null,
          episodi: Number(c.inCasa.episodi_disponibili) || null
        }
      : null
  });

  return {
    temi: traduci(temiBase).slice(0, 6),
    daScoprire: daScoprire.slice(0, quanti).map(carta),
    riprendile: riprendile.slice(0, 6).map(carta),
    gia_viste: finite.length,
    fonti: {
      anilist: risAniList.status === "fulfilled" && Boolean(daAL.opere?.length),
      animeclick: risAnimeClick.status === "fulfilled" && Boolean(daAC.length)
    }
  };
}

module.exports = { similiDi, indiceCatalogo, ordina, motivoDi, unisci };
