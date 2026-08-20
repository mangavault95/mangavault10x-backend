const express = require("express");
const router = express.Router();
const pool = require("../db");
const { requireAuth, identificaUtente } = require("../services/auth");
const { utenteLetto, utenteScrive } = require("../services/utenti");

// --------------------------------------------------
// LE LETTURE SONO DI QUALCUNO
//
// Finché il lettore era uno, la cronologia era "la" cronologia. Adesso
// ogni riga ha un padrone, e le regole sono due, diverse fra loro:
//
//   in LETTURA  chi guarda lo dice l'indirizzo (`?utente=3`), o il
//               token, o — se non c'è nessuno dei due — il proprietario.
//               Da fuori la biblioteca resta quella di sempre.
//
//   in SCRITTURA chi scrive lo dice SOLO il token. Segnare un volume
//               come letto è un fatto personale: nessuno deve poterlo
//               fare a nome di un altro cambiando un numero
//               nell'indirizzo. Per questo qui è comparso `requireAuth`,
//               che prima non c'era.
// --------------------------------------------------

// --------------------------------------------------
// GET /api/reading-history
// Lo scorrimento cronologico: un volume per riga.
//
// Il limite era fisso a 30, il che bastava per un "ultimi letti"
// ma non per ricostruire gli scaffali. Ora è un parametro.
// --------------------------------------------------
router.get("/", identificaUtente, async (req, res) => {
  const limite = Math.min(Math.max(Number(req.query.limit) || 60, 1), 500);

  try {
    const utenteId = await utenteLetto(req);

    const result = await pool.query(
      `
      SELECT id, manga_id, titolo, autore, coverurl, volume, read_at
      FROM reading_history
      WHERE utente_id = $2
      ORDER BY read_at DESC
      LIMIT $1
      `,
      [limite, utenteId]
    );

    return res.json(result.rows);
  } catch (err) {
    console.error("READING HISTORY GET ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

// --------------------------------------------------
// GET /api/reading-history/per-serie
//
// La stessa cronologia vista per scaffale invece che per data:
// una riga per serie, con dentro l'elenco dei volumi letti.
//
// Il raggruppamento sta qui e non nel browser perché il numero di
// righe cresce con gli anni, mentre le serie restano poche centinaia:
// mandare 2.000 volumi per farne 180 gruppi sarebbe spreco.
// --------------------------------------------------
router.get("/per-serie", identificaUtente, async (req, res) => {
  try {
    const utenteId = await utenteLetto(req);

    const result = await pool.query(
      `
      SELECT
        h.manga_id,
        COALESCE(m."Titolo", MAX(h.titolo))       AS titolo,
        COALESCE(m."Autore", MAX(h.autore))       AS autore,
        COALESCE(m."CoverURL", MAX(h.coverurl))   AS coverurl,
        m."VolumiTotali"                          AS volumitotali,
        m."StatoSerie"                            AS statoserie,
        m."Editore"                               AS editore,
        m."Droppato"                               AS droppato,

        -- I volumi distinti in ordine: rileggere lo stesso volume
        -- due volte non deve farlo comparire doppio sullo scaffale.
        ARRAY_AGG(DISTINCT h.volume ORDER BY h.volume) AS volumi,
        COUNT(DISTINCT h.volume)::int                  AS volumi_letti,
        MIN(h.read_at)                                 AS primo,
        MAX(h.read_at)                                 AS ultimo

      FROM reading_history h
      LEFT JOIN "Manga" m ON m."ID" = h.manga_id
      WHERE h.utente_id = $1
      GROUP BY h.manga_id, m."Titolo", m."Autore", m."CoverURL",
               m."VolumiTotali", m."StatoSerie", m."Editore", m."Droppato"
      ORDER BY MAX(h.read_at) DESC
      `,
      [utenteId]
    );

    return res.json(result.rows);
  } catch (err) {
    console.error("READING HISTORY PER-SERIE ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

// --------------------------------------------------
// POST /api/reading-history
// --------------------------------------------------
router.post("/", requireAuth, async (req, res) => {
  try {
    const { manga_id, titolo, autore, coverurl, volume } = req.body;

    if (!manga_id || !titolo) {
      return res.status(400).json({
        error: "manga_id e titolo sono obbligatori"
      });
    }

    const utenteId = await utenteScrive(req);

    const result = await pool.query(
      `
      INSERT INTO reading_history
      (manga_id, titolo, autore, coverurl, volume, read_at, utente_id)
      VALUES ($1, $2, $3, $4, $5, NOW(), $6)
      RETURNING *
      `,
      [Number(manga_id), titolo, autore || "", coverurl || "", Number(volume) || 0, utenteId]
    );

    return res.status(201).json({ success: true, item: result.rows[0] });
  } catch (err) {
    console.error("READING HISTORY POST ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

// --------------------------------------------------
// DELETE /api/reading-history/:id
// Serve per correggere: un volume segnato per sbaglio deve poter
// sparire, altrimenti lo storico diventa inaffidabile e si smette
// di fidarsene.
//
// Si cancella solo la propria riga: la condizione sull'utente non è
// un dettaglio di sicurezza, è quello che impedisce di correggere per
// sbaglio la cronologia dell'altra persona.
// --------------------------------------------------
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const utenteId = await utenteScrive(req);

    const { rowCount } = await pool.query(
      `DELETE FROM reading_history WHERE id = $1 AND utente_id = $2`,
      [req.params.id, utenteId]
    );

    if (rowCount === 0) {
      return res.status(404).json({ error: "Voce non trovata" });
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("READING HISTORY DELETE ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

module.exports = router;
