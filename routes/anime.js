const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const pool = require("../db");
const { requireAuth } = require("../services/auth");
const { utenteLetto, utenteScrive } = require("../services/utenti");
const ac = require("../services/providers/animeclickAnime");
const videoteca = require("../services/videoteca");

// --------------------------------------------------
// LA VIDEOTECA
//
// Gli anime visti, a che punto si è, cosa se ne pensa e quando esce il
// prossimo episodio.
//
// Vale la stessa riga che divide il sito da quando i lettori sono due:
// in LETTURA si può guardare la videoteca di un altro (`?utente=3`),
// in SCRITTURA chi sei lo dice solo il token. Un numero nell'indirizzo
// non deve poter spuntare un episodio al posto di qualcun altro.
//
// La differenza con i manga: qui non si possiede niente. Un anime non
// sta su uno scaffale, quindi non c'è nulla in comune — progresso,
// voti, note e l'aver mollato sono di ciascuno.
// --------------------------------------------------

// Le tre cose che il sito chiede sempre insieme alla scheda, per non
// fare quattro richieste dove ne basta una.
const DATI_DEL_LETTORE = `
  (SELECT COUNT(*)     FROM episodi_visti ev
    WHERE ev.anime_id = a.id AND ev.utente_id = $1)              AS episodi_visti,
  (SELECT MAX(ev.numero) FROM episodi_visti ev
    WHERE ev.anime_id = a.id AND ev.utente_id = $1)              AS ultimo_visto,
  (SELECT v.stato      FROM visioni v
    WHERE v.anime_id = a.id AND v.utente_id = $1)                AS stato_visione,
  (SELECT vo.voto      FROM voti_anime vo
    WHERE vo.anime_id = a.id AND vo.utente_id = $1)              AS voto
`;

function numeroValido(grezzo) {
  const n = Number(grezzo);

  return Number.isInteger(n) && n >= 0 ? n : null;
}

// ==================================================
// LETTURA
// ==================================================

/**
 * GET /api/anime — la videoteca intera.
 *
 * Una richiesta sola: l'anagrafica dalla vista, il progresso di chi
 * guarda, e il voto medio che la vista calcola già.
 */
router.get("/", async (req, res) => {
  try {
    const utenteId = await utenteLetto(req);

    const { rows } = await pool.query(
      `
      SELECT
        a.id, a.titolo, a.tipo, a.stato, a.stato_italia,
        a.anno_inizio, a.cover_url, a.generi, a.distributori,
        a.episodi_totali, a.manga_id,
        v.episodi_disponibili, v.voto_medio, v.note,
        v.prossima_uscita, v.prossimo_episodio,
        ${DATI_DEL_LETTORE}
      FROM anime a
      JOIN v_videoteca v ON v.id = a.id
      ORDER BY lower(a.titolo)
      `,
      [utenteId]
    );

    return res.json(rows);
  } catch (err) {
    console.error("ANIME GET ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

/**
 * GET /api/anime/cerca?titolo=… — i candidati su AnimeClick.
 *
 * Restituisce una lista, mai una scelta: la ricerca di AnimeClick
 * ordina per titolo e non per pertinenza, e "one piece" propone come
 * primo risultato "Dream 9: Toriko & One Piece & Dragon Ball Z".
 * Chi aggancia deve vedere e confermare.
 *
 * Sta prima di `/:id` perché "cerca" non è un numero e Express
 * assegna le rotte in ordine di dichiarazione.
 */
router.get("/cerca", requireAuth, async (req, res) => {
  try {
    const titolo = String(req.query.titolo || "").trim();

    if (titolo.length < 2) {
      return res.status(400).json({ error: "Scrivi almeno due lettere." });
    }

    const candidati = await ac.cercaAnime(titolo, { quanti: 8 });

    // Quelle già in videoteca si segnalano: agganciarle una seconda
    // volta non romperebbe niente, ma chi guarda deve saperlo prima.
    const { rows: gia } = await pool.query(
      `SELECT animeclick_id, id FROM anime WHERE animeclick_id = ANY($1::int[])`,
      [candidati.map((c) => c.id)]
    );

    const mappa = new Map(gia.map((g) => [Number(g.animeclick_id), Number(g.id)]));

    return res.json(
      candidati.map((c) => ({
        animeclickId: c.id,
        titolo: c.titolo,
        anno: c.anno,
        copertina: c.copertina,
        url: c.url,
        punteggio: c.punteggio,
        giaInVideoteca: mappa.get(c.id) ?? null
      }))
    );
  } catch (err) {
    console.error("ANIME CERCA ERROR:", err);
    return res.status(502).json({ error: "AnimeClick non risponde" });
  }
});

/**
 * GET /api/anime/calendario — cosa esce nei prossimi giorni.
 *
 * Legge dal nostro database, non da AnimeClick: le date le porta il
 * lavoro schedulato. Una pagina che si apre non deve dipendere da un
 * sito altrui.
 */
router.get("/calendario", async (req, res) => {
  try {
    const utenteId = await utenteLetto(req);
    const giorni = Math.min(Math.max(Number(req.query.giorni) || 14, 1), 60);

    const { rows } = await pool.query(
      `
      SELECT
        e.anime_id, e.numero, e.titolo, e.uscita_italia, e.piattaforma,
        a.titolo AS serie, a.cover_url, a.tipo,
        (SELECT v.stato FROM visioni v
          WHERE v.anime_id = a.id AND v.utente_id = $1)  AS stato_visione,
        (SELECT MAX(ev.numero) FROM episodi_visti ev
          WHERE ev.anime_id = a.id AND ev.utente_id = $1) AS ultimo_visto
      FROM anime_episodi e
      JOIN anime a ON a.id = e.anime_id
      WHERE e.uscita_italia IS NOT NULL
        AND e.uscita_italia >= NOW() - interval '12 hours'
        AND e.uscita_italia <= NOW() + ($2 || ' days')::interval
      ORDER BY e.uscita_italia
      `,
      [utenteId, String(giorni)]
    );

    return res.json(rows);
  } catch (err) {
    console.error("ANIME CALENDARIO ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

/** GET /api/anime/:id — la scheda, con le puntate e cosa se n'è detto. */
router.get("/:id", async (req, res) => {
  try {
    const utenteId = await utenteLetto(req);
    const id = Number(req.params.id);

    const { rows } = await pool.query(
      `
      SELECT a.*, v.episodi_disponibili, v.voto_medio,
             v.prossima_uscita, v.prossimo_episodio,
             ${DATI_DEL_LETTORE}
      FROM anime a
      JOIN v_videoteca v ON v.id = a.id
      WHERE a.id = $2
      `,
      [utenteId, id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "Anime non trovato" });
    }

    // Gli episodi con la spunta di chi guarda già attaccata: la scheda
    // deve poter disegnare le caselle senza una seconda richiesta.
    const { rows: episodi } = await pool.query(
      `
      SELECT
        e.numero, e.titolo, e.durata, e.uscita_italia, e.piattaforma,
        (ev.visto_il IS NOT NULL) AS visto,
        ev.visto_il
      FROM anime_episodi e
      LEFT JOIN episodi_visti ev
        ON ev.anime_id = e.anime_id AND ev.numero = e.numero AND ev.utente_id = $1
      WHERE e.anime_id = $2
      ORDER BY e.numero
      `,
      [utenteId, id]
    );

    // I voti si vedono in due, come in collezione.
    const { rows: voti } = await pool.query(
      `
      SELECT u.id AS utente_id, u.nickname, u.colore, vo.voto
      FROM voti_anime vo
      JOIN utenti u ON u.id = vo.utente_id
      WHERE vo.anime_id = $1
      ORDER BY u.creato_il
      `,
      [id]
    );

    const { rows: note } = await pool.query(
      `
      SELECT n.id, n.numero_episodio, n.testo, n.spoiler, n.creata_il,
             u.id AS utente_id, u.nickname, u.colore
      FROM note_anime n
      JOIN utenti u ON u.id = n.utente_id
      WHERE n.anime_id = $1
      ORDER BY n.creata_il DESC
      `,
      [id]
    );

    return res.json({ ...rows[0], episodi, voti, note });
  } catch (err) {
    console.error("ANIME SCHEDA ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

// ==================================================
// AGGANCIO
// ==================================================

/**
 * POST /api/anime — aggancia una scheda di AnimeClick.
 *
 * Si passa l'`animeclick_id` scelto fra i candidati, non un titolo:
 * la scelta l'ha già fatta una persona guardando la lista.
 */
router.post("/", requireAuth, async (req, res) => {
  try {
    const animeclickId = numeroValido(req.body?.animeclick_id);

    if (!animeclickId) {
      return res.status(400).json({ error: "animeclick_id è obbligatorio" });
    }

    const { anime, episodi } = await videoteca.agganciaSerie(pool, animeclickId);

    return res.status(201).json({ success: true, anime, episodi });
  } catch (err) {
    console.error("ANIME AGGANCIO ERROR:", err);

    // Distinguere serve: "AnimeClick non risponde" si riprova fra un
    // minuto, "errore server" no.
    const suDiLoro = /AnimeClick/i.test(err.message);

    return res.status(suDiLoro ? 502 : 500).json({
      error: suDiLoro ? err.message : "Errore server"
    });
  }
});

/** POST /api/anime/:id/rileggi — rilegge scheda ed episodi da AnimeClick. */
router.post("/:id/rileggi", requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT animeclick_id FROM anime WHERE id = $1`, [
      Number(req.params.id)
    ]);

    if (rows.length === 0) {
      return res.status(404).json({ error: "Anime non trovato" });
    }

    const esito = await videoteca.agganciaSerie(pool, Number(rows[0].animeclick_id));

    return res.json({ success: true, ...esito });
  } catch (err) {
    console.error("ANIME RILEGGI ERROR:", err);
    return res.status(502).json({ error: "AnimeClick non risponde" });
  }
});

/**
 * PUT /api/anime/:id/manga — il ponte con la collezione di carta.
 *
 * È quello che permette alla scheda di dire "sei al volume 12, l'anime
 * arriva al 9". Si può anche staccare, passando null.
 */
router.put("/:id/manga", requireAuth, async (req, res) => {
  try {
    const mangaId = req.body?.manga_id === null ? null : numeroValido(req.body?.manga_id);

    const { rowCount } = await pool.query(
      `UPDATE anime SET manga_id = $1, aggiornato_il = NOW() WHERE id = $2`,
      [mangaId, Number(req.params.id)]
    );

    if (rowCount === 0) return res.status(404).json({ error: "Anime non trovato" });

    return res.json({ success: true });
  } catch (err) {
    console.error("ANIME MANGA ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

// ==================================================
// GUARDARE
// ==================================================

const STATI_VISIONE = ["da_vedere", "in_visione", "in_pausa", "droppata", "completa"];

/** PUT /api/anime/:id/visione — da vedere, in visione, in pausa, mollata, finita. */
router.put("/:id/visione", requireAuth, async (req, res) => {
  try {
    const stato = String(req.body?.stato || "");

    if (!STATI_VISIONE.includes(stato)) {
      return res.status(400).json({ error: `Stato non valido: ${stato}` });
    }

    const utenteId = await utenteScrive(req);

    await pool.query(
      `
      INSERT INTO visioni (anime_id, utente_id, stato, iniziata_il, finita_il)
      VALUES ($1, $2, $3,
              CASE WHEN $3 = 'in_visione' THEN NOW() END,
              CASE WHEN $3 = 'completa'   THEN NOW() END)
      ON CONFLICT (anime_id, utente_id) DO UPDATE SET
        stato       = EXCLUDED.stato,
        -- La data d'inizio è quella della prima volta: riprendere una
        -- serie in pausa non deve far dimenticare quando la si è
        -- cominciata.
        iniziata_il = COALESCE(visioni.iniziata_il, EXCLUDED.iniziata_il),
        finita_il   = CASE WHEN EXCLUDED.stato = 'completa'
                           THEN COALESCE(visioni.finita_il, NOW()) END,
        aggiornata_il = NOW()
      `,
      [Number(req.params.id), utenteId, stato]
    );

    return res.json({ success: true, stato });
  } catch (err) {
    console.error("ANIME VISIONE ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

/**
 * POST /api/anime/:id/episodi/:numero — l'ho visto.
 *
 * Con `{ "fino": true }` spunta anche tutti quelli prima: è il gesto
 * di chi torna dopo una serata e non vuole toccare otto caselle.
 *
 * Spuntare due volte non è un errore — un tocco ripetuto sul telefono
 * non deve dare un 500 — e la prima spunta accende da sola la visione,
 * perché a nessuno viene in mente di dichiarare "sto guardando" prima
 * di aver guardato.
 */
router.post("/:id/episodi/:numero", requireAuth, async (req, res) => {
  try {
    const animeId = Number(req.params.id);
    const numero = numeroValido(req.params.numero);

    if (numero === null) return res.status(400).json({ error: "Numero non valido" });

    const utenteId = await utenteScrive(req);
    const fino = req.body?.fino === true;

    if (fino) {
      // Solo gli episodi che esistono davvero: riempire fino al 12 di
      // una serie che ne ha 10 scriverebbe due puntate immaginarie.
      await pool.query(
        `
        INSERT INTO episodi_visti (anime_id, numero, utente_id)
        SELECT e.anime_id, e.numero, $3
        FROM anime_episodi e
        WHERE e.anime_id = $1 AND e.numero > 0 AND e.numero <= $2
        ON CONFLICT (anime_id, numero, utente_id) DO NOTHING
        `,
        [animeId, numero, utenteId]
      );
    } else {
      await pool.query(
        `
        INSERT INTO episodi_visti (anime_id, numero, utente_id)
        VALUES ($1, $2, $3)
        ON CONFLICT (anime_id, numero, utente_id) DO NOTHING
        `,
        [animeId, numero, utenteId]
      );
    }

    await pool.query(
      `
      INSERT INTO visioni (anime_id, utente_id, stato, iniziata_il)
      VALUES ($1, $2, 'in_visione', NOW())
      ON CONFLICT (anime_id, utente_id) DO NOTHING
      `,
      [animeId, utenteId]
    );

    // Finita davvero: tutte le puntate elencate sono spuntate e la
    // serie non ne aspetta altre. Se è ancora in corso non si dichiara
    // niente — si è solo in pari.
    const { rows } = await pool.query(
      `
      SELECT
        a.stato,
        (SELECT COUNT(*) FROM anime_episodi e
          WHERE e.anime_id = a.id AND e.numero > 0)                       AS disponibili,
        (SELECT COUNT(*) FROM episodi_visti ev
          WHERE ev.anime_id = a.id AND ev.utente_id = $2 AND ev.numero > 0) AS visti
      FROM anime a WHERE a.id = $1
      `,
      [animeId, utenteId]
    );

    const s = rows[0];
    const finita =
      s && s.stato === "conclusa" && Number(s.disponibili) > 0 &&
      Number(s.visti) >= Number(s.disponibili);

    if (finita) {
      await pool.query(
        `
        UPDATE visioni
        SET stato = 'completa', finita_il = COALESCE(finita_il, NOW()), aggiornata_il = NOW()
        WHERE anime_id = $1 AND utente_id = $2 AND stato <> 'completa'
        `,
        [animeId, utenteId]
      );
    }

    return res.json({
      success: true,
      visti: Number(s?.visti ?? 0),
      disponibili: Number(s?.disponibili ?? 0),
      completa: finita
    });
  } catch (err) {
    console.error("ANIME EPISODIO POST ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

/** DELETE /api/anime/:id/episodi/:numero — non l'avevo visto. */
router.delete("/:id/episodi/:numero", requireAuth, async (req, res) => {
  try {
    const utenteId = await utenteScrive(req);

    await pool.query(
      `DELETE FROM episodi_visti WHERE anime_id = $1 AND numero = $2 AND utente_id = $3`,
      [Number(req.params.id), Number(req.params.numero), utenteId]
    );

    // Togliere una spunta a una serie che risultava finita la riporta
    // in visione: il contrario lascerebbe in videoteca una serie
    // "completa" con una casella vuota dentro.
    await pool.query(
      `
      UPDATE visioni SET stato = 'in_visione', finita_il = NULL, aggiornata_il = NOW()
      WHERE anime_id = $1 AND utente_id = $2 AND stato = 'completa'
      `,
      [Number(req.params.id), utenteId]
    );

    return res.json({ success: true });
  } catch (err) {
    console.error("ANIME EPISODIO DELETE ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

// ==================================================
// VOTO
// ==================================================

/** PUT /api/anime/:id/voto — mezze stelle, come in collezione. */
router.put("/:id/voto", requireAuth, async (req, res) => {
  try {
    const voto = Number(req.body?.voto);

    if (!(voto >= 0.5 && voto <= 5 && voto * 2 === Math.round(voto * 2))) {
      return res.status(400).json({ error: "Il voto va da 0,5 a 5, a mezze stelle." });
    }

    const utenteId = await utenteScrive(req);

    await pool.query(
      `
      INSERT INTO voti_anime (anime_id, utente_id, voto)
      VALUES ($1, $2, $3)
      ON CONFLICT (anime_id, utente_id) DO UPDATE SET
        voto = EXCLUDED.voto, aggiornato_il = NOW()
      `,
      [Number(req.params.id), utenteId, voto]
    );

    return res.json({ success: true, voto });
  } catch (err) {
    console.error("ANIME VOTO ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

/** DELETE /api/anime/:id/voto — non votato non è zero, è l'assenza della riga. */
router.delete("/:id/voto", requireAuth, async (req, res) => {
  try {
    const utenteId = await utenteScrive(req);

    await pool.query(`DELETE FROM voti_anime WHERE anime_id = $1 AND utente_id = $2`, [
      Number(req.params.id),
      utenteId
    ]);

    return res.json({ success: true });
  } catch (err) {
    console.error("ANIME VOTO DELETE ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

// ==================================================
// NOTE — della serie o della singola puntata
// ==================================================

const TESTO_MAX = 2000;

function testoValido(grezzo) {
  const testo = String(grezzo ?? "").trim();

  if (!testo) return { errore: "La nota è vuota." };
  if (testo.length > TESTO_MAX) {
    return { errore: `La nota non può superare i ${TESTO_MAX} caratteri.` };
  }

  return { testo };
}

/**
 * POST /api/anime/:id/note — un commento.
 *
 * Con `numero_episodio` parla di quella puntata, senza parla della
 * serie. È la stessa tabella: due elenchi diversi da leggere, un posto
 * solo dove stanno.
 */
router.post("/:id/note", requireAuth, async (req, res) => {
  try {
    const { testo, errore } = testoValido(req.body?.testo);
    if (errore) return res.status(400).json({ error: errore });

    const numeroEpisodio =
      req.body?.numero_episodio == null ? null : numeroValido(req.body.numero_episodio);

    const utenteId = await utenteScrive(req);

    const { rows } = await pool.query(
      `
      INSERT INTO note_anime (anime_id, utente_id, numero_episodio, testo, spoiler)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, numero_episodio, testo, spoiler, creata_il
      `,
      [Number(req.params.id), utenteId, numeroEpisodio, testo, req.body?.spoiler === true]
    );

    const { rows: chi } = await pool.query(
      `SELECT nickname, colore FROM utenti WHERE id = $1`,
      [utenteId]
    );

    return res.status(201).json({
      success: true,
      nota: {
        ...rows[0],
        utente_id: utenteId,
        nickname: chi[0]?.nickname ?? null,
        colore: chi[0]?.colore ?? null
      }
    });
  } catch (err) {
    console.error("ANIME NOTA POST ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

/**
 * PUT /api/anime/note/:noteId — correggere quello che si è scritto.
 *
 * La condizione sull'utente non è un dettaglio di sicurezza: è quello
 * che impedisce di correggere il pensiero di un altro credendo di
 * correggere il proprio.
 */
router.put("/note/:noteId", requireAuth, async (req, res) => {
  try {
    const { testo, errore } = testoValido(req.body?.testo);
    if (errore) return res.status(400).json({ error: errore });

    const utenteId = await utenteScrive(req);

    const { rows } = await pool.query(
      `
      UPDATE note_anime
      SET testo = $1,
          spoiler = COALESCE($4, spoiler),
          aggiornata_il = NOW()
      WHERE id = $2 AND utente_id = $3
      RETURNING id, testo, spoiler, aggiornata_il
      `,
      [testo, Number(req.params.noteId), utenteId, req.body?.spoiler ?? null]
    );

    // Non trovata o non tua: da fuori è la stessa cosa, e va bene così.
    if (rows.length === 0) return res.status(404).json({ error: "Nota non trovata" });

    return res.json({ success: true, nota: rows[0] });
  } catch (err) {
    console.error("ANIME NOTA PUT ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

/** DELETE /api/anime/note/:noteId */
router.delete("/note/:noteId", requireAuth, async (req, res) => {
  try {
    const utenteId = await utenteScrive(req);

    const { rowCount } = await pool.query(
      `DELETE FROM note_anime WHERE id = $1 AND utente_id = $2`,
      [Number(req.params.noteId), utenteId]
    );

    if (rowCount === 0) return res.status(404).json({ error: "Nota non trovata" });

    return res.json({ success: true });
  } catch (err) {
    console.error("ANIME NOTA DELETE ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

// ==================================================
// IL LAVORO SCHEDULATO
// ==================================================

// Chiamata da GitHub Actions e non da un browser: niente login, un
// segreto condiviso nell'header. Stessa scelta del rapporto volumi
// (routes/manga.js), stessa ragione — un JWT scade, un job no.
function richiedeSegretoCron(req, res, next) {
  const atteso = process.env.CRON_SECRET;
  const ricevuto = req.headers["x-cron-secret"] || "";

  if (!atteso) return res.status(500).json({ error: "CRON_SECRET non configurato" });

  const bufAtteso = Buffer.from(atteso);
  const bufRicevuto = Buffer.from(String(ricevuto));

  if (bufAtteso.length !== bufRicevuto.length || !crypto.timingSafeEqual(bufAtteso, bufRicevuto)) {
    return res.status(403).json({ error: "Segreto non valido" });
  }

  return next();
}

/**
 * POST /api/anime/calendario/aggiorna — il giro quotidiano.
 *
 * Legge il calendario italiano di AnimeClick e scrive le date sugli
 * episodi delle serie che abbiamo. Con `{"scrivi": false}` dice solo
 * cosa farebbe: serve a provarlo senza toccare niente.
 */
router.post("/calendario/aggiorna", richiedeSegretoCron, async (req, res) => {
  try {
    const scrivi = req.body?.scrivi !== false;

    const oggi = await videoteca.aggiornaCalendario(pool, { scrivi });

    // La pagina di apertura copre da oggi a fine mese (una decina di
    // giorni), il mese dopo la allunga fino a sei settimane.
    //
    // `next-month` e non `next-week`: verificato il 21/08/2026 che
    // `?paging=next-week` risponde 500 sul loro server, sia da browser
    // sia da qui. Non è colpa nostra e non c'è niente da riprovare.
    const dopo = await videoteca.aggiornaCalendario(pool, { quando: "next-month", scrivi });

    const esito = {
      lette: oggi.lette + dopo.lette,
      riconosciute: oggi.riconosciute + dopo.riconosciute,
      scritte: oggi.scritte + dopo.scritte
    };

    console.log(
      `📺 Calendario: ${esito.scritte} uscite scritte su ${esito.riconosciute} riconosciute ` +
        `(${esito.lette} lette da AnimeClick)`
    );

    return res.json({ success: true, ...esito });
  } catch (err) {
    console.error("ANIME CALENDARIO CRON ERROR:", err);
    return res.status(502).json({ error: err.message });
  }
});

/** POST /api/anime/serie/aggiorna — rilegge le schede che possono cambiare. */
router.post("/serie/aggiorna", richiedeSegretoCron, async (req, res) => {
  try {
    const esito = await videoteca.aggiornaSerie(pool, {
      giorni: Number(req.body?.giorni) || 7,
      quante: Number(req.body?.quante) || 20
    });

    console.log(`📺 Schede rilette: ${esito.lette}, errori: ${esito.errori.length}`);

    return res.json({ success: true, ...esito });
  } catch (err) {
    console.error("ANIME SERIE CRON ERROR:", err);
    return res.status(502).json({ error: err.message });
  }
});

module.exports = router;
