const express = require("express");
const router = express.Router();
const pool = require("../db");

// GET /api/reading-sessions
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT id, manga_id, titolo, autore, coverurl, volume, volumitotali, updated_at
      FROM reading_sessions
      ORDER BY updated_at DESC
      `
    );

    return res.json(result.rows);
  } catch (err) {
    console.error("READING SESSIONS GET ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

// POST /api/reading-sessions
// crea o aggiorna una sessione attiva
router.post("/", async (req, res) => {
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

    const result = await pool.query(
      `
      INSERT INTO reading_sessions
      (manga_id, titolo, autore, coverurl, volume, volumitotali, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (manga_id)
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
          : null
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
router.put("/:mangaId", async (req, res) => {
  try {
    const { mangaId } = req.params;
    const { volume } = req.body;

    const result = await pool.query(
      `
      UPDATE reading_sessions
      SET volume = $1,
          updated_at = NOW()
      WHERE manga_id = $2
      RETURNING *
      `,
      [Number(volume) || 0, Number(mangaId)]
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
router.delete("/:mangaId", async (req, res) => {
  try {
    await pool.query(
      `
      DELETE FROM reading_sessions
      WHERE manga_id = $1
      `,
      [Number(req.params.mangaId)]
    );

    return res.json({ success: true });
  } catch (err) {
    console.error("READING SESSIONS DELETE ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

module.exports = router;
