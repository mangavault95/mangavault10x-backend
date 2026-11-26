const express = require("express");
const router = express.Router();
const pool = require("../db");
const { requireAuth } = require("../services/auth");
const { utenteScrive } = require("../services/utenti");
const { limite } = require("../services/limite");
const push = require("../services/push");

/**
 * LE NOTIFICHE PUSH — chi si iscrive e come si prova.
 *
 *   GET    /api/push/chiave        la chiave pubblica, o 404 se il push è spento
 *   POST   /api/push/sottoscrivi   questo dispositivo vuole le notifiche
 *   DELETE /api/push/sottoscrivi   questo dispositivo non le vuole più
 *   POST   /api/push/prova         una notifica di prova a TUTTI i miei dispositivi
 *
 * Tutto, tranne la chiave (che è pubblica per definizione), vuole un accesso: una
 * notifica ha un destinatario, e chi non è entrato non ne ha. CHI è il
 * destinatario lo dice il token e nient'altro (`utenteScrive`): un numero
 * nell'indirizzo non deve poter iscrivere il telefono di qualcuno alle notifiche
 * di un altro.
 */

const limiteScrittura = limite({
  finestraMs: 15 * 60 * 1000,
  massimo: 30,
  messaggio: "Troppe richieste. Riprova fra qualche minuto."
});

// Una prova ogni tanto, non una raffica: ogni prova è una chiamata a un servizio altrui.
const limiteProva = limite({
  finestraMs: 15 * 60 * 1000,
  massimo: 5,
  messaggio: "Troppe prove. Riprova fra qualche minuto."
});

function manca(res, err) {
  // 42P01 = tabella che non c'è: la migrazione 037 non è ancora stata eseguita.
  if (err.code === "42P01") {
    return res.status(503).json({ error: "Le notifiche non sono ancora pronte: riprova fra poco." });
  }

  console.error("PUSH ERROR:", err);
  return res.status(500).json({ error: "Errore server" });
}

router.get("/chiave", (req, res) => {
  const chiave = push.chiavePubblica();

  if (!chiave) return res.status(404).json({ error: "Le notifiche non sono attive" });

  return res.json({ chiave });
});

router.post("/sottoscrivi", requireAuth, limiteScrittura, async (req, res) => {
  if (!push.configurato()) return res.status(404).json({ error: "Le notifiche non sono attive" });

  const sottoscrizione = push.leggiSottoscrizione(req.body);

  if (!sottoscrizione) return res.status(400).json({ error: "Sottoscrizione non valida" });

  try {
    const utenteId = await utenteScrive(req);

    // Il tappo conta i dispositivi DIVERSI da questo: ripetere la stessa iscrizione non lo consuma.
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS quanti FROM push_sottoscrizioni WHERE utente_id = $1 AND endpoint <> $2`,
      [utenteId, sottoscrizione.endpoint]
    );

    if (rows[0].quanti >= push.MASSIMO_PER_PERSONA) {
      return res.status(400).json({ error: "Troppi dispositivi: toglierne qualcuno prima di aggiungerne un altro." });
    }

    // Lo stesso dispositivo passa a chi si iscrive per ultimo (vedi la 037).
    await pool.query(
      `
      INSERT INTO push_sottoscrizioni (utente_id, endpoint, p256dh, auth)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (endpoint) DO UPDATE
        SET utente_id = EXCLUDED.utente_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth
      `,
      [utenteId, sottoscrizione.endpoint, sottoscrizione.p256dh, sottoscrizione.auth]
    );

    return res.status(201).json({ success: true });
  } catch (err) {
    return manca(res, err);
  }
});

router.delete("/sottoscrivi", requireAuth, limiteScrittura, async (req, res) => {
  const endpoint = String(req.body?.endpoint || "");

  if (!endpoint || endpoint.length > 1000) return res.status(400).json({ error: "Indirizzo mancante" });

  try {
    const utenteId = await utenteScrive(req);

    // Solo le proprie: l'indirizzo di un altro non si può cancellare.
    await pool.query(`DELETE FROM push_sottoscrizioni WHERE endpoint = $1 AND utente_id = $2`, [endpoint, utenteId]);

    return res.json({ success: true });
  } catch (err) {
    return manca(res, err);
  }
});

router.post("/prova", requireAuth, limiteProva, async (req, res) => {
  if (!push.configurato()) return res.status(404).json({ error: "Le notifiche non sono attive" });

  try {
    const utenteId = await utenteScrive(req);

    const consegnati = await push.inviaAPersona(pool, utenteId, {
      titolo: "MangaVault",
      corpo: "Le notifiche funzionano.",
      url: "/",
      tag: "prova"
    });

    if (consegnati === 0) {
      return res.status(409).json({ error: "Nessun dispositivo iscritto, o il servizio non ha risposto." });
    }

    return res.json({ success: true, consegnati });
  } catch (err) {
    return manca(res, err);
  }
});

module.exports = router;
