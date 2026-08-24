const express = require("express");
const router = express.Router();
const pool = require("../db");
const { requireAuth, identificaUtente } = require("../services/auth");
const utenti = require("../services/utenti");
const { utenteScrive, idProprietario } = utenti;
const cineforum = require("../services/cineforum");
const campanella = require("../services/campanella");
const consigli = require("../services/consigli");

/**
 * IL CINEFORUM — la piazza della videoteca.
 *
 * Le regole di chi può fare cosa sono le stesse del resto del sito,
 * con una differenza che vale la pena dire ad alta voce:
 *
 *   LEGGERE è di tutti, anche di chi non è entrato. È il senso della
 *   cosa: «tutti vedono gli aggiornamenti di tutti», e mettere una
 *   password davanti alla pagina principale della videoteca vorrebbe
 *   dire che chi apre il sito dal telefono di qualcun altro trova un
 *   muro invece di casa.
 *
 *   SCRIVERE lo dice solo il token. Un numero nell'indirizzo non deve
 *   poter mettere un cuore o rispondere al posto di un altro.
 *
 * `identificaUtente` sta su tutto il router: non blocca nessuno, ma
 * quando l'accesso c'è permette di rispondere «questo cuore è già
 * tuo» invece di far ricontare i cuori al browser.
 */

router.use(identificaUtente);

/* ==================================================
   CHI È
   ================================================== */

// Le colonne che descrivono una persona a chi la guarda. Sono le
// stesse in quattro query diverse, e quattro elenchi da tenere
// d'accordo sono tre occasioni di dimenticarne uno.
const ASPETTO = `
  u.id, u.nickname, u.colore, u.proprietario, u.creato_il, u.faccia_il,
  COALESCE(
    (SELECT array_agg(s.id ORDER BY s.ordine, s.id)
       FROM utenti_striscione s WHERE s.utente_id = u.id),
    '{}'
  ) AS striscione
`;

/**
 * Una persona dal suo soprannome.
 *
 * Il soprannome è l'indirizzo pubblico di ciascuno — `/videoteca/chi/Nanaki`
 * — e si cerca senza distinguere maiuscole e minuscole, esattamente
 * come il nome con cui si entra: chi scrive «nanaki» nella barra sta
 * cercando la stessa persona.
 */
async function perNickname(nickname) {
  const { rows } = await pool.query(
    `
    SELECT ${ASPETTO}
      FROM utenti u
     WHERE lower(u.nickname) = lower($1) AND u.stato = 'attivo'
     LIMIT 1
    `,
    [String(nickname || "").trim()]
  );

  return rows[0] || null;
}

/**
 * Come si consegna una persona.
 *
 * Delle immagini escono gli indirizzi, non i byte: `faccia` è il
 * momento in cui è stata messa (va appeso all'indirizzo, o il browser
 * tiene per un anno quella di prima) e `striscione` è l'elenco degli
 * identificativi. La forma la costruisce `utenti.aspetto`, così è la
 * stessa qui, in `/pubblici` e dentro ogni post del feed.
 */
function comePersona(riga) {
  return { ...utenti.aspetto(riga), daQuando: riga.creato_il ?? null };
}

/* ==================================================
   IL FEED
   ================================================== */

/**
 * GET /api/cineforum — cosa è successo, a tutti, dal più recente.
 *
 * `?prima=<istante>` continua la lettura da dove si era rimasti.
 * `?utente=<id>` la restringe a una persona sola: è il diario che
 * compare dentro la sua pagina personale, e non è una rotta diversa
 * perché è esattamente lo stesso feed con un filtro in più.
 */
router.get("/", async (req, res) => {
  try {
    const prima = req.query.prima ? new Date(req.query.prima) : null;

    if (prima && Number.isNaN(prima.getTime())) {
      return res.status(400).json({ error: "Istante non valido" });
    }

    const utente = Number(req.query.utente);

    const esito = await cineforum.feed(pool, {
      prima,
      quanti: req.query.quanti,
      utenteId: Number.isInteger(utente) && utente > 0 ? utente : null,
      chiGuarda: req.user?.id ? Number(req.user.id) : null
    });

    return res.json(esito);
  } catch (err) {
    // Prima della migrazione 016 le tabelle non ci sono: il sito nuovo
    // arriva su Vercel in pochi minuti e Render ci mette mezz'ora
    // (succede: 22/08/2026). Un feed vuoto è un'attesa, un 500 rosso
    // sembra un guasto.
    if (err.code === "42P01" || err.code === "42703") {
      return res.json({ post: [], ancora: false, prossimo: null, daMigrare: true });
    }

    console.error("CINEFORUM FEED ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

/* ==================================================
   I MESSAGGI
   ================================================== */

const TESTO_MAX = 2000;

function testoValido(grezzo) {
  const testo = String(grezzo || "").trim();

  if (!testo || testo.length > TESTO_MAX) return null;

  return testo;
}

/** POST /api/cineforum/messaggi — quello che si scrive apposta. */
router.post("/messaggi", requireAuth, async (req, res) => {
  try {
    const testo = testoValido(req.body?.testo);

    if (!testo) {
      return res.status(400).json({ error: `Il messaggio è vuoto o supera ${TESTO_MAX} caratteri` });
    }

    const utenteId = await utenteScrive(req);

    // L'aggancio a una serie è facoltativo, ma se c'è dev'essere vero:
    // un id inventato farebbe comparire un messaggio con sotto una
    // copertina che non esiste.
    const animeId = Number(req.body?.animeId);
    const aggancio = Number.isInteger(animeId) && animeId > 0 ? animeId : null;

    const { rows } = await pool.query(
      `
      INSERT INTO cineforum_messaggi (utente_id, testo, anime_id)
      VALUES ($1, $2, $3)
      RETURNING id, creato_il
      `,
      [utenteId, testo, aggancio]
    );

    return res.status(201).json({
      id: Number(rows[0].id),
      chiave: `messaggio:${rows[0].id}`,
      creato_il: rows[0].creato_il
    });
  } catch (err) {
    if (err.code === "23503") {
      return res.status(400).json({ error: "Quella serie non esiste" });
    }

    console.error("CINEFORUM MESSAGGIO ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

/**
 * PUT /api/cineforum/messaggi/:id — correggere quello che si è scritto.
 *
 * Solo il proprio: il proprietario amministra le schede, non le frasi
 * degli altri. Un messaggio che qualcun altro può riscrivere non è
 * più una cosa che hai detto tu.
 */
router.put("/messaggi/:id", requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const testo = testoValido(req.body?.testo);

    if (!Number.isInteger(id)) return res.status(400).json({ error: "Identificativo non valido" });
    if (!testo) return res.status(400).json({ error: "Il messaggio è vuoto o troppo lungo" });

    const utenteId = await utenteScrive(req);

    const { rowCount } = await pool.query(
      `
      UPDATE cineforum_messaggi
         SET testo = $1, modificato_il = NOW()
       WHERE id = $2 AND utente_id = $3
      `,
      [testo, id, utenteId]
    );

    if (rowCount === 0) return res.status(404).json({ error: "Messaggio non trovato" });

    return res.json({ success: true });
  } catch (err) {
    console.error("CINEFORUM MODIFICA ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

/**
 * DELETE /api/cineforum/messaggi/:id
 *
 * Le risposte e i cuori non hanno una chiave esterna verso il
 * messaggio (la chiave è testo, e deve poter puntare anche alle
 * giornate che non sono righe): vanno tolti a mano, o resterebbero
 * appesi a un post che non c'è più.
 */
router.delete("/messaggi/:id", requireAuth, async (req, res) => {
  const cliente = await pool.connect();

  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id)) return res.status(400).json({ error: "Identificativo non valido" });

    const utenteId = await utenteScrive(req);

    await cliente.query("BEGIN");

    const { rowCount } = await cliente.query(
      `DELETE FROM cineforum_messaggi WHERE id = $1 AND utente_id = $2`,
      [id, utenteId]
    );

    if (rowCount === 0) {
      await cliente.query("ROLLBACK");
      return res.status(404).json({ error: "Messaggio non trovato" });
    }

    const chiave = `messaggio:${id}`;

    await cliente.query(`DELETE FROM cineforum_cuori    WHERE chiave = $1`, [chiave]);
    await cliente.query(`DELETE FROM cineforum_risposte WHERE chiave = $1`, [chiave]);

    await cliente.query("COMMIT");

    return res.json({ success: true });
  } catch (err) {
    await cliente.query("ROLLBACK").catch(() => {});
    console.error("CINEFORUM ELIMINA ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  } finally {
    cliente.release();
  }
});

/* ==================================================
   I CUORI
   ================================================== */

/**
 * POST /api/cineforum/cuore — mettere e togliere sono lo stesso gesto.
 *
 * Un solo indirizzo che commuta, e non due: il bottone è uno, e chi
 * lo preme due volte di fila per sbaglio deve ritrovarsi come prima
 * invece che davanti a un errore.
 */
router.post("/cuore", requireAuth, async (req, res) => {
  try {
    const chiave = cineforum.chiaveValida(req.body?.chiave);

    if (!chiave) return res.status(400).json({ error: "Post non valido" });

    const utenteId = await utenteScrive(req);

    const { rowCount } = await pool.query(
      `DELETE FROM cineforum_cuori WHERE chiave = $1 AND utente_id = $2`,
      [chiave, utenteId]
    );

    if (rowCount === 0) {
      await pool.query(
        `INSERT INTO cineforum_cuori (chiave, utente_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [chiave, utenteId]
      );
    }

    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS quanti FROM cineforum_cuori WHERE chiave = $1`,
      [chiave]
    );

    return res.json({ acceso: rowCount === 0, quanti: rows[0].quanti });
  } catch (err) {
    console.error("CINEFORUM CUORE ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

/* ==================================================
   LE RISPOSTE
   ================================================== */

router.post("/risposte", requireAuth, async (req, res) => {
  try {
    const chiave = cineforum.chiaveValida(req.body?.chiave);
    const testo = testoValido(req.body?.testo);

    if (!chiave) return res.status(400).json({ error: "Post non valido" });
    if (!testo) return res.status(400).json({ error: "La risposta è vuota o troppo lunga" });

    const utenteId = await utenteScrive(req);

    const { rows } = await pool.query(
      `
      INSERT INTO cineforum_risposte (chiave, utente_id, testo)
      VALUES ($1, $2, $3)
      RETURNING id, creata_il
      `,
      [chiave, utenteId, testo]
    );

    return res.status(201).json({ id: Number(rows[0].id), creata_il: rows[0].creata_il });
  } catch (err) {
    console.error("CINEFORUM RISPOSTA ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

router.put("/risposte/:id", requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const testo = testoValido(req.body?.testo);

    if (!Number.isInteger(id)) return res.status(400).json({ error: "Identificativo non valido" });
    if (!testo) return res.status(400).json({ error: "La risposta è vuota o troppo lunga" });

    const utenteId = await utenteScrive(req);

    const { rowCount } = await pool.query(
      `
      UPDATE cineforum_risposte
         SET testo = $1, modificata_il = NOW()
       WHERE id = $2 AND utente_id = $3
      `,
      [testo, id, utenteId]
    );

    if (rowCount === 0) return res.status(404).json({ error: "Risposta non trovata" });

    return res.json({ success: true });
  } catch (err) {
    console.error("CINEFORUM RISPOSTA MODIFICA ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

router.delete("/risposte/:id", requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id)) return res.status(400).json({ error: "Identificativo non valido" });

    const utenteId = await utenteScrive(req);

    const { rowCount } = await pool.query(
      `DELETE FROM cineforum_risposte WHERE id = $1 AND utente_id = $2`,
      [id, utenteId]
    );

    if (rowCount === 0) return res.status(404).json({ error: "Risposta non trovata" });

    return res.json({ success: true });
  } catch (err) {
    console.error("CINEFORUM RISPOSTA ELIMINA ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

/* ==================================================
   LA CAMPANELLA
   ================================================== */

/**
 * GET /api/cineforum/avvisi — cosa è successo che ti riguarda.
 *
 * Sotto autenticazione, e non per prudenza: senza sapere chi sei non
 * c'è proprio niente da calcolare. Chi non è entrato non vede la
 * campanella affatto.
 */
router.get("/avvisi", requireAuth, async (req, res) => {
  try {
    // `utenteScrive` e non `utenteLetto`: quello guarda anche
    // `?utente=` nell'indirizzo, che qui vorrebbe dire leggere gli
    // avvisi di un altro scrivendone il numero. Gli avvisi li dice
    // solo il token.
    const utenteId = await utenteScrive(req);

    return res.json(await campanella.avvisi(pool, utenteId));
  } catch (err) {
    // La 020 si esegue a mano su Supabase e Render può arrivare
    // prima: finché la colonna non c'è, la campanella è spenta invece
    // che rotta. Vale la stessa scelta del feed.
    if (err.code === "42P01" || err.code === "42703") {
      return res.json({ avvisi: [], daLeggere: 0, visti_il: null, daMigrare: true });
    }

    console.error("CINEFORUM AVVISI ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

/** POST /api/cineforum/avvisi/letti — aprire la campanella spegne il pallino. */
router.post("/avvisi/letti", requireAuth, async (req, res) => {
  try {
    const utenteId = await utenteScrive(req);

    return res.json({ visti_il: await campanella.segnaLetti(pool, utenteId) });
  } catch (err) {
    if (err.code === "42P01" || err.code === "42703") {
      return res.json({ visti_il: null, daMigrare: true });
    }

    console.error("CINEFORUM AVVISI LETTI ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

/* ==================================================
   I CONSIGLI
   ==================================================

   «Guarda questo», detto a una persona sola. Il ragionamento su
   com'è fatto sta in `services/consigli.js`; qui ci sono le tre cose
   che si possono fare: mandarne uno, sapere se ne hai in arrivo,
   dire che l'hai aperto.

   Tutte e tre sotto autenticazione, e non per prudenza: un consiglio
   ha per definizione un mittente e un destinatario, e senza sapere
   chi sei non c'è niente da leggere né da scrivere. */

/** Un titolo o una copertina lunghi come un romanzo sono un errore, non un dato. */
const TITOLO_MAX = 300;
const INDIRIZZO_MAX = 600;

/**
 * L'indirizzo della copertina, accettato solo se è un indirizzo.
 *
 * Finisce dentro un `<img src>` sulla cartolina di qualcun altro, e
 * chi lo scrive è un utente. Il ponte delle copertine ha già una
 * lista di domini ammessi — quindi da qui non si scarica niente di
 * arbitrario — ma `urlCopertina` lascia passare `data:` e `/` senza
 * rimbalzarli, e quelli non hanno nessun controllo dietro. Http e
 * https e basta: è tutto quello che AnimeClick manda.
 */
function copertinaValida(grezza) {
  const url = String(grezza || "").trim();

  if (!url || url.length > INDIRIZZO_MAX) return null;
  if (!/^https?:\/\//i.test(url)) return null;

  return url;
}

/**
 * POST /api/cineforum/consigli — manda una cartolina.
 *
 * Il titolo e la copertina arrivano dal browser insieme all'id di
 * AnimeClick, invece di essere riletti qui dalla fonte. È voluto: chi
 * manda ha appena visto quella riga nella ricerca, e rileggere la
 * scheda vorrebbe dire far aspettare AnimeClick a chi preme «manda»
 * per riscrivere le stesse due stringhe che ha già in mano.
 * `animeclick_id` resta l'identità vera, e su quella si ritrova la
 * scheda in catalogo quando c'è.
 */
router.post("/consigli", requireAuth, async (req, res) => {
  try {
    const daId = await utenteScrive(req);

    const aId = Number(req.body?.a);
    const animeclickId = Number(req.body?.animeclickId);
    const titolo = String(req.body?.titolo || "").trim().slice(0, TITOLO_MAX);
    const testo = String(req.body?.testo || "").trim();

    if (!Number.isInteger(aId) || aId <= 0) {
      return res.status(400).json({ error: "Manca la persona a cui mandarlo" });
    }

    if (aId === Number(daId)) {
      return res.status(400).json({ error: "Non puoi consigliarti qualcosa da solo" });
    }

    if (!Number.isInteger(animeclickId) || animeclickId <= 0) {
      return res.status(400).json({ error: "Manca la serie da consigliare" });
    }

    if (!titolo) return res.status(400).json({ error: "Manca il titolo della serie" });

    if (testo.length > consigli.TESTO_MAX) {
      return res
        .status(400)
        .json({ error: `Il commento supera ${consigli.TESTO_MAX} caratteri` });
    }

    const consiglio = await consigli.manda(pool, {
      daId,
      aId,
      animeclickId,
      titolo,
      coverUrl: copertinaValida(req.body?.coverUrl),
      testo
    });

    return res.status(201).json(consiglio);
  } catch (err) {
    if (err.stato) return res.status(err.stato).json({ error: err.message });

    if (err.code === "42P01" || err.code === "42703") {
      return res
        .status(503)
        .json({ error: "Il server non ha ancora l'ultima migrazione: riprova fra poco." });
    }

    console.error("CINEFORUM CONSIGLIO ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

/**
 * GET /api/cineforum/consigli/in-arrivo — le cartoline non ancora aperte.
 *
 * La chiede la cornice a ogni apertura del mondo videoteca, per
 * mostrare l'animazione a schermo intero. È la ragione dell'indice
 * parziale della 021: deve costare quanto una lettura di chiave.
 *
 * Prima della migrazione risponde con una lista vuota invece che con
 * un errore — Render può servire il codice nuovo prima che la
 * migrazione sia girata, e una cartolina che non arriva è un'attesa
 * mentre un 500 in cima a ogni pagina è un guasto.
 */
router.get("/consigli/in-arrivo", requireAuth, async (req, res) => {
  try {
    const utenteId = await utenteScrive(req);

    return res.json({ consigli: await consigli.inArrivo(pool, utenteId) });
  } catch (err) {
    if (err.code === "42P01" || err.code === "42703") {
      return res.json({ consigli: [], daMigrare: true });
    }

    console.error("CINEFORUM CONSIGLI IN ARRIVO ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

/**
 * POST /api/cineforum/consigli/:id/aperto — «l'ho vista».
 *
 * Si chiama quando la cartolina COMPARE, non quando si chiude: chi
 * spegne il telefono a metà animazione l'ha comunque vista, e
 * rimostrargliela per sempre sarebbe peggio che darla per letta.
 *
 * È anche il momento in cui il mittente riceve il suo avviso, perché
 * quell'avviso non è una riga ma la stessa riga letta dall'altro capo
 * (vedi `services/campanella.js`).
 */
router.post("/consigli/:id/aperto", requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id)) return res.status(400).json({ error: "Identificativo non valido" });

    const utenteId = await utenteScrive(req);

    // `null` vuol dire «non era tua, o l'avevi già aperta»: nessuna
    // delle due è un errore da mostrare — la cartolina è comunque
    // fuori dalla coda, che è quello che il browser voleva sapere.
    return res.json({ aperto_il: await consigli.apri(pool, id, utenteId) });
  } catch (err) {
    if (err.code === "42P01" || err.code === "42703") {
      return res.json({ aperto_il: null, daMigrare: true });
    }

    console.error("CINEFORUM CONSIGLIO APERTO ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

/* ==================================================
   LE PAGINE PERSONALI
   ================================================== */

/**
 * GET /api/cineforum/profilo/:nickname — chi è, e i suoi numeri.
 *
 * Non manda anche la videoteca: quella si chiede a `/api/anime?utente=<id>`,
 * che è la stessa rotta che la griglia usa da sempre. Due richieste in
 * parallelo invece di una grossa, e soprattutto un solo posto dove è
 * scritto come si legge una videoteca.
 */
router.get("/profilo/:nickname", async (req, res) => {
  try {
    const riga = await perNickname(req.params.nickname);

    if (!riga) return res.status(404).json({ error: "Nessuno con questo nome" });

    // I fuochi solo qui: la fascia si vede solo su questa pagina, e
    // `comePersona` finisce anche dentro ogni post del Cineforum,
    // dove sarebbero due numeri in più per quindici post che non ne
    // fanno niente. La lettura non può fallire — vedi
    // `utenti.fuochiStriscione`.
    const [statistiche, fuochi] = await Promise.all([
      cineforum.statistiche(pool, riga.id),
      utenti.fuochiStriscione(riga.id)
    ]);

    return res.json({ utente: { ...comePersona(riga), fuochi }, statistiche });
  } catch (err) {
    // 42P01 = tabella che non c'e, 42703 = colonna che non c'e.
    // Sono i due modi in cui questa rotta si rompe fra il codice nuovo
    // e la migrazione eseguita a mano: dirlo e' utile, un 500 rosso no.
    if (err.code === "42P01" || err.code === "42703") {
      return res.status(503).json({ error: "Il server non ha ancora l'ultima migrazione: riprova fra poco." });
    }


    console.error("CINEFORUM PROFILO ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

/**
 * GET /api/cineforum/commenti/:nickname — tutto quello che ha scritto.
 *
 * Serie e puntate insieme, dal più recente: è la voce «commenti» del
 * menu della pagina personale, e leggere i commenti di qualcuno in
 * fila è un modo di conoscerlo che la griglia delle copertine non dà.
 */
router.get("/commenti/:nickname", async (req, res) => {
  try {
    const riga = await perNickname(req.params.nickname);

    if (!riga) return res.status(404).json({ error: "Nessuno con questo nome" });

    const { rows } = await pool.query(
      `
      SELECT n.id, n.testo, n.spoiler, n.numero_episodio, n.creata_il, n.aggiornata_il,
             a.id AS anime_id, a.cover_url, a.tipo,
             COALESCE(g.titolo, a.titolo) AS titolo,
             (SELECT e.titolo FROM anime_episodi e
               WHERE e.anime_id = a.id AND e.numero = n.numero_episodio) AS titolo_episodio
        FROM note_anime n
        JOIN anime a ON a.id = n.anime_id
        LEFT JOIN anime_gruppi g ON g.id = a.gruppo_id
       WHERE n.utente_id = $1
       ORDER BY n.creata_il DESC
       LIMIT 300
      `,
      [riga.id]
    );

    return res.json({
      utente: comePersona(riga),
      commenti: rows.map((r) => ({
        id: Number(r.id),
        testo: r.testo,
        spoiler: r.spoiler,
        numeroEpisodio: r.numero_episodio,
        titoloEpisodio: r.titolo_episodio,
        creata_il: r.creata_il,
        aggiornata_il: r.aggiornata_il,
        anime: {
          id: Number(r.anime_id),
          titolo: r.titolo,
          cover_url: r.cover_url,
          tipo: r.tipo
        }
      }))
    });
  } catch (err) {
    // 42P01 = tabella che non c'e, 42703 = colonna che non c'e.
    // Sono i due modi in cui questa rotta si rompe fra il codice nuovo
    // e la migrazione eseguita a mano: dirlo e' utile, un 500 rosso no.
    if (err.code === "42P01" || err.code === "42703") {
      return res.status(503).json({ error: "Il server non ha ancora l'ultima migrazione: riprova fra poco." });
    }

    console.error("CINEFORUM COMMENTI ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

/**
 * GET /api/cineforum/confronto/:a/:b — voi due, uno accanto all'altro.
 *
 * Due soprannomi nell'indirizzo e non «io contro lui»: un confronto è
 * la tipica cosa che si manda a qualcuno («guarda quanto siamo
 * diversi»), e un indirizzo che dipende da chi lo apre mostrerebbe a
 * chi lo riceve un confronto diverso da quello di chi l'ha mandato.
 */
router.get("/confronto/:a/:b", async (req, res) => {
  try {
    const [a, b] = await Promise.all([perNickname(req.params.a), perNickname(req.params.b)]);

    if (!a || !b) return res.status(404).json({ error: "Nessuno con questo nome" });

    if (Number(a.id) === Number(b.id)) {
      return res.status(400).json({ error: "È la stessa persona" });
    }

    const esito = await cineforum.confronto(pool, a.id, b.id);

    return res.json({ ...esito, personaA: comePersona(a), personaB: comePersona(b) });
  } catch (err) {
    // 42P01 = tabella che non c'e, 42703 = colonna che non c'e.
    // Sono i due modi in cui questa rotta si rompe fra il codice nuovo
    // e la migrazione eseguita a mano: dirlo e' utile, un 500 rosso no.
    if (err.code === "42P01" || err.code === "42703") {
      return res.status(503).json({ error: "Il server non ha ancora l'ultima migrazione: riprova fra poco." });
    }

    console.error("CINEFORUM CONFRONTO ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

/**
 * GET /api/cineforum/chi — i soprannomi cercabili.
 *
 * È `/api/utenti/pubblici` con i numeri attaccati: la pagina di
 * ricerca deve poter dire «Nanaki · 34 serie» senza chiedere le
 * statistiche di ognuno una per volta.
 */
router.get("/chi", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `
      SELECT ${ASPETTO},
             (SELECT COUNT(DISTINCT COALESCE('g' || a.gruppo_id, 'a' || a.id))
                FROM visioni vis JOIN anime a ON a.id = vis.anime_id
               WHERE vis.utente_id = u.id)                                AS serie,
             (SELECT COUNT(*) FROM episodi_visti ev WHERE ev.utente_id = u.id) AS episodi
        FROM utenti u
       WHERE u.stato = 'attivo'
       ORDER BY u.proprietario DESC, u.creato_il ASC
      `
    );

    return res.json(
      rows.map((r) => ({
        ...comePersona(r),
        serie: Number(r.serie || 0),
        episodi: Number(r.episodi || 0)
      }))
    );
  } catch (err) {
    if (err.code === "42P01" || err.code === "42703") return res.json([]);

    console.error("CINEFORUM CHI ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

/**
 * GET /api/cineforum/io — il soprannome di chi guarda.
 *
 * Serve alla barra: la voce «Videoteca» punta alla pagina personale, e
 * per costruire l'indirizzo ci vuole il nome. Chi non è entrato riceve
 * quello del padrone di casa, che è la regola di lettura di tutto il
 * sito.
 */
router.get("/io", async (req, res) => {
  try {
    const id = req.user?.id ? Number(req.user.id) : await idProprietario();

    if (!id) return res.status(404).json({ error: "Nessun proprietario configurato" });

    const { rows } = await pool.query(
      `SELECT ${ASPETTO} FROM utenti u WHERE u.id = $1`,
      [id]
    );

    if (rows.length === 0) return res.status(404).json({ error: "Utente non trovato" });

    return res.json(comePersona(rows[0]));
  } catch (err) {
    // 42P01 = tabella che non c'e, 42703 = colonna che non c'e.
    // Sono i due modi in cui questa rotta si rompe fra il codice nuovo
    // e la migrazione eseguita a mano: dirlo e' utile, un 500 rosso no.
    if (err.code === "42P01" || err.code === "42703") {
      return res.status(503).json({ error: "Il server non ha ancora l'ultima migrazione: riprova fra poco." });
    }

    console.error("CINEFORUM IO ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

module.exports = router;
