const express = require("express");
const router = express.Router();
const pool = require("../db");
const { requireAuth, identificaUtente } = require("../services/auth");
const { utenteLetto, utenteScrive } = require("../services/utenti");

// --------------------------------------------------
// I SEGNALIBRI SONO DI QUALCUNO
//
// Stessa regola della cronologia (vedi readingHistory.js): in lettura
// si può chiedere di chi, in scrittura lo decide il token e basta.
//
// Qui però cambia anche una cosa che si vede: due persone possono
// leggere la STESSA serie a due punti diversi. Il segnalibro non è più
// unico per serie ma per (serie, persona) — se restasse unico, chi
// arriva al volume 3 sposterebbe il segno dell'altro.
// --------------------------------------------------

// GET /api/reading-sessions
router.get("/", identificaUtente, async (req, res) => {
  try {
    const utenteId = await utenteLetto(req);

    const result = await pool.query(
      `
      SELECT id, manga_id, titolo, autore, coverurl, volume, volumitotali, updated_at
      FROM reading_sessions
      WHERE utente_id = $1
      ORDER BY updated_at DESC
      `,
      [utenteId]
    );

    return res.json(result.rows);
  } catch (err) {
    console.error("READING SESSIONS GET ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

// POST /api/reading-sessions
// crea o aggiorna una sessione attiva
router.post("/", requireAuth, async (req, res) => {
  try {
    const {
      manga_id,
      titolo,
      autore,
      coverurl,
      volume,
      volumitotali
    } = req.body;

    if (!manga_id || !titolo) {
      return res.status(400).json({
        error: "manga_id e titolo sono obbligatori"
      });
    }

    const utenteId = await utenteScrive(req);

    const result = await pool.query(
      `
      INSERT INTO reading_sessions
      (manga_id, titolo, autore, coverurl, volume, volumitotali, updated_at, utente_id)
      VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7)
      ON CONFLICT (manga_id, utente_id)
      DO UPDATE SET
        titolo = EXCLUDED.titolo,
        autore = EXCLUDED.autore,
        coverurl = EXCLUDED.coverurl,
        volume = EXCLUDED.volume,
        volumitotali = EXCLUDED.volumitotali,
        updated_at = NOW()
      RETURNING *
      `,
      [
        Number(manga_id),
        titolo,
        autore || "",
        coverurl || "",
        Number(volume) || 0,
        volumitotali !== null && volumitotali !== undefined
          ? Number(volumitotali)
          : null,
        utenteId
      ]
    );

    return res.status(201).json({
      success: true,
      item: result.rows[0]
    });
  } catch (err) {
    console.error("READING SESSIONS POST ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

// PUT /api/reading-sessions/:mangaId
router.put("/:mangaId", requireAuth, async (req, res) => {
  try {
    const { mangaId } = req.params;
    const { volume } = req.body;

    const utenteId = await utenteScrive(req);

    const result = await pool.query(
      `
      UPDATE reading_sessions
      SET volume = $1,
          updated_at = NOW()
      WHERE manga_id = $2 AND utente_id = $3
      RETURNING *
      `,
      [Number(volume) || 0, Number(mangaId), utenteId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Sessione non trovata" });
    }

    return res.json({
      success: true,
      item: result.rows[0]
    });
  } catch (err) {
    console.error("READING SESSIONS PUT ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

// DELETE /api/reading-sessions/:mangaId
router.delete("/:mangaId", requireAuth, async (req, res) => {
  try {
    const utenteId = await utenteScrive(req);

    await pool.query(
      `
      DELETE FROM reading_sessions
      WHERE manga_id = $1 AND utente_id = $2
      `,
      [Number(req.params.mangaId), utenteId]
    );

    return res.json({ success: true });
  } catch (err) {
    console.error("READING SESSIONS DELETE ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

module.exports = router;
