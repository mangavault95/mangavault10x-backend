const express = require("express");
const router = express.Router();
const pool = require("../db");

/**
 * GET /api/mese?m=AAAA-MM — il vostro mese (04/10/2026).
 *
 * Il riassunto di un mese di casa, da guardare a inizio mese successivo:
 * quanti volumi sono entrati (gli acquisti li scrive il bot di Telegram
 * e la casella Cerca del sito), quanto sono costati, la serie che vi ha
 * preso di più, e quanto ha letto e guardato ciascuno.
 *
 * Gli acquisti sono della casa, non di una persona: la tabella non dice
 * chi è andato in fumetteria. Letture e puntate invece sono di ciascuno,
 * e si contano per persona — solo chi ha fatto qualcosa nel mese.
 *
 * Senza `m` vale il mese scorso: è quello che ha senso riassumere, il
 * mese in corso non è finito.
 *
 * Si legge senza entrare, come il resto del sito.
 */
function meseDi(grezzo) {
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(String(grezzo || ""))) return grezzo;

  const oggi = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Rome" }).format(new Date());
  const [anno, mese] = oggi.split("-").map(Number);
  const scorso = new Date(Date.UTC(anno, mese - 2, 1));

  return scorso.toISOString().slice(0, 7);
}

/**
 * Gli acquisti del mese raggruppati per serie: quali volumi (come numeri
 * in fila, «3-5, 8»), quanti, quanto sono costati. In ordine di quanti
 * volumi sono entrati, poi dal più recente. Un acquisto senza numero di
 * volume (se la riga non lo dice) conta come un volume solo e non finisce
 * fra i numeri.
 */
function elencoAcquisti(righe) {
  const perSerie = new Map();

  for (const r of righe) {
    if (!perSerie.has(r.id)) {
      perSerie.set(r.id, {
        id: r.id,
        titolo: r.titolo,
        edizione: r.edizione || null,
        copertina: r.copertina,
        volumi: 0,
        spesa: 0,
        numeri: new Set(),
        ultimo: r.data
      });
    }

    const s = perSerie.get(r.id);
    const da = r.volume_da ?? r.volume_a;
    const a = r.volume_a ?? r.volume_da;

    s.volumi += da == null ? 1 : a - da + 1;
    s.spesa += r.prezzo || 0;

    if (da != null) for (let n = da; n <= a; n += 1) s.numeri.add(n);
    if (r.data > s.ultimo) s.ultimo = r.data;
  }

  return [...perSerie.values()]
    .sort((x, y) => y.volumi - x.volumi || y.ultimo.localeCompare(x.ultimo))
    .map(({ numeri, ...s }) => ({ ...s, spesa: Math.round(s.spesa * 100) / 100, numeri: [...numeri].sort((p, q) => p - q) }));
}

router.get("/", async (req, res) => {
  const mese = meseDi(req.query.m);
  const dal = `${mese}-01`;

  try {
    const finestra = [dal];

    const [acquisti, serieTop, righeAcquisti, letti, puntate, animeTop] = await Promise.all([
      pool.query(
        `SELECT COALESCE(SUM(volume_a - volume_da + 1), 0)::int AS volumi,
                COALESCE(SUM(prezzo), 0)::float AS spesa
           FROM acquisti
          WHERE data_acquisto >= $1::date AND data_acquisto < ($1::date + INTERVAL '1 month')`,
        finestra
      ),
      pool.query(
        `SELECT m."ID" AS id, m."Titolo" AS titolo, m."CoverURL" AS copertina,
                SUM(a.volume_a - a.volume_da + 1)::int AS volumi
           FROM acquisti a JOIN "Manga" m ON m."ID" = a.manga_id
          WHERE a.data_acquisto >= $1::date AND a.data_acquisto < ($1::date + INTERVAL '1 month')
          GROUP BY m."ID", m."Titolo", m."CoverURL"
          ORDER BY volumi DESC, MAX(a.data_acquisto) DESC
          LIMIT 1`,
        finestra
      ),
      // Ogni acquisto del mese, con la serie: l'elenco di cosa è entrato.
      pool.query(
        `SELECT m."ID" AS id, m."Titolo" AS titolo, m."Edizione" AS edizione,
                m."CoverURL" AS copertina, a.volume_da, a.volume_a,
                a.prezzo::float AS prezzo, a.data_acquisto::text AS data
           FROM acquisti a JOIN "Manga" m ON m."ID" = a.manga_id
          WHERE a.data_acquisto >= $1::date AND a.data_acquisto < ($1::date + INTERVAL '1 month')
          ORDER BY a.data_acquisto DESC, a.id DESC`,
        finestra
      ),
      pool.query(
        `SELECT u.id, u.nickname, u.colore, COUNT(*)::int AS volumi
           FROM reading_history r JOIN utenti u ON u.id = r.utente_id
          WHERE r.read_at >= ($1::date AT TIME ZONE 'Europe/Rome')
            AND r.read_at < (($1::date + INTERVAL '1 month') AT TIME ZONE 'Europe/Rome')
          GROUP BY u.id, u.nickname, u.colore
          ORDER BY volumi DESC`,
        finestra
      ),
      pool.query(
        `SELECT u.id, u.nickname, u.colore, COUNT(*)::int AS puntate
           FROM episodi_visti e JOIN utenti u ON u.id = e.utente_id
          WHERE e.visto_il >= ($1::date AT TIME ZONE 'Europe/Rome')
            AND e.visto_il < (($1::date + INTERVAL '1 month') AT TIME ZONE 'Europe/Rome')
          GROUP BY u.id, u.nickname, u.colore
          ORDER BY puntate DESC`,
        finestra
      ),
      pool.query(
        `SELECT a.id, a.titolo, a.cover_url AS copertina, COUNT(*)::int AS puntate
           FROM episodi_visti e JOIN anime a ON a.id = e.anime_id
          WHERE e.visto_il >= ($1::date AT TIME ZONE 'Europe/Rome')
            AND e.visto_il < (($1::date + INTERVAL '1 month') AT TIME ZONE 'Europe/Rome')
          GROUP BY a.id, a.titolo, a.cover_url
          ORDER BY puntate DESC
          LIMIT 1`,
        finestra
      )
    ]);

    return res.json({
      mese,
      acquisti: { ...acquisti.rows[0], serie: serieTop.rows[0] || null, elenco: elencoAcquisti(righeAcquisti.rows) },
      letti: letti.rows,
      puntate: puntate.rows,
      anime: animeTop.rows[0] || null
    });
  } catch (err) {
    console.error("❌ MESE ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

module.exports = router;
