// routes/isbn.js
//
//   GET  /api/isbn/:codice[?aggiunta=NNNNN][&numero=N]
//        Cos'è questo codice a barre e a che punto siete (`services/isbn.js`).
//   POST /api/isbn/collega    Ricorda che un codice è il volume N di una serie, e risponde
//                             come il GET. Body: { codice, aggiunta?, mangaId, numero }
//   POST /api/isbn/scollega   Dimentica un collegamento sbagliato. Body: { codice, aggiunta? }
//
// Solo per chi è di casa (`richiediBiblioteca`): la lettura può costare una chiamata a
// Google Books, che ha una quota giornaliera, e non va lasciata a chiunque trovi l'indirizzo.

const express = require("express");
const pool = require("../db");
const { limite } = require("../services/limite");
const { richiediBiblioteca } = require("../services/biblioteca");
const { riconosci, collega, scollega, CollegamentoNonValido } = require("../services/isbn");

const router = express.Router();

// In fumetteria si scansiona a raffica: duecento codici in un quarto d'ora sono una pila
// intera controllata due volte. Oltre non è una persona.
const limiteScansioni = limite({
  finestraMs: 15 * 60 * 1000,
  massimo: 200,
  messaggio: "Troppe scansioni in poco tempo. Riprova fra qualche minuto."
});

router.get("/:codice", richiediBiblioteca, limiteScansioni, async (req, res) => {
  const numero = Number(req.query.numero);

  try {
    return res.json(
      await riconosci(pool, req.params.codice, {
        aggiunta: req.query.aggiunta,
        numero: Number.isInteger(numero) && numero > 0 && numero < 1000 ? numero : undefined
      })
    );
  } catch (err) {
    console.error("ISBN ERROR:", err.message);

    return res.status(500).json({ error: "Errore server" });
  }
});

function scrive(azione) {
  return async (req, res) => {
    try {
      return res.json(await azione(pool, req.body || {}));
    } catch (err) {
      if (err instanceof CollegamentoNonValido) return res.status(400).json({ error: err.message });

      console.error("ISBN SCRITTURA ERROR:", err.message);

      return res.status(500).json({ error: "Errore server" });
    }
  };
}

router.post("/collega", richiediBiblioteca, limiteScansioni, scrive(collega));
router.post("/scollega", richiediBiblioteca, limiteScansioni, scrive(scollega));

module.exports = router;
