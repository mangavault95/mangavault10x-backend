const express = require("express");
const router = express.Router();
const pool = require("../db");

// GET /api/reading-history
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT id, manga_id, titolo, autore, coverurl, volume, read_at
      FROM reading_history
      ORDER BY read_at DESC
      LIMIT 30
      `
    );

    return res.json(result.rows);
  } catch (err) {
    console.error("READING HISTORY GET ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

// POST /api/reading-history
router.post("/", async (req, res) => {
  try {
    const { manga_id, titolo, autore, coverurl, volume } = req.body;

    if (!manga_id || !titolo) {
      return res.status(400).json({ error: "manga_id e titolo sono obbligatori" });
    }

    const result = await pool.query(
      `
      INSERT INTO reading_history
      (manga_id, titolo, autore, coverurl, volume, read_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      RETURNING *
      `,
      [
        Number(manga_id),
        titolo,
        autore || "",
        coverurl || "",
        Number(volume) || 0
      ]
    );

    return res.status(201).json({
      success: true,
      item: result.rows[0]
    });
  } catch (err) {
    console.error("READING HISTORY POST ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

module.exports = router;
