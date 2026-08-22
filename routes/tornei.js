const express = require("express");
const router = express.Router();
const { richiediBiblioteca } = require("../services/biblioteca");
const { utenteScrive } = require("../services/utenti");
const tornei = require("../services/tornei");

/**
 * Il Kachinuki-sen (勝ち抜き戦): il torneo a eliminazione fra le serie
 * in collezione.
 *
 * Le regole di chi-sei sono le stesse del resto del sito: in lettura
 * si vede tutto senza entrare — la cronologia è un albo, non un
 * diario — mentre giocare e salvare vuole il token, perché una partita
 * appartiene a chi l'ha giocata.
 *
 * La ricostruzione del tabellone sta in services/tornei.js: qui non si
 * decide niente sul contenuto, si smistano richieste.
 */

// Prima che sql/010_kachinuki.sql sia stato eseguito su Supabase le
// tabelle non esistono. Non è un errore da mostrare in faccia a chi
// apre la pagina: la cronologia è semplicemente vuota, e chi prova a
// giocare va avvisato con parole sue.
const TABELLA_ASSENTE = "42P01";

router.get("/", async (req, res) => {
  try {
    return res.json(await tornei.elenco({ limite: req.query.limite }));
  } catch (err) {
    if (err.code === TABELLA_ASSENTE) return res.json([]);

    console.error("❌ GET TORNEI ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

router.get("/:id", async (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isInteger(id)) return res.status(400).json({ error: "Partita non valida" });

  try {
    const partita = await tornei.dettaglio(id);

    if (!partita) return res.status(404).json({ error: "Partita non trovata" });

    return res.json(partita);
  } catch (err) {
    if (err.code === TABELLA_ASSENTE) return res.status(404).json({ error: "Partita non trovata" });

    console.error("❌ GET TORNEO ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

/**
 * Salva una partita finita.
 *
 * Chi ha giocato lo dice il token e mai il corpo della richiesta: è la
 * stessa regola dei voti, e per la stessa ragione — un numero che
 * arriva da fuori non deve poter attribuire a un'altra persona una
 * cosa che non ha fatto.
 */
router.post("/", richiediBiblioteca, async (req, res) => {
  const { errore, partita } = tornei.valida(req.body);

  if (errore) return res.status(400).json({ error: errore });

  try {
    const utenteId = await utenteScrive(req);

    if (!utenteId) return res.status(500).json({ error: "Utente non riconosciuto" });

    const salvata = await tornei.salva(partita, utenteId);

    return res.status(201).json({ success: true, ...salvata });
  } catch (err) {
    if (err.code === TABELLA_ASSENTE) {
      return res.status(503).json({
        error: "La cronologia delle partite non è ancora attiva."
      });
    }

    console.error("❌ SALVA TORNEO ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

router.delete("/:id", richiediBiblioteca, async (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isInteger(id)) return res.status(400).json({ error: "Partita non valida" });

  try {
    const utenteId = await utenteScrive(req);

    const fatto = await tornei.elimina(id, utenteId, req.user?.proprietario);

    if (!fatto) {
      return res.status(404).json({ error: "Partita non trovata, o non è tua" });
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("❌ ELIMINA TORNEO ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

module.exports = router;
