// AniList, lato anime — due mestieri, e il secondo è arrivato dopo.
//
//   1. DOVE FINISCE UNA STAGIONE. Il mestiere originale, e per mesi
//      l'unico. Si prendono dei NUMERI, che non hanno lingua.
//   2. CHI ASSOMIGLIA A CHI. Le raccomandazioni votate dagli utenti:
//      «se ti è piaciuto questo, guarda quest'altro».
//
// Il resto della Videoteca sta in italiano e viene da AnimeClick (vedi
// `animeclickAnime.js`): titoli, trame, generi, orari di uscita.
//
// ⚠️ Il secondo mestiere incrina la regola del primo, e va detto invece
// che nascosto: le raccomandazioni arrivano con dei TESTI inglesi
// (titoli e temi). La regola resta salva dove conta davvero — niente di
// tutto questo entra nel database, e a schermo i titoli si mostrano in
// italiano quando la serie è già in catalogo o AnimeClick la conosce,
// mentre i temi passano da un vocabolario scritto a mano
// (`services/temiItaliani.js`) e quelli che non sappiamo tradurre non
// si mostrano affatto. Un consiglio calcolato al volo e buttato dopo
// dieci minuti di cache non è la stessa cosa di una trama scritta in
// tabella per sempre.
//
// Perché per gli anime AniList è la fonte FORTE e non la scorta,
// all'incontrario di tutto il resto della Videoteca — misurato su
// Dandadan il 24/08/2026: AniList accosta Mob Psycho 100 con 539 voti,
// Chainsaw Man con 378, FLCL con 212; AnimeClick, sulla stessa serie,
// dà Zom 100 segnalato da DUE persone e quattro schede dei Cavalieri
// dello Zodiaco. Sui fumetti il rapporto è rovesciato (Berserk ha 166
// consigli italiani), ed è il motivo per cui le due sezioni gemelle
// pesano le fonti in modo diverso.
//
// Il motivo è la discordanza annotata fin dalla 013: AnimeClick conta
// 38 episodi di Frieren, AniList 28. Non sbaglia nessuno dei due —
// AnimeClick tiene una scheda per franchise e numera di seguito,
// AniList apre un media per stagione. Per mesi quella differenza è
// stata un fastidio da evitare; è invece l'unica misura esistente di
// dove finisca la prima stagione. 28 + 10 = 38: la seconda comincia
// dalla puntata 29.
//
// Verificato dal vivo il 21/08/2026 su tre serie:
//   Sousou no Frieren        28 + 10  (+ una terza nel 2027, ancora senza numero)
//   Nige Jouzu no Wakagimi   12 + 12
//   Isekai Nonbiri Nouka     12 + 12  (che su AnimeClick sono due schede)

const ENDPOINT = "https://graphql.anilist.co";

// Una richiesta per media. La catena di una serie sono due o tre
// media, quindi due o tre richieste: il limite di AniList è 90 al
// minuto e questo giro si fa solo agganciando o rileggendo una serie.
const CAMPI = `
  id
  title { romaji english native }
  episodes
  format
  status
  startDate { year month day }
  relations {
    edges {
      relationType
      node { id title { romaji english native } episodes format startDate { year month day } }
    }
  }
`;

// La ricerca torna una LISTA e non il primo risultato, per la stessa
// ragione per cui la torna quella di AnimeClick: cercando «Sōsō no
// Frieren» il primo che arriva è «Sousou no Frieren: ●● no Mahou», la
// serie di corti — 12 + 6 puntate invece di 28 + 10. Agganciarla
// avrebbe tagliato Frieren alla puntata 13 e alla 19, cioè in mezzo
// alla prima stagione.
const RICERCA = `
  query ($search: String) {
    Page(perPage: 8) {
      media(search: $search, type: ANIME) { ${CAMPI} }
    }
  }
`;

const PER_ID = `
  query ($id: Int) {
    Media(id: $id, type: ANIME) { ${CAMPI} }
  }
`;

function normalizza(testo) {
  return String(testo || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

async function chiedi(query, variabili, fetchImpl = fetch, tentativo = 0) {
  const risposta = await fetchImpl(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables: variabili }),
    signal: AbortSignal.timeout(15000)
  });

  // 404 vuol dire «nessun media con questo titolo», che è una risposta
  // e non un guasto: chi chiama deve poter tirare avanti.
  if (risposta.status === 404) return null;

  // 90 richieste al minuto, e una serie ne consuma tre o quattro:
  // basta rileggere qualche scheda di fila per sbatterci. AniList dice
  // lui stesso quanto aspettare, e aspettare è la cosa giusta — una
  // catena di stagioni non è urgente.
  if (risposta.status === 429 && tentativo < 1) {
    const attesa = Number(risposta.headers.get("retry-after")) || 60;

    await new Promise((r) => setTimeout(r, Math.min(attesa, 70) * 1000));

    return chiedi(query, variabili, fetchImpl, tentativo + 1);
  }

  if (!risposta.ok) throw new Error(`AniList HTTP ${risposta.status}`);

  const json = await risposta.json();

  return json?.data?.Media || json?.data?.Page?.media || null;
}

/** Il giorno d'inizio come numero ordinabile: 2023-09 → 202309. */
function quando(media) {
  const d = media?.startDate;

  return (d?.year || 9999) * 10000 + (d?.month || 0) * 100 + (d?.day || 0);
}

function titoliDi(media) {
  return [media?.title?.romaji, media?.title?.english, media?.title?.native].filter(Boolean);
}

/**
 * La catena delle stagioni, dalla prima all'ultima.
 *
 * Si parte dal media trovato per titolo, si risale ai PREQUEL fino a
 * chi non ne ha, poi si scende di SEQUEL in SEQUEL. Solo quelle due
 * relazioni: uno spin-off o una storia parallela non è una stagione, e
 * contarla sposterebbe tutti i tagli.
 *
 * Solo formati «a puntate» (TV, ONA e simili): un film in mezzo alla
 * strada non aggiunge episodi all'elenco numerato di AnimeClick, e
 * sommarlo farebbe cadere il taglio nel punto sbagliato.
 */
const FORMATI_A_PUNTATE = /^(TV|TV_SHORT|ONA)$/;

async function catenaDaMedia(primo, { fetchImpl = fetch } = {}) {
  const visti = new Map([[primo.id, primo]]);

  // Un tetto ai salti: una catena di serie normale è di due o tre
  // media, e un ciclo fra relazioni mal compilate non deve poter
  // girare all'infinito.
  const massimo = 8;

  async function segui(media, relazione) {
    let corrente = media;

    for (let salto = 0; salto < massimo; salto++) {
      const arco = (corrente.relations?.edges || []).find(
        (e) => e.relationType === relazione && FORMATI_A_PUNTATE.test(e.node?.format || "")
      );

      if (!arco || visti.has(arco.node.id)) return corrente;

      const pieno = await chiedi(PER_ID, { id: arco.node.id }, fetchImpl);

      if (!pieno) return corrente;

      visti.set(pieno.id, pieno);
      corrente = pieno;
    }

    return corrente;
  }

  // Prima all'indietro fino alla capostipite, poi in avanti da lì.
  const capostipite = await segui(primo, "PREQUEL");
  await segui(capostipite, "SEQUEL");

  return [...visti.values()]
    .filter((m) => FORMATI_A_PUNTATE.test(m.format || ""))
    .sort((a, b) => quando(a) - quando(b))
    .map((m) => ({
      id: m.id,
      titolo: m.title?.romaji || m.title?.english || null,
      episodi: m.episodes ?? null,
      formato: m.format,
      anno: m.startDate?.year ?? null
    }));
}

/** Le somme progressive delle puntate: [28, 38] per Frieren. */
function progressive(stagioni) {
  const somme = [];
  let somma = 0;

  for (const stagione of stagioni) {
    if (!stagione.episodi) break; // una stagione senza numero interrompe il conto

    somma += stagione.episodi;
    somme.push(somma);
  }

  return somme;
}

/**
 * Da quali episodi comincia una stagione nuova, dentro un elenco
 * numerato di seguito.
 *
 * Le somme progressive dicono dove finisce ciascuna stagione: 28 → la
 * seconda comincia dalla 29; 28 + 10 = 38 → la terza comincerebbe
 * dalla 39, che questa scheda non ha, e quel taglio si butta. È la
 * regola che fa sistemare da sé i casi storti: una stagione annunciata
 * e non ancora uscita non taglia niente.
 *
 * `disponibili` è quante puntate ha davvero l'elenco di AnimeClick, ed
 * è l'unico numero di cui ci si fida per decidere.
 */
function tagliDa(stagioni, disponibili) {
  return progressive(stagioni)
    .map((somma) => somma + 1)
    .filter((taglio) => taglio > 1 && taglio <= disponibili);
}

/**
 * La catena è quella giusta?
 *
 * La prova è aritmetica, e vale più di qualunque somiglianza fra
 * titoli: se le stagioni di AniList sommate danno esattamente le
 * puntate che AnimeClick elenca, le due fonti stanno parlando della
 * stessa opera. Frieren: 28 + 10 = 38, ed è 38 che ha in tabella.
 *
 * Serve perché la ricerca per titolo sbaglia in modo silenzioso:
 * «Sōsō no Frieren» trova prima la serie di corti (12 + 6 = 18), che
 * somiglia al titolo quanto quella vera ma non torna con 38.
 *
 * Quando nessuna catena torna, non si taglia: un elenco unico è
 * scomodo, un taglio in mezzo a una stagione è una bugia. Resta il
 * campo a mano nella Gestione.
 */
function torna(stagioni, disponibili) {
  return progressive(stagioni).includes(disponibili);
}

/**
 * I tagli di una scheda, partendo dai suoi titoli.
 *
 * Si prova con i titoli nell'ordine in cui è più probabile che AniList
 * li conosca: l'originale in caratteri latini, poi l'inglese, poi
 * l'italiano — che quasi mai combacia («Frieren - Oltre la Fine del
 * Viaggio» non è «Sousou no Frieren»).
 *
 * Per ogni titolo si guardano più candidati e si tiene il primo la cui
 * catena torna col conto. I candidati si provano in ordine di
 * somiglianza, con le serie TV davanti ai corti: non cambia quale
 * catena è giusta, cambia quante richieste servono per trovarla.
 */
async function tagliDiScheda(
  { titolo, titolo_originale, titolo_inglese },
  disponibili,
  { fetchImpl = fetch, quanti = 4 } = {}
) {
  const provati = new Set();

  for (const forma of [titolo_originale, titolo_inglese, titolo].filter(Boolean)) {
    const candidati = (await chiedi(RICERCA, { search: forma }, fetchImpl)) || [];
    const cercato = normalizza(forma);

    const ordinati = candidati
      .filter((m) => FORMATI_A_PUNTATE.test(m.format || ""))
      .map((m) => {
        const nomi = titoliDi(m).map(normalizza);

        const somiglianza = nomi.some((n) => n === cercato)
          ? 3
          : nomi.some((n) => n.includes(cercato) || cercato.includes(n))
            ? 1
            : 0;

        return { media: m, punteggio: somiglianza + (m.format === "TV" ? 1 : 0) };
      })
      .sort((a, b) => b.punteggio - a.punteggio)
      .slice(0, quanti);

    for (const { media } of ordinati) {
      if (provati.has(media.id)) continue;

      provati.add(media.id);

      const catena = await catenaDaMedia(media, { fetchImpl });

      if (!torna(catena, disponibili)) continue;

      return {
        anilistId: catena[0].id,
        stagioni: catena,
        tagli: tagliDa(catena, disponibili)
      };
    }
  }

  return null;
}

// --------------------------------------------------
// Secondo mestiere: chi assomiglia a chi
// --------------------------------------------------

/**
 * I campi di un'opera consigliata.
 *
 * `tags` porta anche il RANGO (0-100), che è quanto quel tema pesa
 * sull'opera secondo chi ha votato. Senza il rango i temi sarebbero
 * un elenco piatto in cui «Urban Fantasy» conta come «Acrobatics», e
 * il motivo scritto sulla carta finirebbe per citare il dettaglio
 * invece della sostanza.
 *
 * `isGeneralSpoiler`/`isMediaSpoiler` esistono perché certi temi
 * raccontano il finale: su Dandadan «Tragedy» è marcato spoiler. Un
 * consiglio che rovina una serie che non hai ancora visto è peggio di
 * nessun consiglio, quindi quelli si buttano e non si mostrano mai.
 */
const OPERA_CONSIGLIATA = `
  id
  title { romaji english native }
  format
  episodes
  averageScore
  startDate { year }
  # ⚠️ I nomi di AniList sono sfalsati di un gradino, verificato il
  # 24/08/2026: «extraLarge» serve il file sotto /cover/large/, mentre
  # «large» serve quello sotto /cover/medium/. In una carta 3:4 la
  # differenza si vede, quindi si chiede il primo — e il secondo resta
  # come ripiego per le schede che non ce l'hanno.
  coverImage { extraLarge large }
  tags { name rank isGeneralSpoiler isMediaSpoiler }
`;

// Una richiesta sola porta a casa tutto: l'opera di partenza coi suoi
// temi, le opere accostate, i voti dell'accostamento e i temi di
// ciascuna. Verificato il 24/08/2026 — 17,5 kB per sei consigli, sotto
// i 40 kB per quattordici. Il conto è quello che rende questa sezione
// possibile: senza i temi in linea servirebbe una richiesta per ogni
// consiglio, cioè quattordici richieste su un limite di novanta al
// minuto, e la pagina di un anime da sola mangerebbe un sesto del
// budget.
const RACCOMANDAZIONI = `
  query ($id: Int, $quanti: Int) {
    Media(id: $id, type: ANIME) {
      id
      title { romaji english native }
      tags { name rank isGeneralSpoiler isMediaSpoiler }
      recommendations(sort: RATING_DESC, perPage: $quanti) {
        nodes {
          rating
          mediaRecommendation { ${OPERA_CONSIGLIATA} }
        }
      }
    }
  }
`;

const RACCOMANDAZIONI_PER_TITOLO = `
  query ($search: String, $quanti: Int) {
    Page(perPage: 5) {
      media(search: $search, type: ANIME) {
        id
        title { romaji english native }
        format
        episodes
        tags { name rank isGeneralSpoiler isMediaSpoiler }
        recommendations(sort: RATING_DESC, perPage: $quanti) {
          nodes {
            rating
            mediaRecommendation { ${OPERA_CONSIGLIATA} }
          }
        }
      }
    }
  }
`;

/** I temi mostrabili: niente spoiler, niente dettagli di contorno. */
function temiDi(media, { rangoMinimo = 50 } = {}) {
  return (media?.tags || [])
    .filter((t) => t && !t.isGeneralSpoiler && !t.isMediaSpoiler)
    .filter((t) => (t.rank ?? 0) >= rangoMinimo)
    .sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0))
    .map((t) => ({ nome: t.name, rango: t.rank ?? 0 }));
}

function opereDa(media) {
  return (media?.recommendations?.nodes || [])
    .filter((n) => n?.mediaRecommendation?.id)
    .map((n) => {
      const m = n.mediaRecommendation;

      return {
        anilistId: m.id,
        // Tutti e tre i titoli, perché servono a due cose diverse:
        // mostrare (l'inglese è il più leggibile) e RICONOSCERE se
        // l'opera è già in videoteca, dove il romaji e il nativo
        // pescano le schede che l'inglese non aggancia.
        titoli: {
          romaji: m.title?.romaji || null,
          inglese: m.title?.english || null,
          nativo: m.title?.native || null
        },
        formato: m.format || null,
        episodi: m.episodes ?? null,
        anno: m.startDate?.year ?? null,
        // AniList dà 0-100, la videoteca ragiona in cinquantesimi di
        // stella: la conversione la fa chi mostra, qui resta il numero
        // della fonte.
        voto: m.averageScore ?? null,
        copertina: m.coverImage?.extraLarge || m.coverImage?.large || null,
        temi: temiDi(m),
        // Quante persone hanno votato QUESTO accostamento. È il segnale
        // vero della sezione: non «quanto è bella quest'opera» ma
        // «quanto è giusto accostarla a quella che stai guardando».
        voti: Number(n.rating) || 0
      };
    })
    // AniList tiene anche gli accostamenti bocciati, con rating
    // negativo: sono opere che qualcuno ha proposto e gli altri hanno
    // votato contro. Tenerle sarebbe prendere per consiglio il suo
    // contrario.
    .filter((o) => o.voti > 0);
}

/**
 * Le opere che i votanti di AniList accostano a questa.
 *
 * `anilistId` quando c'è si usa e basta: è già stato verificato col
 * conto delle puntate quando si sono tagliate le stagioni (vedi
 * `tagliDiScheda`), quindi è la corrispondenza più solida che abbiamo e
 * cercare per titolo sarebbe solo un modo di sbagliare.
 *
 * Senza, si cerca per titolo con la stessa prudenza del resto del file:
 * fra i candidati vince quello che somiglia di più, con le serie TV
 * davanti — e se nessuno somiglia per davvero non si torna il primo
 * della lista, si torna niente. Consigliare le opere accostate a
 * un'altra serie è peggio che non consigliare nulla, ed è esattamente
 * come sbaglia la ricerca di AniList: «Sōsō no Frieren» risponde per
 * prima la serie di corti.
 */
async function raccomandazioni(
  { anilistId = null, titoli = [] },
  { quanti = 14, fetchImpl = fetch } = {}
) {
  if (anilistId) {
    const media = await chiedi(RACCOMANDAZIONI, { id: anilistId, quanti }, fetchImpl);

    if (media) {
      return { anilistId: media.id, temi: temiDi(media), opere: opereDa(media) };
    }
  }

  for (const forma of titoli.filter(Boolean)) {
    const candidati = (await chiedi(RACCOMANDAZIONI_PER_TITOLO, { search: forma, quanti }, fetchImpl)) || [];
    const cercato = normalizza(forma);

    const scelto = candidati
      .map((m) => {
        const nomi = titoliDi(m).map(normalizza);

        const somiglianza = nomi.some((n) => n === cercato)
          ? 3
          : nomi.some((n) => n.includes(cercato) || cercato.includes(n))
            ? 1
            : 0;

        return { media: m, punteggio: somiglianza + (m.format === "TV" ? 1 : 0) };
      })
      // Zero somiglianza vuol dire che AniList ha risposto qualcosa,
      // ma non quello che si cercava: si passa al titolo successivo.
      .filter((c) => c.punteggio >= 1)
      .sort((a, b) => b.punteggio - a.punteggio)[0];

    if (scelto) {
      return {
        anilistId: scelto.media.id,
        temi: temiDi(scelto.media),
        opere: opereDa(scelto.media)
      };
    }
  }

  return { anilistId: null, temi: [], opere: [] };
}

module.exports = { catenaDaMedia, tagliDa, torna, tagliDiScheda, raccomandazioni, temiDi };
