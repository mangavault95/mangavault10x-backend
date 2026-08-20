const express = require("express");
const router = express.Router();
const { requireAuth, requireProprietario } = require("../services/auth");
const utenti = require("../services/utenti");

/**
 * Le persone.
 *
 * Tre porte diverse, e conviene tenerle distinte in testa:
 *
 *   /login          — entra chi c'è già
 *   /registrazione  — chiede di entrare chi non c'è ancora
 *   /richieste      — chi ha chiesto, visto dal proprietario
 *
 * La terza è l'unica che il sito mostra come "notifica": una richiesta
 * di accesso non è una mail da mandare, è una riga che aspetta e che
 * si vede appena si apre Gestione.
 */

/* ==================================================
   ENTRARE
   ================================================== */

async function gestisciLogin(req, res) {
  const { username, password } = req.body || {};

  try {
    const esito = await utenti.accedi(username, password);

    if (esito.errore === utenti.MOTIVI.IN_ATTESA) {
      // 403 e non 401: le credenziali sono giuste, manca il permesso.
      // La differenza serve al browser per dire la cosa giusta invece
      // di far ricontrollare una password che è corretta.
      return res.status(403).json({
        error: "La tua richiesta è in attesa di approvazione.",
        motivo: utenti.MOTIVI.IN_ATTESA
      });
    }

    if (esito.errore === utenti.MOTIVI.RIFIUTATO) {
      return res.status(403).json({
        error: "Questo accesso non è stato approvato.",
        motivo: utenti.MOTIVI.RIFIUTATO
      });
    }

    if (esito.errore) {
      return res.status(401).json({ error: "Credenziali errate" });
    }

    return res.json({ token: esito.token, utente: esito.utente });
  } catch (err) {
    console.error("❌ LOGIN ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
}

router.post("/login", gestisciLogin);

/* ==================================================
   CHIEDERE DI ENTRARE
   ================================================== */

// Quante richieste in attesa si accettano prima di dire basta. Non è
// una difesa da attacco vero, è un tappo: senza, chiunque trovi
// l'indirizzo può riempire la schermata di Gestione di righe finte.
const MASSIME_IN_ATTESA = 10;

router.post("/registrazione", async (req, res) => {
  const { username, nickname, password } = req.body || {};

  try {
    const inCoda = await utenti.richieste();

    if (inCoda.length >= MASSIME_IN_ATTESA) {
      return res.status(429).json({
        error: "Ci sono troppe richieste in attesa. Riprova più tardi."
      });
    }

    const esito = await utenti.registra({ username, nickname, password });

    if (esito.errore) {
      return res.status(400).json({ error: esito.errore });
    }

    return res.status(201).json({ utente: esito.utente });
  } catch (err) {
    console.error("❌ REGISTRAZIONE ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

/* ==================================================
   CHI SIETE
   ================================================== */

/**
 * I soprannomi di chi può votare.
 *
 * Aperta apposta: la scheda di una serie deve poter scrivere "Voto
 * Nicer" e "Voto <lei>" anche a chi sta guardando senza essere
 * entrato, altrimenti i due voti sarebbero due numeri senza nome.
 */
router.get("/pubblici", async (req, res) => {
  try {
    return res.json(await utenti.pubblici());
  } catch (err) {
    if (err.code === "42P01") return res.json([]);

    console.error("❌ UTENTI PUBBLICI ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

/** Chi sono io, secondo il token che ho in mano. */
router.get("/io", requireAuth, (req, res) => {
  return res.json({
    id: req.user.id ?? null,
    username: req.user.user,
    nickname: req.user.nickname ?? req.user.user,
    ruolo: req.user.role,
    proprietario: Boolean(req.user.proprietario)
  });
});

/* ==================================================
   LA LISTA, E LE DECISIONI
   ================================================== */

router.get("/", requireProprietario, async (req, res) => {
  try {
    return res.json(await utenti.elenco());
  } catch (err) {
    console.error("❌ UTENTI ELENCO ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

router.get("/richieste", requireProprietario, async (req, res) => {
  try {
    return res.json(await utenti.richieste());
  } catch (err) {
    if (err.code === "42P01") return res.json([]);

    console.error("❌ UTENTI RICHIESTE ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

router.post("/:id/approva", requireProprietario, (req, res) => decide(req, res, true));
router.post("/:id/rifiuta", requireProprietario, (req, res) => decide(req, res, false));

async function decide(req, res, approvato) {
  const id = Number(req.params.id);

  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "Identificativo non valido" });
  }

  try {
    const utente = await utenti.decidi(id, approvato);

    if (!utente) {
      return res.status(404).json({ error: "Richiesta non trovata" });
    }

    return res.json({ utente });
  } catch (err) {
    console.error("❌ UTENTI DECISIONE ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
}

module.exports = router;

// L'accesso si raggiunge anche dal vecchio indirizzo `/api/manga/login`,
// che è quello che il sito pubblicato chiama da mesi. Esporto la
// funzione invece di rimbalzare la richiesta da un router all'altro:
// due strade per la stessa porta, una sola implementazione.
module.exports.gestisciLogin = gestisciLogin;
