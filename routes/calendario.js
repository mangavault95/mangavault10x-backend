// routes/calendario.js
//
//   GET /api/calendario/uscite.ics?t=<CALENDARIO_TOKEN>[&utente=<id>]
//
// Il calendario delle uscite da abbonare dal Calendario dell'iPhone (Impostazioni →
// Calendario → Account → Aggiungi account → Altro → Aggiungi calendario con abbonamento).
//
// Il telefono non sa mandare l'intestazione `Authorization`, quindi l'indirizzo stesso è la
// chiave: `?t=` deve essere uguale alla variabile `CALENDARIO_TOKEN` di Render. Senza la
// variabile la rotta non esiste (404), così non è mai aperta per dimenticanza.
// Dentro ci sono solo cose che il sito mostra già senza accesso (uscite e puntate); il
// token serve a non lasciarlo a disposizione di chiunque trovi l'indirizzo.
// Si cambia il token per far smettere l'abbonamento vecchio.

const crypto = require("crypto");
const express = require("express");
const pool = require("../db");
const { limite } = require("../services/limite");
const { utenteLetto } = require("../services/utenti");
const { usciteTra, piuGiorni, oggiInItalia } = require("../services/usciteManga");
const { costruisciCalendario } = require("../services/calendarioIcs");

const router = express.Router();

const limiteCalendario = limite({
  finestraMs: 15 * 60 * 1000,
  massimo: 60,
  messaggio: "Troppe richieste del calendario. Riprova fra qualche minuto."
});

function tokenGiusto(ricevuto) {
  const atteso = process.env.CALENDARIO_TOKEN;

  if (!atteso) return null; // rotta spenta

  const a = Buffer.from(atteso);
  const b = Buffer.from(String(ricevuto || ""));

  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

router.get("/uscite.ics", limiteCalendario, async (req, res) => {
  const esito = tokenGiusto(req.query.t);

  if (esito === null) return res.status(404).json({ error: "Non trovato" });
  if (!esito) return res.status(403).json({ error: "Token non valido" });

  try {
    const oggi = oggiInItalia();

    // Un mese indietro (per non perdere ciò che è uscito da poco) e tre avanti.
    const uscite = await usciteTra(pool, { dopo: piuGiorni(oggi, -30), fino: piuGiorni(oggi, 90), soloMie: true });

    // Il token `?t=` verificato qui sopra è la prova: `?utente=` vale anche senza accesso.
    const utenteId = await utenteLetto(req, { fidato: true });
    const { rows: episodi } = await pool.query(
      `SELECT e.anime_id, e.numero, e.uscita_italia, e.piattaforma, a.titolo AS serie
         FROM anime_episodi e
         JOIN anime a ON a.id = e.anime_id
         JOIN visioni vis ON vis.anime_id = a.id AND vis.utente_id = $1
        WHERE e.uscita_italia IS NOT NULL
          AND e.uscita_italia >= NOW() - INTERVAL '30 days'
          AND e.uscita_italia <= NOW() + INTERVAL '90 days'
          AND vis.stato NOT IN ('droppata', 'in_pausa')
        ORDER BY e.uscita_italia`,
      [utenteId]
    );

    res.set("Content-Type", "text/calendar; charset=utf-8");
    res.set("Cache-Control", "private, max-age=900");
    res.set("Content-Disposition", 'inline; filename="mangavault-uscite.ics"');

    return res.send(costruisciCalendario({ uscite, episodi }));
  } catch (err) {
    console.error("CALENDARIO ICS ERROR:", err.message);

    return res.status(500).json({ error: "Il calendario non si legge adesso" });
  }
});

module.exports = router;
