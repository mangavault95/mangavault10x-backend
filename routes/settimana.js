const express = require("express");
const router = express.Router();
const pool = require("../db");
const { identificaUtente } = require("../services/auth");
const { utenteLetto } = require("../services/utenti");
const { settimana } = require("../services/settimana");

/**
 * GET /api/settimana — la tua settimana (26/11/2026).
 *
 * Puntate viste, volumi letti e quanto speso negli ultimi sette giorni, per la
 * Home della domenica sera (vedi `services/settimana.js`). Si legge come il resto
 * del sito: chi è entrato vede i suoi numeri, chi passa senza entrare quelli del
 * proprietario — la regola di `utenteLetto`.
 */
router.get("/", identificaUtente, async (req, res) => {
  try {
    const utenteId = await utenteLetto(req);

    return res.json(await settimana(pool, { utenteId }));
  } catch (err) {
    console.error("❌ SETTIMANA ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

module.exports = router;
