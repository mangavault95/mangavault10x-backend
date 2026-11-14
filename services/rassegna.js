// services/rassegna.js
//
// L'ANNO IN RASSEGNA, alla Spotify: i numeri di un anno per UNA persona.
//
//   manga   volumi letti, serie lette, le più lette, il mese e il giorno più intensi,
//           i voti più alti dati nell'anno;
//   anime   puntate viste, ore, serie, le più guardate, i generi, i mesi, i voti più alti;
//   casa    acquisti (volumi, spesa, serie, mese più intenso). Gli acquisti sono della
//           CASA, non di una persona: la tabella non dice chi è andato in fumetteria,
//           quindi i due «Anno in rassegna» mostrano la stessa spesa. `casa: true` lo dice;
//   serie   i giorni di fila con almeno una lettura o una puntata;
//   dati    da quando i dati dell'anno esistono davvero (`primoGiorno`): il sito è nato
//           nel 2026, quindi quell'anno è parziale e la pagina lo scrive.
//
// Il giorno e il mese si contano in ora italiana (Europe/Rome), come il resto del sito.
// `costruisci` è pura, così si prova senza database.

const FINESTRA = (campo) =>
  `${campo} >= ($2::date::timestamp AT TIME ZONE 'Europe/Rome') AND ${campo} < (($2::date + INTERVAL '1 year')::timestamp AT TIME ZONE 'Europe/Rome')`;

const GIORNO = (campo) => `to_char(${campo} AT TIME ZONE 'Europe/Rome', 'YYYY-MM-DD')`;

// Quanti volumi vale una riga di acquisto: da..a compresi, o 1 se non dice quali.
const VOLUMI_ACQUISTO = `
  CASE WHEN volume_da IS NULL AND volume_a IS NULL THEN 1
       ELSE COALESCE(volume_a, volume_da) - COALESCE(volume_da, volume_a) + 1 END`;

/**
 * La rassegna di un anno si apre il 31 dicembre di quell'anno, alle 00:00 ora italiana, e da
 * lì resta aperta per sempre. Prima di allora no, nemmeno per chi conosce l'indirizzo: l'anno
 * non è finito e i numeri sarebbero a metà (e rovinerebbero la sorpresa).
 * `oggi` è "AAAA-MM-GG" in ora italiana; "AAAA-12-31" <= oggi si confronta come testo.
 */
const giornoApertura = (anno) => `${anno}-12-31`;
const disponibile = (anno, oggi) => String(oggi) >= giornoApertura(anno);
const oggiInItalia = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Rome" }).format(new Date());

/** Il giorno più lungo di giorni consecutivi, da un elenco di "AAAA-MM-GG" (anche ripetuti, anche disordinati). */
function giorniDiFila(giorni) {
  const unici = [...new Set(giorni)].sort();
  let migliore = 0;
  let corrente = 0;
  let precedente = null;

  for (const g of unici) {
    const t = Date.parse(`${g}T00:00:00Z`);

    corrente = precedente !== null && t - precedente === 86400000 ? corrente + 1 : 1;
    migliore = Math.max(migliore, corrente);
    precedente = t;
  }

  return migliore;
}

/** Da righe {mese:1..12, n} a 12 numeri (gennaio è l'indice 0). */
function perMese(righe) {
  const v = Array(12).fill(0);

  for (const r of righe) v[Number(r.mese) - 1] = Number(r.n);

  return v;
}

/** L'indice (1..12) del mese col valore più alto, o null se è tutto a zero. */
function meseTop(valori) {
  const massimo = Math.max(...valori);

  return massimo > 0 ? valori.indexOf(massimo) + 1 : null;
}

/**
 * @param {object} r le righe già lette dal database (vedi `rassegna` qui sotto)
 */
function costruisci(r) {
  const lettiMese = perMese(r.lettiPerMese);
  const puntateMese = perMese(r.puntatePerMese);
  const acquistiMese = perMese(r.acquistiPerMese);
  const giorniAttivi = [...r.giorniLetture, ...r.giorniPuntate];

  const primi = [r.primoLettura, r.primoPuntata].filter(Boolean).sort();

  return {
    anno: r.anno,
    utente: r.utente,
    manga: {
      volumiLetti: lettiMese.reduce((a, b) => a + b, 0),
      serieLette: r.serieLette,
      topSerie: r.topManga,
      perMese: lettiMese,
      meseTop: meseTop(lettiMese),
      giornoTop: r.giornoTopLetture,
      votiAlti: r.votiManga
    },
    anime: {
      puntate: puntateMese.reduce((a, b) => a + b, 0),
      ore: Math.round(r.minutiAnime / 6) / 10,
      serieViste: r.serieViste,
      serieFinite: r.serieFinite,
      topSerie: r.topAnime,
      generi: r.generiAnime,
      perMese: puntateMese,
      meseTop: meseTop(puntateMese),
      giornoTop: r.giornoTopPuntate,
      votiAlti: r.votiAnime
    },
    casa: {
      casa: true,
      volumi: acquistiMese.reduce((a, b) => a + b, 0),
      spesa: r.spesa,
      serie: r.serieAcquistate,
      topSerie: r.topAcquisti,
      perMese: acquistiMese,
      meseTop: meseTop(acquistiMese)
    },
    giorniDiFila: giorniDiFila(giorniAttivi),
    giorniAttivi: new Set(giorniAttivi).size,
    // Da quando ci sono dati di questa persona: se è dopo il 1° gennaio, l'anno è parziale.
    primoGiorno: primi[0] || null,
    parziale: Boolean(primi[0]) && primi[0] > `${r.anno}-01-07`
  };
}

async function rassegna(pool, { anno, utenteId }) {
  const inizio = `${anno}-01-01`;
  const q = (testo, extra = []) => pool.query(testo, [utenteId, inizio, ...extra]);

  const [
    utente, lettiPerMese, giorniLetture, serieLette, topManga, votiManga,
    puntatePerMese, giorniPuntate, minuti, serieViste, serieFinite, topAnime, generi, votiAnime,
    acquistiPerMese, acquisti, topAcquisti
  ] = await Promise.all([
    q(`SELECT id, nickname, colore FROM utenti WHERE id = $1 AND $2::date IS NOT NULL`),

    q(`SELECT EXTRACT(MONTH FROM read_at AT TIME ZONE 'Europe/Rome')::int AS mese, COUNT(*)::int AS n
         FROM reading_history WHERE utente_id = $1 AND ${FINESTRA("read_at")} GROUP BY 1`),
    q(`SELECT ${GIORNO("read_at")} AS g, COUNT(*)::int AS n
         FROM reading_history WHERE utente_id = $1 AND ${FINESTRA("read_at")} GROUP BY 1 ORDER BY n DESC, g`),
    q(`SELECT COUNT(DISTINCT manga_id)::int AS n
         FROM reading_history WHERE utente_id = $1 AND ${FINESTRA("read_at")}`),
    q(`SELECT h.manga_id AS id, COALESCE(m."Titolo", MAX(h.titolo)) AS titolo,
              COALESCE(m."CoverURL", MAX(h.coverurl)) AS copertina, COUNT(*)::int AS volumi
         FROM reading_history h LEFT JOIN "Manga" m ON m."ID" = h.manga_id
        WHERE h.utente_id = $1 AND ${FINESTRA("h.read_at")}
        GROUP BY h.manga_id, m."Titolo", m."CoverURL" ORDER BY volumi DESC, titolo LIMIT 5`),
    q(`SELECT m."ID" AS id, m."Titolo" AS titolo, m."CoverURL" AS copertina, v.voto::float AS voto
         FROM voti v JOIN "Manga" m ON m."ID" = v.manga_id
        WHERE v.utente_id = $1 AND ${FINESTRA("v.aggiornato_il")}
        ORDER BY v.voto DESC, v.aggiornato_il DESC LIMIT 3`),

    q(`SELECT EXTRACT(MONTH FROM visto_il AT TIME ZONE 'Europe/Rome')::int AS mese, COUNT(*)::int AS n
         FROM episodi_visti WHERE utente_id = $1 AND ${FINESTRA("visto_il")} GROUP BY 1`),
    q(`SELECT ${GIORNO("visto_il")} AS g, COUNT(*)::int AS n
         FROM episodi_visti WHERE utente_id = $1 AND ${FINESTRA("visto_il")} GROUP BY 1 ORDER BY n DESC, g`),
    q(`SELECT COALESCE(SUM(COALESCE(e.durata, a.durata_media, 24)), 0)::int AS minuti
         FROM episodi_visti ev JOIN anime a ON a.id = ev.anime_id
         LEFT JOIN anime_episodi e ON e.anime_id = ev.anime_id AND e.numero = ev.numero
        WHERE ev.utente_id = $1 AND ${FINESTRA("ev.visto_il")}`),
    q(`SELECT COUNT(DISTINCT anime_id)::int AS n
         FROM episodi_visti WHERE utente_id = $1 AND ${FINESTRA("visto_il")}`),
    q(`SELECT COUNT(*)::int AS n FROM visioni
        WHERE utente_id = $1 AND stato = 'completa' AND ${FINESTRA("finita_il")}`),
    q(`SELECT a.id, a.titolo, a.cover_url AS copertina, COUNT(*)::int AS puntate
         FROM episodi_visti ev JOIN anime a ON a.id = ev.anime_id
        WHERE ev.utente_id = $1 AND ${FINESTRA("ev.visto_il")}
        GROUP BY a.id, a.titolo, a.cover_url ORDER BY puntate DESC, a.titolo LIMIT 5`),
    q(`SELECT genere, COUNT(DISTINCT a.id)::int AS serie
         FROM episodi_visti ev JOIN anime a ON a.id = ev.anime_id
         CROSS JOIN LATERAL unnest(a.generi) AS genere
        WHERE ev.utente_id = $1 AND ${FINESTRA("ev.visto_il")}
        GROUP BY genere ORDER BY serie DESC, genere LIMIT 3`),
    q(`SELECT a.id, a.titolo, a.cover_url AS copertina, v.voto::float AS voto
         FROM voti_anime v JOIN anime a ON a.id = v.anime_id
        WHERE v.utente_id = $1 AND ${FINESTRA("v.aggiornato_il")}
        ORDER BY v.voto DESC, v.aggiornato_il DESC LIMIT 3`),

    // Gli acquisti sono della casa: `$1` (la persona) qui non entra, ma la query lo riceve per
    // tenere i segnaposto uguali alle altre.
    q(`SELECT EXTRACT(MONTH FROM data_acquisto)::int AS mese, SUM(${VOLUMI_ACQUISTO})::int AS n
         FROM acquisti WHERE $1::bigint IS NOT NULL
          AND data_acquisto >= $2::date AND data_acquisto < ($2::date + INTERVAL '1 year') GROUP BY 1`),
    q(`SELECT COALESCE(SUM(prezzo), 0)::float AS spesa, COUNT(DISTINCT manga_id)::int AS serie
         FROM acquisti WHERE $1::bigint IS NOT NULL
          AND data_acquisto >= $2::date AND data_acquisto < ($2::date + INTERVAL '1 year')`),
    q(`SELECT m."ID" AS id, m."Titolo" AS titolo, m."CoverURL" AS copertina, SUM(${VOLUMI_ACQUISTO})::int AS volumi
         FROM acquisti a JOIN "Manga" m ON m."ID" = a.manga_id
        WHERE $1::bigint IS NOT NULL AND a.data_acquisto >= $2::date AND a.data_acquisto < ($2::date + INTERVAL '1 year')
        GROUP BY m."ID", m."Titolo", m."CoverURL" ORDER BY volumi DESC, titolo LIMIT 3`)
  ]);

  if (!utente.rows.length) return null;

  const primo = (righe) => righe.map((x) => x.g).sort()[0] || null;

  return costruisci({
    anno,
    utente: utente.rows[0],
    lettiPerMese: lettiPerMese.rows,
    giorniLetture: giorniLetture.rows.map((x) => x.g),
    giornoTopLetture: giorniLetture.rows[0] ? { giorno: giorniLetture.rows[0].g, n: giorniLetture.rows[0].n } : null,
    primoLettura: primo(giorniLetture.rows),
    serieLette: serieLette.rows[0].n,
    topManga: topManga.rows,
    votiManga: votiManga.rows,
    puntatePerMese: puntatePerMese.rows,
    giorniPuntate: giorniPuntate.rows.map((x) => x.g),
    giornoTopPuntate: giorniPuntate.rows[0] ? { giorno: giorniPuntate.rows[0].g, n: giorniPuntate.rows[0].n } : null,
    primoPuntata: primo(giorniPuntate.rows),
    minutiAnime: minuti.rows[0].minuti,
    serieViste: serieViste.rows[0].n,
    serieFinite: serieFinite.rows[0].n,
    topAnime: topAnime.rows,
    generiAnime: generi.rows,
    votiAnime: votiAnime.rows,
    acquistiPerMese: acquistiPerMese.rows,
    spesa: acquisti.rows[0].spesa,
    serieAcquistate: acquisti.rows[0].serie,
    topAcquisti: topAcquisti.rows
  });
}

module.exports = { rassegna, costruisci, giorniDiFila, perMese, meseTop, disponibile, giornoApertura, oggiInItalia };
