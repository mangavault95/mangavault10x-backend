const express = require("express");
const router = express.Router();
const pool = require("../db");
const { login, requireAuth } = require("../services/auth");
const { enrich } = require("../services/enrich");
const { eseguiRapportoVolumi } = require("../services/rapportoVolumi");

// --------------------------------------------------
// ENRICH — dati di una serie dalle fonti esterne
// --------------------------------------------------
router.post("/enrich", async (req, res) => {
  try {
    const { titolo, autore } = req.body;

    if (!titolo) {
      return res.status(400).json({ error: "Titolo mancante" });
    }

    const result = await enrich(titolo, autore);

    if (!result.trovato) {
      return res.json({ error: "Nessun risultato trovato", dettagli: result.errori });
    }

    // Il titolo lo decide l'utente: le fonti danno il romaji/giapponese,
    // ma in collezione vale l'edizione italiana.
    return res.json({ titolo, ...result });
  } catch (err) {
    console.error("❌ ENRICH ERROR:", err);
    return res.status(500).json({ error: err.message });
  }
});

// --------------------------------------------------
// ENRICH BULK — ricompila le schede incomplete.
//
// Lavora a lotti (default 20) per non sforare i limiti
// delle API e non far scadere la richiesta HTTP.
// Rilanciarlo finché "rimanenti" non arriva a zero.
// --------------------------------------------------
router.post("/enrich-bulk", requireAuth, async (req, res) => {
  const limit = Math.min(Number(req.body?.limit) || 20, 50);
  const soloTrame = Boolean(req.body?.soloTrame);
  const soloCover = Boolean(req.body?.soloCover);
  const soloGenere = Boolean(req.body?.soloGenere);

  try {
    // Le copertine non AniList sono un problema a parte: miniature a
    // bassa risoluzione (AnimeClick), URL che si rompono (MyAnimeList)
    // o cache temporanee che scadono (gstatic). Queste schede possono
    // essere complete sotto ogni altro aspetto, quindi servono un
    // filtro dedicato.
    //
    // Stessa storia per il genere: il filtro generico sotto non lo
    // controlla, quindi una scheda già completa per il resto (trama,
    // editore, disegnatore...) può restare senza genere per sempre
    // se non la si cerca esplicitamente.
    let filtro;

    if (soloCover) {
      filtro = `("CoverURL" IS NULL OR "CoverURL" NOT LIKE '%anilist%')`;
    } else if (soloTrame) {
      filtro = `"Trama" IS NULL`;
    } else if (soloGenere) {
      filtro = `("Genere" IS NULL OR TRIM("Genere") = '')`;
    } else {
      filtro = `("Trama" IS NULL OR "Editore" IS NULL OR "VolumiTotali" IS NULL
                 OR "Disegnatore" IS NULL OR "StatoSerie" IS NULL)`;
    }

    // L'offset serve a non riprovare all'infinito le schede che le
    // fonti non riescono a risolvere: senza di esso ogni lotto
    // riparte dalle stesse prime N e il conteggio non scende mai.
    const offset = Math.max(Number(req.body?.offset) || 0, 0);

    const { rows } = await pool.query(
      `SELECT "ID", "Titolo", "Autore" FROM "Manga" WHERE ${filtro}
       ORDER BY "ID" LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    const esiti = [];
    let quotaEsaurita = false;

    for (const riga of rows) {
      try {
        const dati = await enrich(riga.Titolo, riga.Autore, { traduci: !soloCover });

        if (!dati.trovato) {
          esiti.push({ id: riga.ID, titolo: riga.Titolo, esito: "non trovato" });
          continue;
        }

        // Regola: riempio solo i campi vuoti, non sovrascrivo mai un
        // valore già presente — potresti averlo corretto a mano.
        //
        // Unica eccezione la copertina: una cover AniList è sempre
        // meglio di una miniatura AnimeClick o di un URL che scade,
        // quindi lì il dato nuovo vince.
        await pool.query(
          `
          UPDATE "Manga" SET
            "Trama"           = COALESCE("Trama",           $1),
            "CoverURL"        = COALESCE($2,  "CoverURL"),
            "Genere"          = COALESCE("Genere",          $3),
            "Disegnatore"     = COALESCE("Disegnatore",     $4),
            "VolumiTotali"    = COALESCE("VolumiTotali",    $5),
            "Editore"         = COALESCE("Editore",         $6),
            "Isbn"            = COALESCE("Isbn",            $7),
            "PrezzoCopertina" = COALESCE("PrezzoCopertina", $8),
            "StatoSerie"      = COALESCE("StatoSerie",      $9),
            "TitoloOriginale" = COALESCE("TitoloOriginale", $10),
            "AnnoInizio"      = COALESCE("AnnoInizio",      $11)
          WHERE "ID" = $12
          `,
          [
            dati.trama,
            dati.coverurl,
            dati.genere,
            dati.disegnatore,
            dati.volumitotali,
            dati.editore,
            dati.isbn,
            dati.prezzoCopertina,
            dati.statoSerie,
            dati.titoloOriginale,
            dati.annoInizio,
            riga.ID
          ]
        );

        esiti.push({
          id: riga.ID,
          titolo: riga.Titolo,
          esito: "aggiornato",
          tramaInItaliano: dati.tramaInItaliano
        });
      } catch (err) {
        // Quota del traduttore finita: inutile continuare, le schede
        // successive resterebbero senza trama. Mi fermo e lo dico.
        if (err.quotaEsaurita) {
          esiti.push({ id: riga.ID, titolo: riga.Titolo, esito: "quota esaurita" });
          quotaEsaurita = true;
          break;
        }

        esiti.push({ id: riga.ID, titolo: riga.Titolo, esito: "errore", messaggio: err.message });
      }

      // AniList consente 90 richieste/minuto: mi tengo largo.
      await new Promise((r) => setTimeout(r, 800));
    }

    const { rows: conteggio } = await pool.query(
      `SELECT COUNT(*)::int AS rimanenti FROM "Manga" WHERE ${filtro}`
    );

    return res.json({
      elaborati: esiti.length,
      aggiornati: esiti.filter((e) => e.esito === "aggiornato").length,
      conTramaItaliana: esiti.filter((e) => e.tramaInItaliano).length,
      rimanenti: conteggio[0].rimanenti,
      quotaEsaurita,
      messaggio: quotaEsaurita
        ? "Quota giornaliera del traduttore esaurita: riprendi domani."
        : undefined,
      esiti
    });
  } catch (err) {
    console.error("❌ ENRICH BULK ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

// --------------------------------------------------
// RAPPORTO VOLUMI — quanti volumi sono usciti in Italia.
//
// Chiamata dal job mensile su GitHub Actions (vedi
// .github/workflows/rapporto-volumi.yml), non da un browser: niente
// login admin, un segreto condiviso nell'header. `requireAuth` usa
// un JWT pensato per una sessione umana con scadenza breve, qui serve
// invece un token fisso che uno scheduler possa riusare per sempre.
//
// `timingSafeEqual` invece di `===`: altrimenti il tempo di risposta
// rivelerebbe quanti caratteri del segreto sono giusti, un carattere
// alla volta.
const crypto = require("crypto");

function richiedeSegretoCron(req, res, next) {
  const atteso = process.env.CRON_SECRET;
  const ricevuto = req.headers["x-cron-secret"] || "";

  if (!atteso) {
    return res.status(500).json({ error: "CRON_SECRET non configurato" });
  }

  const bufAtteso = Buffer.from(atteso);
  const bufRicevuto = Buffer.from(String(ricevuto));

  if (bufAtteso.length !== bufRicevuto.length || !crypto.timingSafeEqual(bufAtteso, bufRicevuto)) {
    return res.status(403).json({ error: "Segreto non valido" });
  }

  return next();
}

router.post("/rapporto-volumi", richiedeSegretoCron, async (req, res) => {
  const scrivi = req.body?.scrivi !== false; // il job schedulato scrive di default

  try {
    const risultato = await eseguiRapportoVolumi(pool, { scrivi });

    console.log(
      `📚 Rapporto volumi: ${risultato.scritte} aggiornate su ${risultato.mappate} mappate ` +
        `(${scrivi ? "scrittura" : "prova a vuoto"})`
    );

    return res.json(risultato);
  } catch (err) {
    console.error("❌ RAPPORTO VOLUMI ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

// --------------------------------------------------
// LOGIN
// --------------------------------------------------
router.post("/login", (req, res) => {
  const { username, password } = req.body;

  try {
    const token = login(username, password);

    if (!token) {
      return res.status(401).json({ error: "Credenziali errate" });
    }

    return res.json({ token });
  } catch (err) {
    console.error("❌ LOGIN CONFIG ERROR:", err.message);
    return res.status(500).json({ error: "Autenticazione non configurata" });
  }
});

// --------------------------------------------------
// UPDATE MANGA
// --------------------------------------------------
const CAMPI_AGGIORNABILI = {
  titolo: "Titolo",
  autore: "Autore",
  disegnatore: "Disegnatore",
  genere: "Genere",
  trama: "Trama",
  coverurl: "CoverURL",
  editore: "Editore",
  costo: "Costo",
  volumiposseduti: "VolumiPosseduti",
  volumitotali: "VolumiTotali",
  valutazione: "Valutazione",
  statoSerie: "StatoSerie",
  prezzoCopertina: "PrezzoCopertina",
  isbn: "Isbn",
  annoInizio: "AnnoInizio",
  titoloOriginale: "TitoloOriginale",
  preferito: "Preferito",
  droppato: "Droppato",
  edizione: "Edizione",
  operaId: "OperaId"
};

async function aggiornaManga(id, body) {
  const set = [];
  const valori = [];

  for (const [chiave, colonna] of Object.entries(CAMPI_AGGIORNABILI)) {
    if (body[chiave] === undefined) continue;

    valori.push(body[chiave] === "" ? null : body[chiave]);
    set.push(`"${colonna}" = $${valori.length}`);
  }

  if (set.length === 0) {
    return { errore: "Nessun campo da aggiornare" };
  }

  valori.push(id);

  const { rows } = await pool.query(
    `UPDATE "Manga" SET ${set.join(", ")} WHERE "ID" = $${valori.length} RETURNING *`,
    valori
  );

  return rows.length === 0 ? { errore: "Record non trovato" } : { riga: rows[0] };
}

// --------------------------------------------------
// CREA MANGA — una serie nuova, direttamente in collezione.
//
// Riusa la stessa mappa CAMPI_AGGIORNABILI dell'update: i campi
// accettati sono identici, così una scheda creata a mano e una
// modificata dopo passano dallo stesso filtro di sicurezza.
// --------------------------------------------------
router.post("/", requireAuth, async (req, res) => {
  try {
    const { titolo } = req.body;

    if (!titolo || !String(titolo).trim()) {
      return res.status(400).json({ error: "Titolo obbligatorio" });
    }

    // "ID" non ha un default automatico in questa tabella (nessuna
    // sequenza collegata) — va calcolato a mano, o l'INSERT fallisce
    // con "null value in column ID". Stessa ricetta già usata in
    // wishlistActions.js per portare una serie dalla wishlist qui.
    const { rows: prossimoId } = await pool.query(
      `SELECT COALESCE(MAX("ID"), 0) + 1 AS next_id FROM "Manga"`
    );

    const colonne = ['"ID"', '"Titolo"'];
    const valori = [prossimoId[0].next_id, String(titolo).trim()];

    for (const [chiave, colonna] of Object.entries(CAMPI_AGGIORNABILI)) {
      if (chiave === "titolo" || req.body[chiave] === undefined) continue;

      valori.push(req.body[chiave] === "" ? null : req.body[chiave]);
      colonne.push(`"${colonna}"`);
    }

    const segnaposto = colonne.map((_, i) => `$${i + 1}`).join(", ");

    const { rows } = await pool.query(
      `INSERT INTO "Manga" (${colonne.join(", ")}) VALUES (${segnaposto}) RETURNING *`,
      valori
    );

    return res.status(201).json({ success: true, creato: rows[0] });
  } catch (err) {
    console.error("❌ CREA MANGA ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

router.put("/:id", requireAuth, async (req, res) => {
  try {
    const esito = await aggiornaManga(req.params.id, req.body);

    if (esito.errore) {
      return res.status(esito.errore === "Record non trovato" ? 404 : 400).json({ error: esito.errore });
    }

    return res.json({ success: true, updated: esito.riga });
  } catch (err) {
    console.error("❌ PUT UPDATE MANGA ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

router.post("/update", requireAuth, async (req, res) => {
  try {
    const { id, ...campi } = req.body;

    if (!id) return res.status(400).json({ error: "ID mancante" });

    const esito = await aggiornaManga(id, campi);

    if (esito.errore) {
      return res.status(esito.errore === "Record non trovato" ? 404 : 400).json({ error: esito.errore });
    }

    return res.json({ success: true, updated: esito.riga });
  } catch (err) {
    console.error("❌ POST UPDATE MANGA ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

// --------------------------------------------------
// ELIMINA UNA SCHEDA
//
// Serve per le schede sbagliate (un doppione, una serie creata per
// prova) e per quelle che non si hanno più. Non c'è un cestino: la
// riga sparisce, quindi la conferma sta nell'interfaccia e qui si
// risponde con l'elenco di quello che se n'è andato insieme.
//
// `acquisti` e `prezzi_mercato` hanno il vincolo con ON DELETE
// CASCADE e si puliscono da soli. `reading_history` e
// `reading_sessions` no: hanno un `manga_id` senza vincolo, e senza
// queste due righe resterebbero lì a puntare a una scheda che non
// esiste più.
// --------------------------------------------------
router.delete("/:id", requireAuth, async (req, res) => {
  const cliente = await pool.connect();

  try {
    await cliente.query("BEGIN");

    const { rows: scheda } = await cliente.query(
      `SELECT "Titolo" FROM "Manga" WHERE "ID" = $1`,
      [req.params.id]
    );

    if (scheda.length === 0) {
      await cliente.query("ROLLBACK");
      return res.status(404).json({ error: "Record non trovato" });
    }

    // Contati prima: dopo la DELETE non c'è più niente da contare, e
    // dire cosa si è portata via è metà del valore della risposta.
    const { rows: conteggi } = await cliente.query(
      `SELECT
         (SELECT COUNT(*) FROM acquisti          WHERE manga_id = $1)::int AS acquisti,
         (SELECT COUNT(*) FROM reading_history   WHERE manga_id = $1)::int AS letture,
         (SELECT COUNT(*) FROM reading_sessions  WHERE manga_id = $1)::int AS sessioni,
         (SELECT COUNT(*) FROM prezzi_mercato    WHERE manga_id = $1)::int AS prezzi,
         (SELECT COUNT(*) FROM "Manga"           WHERE "OperaId" = $1)::int AS sorelle`,
      [req.params.id]
    );

    await cliente.query(`DELETE FROM reading_history  WHERE manga_id = $1`, [req.params.id]);
    await cliente.query(`DELETE FROM reading_sessions WHERE manga_id = $1`, [req.params.id]);
    await cliente.query(`DELETE FROM "Manga" WHERE "ID" = $1`, [req.params.id]);

    await cliente.query("COMMIT");

    return res.json({
      success: true,
      eliminata: String(scheda[0].Titolo).trim(),
      insieme: conteggi[0]
    });
  } catch (err) {
    await cliente.query("ROLLBACK");
    console.error("❌ DELETE MANGA ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  } finally {
    cliente.release();
  }
});

router.post("/updateRating", requireAuth, async (req, res) => {
  const { id, rating } = req.body;

  try {
    await pool.query(`UPDATE "Manga" SET "Valutazione" = $1 WHERE "ID" = $2`, [rating, id]);
    return res.json({ success: true });
  } catch (err) {
    console.error("❌ UPDATE RATING ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

// --------------------------------------------------
// LETTURA
// --------------------------------------------------
router.get("/", async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM "Manga" ORDER BY "ID" DESC`);
    return res.json(rows);
  } catch (err) {
    console.error("❌ GET MANGA ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

// Vista arricchita: completamento, spesa stimata, schede incomplete.
router.get("/riepilogo", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM v_collezione_riepilogo ORDER BY "Titolo"`
    );
    return res.json(rows);
  } catch (err) {
    console.error("❌ GET RIEPILOGO ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

// Numeri per la dashboard: il totale sempre sott'occhio.
router.get("/statistiche", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*)::int                                   AS serie,
        COALESCE(SUM("VolumiPosseduti"), 0)::int        AS volumi,
        ROUND(COALESCE(SUM(spesa_stimata), 0), 2)       AS valore_collezione,
        ROUND(COALESCE(AVG(prezzo_volume), 0), 2)       AS prezzo_medio_volume,
        COUNT(*) FILTER (WHERE "StatoSerie" = 'conclusa')::int  AS serie_concluse,
        COUNT(*) FILTER (WHERE "StatoSerie" = 'in_corso')::int  AS serie_in_corso,
        COUNT(*) FILTER (WHERE completamento_pct = 100)::int    AS serie_complete,
        COUNT(*) FILTER (WHERE scheda_incompleta)::int          AS schede_incomplete,
        COUNT(*) FILTER (WHERE trama_mancante)::int             AS trame_mancanti
      FROM v_collezione_riepilogo
    `);

    return res.json(rows[0]);
  } catch (err) {
    console.error("❌ GET STATISTICHE ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

module.exports = router;
