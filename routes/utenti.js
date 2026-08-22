const express = require("express");
const router = express.Router();
const { requireAuth, requireProprietario } = require("../services/auth");
const utenti = require("../services/utenti");
const immagini = require("../services/immagini");

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
    // 42P01 = tabella che non c'è, 42703 = colonna che non c'è.
    // Sono i due modi in cui questa rotta può rompersi nella mezz'ora
    // fra il codice nuovo su Vercel e la migrazione eseguita a mano:
    // un elenco vuoto è un'attesa, un 500 sembra un guasto.
    if (err.code === "42P01" || err.code === "42703") return res.json([]);

    console.error("❌ UTENTI PUBBLICI ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

/* ==================================================
   LA FACCIA E LO STRISCIONE
   ==================================================

   Le immagini di profilo hanno un indirizzo loro invece di viaggiare
   dentro il JSON, ed è la scelta che tiene leggero il Cineforum: là
   la stessa faccia compare quindici volte per pagina, e in base64
   sarebbero quindici copie degli stessi trenta kilobyte. Così il
   browser la scarica una volta e se la tiene per un anno.

   LEGGERE è di tutti — una faccia si vede anche senza essere entrati,
   come il soprannome. SCRIVERE è solo la propria: non esiste
   `/utenti/:id/faccia` in scrittura, esiste `/utenti/io/faccia`, così
   non c'è nemmeno la strada per cambiare la faccia di un altro. */

/** GET /api/utenti/:id/faccia — l'immagine tonda di qualcuno. */
router.get("/:id/faccia", async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id)) return res.status(400).end();

    const trovata = await utenti.faccia(id);

    if (!trovata) return res.status(404).end();

    res.set(immagini.intestazioni(trovata.dati, trovata.tipo, trovata.quando));

    return res.end(trovata.dati);
  } catch (err) {
    if (err.code === "42703" || err.code === "42P01") return res.status(404).end();

    console.error("❌ FACCIA ERROR:", err);
    return res.status(500).end();
  }
});

/** PUT /api/utenti/io/faccia — la propria, e solo la propria. */
router.put("/io/faccia", requireAuth, async (req, res) => {
  try {
    const { dati, tipo, errore } = immagini.decodifica(req.body?.immagine, {
      massimo: utenti.PESO_FACCIA
    });

    if (errore) return res.status(400).json({ error: errore });

    const id = await utenti.utenteScrive(req);

    await utenti.mettiFaccia(id, dati, tipo);

    // Il momento torna indietro perché è quello che il browser deve
    // appendere all'indirizzo: senza, continuerebbe a mostrare quella
    // di prima, che ha in cache per un anno.
    return res.json({ faccia: Date.now() });
  } catch (err) {
    if (err.code === "42703") {
      return res.status(503).json({ error: "Migrazione 017 non ancora eseguita" });
    }

    console.error("❌ FACCIA PUT ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

/** DELETE /api/utenti/io/faccia — si torna all'iniziale colorata. */
router.delete("/io/faccia", requireAuth, async (req, res) => {
  try {
    await utenti.togliFaccia(await utenti.utenteScrive(req));

    return res.json({ faccia: null });
  } catch (err) {
    console.error("❌ FACCIA DELETE ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

/** GET /api/utenti/striscione/:id — una delle immagini della fascia. */
router.get("/striscione/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id)) return res.status(400).end();

    const trovata = await utenti.immagineStriscione(id);

    if (!trovata) return res.status(404).end();

    res.set(immagini.intestazioni(trovata.dati, trovata.tipo, trovata.quando));

    return res.end(trovata.dati);
  } catch (err) {
    if (err.code === "42P01") return res.status(404).end();

    console.error("❌ STRISCIONE ERROR:", err);
    return res.status(500).end();
  }
});

/**
 * PUT /api/utenti/io/striscione — la fascia, riscritta per intero.
 *
 * Il corpo è `{ immagini: [...] }`, dove ogni voce è o un numero —
 * un'immagine già lì, da tenere — o un data URI nuovo. Un solo
 * indirizzo per aggiungere, togliere e riordinare: sono la stessa
 * cosa vista da tre lati, e tre rotte separate avrebbero significato
 * tre modi di far andare l'ordine fuori sincrono.
 */
router.put("/io/striscione", requireAuth, async (req, res) => {
  try {
    const elenco = req.body?.immagini;

    if (!Array.isArray(elenco)) {
      return res.status(400).json({ error: "Serve un elenco di immagini" });
    }

    if (elenco.length > utenti.QUANTE_IMMAGINI) {
      return res.status(400).json({
        error: `Nello striscione stanno al massimo ${utenti.QUANTE_IMMAGINI} immagini`
      });
    }

    const pezzi = [];

    for (const voce of elenco) {
      if (typeof voce === "number" && Number.isInteger(voce)) {
        pezzi.push(voce);
        continue;
      }

      const { dati, tipo, errore } = immagini.decodifica(voce, {
        massimo: utenti.PESO_IMMAGINE
      });

      if (errore) return res.status(400).json({ error: errore });

      pezzi.push({ dati, tipo });
    }

    const id = await utenti.utenteScrive(req);

    // Le immagini «da tenere» si accettano solo se sono davvero sue:
    // senza questo, un numero qualunque nell'elenco si porterebbe in
    // casa l'immagine di un altro. `mettiStriscione` lo garantisce
    // sull'aggiornamento (WHERE utente_id), ma è meglio dirlo qui e
    // rispondere invece di ignorare in silenzio.
    return res.json({ striscione: await utenti.mettiStriscione(id, pezzi) });
  } catch (err) {
    if (err.code === "42P01") {
      return res.status(503).json({ error: "Migrazione 017 non ancora eseguita" });
    }

    console.error("❌ STRISCIONE PUT ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

/**
 * Chi sono io, secondo il token che ho in mano.
 *
 * Tutto viene dal token tranne `biblioteca`, che si chiede al
 * database: il token dura trenta giorni e direbbe il permesso di un
 * mese fa. È l'unica cosa qui dentro che possa cambiare senza che si
 * rifaccia l'accesso.
 */
router.get("/io", requireAuth, async (req, res) => {
  const id = req.user.id == null ? null : Number(req.user.id);

  return res.json({
    id,
    username: req.user.user,
    nickname: req.user.nickname ?? req.user.user,
    ruolo: req.user.role,
    proprietario: Boolean(req.user.proprietario),
    biblioteca: Boolean(req.user.proprietario) || (await utenti.haBiblioteca(id))
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

/**
 * Apre o chiude la biblioteca a qualcuno.
 *
 * È l'unico modo di entrarci: non c'è una registrazione che la dia e
 * non c'è un ruolo che la implichi. Chi si iscrive dal sito prende la
 * videoteca; la biblioteca la dà il proprietario, uno per uno, da
 * questa rotta — che è quello che si vede in Gestione come un
 * interruttore accanto a un nome.
 *
 * Restituisce la riga aggiornata invece di un `success`: la Gestione
 * ridisegna la persona senza richiedere l'elenco intero.
 */
router.post("/:id/biblioteca", requireProprietario, async (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "Identificativo non valido" });
  }

  try {
    const utente = await utenti.impostaBiblioteca(id, Boolean(req.body?.dentro));

    // Nessuna riga: o non esiste, o è il proprietario (che non si può
    // chiudere fuori da casa sua), o non è ancora stato accettato.
    if (!utente) {
      return res.status(404).json({ error: "Persona non trovata" });
    }

    return res.json({ utente });
  } catch (err) {
    if (err.code === "42703") {
      return res.status(503).json({ error: "Migrazione 018 non ancora eseguita" });
    }

    console.error("❌ UTENTI BIBLIOTECA ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

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
