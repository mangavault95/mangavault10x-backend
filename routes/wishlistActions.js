const express = require("express");
const { randomUUID } = require("crypto");
const router = express.Router();
const pool = require("../db");

// POST /api/wishlist-actions/purchase/:id
// Legge da wishlist_custom, inserisce in "Manga", poi rimuove dalla wishlist
router.post("/purchase/:id", async (req, res) => {
  const client = await pool.connect();

  try {
    const { id } = req.params;

    await client.query("BEGIN");

    // 1) prendo il manga dalla wishlist
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

    // 2) controllo se esiste già in Manga per evitare duplicati stupidi
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
      // Se esiste già, lo tolgo solo dalla wishlist
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

    // 3) inserisco nella tabella Manga
    const newId = randomUUID();

    const insertResult = await client.query(
      `
      INSERT INTO "Manga" (
        "ID",
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
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING *
      `,
      [
        newId,
        item.titolo || "",
        item.autori || "",
        item.coverurl || "",
        item.trama || "",
        item.generi || "",
        item.volumitotali !== null && item.volumitotali !== undefined
          ? Number(item.volumitotali)
          : 0,
        0,          // appena acquistato, ma non ancora segnato come posseduto oltre 0
        0,          // costo default
        "",         // editore default
        0           // valutazione default
      ]
    );

    // 4) lo elimino dalla wishlist
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
