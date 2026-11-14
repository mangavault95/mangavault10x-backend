// routes/isbn.js
//
//   GET  /api/isbn/:codice   Cos'è questo codice a barre e a che punto siete (`services/isbn.js`).
//   POST /api/isbn/collega   Ricorda che un codice è il volume N di una serie. Body: { isbn, mangaId, numero }
//
// Solo per chi è di casa (`richiediBiblioteca`): la lettura costa una chiamata a Google Books,
// che ha una quota giornaliera, e non va lasciata a chiunque trovi l'indirizzo.

const express = require("express");
const pool = require("../db");
const { limite } = require("../services/limite");
const { richiediBiblioteca } = require("../services/biblioteca");
const { riconosci, collega } = require("../services/isbn");

const router = express.Router();

const limiteScansioni = limite({
  finestraMs: 15 * 60 * 1000,
  massimo: 120,
  messaggio: "Troppe scansioni in poco tempo. Riprova fra qualche minuto."
});

router.get("/:codice", richiediBiblioteca, limiteScansioni, async (req, res) => {
  try {
    return res.json(await riconosci(pool, req.params.codice));
  } catch (err) {
    console.error("ISBN ERROR:", err.message);

    return res.status(500).json({ error: "Errore server" });
  }
});

router.post("/collega", richiediBiblioteca, limiteScansioni, async (req, res) => {
  try {
    return res.json(await collega(pool, req.body || {}));
  } catch (err) {
    if (/non valido|non trovata/.test(err.message)) return res.status(400).json({ error: err.message });

    console.error("ISBN COLLEGA ERROR:", err.message);

    return res.status(500).json({ error: "Errore server" });
  }
});

module.exports = router;
