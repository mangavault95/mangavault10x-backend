const express = require("express");
const router = express.Router();
const pool = require("../db");
const { richiediBiblioteca } = require("../services/biblioteca");
const { utenteScrive } = require("../services/utenti");
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
router.post("/enrich-bulk", richiediBiblioteca, async (req, res) => {
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
// LOGIN — il vecchio indirizzo.
//
// Adesso l'accesso sta in routes/utenti.js insieme a registrazione e
// approvazioni, che è dove uno va a cercarlo. Questo resta perché è
// l'indirizzo che il sito pubblicato chiama da mesi: un browser con la
// vecchia versione in cache non deve trovarsi la porta murata.
// --------------------------------------------------
router.post("/login", (req, res) => require("./utenti").gestisciLogin(req, res));

// --------------------------------------------------
// UPDATE MANGA
// --------------------------------------------------
const CAMPI_AGGIORNABILI = {
  titolo: "Titolo",
  autore: "Autore",
  disegnatore: "Disegnatore",
  genere: "Genere",
  // Il pubblico dell'opera (shonen, seinen, shojo...). È una cosa
  // diversa dal genere e sta in una colonna sua: "Drama" dice di cosa
  // parla, "seinen" per chi è stato scritto. La riempie
  // `scripts/categorie.js` leggendola da AnimeClick; qui si corregge a
  // mano quando la scheda altrui sbaglia.
  categoria: "Categoria",
  trama: "Trama",
  coverurl: "CoverURL",
  editore: "Editore",
  costo: "Costo",
  volumiposseduti: "VolumiPosseduti",
  volumitotali: "VolumiTotali",
  // `valutazione` non è più un campo della scheda: il voto è di una
  // persona, non della serie, e si scrive da /updateRating.
  statoSerie: "StatoSerie",
  prezzoCopertina: "PrezzoCopertina",
  isbn: "Isbn",
  annoInizio: "AnnoInizio",
  titoloOriginale: "TitoloOriginale",
  preferito: "Preferito",
  // `droppato` è uscito di qui insieme a `valutazione`, e per lo stesso
  // motivo: mollare una serie è di chi legge, non della serie. Si
  // scrive da /api/letture-droppate.
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
router.post("/", richiediBiblioteca, async (req, res) => {
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

router.put("/:id", richiediBiblioteca, async (req, res) => {
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

router.post("/update", richiediBiblioteca, async (req, res) => {
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
router.delete("/:id", richiediBiblioteca, async (req, res) => {
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

// --------------------------------------------------
// VOTO
//
// Non è più una colonna della serie ma una riga per (serie, persona):
// la stessa opera ha due giudizi, e nessuno dei due è "il" voto.
//
// Chi vota lo dice il token, mai il corpo della richiesta: altrimenti
// basterebbe cambiare un numero per votare al posto dell'altra persona.
//
// Mezze stelle ammesse: 0.5, 1, 1.5 … 5. `rating` nullo cancella il
// voto — togliere un giudizio dato per sbaglio deve essere possibile,
// e "non votato" non è lo zero.
// --------------------------------------------------
router.post("/updateRating", richiediBiblioteca, async (req, res) => {
  const { id, rating } = req.body;

  const serie = Number(id);

  if (!Number.isInteger(serie)) {
    return res.status(400).json({ error: "Serie non valida" });
  }

  try {
    const utenteId = await utenteScrive(req);

    if (!utenteId) {
      return res.status(500).json({ error: "Utente non riconosciuto" });
    }

    if (rating === null || rating === undefined || rating === "" || Number(rating) === 0) {
      await pool.query(`DELETE FROM voti WHERE manga_id = $1 AND utente_id = $2`, [
        serie,
        utenteId
      ]);

      return res.json({ success: true, voto: null });
    }

    const voto = Number(rating);

    if (!(voto >= 0.5 && voto <= 5) || Math.round(voto * 2) !== voto * 2) {
      return res.status(400).json({ error: "Voto non valido: da 0,5 a 5, a mezze stelle." });
    }

    const { rows } = await pool.query(
      `
      INSERT INTO voti (manga_id, utente_id, voto)
      VALUES ($1, $2, $3)
      ON CONFLICT (manga_id, utente_id)
      DO UPDATE SET voto = EXCLUDED.voto, aggiornato_il = NOW()
      RETURNING voto
      `,
      [serie, utenteId, voto]
    );

    return res.json({ success: true, voto: Number(rows[0].voto) });
  } catch (err) {
    console.error("❌ UPDATE RATING ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

// --------------------------------------------------
// LETTURA
//
// Ogni scheda si porta dietro i voti di tutti in un campo solo
// (`Voti`), invece di una colonna per persona: le persone possono
// diventare tre, le colonne no. Il browser ne pesca uno — il tuo — e
// mostra gli altri accanto.
//
// Stessa cosa per `Droppate`, che dal 011 non è più la colonna
// "Droppato": mollare una serie è una decisione di chi legge, e qui
// arriva l'elenco di chi l'ha presa. Il browser guarda se ci sei tu.
//
// E per `Note` e `Lettori`, dal 012. Viaggiano attaccate alla scheda
// invece che in una richiesta a parte perché è la stessa domanda:
// dell'opera si vuole sapere tutto insieme, e la collezione è già
// l'unica cosa che il browser scarica per disegnare qualunque pagina.
// `Lettori` dice chi ne ha letto almeno un volume e quanti: serve al
// filtro "lette da" in collezione e alla classifica in "in lettura".
// Il conteggio viaggia insieme al nome apposta — con quello la
// classifica di CHIUNQUE si disegna senza chiedere niente al server,
// e passare da un lettore all'altro è istantaneo invece di essere
// un'altra attesa di Render che si sveglia.
//
// `AND u.biblioteca` su tutt'e quattro: dalla 018 la biblioteca è di
// casa, e chi si è registrato per la videoteca di qua non ha niente di
// suo. Le righe che aveva lasciato prima non si cancellano — restano
// dov'erano e tornerebbero il giorno in cui il proprietario gli
// aprisse la porta — ma smettono di comparire, perché un voto accanto
// a una scheda dice "questa serie l'abbiamo giudicata in tre", e non è
// vero.
//
// La JOIN è una sottoquery e non un GROUP BY sull'intera tabella
// apposta: `SELECT *` deve continuare a restituire le colonne di
// "Manga" come sono, senza che aggiungere una colonna domani obblighi
// a toccare anche il raggruppamento.
// --------------------------------------------------
// Chi conta come "di casa". È un pezzo di SQL e non un valore perché
// prima della 018 la colonna non esiste: in quel caso vale TRUE, cioè
// la biblioteca com'era ieri, invece di una collezione senza più un
// voto (che è quello che succederebbe cadendo nel ripiego qui sotto).
const DI_CASA = 'u.biblioteca';

const schedeComplete = (diCasa) => `
      SELECT
        m.*,
        COALESCE(
          (
            SELECT json_agg(
                     json_build_object(
                       'utenteId', v.utente_id,
                       'nickname', u.nickname,
                       'proprietario', u.proprietario,
                       'voto', v.voto::float
                     )
                     ORDER BY u.proprietario DESC, u.creato_il ASC
                   )
            FROM voti v
            JOIN utenti u ON u.id = v.utente_id
            WHERE v.manga_id = m."ID" AND ${diCasa}
          ),
          '[]'::json
        ) AS "Voti",
        COALESCE(
          (
            SELECT json_agg(
                     json_build_object(
                       'utenteId', d.utente_id,
                       'proprietario', u.proprietario
                     )
                     ORDER BY u.proprietario DESC, u.creato_il ASC
                   )
            FROM letture_droppate d
            JOIN utenti u ON u.id = d.utente_id
            WHERE d.manga_id = m."ID" AND ${diCasa}
          ),
          '[]'::json
        ) AS "Droppate",
        COALESCE(
          (
            SELECT json_agg(
                     json_build_object(
                       'id', n.id,
                       'utenteId', n.utente_id,
                       'nickname', u.nickname,
                       'colore', u.colore,
                       'testo', n.testo,
                       'creataIl', n.creata_il,
                       'aggiornataIl', n.aggiornata_il
                     )
                     ORDER BY n.creata_il ASC
                   )
            FROM note_serie n
            JOIN utenti u ON u.id = n.utente_id
            WHERE n.manga_id = m."ID" AND ${diCasa}
          ),
          '[]'::json
        ) AS "Note",
        COALESCE(
          (
            SELECT json_agg(
                     json_build_object('utenteId', t.utente_id, 'volumi', t.quanti)
                     ORDER BY t.quanti DESC
                   )
            FROM (
              SELECT h.utente_id, COUNT(DISTINCT h.volume)::int AS quanti
              FROM reading_history h
              JOIN utenti u ON u.id = h.utente_id
              WHERE h.manga_id = m."ID" AND ${diCasa}
              GROUP BY h.utente_id
            ) t
          ),
          '[]'::json
        ) AS "Lettori"
      FROM "Manga" m
      ORDER BY m."ID" DESC
`;

router.get("/", async (req, res) => {
  try {
    const { rows } = await pool.query(schedeComplete(DI_CASA));

    return res.json(rows);
  } catch (err) {
    // La 018 non è ancora passata: si rifà la stessa domanda senza il
    // filtro, cioè come il sito rispondeva ieri. Prima di questo
    // tentativo si finiva dritti nel ripiego qui sotto, che è una
    // collezione senza un voto e senza una nota — un guasto molto più
    // grosso di quello che si stava aggirando.
    if (err.code === "42703") {
      try {
        const { rows } = await pool.query(schedeComplete("TRUE"));

        return res.json(rows);
      } catch {
        /* niente da fare: si prova il ripiego vero, qui sotto */
      }
    }

    // Prima delle migrazioni 009, 011 e 012 le tabelle dei voti, delle
    // droppate e delle note non esistono: la collezione deve poter
    // arrivare lo stesso, o il sito è vuoto finché lo script non gira
    // su Supabase. (42703 = la colonna `colore` non c'è ancora.)
    if (err.code === "42P01" || err.code === "42703") {
      try {
        const { rows } = await pool.query(`SELECT * FROM "Manga" ORDER BY "ID" DESC`);
        return res.json(
          rows.map((r) => ({ ...r, Voti: [], Droppate: [], Note: [], Lettori: [] }))
        );
      } catch (err2) {
        console.error("❌ GET MANGA ERROR:", err2);
        return res.status(500).json({ error: "Errore server" });
      }
    }

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
