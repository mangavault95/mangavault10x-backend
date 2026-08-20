const express = require("express");
const router = express.Router();
const pool = require("../db");
 
// POST /api/wishlist-actions/purchase/:id
router.post("/purchase/:id", async (req, res) => {
  const client = await pool.connect();

  try {
    const { id } = req.params;

    // Quanti volumi hai preso, e di quale edizione. Il desiderio non lo
    // sa: "Berserk" sono 42 volumi nella serie rossa e 14 nella Deluxe,
    // e chi lo compra sa quale ha in mano. Se non arriva niente vale
    // quello che valeva prima — zero volumi, nessuna edizione — così le
    // chiamate vecchie continuano a funzionare.
    const intero = (valore, ripiego) => {
      const n = Number(valore);

      return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : ripiego;
    };

    const edizione = typeof req.body?.edizione === "string" ? req.body.edizione.trim() : "";

    await client.query("BEGIN");

    // ✅ recupera wishlist item
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

      return res.status(404).json({
        error: "Elemento wishlist non trovato"
      });
    }

    const item = wishlistResult.rows[0];

    // Due edizioni della stessa serie non sono un duplicato: sono due
    // oggetti diversi sullo scaffale, con volumi e prezzi diversi. Prima
    // il controllo guardava solo il titolo, e la seconda edizione di una
    // serie spariva dalla wishlist senza entrare in collezione.
    const duplicateCheck = await client.query(
      `
      SELECT "ID"
      FROM "Manga"
      WHERE LOWER("Titolo") = LOWER($1)
        AND LOWER(COALESCE("Edizione", '')) = LOWER($2)
      LIMIT 1
      `,
      [item.titolo || "", edizione]
    );

    if (duplicateCheck.rows.length > 0) {

      // già presente → rimuovi solo wishlist
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
        message: "Già presente in collezione"
      });
    }

    // ✅ genera ID numerico manuale
    const nextIdResult = await client.query(`
      SELECT COALESCE(MAX("ID"), 0) + 1 AS next_id
      FROM "Manga"
    `);

    const nextId = nextIdResult.rows[0].next_id;

    // ✅ inserisci nella collezione
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
        "Edizione"
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING *
      `,
      [
        nextId,
        item.titolo || "",
        item.autori || "",
        item.coverurl || "",
        item.trama || "",
        item.generi || "",
        intero(req.body?.volumiTotali, item.volumitotali ? Number(item.volumitotali) : 0),
        intero(req.body?.volumiPosseduti, 0),
        0,
        "",
        // Niente voto qui: da quando i lettori sono due il voto non è più
        // una colonna della serie ma una riga di `voti`, ed è di chi lo
        // dà. Una serie appena comprata non è ancora piaciuta a nessuno.
        edizione
      ]
    );

    // ✅ elimina wishlist item
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
