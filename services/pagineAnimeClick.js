// services/pagineAnimeClick.js
//
// Le pagine di AnimeClick che scarica GitHub Actions e che i lavori leggono da qui, invece
// di chiederle ad AnimeClick da Render (dove risponde 403). Vedi sql/032 per il perché.
//
// Il flusso, uguale per i tre lavori (calendario anime, schede anime, rapporto volumi):
//   1. GitHub chiede `GET /api/animeclick/da-scaricare?lavoro=…`: il backend dice QUALI indirizzi
//      leggere (li decide lui, così gli indirizzi vivono in un posto solo) o che la fonte è in pausa;
//   2. GitHub li scarica uno alla volta, distanziati, fermandosi al primo 403 o 429, e manda
//      ognuno a `POST /api/animeclick/pagina` (qui: `salva`);
//   3. GitHub chiama il lavoro di sempre, che legge le pagine con `fetchDaPagine`;
//   4. il lavoro cancella le pagine usate (`pulisci`).
//
// ⚠️ `fetchDaPagine` NON apre mai la rete. Se un lavoro chiede una pagina che GitHub non ha
// mandato, riceve un errore e basta: da Render non deve partire nessuna richiesta ad AnimeClick.

const BASE = "https://www.animeclick.it";

// Quali indirizzi si accettano: solo le pagine che i tre lavori leggono. Un indirizzo qualunque
// non entra in tabella: chi avesse il segreto del cron non può usarla come deposito.
const PERMESSE = [
  /^https:\/\/www\.animeclick\.it\/calendario-anime(\?paging=(prev|next)-month)?$/,
  /^https:\/\/www\.animeclick\.it\/anime\/\d{1,9}\/-\/(episodi)?$/,
  /^https:\/\/www\.animeclick\.it\/manga\/\d{1,9}\/-\/(edizioni)?$/
];

// Sotto il tetto di 4 MB del corpo (index.js), con margine per il JSON.
const HTML_MASSIMO = 3_500_000;
const VALIDITA = "1 day";
const DOPO_QUANTO_SI_BUTTA = "2 days";

const urlPermesso = (url) => typeof url === "string" && PERMESSE.some((r) => r.test(url));

class PaginaNonAmmessa extends Error {}

async function salva(pool, url, html) {
  if (!urlPermesso(url)) throw new PaginaNonAmmessa("Indirizzo non ammesso");

  if (typeof html !== "string" || html.length === 0 || html.length > HTML_MASSIMO) {
    throw new PaginaNonAmmessa("Pagina vuota o troppo grande");
  }

  await pool.query(
    `INSERT INTO animeclick_pagine (url, html, scaricata_il) VALUES ($1, $2, NOW())
     ON CONFLICT (url) DO UPDATE SET html = EXCLUDED.html, scaricata_il = NOW()`,
    [url, html]
  );

  return html.length;
}

/** Cancella le pagine usate e, già che c'è, quelle dimenticate da più di due giorni. */
async function pulisci(pool, urls = []) {
  try {
    await pool.query(
      `DELETE FROM animeclick_pagine WHERE url = ANY($1::text[]) OR scaricata_il < NOW() - $2::interval`,
      [urls, DOPO_QUANTO_SI_BUTTA]
    );
  } catch (err) {
    console.warn("Pagine di AnimeClick non ripulite:", err.message);
  }
}

/**
 * Un `fetch` finto che serve le pagine della tabella. Ha la stessa forma che i lettori si
 * aspettano (`ok`, `status`, `headers`, `text()`), così si passa come `fetchImpl` e il codice
 * di lettura non cambia di una riga. La marca `daPagine` dice a `prendi` che qui non c'è rete.
 */
function fetchDaPagine(pool) {
  const f = async (url) => {
    const { rows } = await pool.query(
      `SELECT html FROM animeclick_pagine WHERE url = $1 AND scaricata_il > NOW() - $2::interval`,
      [String(url), VALIDITA]
    );

    if (rows.length === 0) throw new Error(`Pagina non scaricata da GitHub: ${url}`);

    const html = rows[0].html;

    return { ok: true, status: 200, headers: { get: () => null }, text: async () => html };
  };

  f.daPagine = true;

  return f;
}

// ---- gli indirizzi che ogni lavoro vuole

const urlCalendario = (quando) => (quando ? `${BASE}/calendario-anime?paging=${quando}` : `${BASE}/calendario-anime`);

/** Nell'ordine in cui il lavoro le legge. */
const urlsCalendario = () => [urlCalendario("prev-month"), urlCalendario(null), urlCalendario("next-month")];

const urlsScheda = (animeClickId) => [`${BASE}/anime/${animeClickId}/-/`, `${BASE}/anime/${animeClickId}/-/episodi`];

const urlsRapportoSerie = (riga, { controllaStato = false } = {}) => {
  if (!riga.AnimeClickID) return [];

  const id = riga.AnimeClickID;
  const urls = [`${BASE}/manga/${id}/-/edizioni`];

  // Lo stato dell'edizione italiana si legge solo nel giro mensile, e solo per le serie in corso.
  if (controllaStato && riga.StatoSerie === "in_corso") urls.push(`${BASE}/manga/${id}/-/`);

  return urls;
};

module.exports = {
  PaginaNonAmmessa,
  urlPermesso,
  salva,
  pulisci,
  fetchDaPagine,
  urlsCalendario,
  urlsScheda,
  urlsRapportoSerie
};
