const express = require("express");
const router = express.Router();
const pool = require("../db");
const { richiediBiblioteca } = require("../services/biblioteca");
const { utenteScrive } = require("../services/utenti");

// --------------------------------------------------
// LE NOTE
//
// Testo libero attaccato a una serie. Si scrivono dal libro aperto in
// "in lettura" e si rileggono dalla scheda della serie, che è dove
// restano quando la lettura è finita o mollata.
//
// Non c'è una GET: le note arrivano già attaccate alle schede in
// `GET /api/manga` (campo `Note`), come i voti e le droppate. Una
// richiesta in meno per pagina.
//
// Si LEGGONO in due — è tutto il senso del colore accanto a ognuna —
// ma si SCRIVE solo la propria: la condizione sull'utente nelle rotte
// di modifica non è un dettaglio di sicurezza, è quello che impedisce
// di correggere il pensiero di un altro credendo di correggere il
// proprio.
// --------------------------------------------------

// Un limite serve, o basta un incollaggio distratto per mandare in
// pagina un muro di testo che nessuna scheda riesce a contenere.
const TESTO_MAX = 2000;

function testoValido(grezzo) {
  const testo = String(grezzo ?? "").trim();

  if (!testo) return { errore: "La nota è vuota." };
  if (testo.length > TESTO_MAX) {
    return { errore: `La nota non può superare i ${TESTO_MAX} caratteri.` };
  }

  return { testo };
}

// POST /api/note — una nota nuova su una serie
router.post("/", richiediBiblioteca, async (req, res) => {
  try {
    const { manga_id, testo: grezzo } = req.body;

    if (!manga_id) {
      return res.status(400).json({ error: "manga_id è obbligatorio" });
    }

    const { testo, errore } = testoValido(grezzo);
    if (errore) return res.status(400).json({ error: errore });

    const utenteId = await utenteScrive(req);

    const { rows } = await pool.query(
      `
      INSERT INTO note_serie (manga_id, utente_id, testo)
      VALUES ($1, $2, $3)
      RETURNING id, manga_id, utente_id, testo, creata_il, aggiornata_il
      `,
      [Number(manga_id), utenteId, testo]
    );

    // La scheda deve poter disegnare la nota appena creata senza
    // ricaricare la collezione: le si allega chi l'ha scritta, che è
    // l'unica cosa che l'INSERT non sa dire.
    const { rows: chi } = await pool.query(
      `SELECT nickname, colore FROM utenti WHERE id = $1`,
      [utenteId]
    );

    return res.status(201).json({
      success: true,
      nota: {
        id: Number(rows[0].id),
        utenteId: Number(rows[0].utente_id),
        nickname: chi[0]?.nickname ?? null,
        colore: chi[0]?.colore ?? null,
        testo: rows[0].testo,
        creataIl: rows[0].creata_il,
        aggiornataIl: rows[0].aggiornata_il
      }
    });
  } catch (err) {
    console.error("NOTE POST ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

// PUT /api/note/:id — correggere quello che si è scritto
router.put("/:id", richiediBiblioteca, async (req, res) => {
  try {
    const { testo, errore } = testoValido(req.body?.testo);
    if (errore) return res.status(400).json({ error: errore });

    const utenteId = await utenteScrive(req);

    const { rows } = await pool.query(
      `
      UPDATE note_serie
      SET testo = $1, aggiornata_il = NOW()
      WHERE id = $2 AND utente_id = $3
      RETURNING id, testo, aggiornata_il
      `,
      [testo, Number(req.params.id), utenteId]
    );

    // Non trovata o non tua: da fuori è la stessa cosa, e va bene così.
    if (rows.length === 0) {
      return res.status(404).json({ error: "Nota non trovata" });
    }

    return res.json({ success: true, nota: rows[0] });
  } catch (err) {
    console.error("NOTE PUT ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

// DELETE /api/note/:id
router.delete("/:id", richiediBiblioteca, async (req, res) => {
  try {
    const utenteId = await utenteScrive(req);

    const { rowCount } = await pool.query(
      `DELETE FROM note_serie WHERE id = $1 AND utente_id = $2`,
      [Number(req.params.id), utenteId]
    );

    if (rowCount === 0) {
      return res.status(404).json({ error: "Nota non trovata" });
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("NOTE DELETE ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

module.exports = router;
