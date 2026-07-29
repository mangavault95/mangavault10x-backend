// AniList — copertine ad alta risoluzione, generi, autori, stato serie.
// GraphQL pubblico, nessuna chiave richiesta. Limite: 90 richieste/minuto.

const ENDPOINT = "https://graphql.anilist.co";

const SEARCH_QUERY = `
  query ($search: String) {
    Page(perPage: 10) {
      media(search: $search, type: MANGA) {
        title { romaji english native }
        description
        volumes
        chapters
        status
        startDate { year }
        genres
        coverImage { extraLarge large }
        staff { edges { role node { name { full } } } }
      }
    }
  }
`;

// Ruoli che non sono autoriali: non devono finire nel campo Autore.
const EXCLUDED_ROLES =
  /(translator|translation|localization|lettering|letterer|assistant|editor|supervisor|design)/i;

const STORY_ROLES = /(story|script|original creator|creator|original story)/i;
const ART_ROLES = /(art|illustration|artwork)/i;

function namesFor(edges, pattern) {
  const matched = (edges || [])
    .filter((e) => !EXCLUDED_ROLES.test(e?.role || ""))
    .filter((e) => pattern.test(e?.role || ""))
    .map((e) => e?.node?.name?.full)
    .filter(Boolean);

  return Array.from(new Set(matched));
}

function allCreators(edges) {
  const matched = (edges || [])
    .filter((e) => !EXCLUDED_ROLES.test(e?.role || ""))
    .map((e) => e?.node?.name?.full)
    .filter(Boolean);

  return Array.from(new Set(matched));
}

function stripHtml(text) {
  return String(text || "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const STATUS_MAP = {
  FINISHED: "conclusa",
  RELEASING: "in_corso",
  NOT_YET_RELEASED: "inedita",
  CANCELLED: "interrotta",
  HIATUS: "interrotta"
};

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Sceglie il risultato migliore confrontando il titolo cercato con
 * romaji / english / native.
 *
 * L'autore vale più del titolo quando i due sono in disaccordo:
 * titoli come "Happy!" o "Monster" appartengono a più opere diverse,
 * mentre la coppia titolo+autore è quasi sempre univoca.
 */
function pickBest(list, searchTitle, searchAuthor) {
  const target = normalize(searchTitle);
  const autore = normalize(searchAuthor);

  const punteggioTitolo = (m) => {
    const candidates = [m?.title?.romaji, m?.title?.english, m?.title?.native]
      .filter(Boolean)
      .map(normalize);

    if (candidates.some((c) => c === target)) return 3;
    if (candidates.some((c) => c.startsWith(target) || target.startsWith(c))) return 2;
    if (candidates.some((c) => c.includes(target) || target.includes(c))) return 1;
    return 0;
  };

  const punteggioAutore = (m) => {
    if (!autore) return 0;

    const nomi = allCreators(m?.staff?.edges).map(normalize);
    if (nomi.length === 0) return 0;

    if (nomi.some((n) => n === autore)) return 6;

    // Confronto anche invertendo nome e cognome: le fonti non
    // concordano sull'ordine ("Naoki Urasawa" vs "Urasawa Naoki").
    const parti = autore.split(" ").filter(Boolean);
    const invertito = parti.slice().reverse().join(" ");

    if (nomi.some((n) => n === invertito)) return 6;
    if (nomi.some((n) => parti.every((p) => p.length > 2 && n.includes(p)))) return 4;

    return 0;
  };

  const score = (m) => punteggioTitolo(m) + punteggioAutore(m);

  return [...list].sort((a, b) => score(b) - score(a))[0] || null;
}

async function search(title, author) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: SEARCH_QUERY, variables: { search: title } })
  });

  if (!res.ok) {
    throw new Error(`AniList HTTP ${res.status}`);
  }

  const json = await res.json();
  const list = json?.data?.Page?.media || [];

  if (list.length === 0) return null;

  const media = pickBest(list, title, author);
  if (!media) return null;

  const edges = media?.staff?.edges || [];
  const story = namesFor(edges, STORY_ROLES);
  const art = namesFor(edges, ART_ROLES);
  const everyone = allCreators(edges);

  return {
    titoloOriginale: media?.title?.native || media?.title?.romaji || null,
    // Se AniList non distingue i ruoli, uso comunque i creatori trovati.
    autore: (story.length ? story : everyone).join(", ") || null,
    disegnatore: (art.length ? art : everyone).join(", ") || null,
    genere: (media?.genres || []).join(", ") || null,
    trama: stripHtml(media?.description) || null,
    coverurl: media?.coverImage?.extraLarge || media?.coverImage?.large || null,
    volumitotali: media?.volumes || null,
    statoSerie: STATUS_MAP[media?.status] || null,
    annoInizio: media?.startDate?.year || null
  };
}

module.exports = { search };
