const express = require("express");
const router = express.Router();
const pool = require("../db");
const { richiediBiblioteca } = require("../services/biblioteca");

// --------------------------------------------------
// I DESIDERI SONO DELLA CASA
//
// La wishlist è la lista della spesa della collezione di carta: quello
// che ci finisce sopra si compra, e quello che si compra entra in
// biblioteca. Quindi vale la regola della biblioteca — la scrivono i
// due di casa, la leggono tutti.
//
// Fino alla 018 queste rotte erano le uniche del sito senza nessun
// controllo: chiunque, anche senza essere entrato, poteva aggiungere e
// cancellare desideri. Era un residuo di quando il sito aveva un
// utente solo e la wishlist non sembrava roba da proteggere.
// --------------------------------------------------

// POST /api/wishlist
router.post("/", richiediBiblioteca, async (req, res) => {
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

// PUT /api/wishlist/:id — aggiorna senza ricreare il record,
// così id e created_at restano quelli originali.
router.put("/:id", richiediBiblioteca, async (req, res) => {
  try {
    const { titolo, autori, coverurl, trama, generi, volumitotali, dovecomprare } =
      req.body;

    if (!titolo) return res.status(400).json({ error: "titolo richiesto" });

    const { rows } = await pool.query(
      `
      UPDATE wishlist_custom
      SET titolo = $1,
          autori = $2,
          coverurl = $3,
          trama = $4,
          generi = $5,
          volumitotali = $6,
          dovecomprare = $7
      WHERE id = $8
      RETURNING id, titolo, autori, coverurl, trama, generi, volumitotali, dovecomprare, created_at
      `,
      [
        titolo,
        autori,
        coverurl,
        trama,
        generi,
        volumitotali,
        dovecomprare || "",
        req.params.id
      ]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "Elemento non trovato" });
    }

    return res.json({ item: rows[0] });
  } catch (err) {
    console.error("wishlist PUT error:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

router.delete("/:id", richiediBiblioteca, async (req, res) => {
  try {
    await pool.query(
      "DELETE FROM wishlist_custom WHERE id=$1",
      [req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Errore delete" });
  }
});

// GET ALL WISHLIST
router.get("/all", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM wishlist_custom ORDER BY created_at DESC"
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json([]);
  }
});

module.exports = router;
