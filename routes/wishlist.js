const express = require("express");
const router = express.Router();
const pool = require("../db"); // il tuo pool pg / supabase client

// POST /api/wishlist
// body: { titolo, autori, coverurl, trama, generi, volumitotali, dovecomprare }
router.post("/", async (req, res) => {
  try {
    const {
      titolo,
      autori,
      coverurl,
      trama,
      generi,
      volumitotali,
      dovecomprare
    } = req.body;

    if (!titolo || titolo.trim().length === 0) {
      return res.status(400).json({ error: "Titolo mancante" });
    }

    const q = `
      INSERT INTO public.wishlist_custom
        (titolo, autori, coverurl, trama, generi, volumitotali, dovecomprare)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING *;
    `;
    const values = [
      titolo,
      autori || null,
      coverurl || null,
      trama || null,
      generi || null,
      volumitotali || null,
      dovecomprare || null
    ];

    const result = await pool.query(q, values);
    return res.json({ success: true, item: result.rows[0] });
  } catch (err) {
    console.error("❌ POST /api/wishlist error:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

module.exports = router;
