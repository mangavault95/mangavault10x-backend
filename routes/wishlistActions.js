const express = require("express");
const router = express.Router();
const pool = require("../db");

// ✅ wishlist → manga
router.post("/purchase/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const { rows } = await pool.query(
      "SELECT * FROM wishlist_custom WHERE id=$1",
      [id]
    );

    if (rows.length === 0)
      return res.status(404).json({ error: "Not found" });

    const item = rows[0];

    // inserisce nel DB principale
    await pool.query(`
      INSERT INTO "Manga"
      ("Titolo","Autore","CoverURL","Trama","Genere","VolumiTotali","VolumiPosseduti")
      VALUES ($1,$2,$3,$4,$5,$6,$7)
    `, [
      item.titolo,
      item.autori,
      item.coverurl,
      item.trama,
      item.generi,
      item.volumitotali,
      0
    ]);

    // cancella dalla wishlist
    await pool.query(
      "DELETE FROM wishlist_custom WHERE id=$1",
      [id]
    );

    res.json({ success: true });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore" });
  }
});

module.exports = router;
``
