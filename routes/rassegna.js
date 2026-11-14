// routes/rassegna.js
//
//   GET /api/rassegna?anno=2026&utente=<id>   L'anno in rassegna di una persona.
//
// Si legge senza entrare, come le letture e la spesa del resto del sito (la decisione «le
// letture sono pubbliche» è già presa). Senza `utente` vale chi guarda (token) o il
// proprietario, come ovunque. Senza `anno` vale quello in corso.
// Vedi `services/rassegna.js` per cosa c'è dentro e per il limite degli acquisti (della casa).

const express = require("express");
const pool = require("../db");
const { limite } = require("../services/limite");
const { identificaUtente } = require("../services/auth");
const { utenteLetto } = require("../services/utenti");
const { rassegna } = require("../services/rassegna");

const router = express.Router();

const limiteRassegna = limite({
  finestraMs: 15 * 60 * 1000,
  massimo: 60,
  messaggio: "Troppe richieste. Riprova fra qualche minuto."
});

router.get("/", limiteRassegna, identificaUtente, async (req, res) => {
  const oggi = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Rome" }).format(new Date());
  const corrente = Number(oggi.slice(0, 4));
  const anno = req.query.anno === undefined ? corrente : Number(req.query.anno);

  if (!Number.isInteger(anno) || anno < 2020 || anno > corrente) {
    return res.status(400).json({ error: "Anno non valido" });
  }

  try {
    const utenteId = await utenteLetto(req);
    const dati = await rassegna(pool, { anno, utenteId });

    if (!dati) return res.status(404).json({ error: "Persona non trovata" });

    return res.json(dati);
  } catch (err) {
    console.error("RASSEGNA ERROR:", err.message);

    return res.status(500).json({ error: "Errore server" });
  }
});

module.exports = router;
