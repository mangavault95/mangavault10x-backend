const express = require("express");
const router = express.Router();
const pool = require("../db");

// POST /api/wishlist-actions/purchase/:id
// Sposta un elemento da wishlist_custom alla tabella principale "Manga"
router.post("/purchase/:id", async (req, res) => {
  const client = await pool.connect();

  try {
    const { id } = req.params;

    await client.query("BEGIN");

    // 1) Recupera elemento wishlist
    const wishlistResult = await client.query(
      `
      SELECT *
      FROM wishlist_custom
      WHERE id = $1
      LIMIT 1
      `,
      [id]
    );

    if (wishlistResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Elemento wishlist non trovato" });
    }

    const item = wishlistResult.rows[0];

    // 2) Evita duplicati banali per titolo
    const duplicateCheck = await client.query(
      `
      SELECT "ID"
      FROM "Manga"
      WHERE LOWER("Titolo") = LOWER($1)
      LIMIT 1
      `,
      [item.titolo || ""]
    );

    if (duplicateCheck.rows.length > 0) {
      // Se esiste già, rimuovilo dalla wishlist e basta
      await client.query(
        `
        DELETE FROM wishlist_custom
        WHERE id = $1
        `,
        [id]
      );

      await client.query("COMMIT");

      return res.json({
        success: true,
        duplicated: true,
        message: "Manga già presente in collezione: rimosso dalla wishlist",
        existingId: duplicateCheck.rows[0].ID
      });
    }

    // 3) Inserisci nella tabella Manga
    // NON passiamo "ID" perché nel tuo DB è bigint/autoincrement
    const insertResult = await client.query(
      `
      INSERT INTO "Manga" (
        "Titolo",
        "Autore",
        "CoverURL",
        "Trama",
        "Genere",
        "VolumiTotali",
        "VolumiPosseduti",
        "Costo",
        "Editore",
        "Valutazione"
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING *
      `,
      [
        item.titolo || "",
        item.autori || "",
        item.coverurl || "",
        item.trama || "",
        item.generi || "",
        item.volumitotali !== null && item.volumitotali !== undefined
          ? Number(item.volumitotali)
          : 0,
        0,
        0,
        "",
        0
      ]
    );

    // 4) Elimina dalla wishlist
    await client.query(
      `
      DELETE FROM wishlist_custom
      WHERE id = $1
      `,
      [id]
    );

    await client.query("COMMIT");

    return res.json({
      success: true,
      inserted: insertResult.rows[0],
      removedWishlistId: id
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("PURCHASE WISHLIST ERROR:", err);
    return res.status(500).json({
      error: "Errore server durante lo spostamento da wishlist a collection",
      details: err.message
    });
  } finally {
    client.release();
  }
});

module.exports = router;
