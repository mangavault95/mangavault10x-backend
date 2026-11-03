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
 * volumi sono entrati, poi dal più recente.
 *
 * Una riga SENZA numeri di volume è «serie intera / non specificato»
 * (vedi `sql/001_fondamenta.sql`). Per contarla a volumi si fa così: i
 * volumi che la serie ha in collezione e che NESSUN altro acquisto
 * nomina a numero sono quelli arrivati con quella riga. Esempio: ho 1-5,
 * ho registrato a parte il 5 → la riga «serie intera» vale 1-4. Se per la
 * stessa serie ci sono più righe così non si può dividere il resto fra
 * loro, e ognuna conta come un volume solo, senza numeri. `contesto` dice,
 * per serie, i numeri già coperti dagli altri acquisti e quante righe
 * senza numeri ci sono in tutto.
 */
function elencoAcquisti(righe, contesto = new Map()) {
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
    let da = r.volume_da ?? r.volume_a;
    let a = r.volume_a ?? r.volume_da;
    let elenco = null;

    s.spesa += r.prezzo || 0;
    if (r.data > s.ultimo) s.ultimo = r.data;

    if (da == null) {
      const c = contesto.get(r.id);

      if (c && c.senzaNumeri === 1) {
        elenco = (r.posseduti || []).map(Number).filter((n) => !c.coperti.has(n));
      }

      if (!elenco || elenco.length === 0) {
        s.volumi += 1;
        continue;
      }
    } else {
      elenco = [];

      for (let n = da; n <= a; n += 1) elenco.push(n);
    }

    s.volumi += elenco.length;
    elenco.forEach((n) => s.numeri.add(n));
  }

  return [...perSerie.values()]
    .sort((x, y) => y.volumi - x.volumi || y.ultimo.localeCompare(x.ultimo))
    .map(({ numeri, ...s }) => ({ ...s, spesa: Math.round(s.spesa * 100) / 100, numeri: [...numeri].sort((p, q) => p - q) }));
}

/** Per le serie con una riga senza numeri: cosa gli altri acquisti già coprono. */
async function contestoSenzaNumeri(righe) {
  const ids = [...new Set(righe.filter((r) => r.volume_da == null && r.volume_a == null).map((r) => r.id))];
  const contesto = new Map();

  if (!ids.length) return contesto;

  const { rows } = await pool.query(
    `SELECT manga_id, volume_da, volume_a FROM acquisti WHERE manga_id = ANY($1::int[])`,
    [ids]
  );

  for (const id of ids) contesto.set(id, { coperti: new Set(), senzaNumeri: 0 });

  for (const r of rows) {
    const c = contesto.get(r.manga_id);

    if (r.volume_da == null && r.volume_a == null) {
      c.senzaNumeri += 1;
      continue;
    }

    const da = r.volume_da ?? r.volume_a;
    const a = r.volume_a ?? r.volume_da;

    for (let n = da; n <= a; n += 1) c.coperti.add(n);
  }

  return contesto;
}

router.get("/", async (req, res) => {
  const mese = meseDi(req.query.m);
  const dal = `${mese}-01`;

  try {
    const finestra = [dal];

    const [acquisti, righeAcquisti, letti, puntate, animeTop] = await Promise.all([
      pool.query(
        `SELECT COALESCE(SUM(volume_a - volume_da + 1), 0)::int AS volumi,
                COALESCE(SUM(prezzo), 0)::float AS spesa
           FROM acquisti
          WHERE data_acquisto >= $1::date AND data_acquisto < ($1::date + INTERVAL '1 month')`,
        finestra
      ),
      // Ogni acquisto del mese, con la serie: l'elenco di cosa è entrato.
      pool.query(
        `SELECT m."ID" AS id, m."Titolo" AS titolo, m."Edizione" AS edizione,
                m."CoverURL" AS copertina, m."NumeriPosseduti" AS posseduti, a.volume_da, a.volume_a,
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

    const elenco = elencoAcquisti(righeAcquisti.rows, await contestoSenzaNumeri(righeAcquisti.rows));

    return res.json({
      mese,
      acquisti: { spesa: acquisti.rows[0].spesa, volumi: elenco.reduce((t, x) => t + x.volumi, 0), elenco },
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
