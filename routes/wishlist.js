const express = require("express");
const router = express.Router();
const { Pool } = require("pg");

// Usa DATABASE_URL da env (Render/Heroku style)
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// POST /api/wishlist
router.post("/", async (req, res) => {
  try {
    const { titolo, autori, coverurl, trama, generi, volumitotali, dovecomprare } = req.body;
    if (!titolo) return res.status(400).json({ error: "titolo richiesto" });

    const insertQuery = `
      INSERT INTO wishlist_custom (titolo, autori, coverurl, trama, generi, volumitotali, dovecomprare, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7, now())
      RETURNING id, titolo, autori, coverurl, trama, generi, volumitotali, dovecomprare, created_at;
    `;
    const values = [titolo, autori, coverurl, trama, generi, volumitotali, dovecomprare || ""];
    const { rows } = await pool.query(insertQuery, values);
    const item = rows[0];
    return res.status(201).json({ item });
  } catch (err) {
    console.error("wishlist POST error:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

module.exports = router;
