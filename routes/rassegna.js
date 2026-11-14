// routes/rassegna.js
//
//   GET /api/rassegna?anno=2026&utente=<id>   L'anno in rassegna di una persona.
//
// Si legge senza entrare, come le letture e la spesa del resto del sito (la decisione «le
// letture sono pubbliche» è già presa). Senza `utente` vale chi guarda (token) o il
// proprietario, come ovunque. Senza `anno` vale quello in corso.
//   POST /api/rassegna/annuncia                il messaggio di Telegram del 31 dicembre (cron)
//
// La rassegna di un anno si apre il 31 dicembre alle 00:00 (ora italiana): prima di allora
// la rotta risponde 403 con `disponibileDal`. Gli anni passati restano aperti.
// Vedi `services/rassegna.js` per cosa c'è dentro e per il limite degli acquisti (della casa).

const express = require("express");
const pool = require("../db");
const { limite } = require("../services/limite");
const { identificaUtente } = require("../services/auth");
const { utenteLetto } = require("../services/utenti");
const { rassegna, disponibile, giornoApertura, oggiInItalia } = require("../services/rassegna");
const { richiedeSegretoCron } = require("../services/segretoCron");
const telegram = require("../services/telegram");

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

  if (!disponibile(anno, oggiInItalia())) {
    return res.status(403).json({ error: "La rassegna si apre il 31 dicembre", disponibileDal: giornoApertura(anno) });
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

/**
 * Il messaggio del 31 dicembre: a ciascuno la sua rassegna, sul telefono, non silenzioso
 * (deve comparire come una notifica). Parte dal bot delle uscite, quello a cui ognuno ha
 * collegato la propria chat. Vale solo dal 31 dicembre: chiamarlo prima non manda niente,
 * così un giro programmato fuori data non scrive a nessuno.
 *
 * `prova: true` dice cosa manderebbe e a chi, senza mandare niente.
 */
router.post("/annuncia", richiedeSegretoCron, async (req, res) => {
  const prova = req.body?.prova === true;
  const oggi = oggiInItalia();
  const anno = Number(oggi.slice(0, 4));

  if (!disponibile(anno, oggi)) {
    return res.status(409).json({ success: false, inviati: 0, error: `La rassegna si apre il ${giornoApertura(anno)}` });
  }

  try {
    const { rows } = await pool.query(
      `SELECT id, nickname, telegram_chat_id FROM utenti
        WHERE stato = 'attivo' AND telegram_chat_id IS NOT NULL ORDER BY id`
    );

    const sito = process.env.SITO_URL || "https://mangavault10x-frontend.vercel.app";
    const testo = (u) =>
      `🎁 <b>Il tuo ${anno} in rassegna è pronto, ${telegram.esc(u.nickname)}!</b>\n\n` +
      `Manga letti, anime guardati, i mesi più intensi e molto altro:\n` +
      `${telegram.esc(sito)}/rassegna?u=${u.id}&anno=${anno}`;

    if (rows.length === 0) {
      return res.status(409).json({ success: false, inviati: 0, error: "Nessuno ha la chat Telegram collegata" });
    }

    if (prova) return res.json({ success: true, prova: true, inviati: 0, destinatari: rows.map((u) => u.nickname) });

    if (!telegram.configurato()) {
      return res.status(503).json({ success: false, inviati: 0, error: "Il bot delle uscite non è configurato" });
    }

    let inviati = 0;
    let falliti = 0;

    for (const u of rows) {
      const esito = await telegram.invia(u.telegram_chat_id, testo(u));

      if (esito.ok) inviati += 1;
      else falliti += 1;
    }

    // Se qualcuno non l'ha ricevuto il giro risulta fallito: GitHub lo segnala.
    return res.status(falliti ? 502 : 200).json({ success: falliti === 0, inviati, falliti });
  } catch (err) {
    console.error("RASSEGNA ANNUNCIA ERROR:", err.message);

    return res.status(500).json({ success: false, inviati: 0, error: "Errore server" });
  }
});

module.exports = router;
