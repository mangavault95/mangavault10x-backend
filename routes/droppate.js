const express = require("express");
const router = express.Router();
const pool = require("../db");
const { requireAuth } = require("../services/auth");
const { utenteScrive } = require("../services/utenti");

// --------------------------------------------------
// MOLLARE UNA SERIE È UNA DECISIONE DI CHI LEGGE
//
// Era una colonna di "Manga" (`Droppato`), cioè un fatto dell'opera.
// Ma "ho smesso di leggerla" sta dalla parte dei voti, non da quella
// dei volumi posseduti: due persone possono leggere la stessa serie e
// solo una mollarla. Con la colonna in comune, la serie che uno
// droppava spariva anche dall'elenco dell'altra.
//
// Non c'è una lettura qui: le droppate arrivano attaccate alle schede
// in `GET /api/manga` (campo `Droppate`), come i voti. Una richiesta
// in meno per pagina, e la collezione è già l'unica cosa che il
// browser scarica.
//
// In scrittura chi sei lo dice SOLO il token, come ovunque da quando i
// lettori sono due: un numero nell'indirizzo non deve poter mollare
// una serie al posto di un altro.
// --------------------------------------------------

// POST /api/letture-droppate/:mangaId — l'ho mollata
router.post("/:mangaId", requireAuth, async (req, res) => {
  try {
    const utenteId = await utenteScrive(req);

    // Droppare due volte non è un errore: è il risultato che conta, e
    // un click ripetuto sul telefono non deve dare un 500.
    await pool.query(
      `
      INSERT INTO letture_droppate (manga_id, utente_id)
      VALUES ($1, $2)
      ON CONFLICT (manga_id, utente_id) DO NOTHING
      `,
      [Number(req.params.mangaId), utenteId]
    );

    return res.json({ success: true });
  } catch (err) {
    console.error("DROPPATE POST ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

// DELETE /api/letture-droppate/:mangaId — l'ho ripresa in mano
router.delete("/:mangaId", requireAuth, async (req, res) => {
  try {
    const utenteId = await utenteScrive(req);

    await pool.query(
      `DELETE FROM letture_droppate WHERE manga_id = $1 AND utente_id = $2`,
      [Number(req.params.mangaId), utenteId]
    );

    // Nessun 404 se non c'era: riprendere una serie che non avevi
    // droppato è già lo stato che volevi.
    return res.json({ success: true });
  } catch (err) {
    console.error("DROPPATE DELETE ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

module.exports = router;
