const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const pool = require("../db");
const { requireAuth } = require("../services/auth");
const { utenteLetto, utenteScrive } = require("../services/utenti");
const ac = require("../services/providers/animeclickAnime");
const videoteca = require("../services/videoteca");
const franchise = require("../services/franchise");

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
//
// ---------------------------------------------------------------
// DUE COSE CHE LA 014 HA CAMBIATO
//
// 1. CATALOGO E VIDEOTECA SONO DUE COSE DIVERSE.
//    `anime` è il catalogo: cosa sappiamo di una serie, in comune,
//    perché i titoli delle puntate sono gli stessi per tutti. La
//    videoteca sono le righe di `visioni`: quali serie sono TUE.
//    Da qui la regola di ogni lettura qui sotto — si passa sempre da
//    un JOIN su `visioni`, e nessuno vede la videoteca di un altro se
//    non chiedendola per nome (`?utente=3`).
//
// 2. LE STAGIONI STANNO INSIEME.
//    AnimeClick tiene Frieren in una scheda sola (38 puntate su due
//    stagioni) ma Isekai Farming in due (42643 e 67685). Il GRUPPO
//    (`anime_gruppi`) rimette insieme quello che è la stessa serie:
//    una copertina in griglia, tutte le stagioni dentro la scheda.
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
    WHERE vo.anime_id = a.id AND vo.utente_id = $1)              AS voto,
  -- Il ripiano in vetrina della pagina personale. EXISTS e non un
  -- SELECT che torna TRUE: senza la riga quello darebbe NULL, e un
  -- NULL si comporta come FALSE dappertutto tranne che in un
  -- confronto stretto, dove smette di colpo.
  EXISTS (SELECT 1     FROM anime_preferiti pr
    WHERE pr.anime_id = a.id AND pr.utente_id = $1)              AS preferito
`;

function numeroValido(grezzo) {
  const n = Number(grezzo);

  return Number.isInteger(n) && n >= 0 ? n : null;
}

// ==================================================
// LETTURA
// ==================================================

/**
 * GET /api/anime — la videoteca di chi guarda.
 *
 * Una richiesta sola: l'anagrafica dalla vista, il progresso di chi
 * guarda, il voto medio che la vista calcola già, e il gruppo a cui la
 * scheda appartiene.
 *
 * Il JOIN su `visioni` è la videoteca: escono solo le serie che sono
 * di questa persona. Prima uscivano tutte, e con due lettori voleva
 * dire vedere in griglia la roba dell'altro senza poterla togliere.
 *
 * L'ordine tiene vicine le stagioni della stessa serie: la griglia le
 * accorpa in una copertina sola, e riceverle sparse la costringerebbe
 * a rimescolare tutto per ritrovarle.
 */
router.get("/", async (req, res) => {
  try {
    const utenteId = await utenteLetto(req);

    const { rows } = await pool.query(
      `
      SELECT
        a.id, a.titolo, a.tipo, a.stato, a.stato_italia,
        -- Gli altri due titoli servono alla ricerca dentro la
        -- videoteca: si cerca «shingeki» tanto quanto «attacco dei
        -- giganti», e senza questi la casella rispondeva solo a uno
        -- dei due.
        a.titolo_originale, a.titolo_inglese,
        a.anno_inizio, a.cover_url, a.generi, a.distributori,
        a.episodi_totali, a.manga_id,
        a.gruppo_id, a.ordine, a.etichetta, a.tagli,
        g.titolo AS gruppo_titolo, g.cover_url AS gruppo_cover,
        v.episodi_disponibili, v.voto_medio, v.note,
        v.prossima_uscita, v.prossimo_episodio,
        ${DATI_DEL_LETTORE}
      FROM anime a
      JOIN v_videoteca v ON v.id = a.id
      JOIN visioni vis ON vis.anime_id = a.id AND vis.utente_id = $1
      LEFT JOIN anime_gruppi g ON g.id = a.gruppo_id
      ORDER BY lower(COALESCE(g.titolo, a.titolo)), a.ordine NULLS FIRST, a.anno_inizio
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
 * Le ricerche fatte da poco.
 *
 * La ricerca della videoteca si aggiorna mentre si scrive: «mushoku»
 * sono sei richieste ad AnimeClick se non si ricorda niente, e la
 * settima è quando si cancella una lettera. Trenta secondi bastano —
 * il tempo di scrivere un titolo e ripensarci — e non tengono in casa
 * un catalogo altrui.
 */
const ricerche = new Map();
const DURATA_RICERCA = 30 * 1000;
const QUANTE_RICERCHE = 80;

async function cercaConMemoria(titolo) {
  const chiave = titolo.toLowerCase();
  const ricordata = ricerche.get(chiave);

  if (ricordata && Date.now() - ricordata.quando < DURATA_RICERCA) return ricordata.esito;

  const esito = await ac.cercaAnime(titolo, { quanti: 12 });

  ricerche.delete(chiave);
  ricerche.set(chiave, { esito, quando: Date.now() });

  while (ricerche.size > QUANTE_RICERCHE) ricerche.delete(ricerche.keys().next().value);

  return esito;
}

/**
 * GET /api/anime/cerca?titolo=… — i candidati su AnimeClick.
 *
 * Restituisce una lista, mai una scelta: la ricerca di AnimeClick
 * ordina per titolo e non per pertinenza, e "one piece" propone come
 * primo risultato "Dream 9: Toriko & One Piece & Dragon Ball Z".
 * Chi aggancia deve vedere e confermare.
 *
 * Ogni risultato porta la `radice` del suo titolo — «Mushoku Tensei»
 * per tutte e tre le sue stagioni — che è quello che permette al
 * pannello di mostrare una riga sola invece di tre. Si calcola qui
 * perché è la stessa regola con cui, un clic dopo, si riconosce una
 * stagione: due modi di dedurla vorrebbero dire due modi di sbagliare.
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

    const candidati = await cercaConMemoria(titolo);

    // Quelle già in videoteca si segnalano: agganciarle una seconda
    // volta non romperebbe niente, ma chi guarda deve saperlo prima.
    //
    // «Già in catalogo» non basta più a dire «già tua»: dalla 014 una
    // scheda può esistere perché la guarda l'altro lettore, e allora
    // il bottone «Aggiungi» deve restare acceso.
    const utenteId = await utenteScrive(req);

    const { rows: gia } = await pool.query(
      `
      SELECT a.animeclick_id, a.id,
             EXISTS (SELECT 1 FROM visioni v
                      WHERE v.anime_id = a.id AND v.utente_id = $2) AS mia
        FROM anime a
       WHERE a.animeclick_id = ANY($1::int[])
      `,
      [candidati.map((c) => c.id), utenteId]
    );

    const mappa = new Map(
      gia.filter((g) => g.mia).map((g) => [Number(g.animeclick_id), Number(g.id)])
    );

    return res.json(
      candidati.map((c) => ({
        animeclickId: c.id,
        titolo: c.titolo,
        anno: c.anno,
        copertina: c.copertina,
        url: c.url,
        punteggio: c.punteggio,
        radice: ac.radiceTitolo(c.titolo),
        giaInVideoteca: mappa.get(c.id) ?? null
      }))
    );
  } catch (err) {
    console.error("ANIME CERCA ERROR:", err);
    return res.status(502).json({ error: "AnimeClick non risponde" });
  }
});

/**
 * GET /api/anime/franchise/:animeclickId — tutta la serie, prima di prenderla.
 *
 * È il cuore della risposta a «voglio cercare il titolo una volta
 * sola»: si sceglie una scheda nella ricerca e questa rotta dice di
 * quante parti è fatta la serie a cui appartiene — stagioni, film,
 * OAV — ognuna con scritto se conviene prenderla e perché.
 *
 * Non aggiunge niente. La proposta si vede prima, perché la pagina
 * delle relazioni di AnimeClick è un sacco che contiene anche i
 * riassunti e i corti comici, e una scheda che si riempie di roba che
 * nessuno ha chiesto è peggio di una che ne chiede conferma.
 *
 * Ogni parte porta anche cosa ne sappiamo già: `giaInCatalogo` è la
 * scheda che esiste (magari perché la guarda l'altro lettore),
 * `giaTua` è quella che è già nella TUA videoteca — e quelle non si
 * ripropongono da spuntare.
 */
router.get("/franchise/:animeclickId", requireAuth, async (req, res) => {
  try {
    const animeclickId = numeroValido(req.params.animeclickId);

    if (!animeclickId) return res.status(400).json({ error: "Serve un id di AnimeClick." });

    const utenteId = await utenteScrive(req);
    const { capo, parti } = await franchise.esplora(animeclickId);

    const { rows: note } = await pool.query(
      `
      SELECT a.animeclick_id, a.id,
             EXISTS (SELECT 1 FROM visioni v
                      WHERE v.anime_id = a.id AND v.utente_id = $2) AS mia
        FROM anime a
       WHERE a.animeclick_id = ANY($1::int[])
      `,
      [parti.map((p) => p.animeclick_id), utenteId]
    );

    const conosciute = new Map(note.map((n) => [Number(n.animeclick_id), n]));

    return res.json({
      capo,
      parti: parti.map((p) => {
        const conosciuta = conosciute.get(p.animeclick_id);

        return {
          ...p,
          giaInCatalogo: conosciuta ? Number(conosciuta.id) : null,
          giaTua: Boolean(conosciuta?.mia)
        };
      })
    });
  } catch (err) {
    console.error("ANIME FRANCHISE ERROR:", err);
    return res.status(502).json({ error: "AnimeClick non risponde" });
  }
});

/**
 * GET /api/anime/anteprima/:animeclickId — cosa racconta questa parte.
 *
 * La proposta di un franchise elenca dei titoli, e certi titoli non
 * dicono niente: «Koyomimonogatari», «Zoku Owarimonogatari». Questa
 * rotta risponde alla domanda che uno si fa prima di spuntare la
 * casella — che roba è?
 *
 * Le schede già in catalogo si leggono dal DATABASE: la trama ce
 * l'abbiamo già, e andare a ridomandarla ad AnimeClick per una cosa
 * che sappiamo sarebbe scortesia verso un sito che ci lascia leggere
 * senza chiederci niente. Le altre si vanno a prendere una per volta,
 * e restano in memoria dieci minuti.
 */
router.get("/anteprima/:animeclickId", requireAuth, async (req, res) => {
  try {
    const animeclickId = numeroValido(req.params.animeclickId);

    if (!animeclickId) return res.status(400).json({ error: "Serve un id di AnimeClick." });

    const { rows } = await pool.query(
      `
      SELECT animeclick_id, titolo, titolo_originale, tipo, anno_inizio,
             episodi_dichiarati, stato_italia, generi, distributori, trama, cover_url
        FROM anime
       WHERE animeclick_id = $1 AND trama IS NOT NULL
      `,
      [animeclickId]
    );

    if (rows.length > 0) return res.json({ ...rows[0], daNoi: true });

    const scheda = await franchise.anteprima(animeclickId);

    return res.json({ ...scheda, daNoi: false });
  } catch (err) {
    console.error("ANIME ANTEPRIMA ERROR:", err);
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
      JOIN visioni vis ON vis.anime_id = a.id AND vis.utente_id = $1
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

/**
 * GET /api/anime/:id — la serie intera: tutte le sue stagioni.
 *
 * L'indirizzo continua a portare l'id di una scheda, ma quello che
 * torna è il GRUPPO a cui appartiene — perché è quello che una persona
 * chiama «la serie». Aprire la seconda stagione di Isekai Farming e
 * aprire la prima porta allo stesso posto: un pannello con dentro
 * tutte e due.
 *
 * Le puntate, i voti e le note restano attaccati alla stagione che li
 * ha davvero: i numeri di AnimeClick ripartono da 1 a ogni scheda, e
 * appiattirli qui vorrebbe dire due «episodio 3» indistinguibili.
 *
 * Una serie senza gruppo non è un caso a parte: è un gruppo di una
 * stagione sola, e chi disegna la pagina non deve saperlo.
 */
router.get("/:id", async (req, res) => {
  try {
    const utenteId = await utenteLetto(req);
    const id = Number(req.params.id);

    const { rows } = await pool.query(
      `
      SELECT a.*, v.episodi_disponibili, v.voto_medio,
             v.prossima_uscita, v.prossimo_episodio,
             g.titolo AS gruppo_titolo, g.cover_url AS gruppo_cover,
             ${DATI_DEL_LETTORE}
      FROM anime a
      JOIN v_videoteca v ON v.id = a.id
      LEFT JOIN anime_gruppi g ON g.id = a.gruppo_id
      WHERE a.id = $2
      `,
      [utenteId, id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "Anime non trovato" });
    }

    const aperta = rows[0];

    // Le stagioni del gruppo. Senza gruppo, la sola scheda aperta.
    const { rows: stagioni } = aperta.gruppo_id
      ? await pool.query(
          `
          SELECT a.*, v.episodi_disponibili, v.voto_medio,
                 v.prossima_uscita, v.prossimo_episodio,
                 (SELECT COUNT(*) FROM visioni vi
                   WHERE vi.anime_id = a.id AND vi.utente_id = $1) > 0 AS in_videoteca,
                 ${DATI_DEL_LETTORE}
          FROM anime a
          JOIN v_videoteca v ON v.id = a.id
          WHERE a.gruppo_id = $2
          ORDER BY a.ordine NULLS LAST, a.anno_inizio NULLS LAST, a.animeclick_id
          `,
          [utenteId, aperta.gruppo_id]
        )
      : { rows: [{ ...aperta, in_videoteca: true }] };

    const idStagioni = stagioni.map((s) => Number(s.id));

    // Un giro solo per le puntate di tutte le stagioni: la scheda deve
    // poter disegnare le caselle senza una richiesta per stagione.
    const { rows: episodi } = await pool.query(
      `
      SELECT
        e.anime_id, e.numero, e.titolo, e.durata, e.uscita_italia, e.piattaforma,
        (ev.visto_il IS NOT NULL) AS visto,
        ev.visto_il
      FROM anime_episodi e
      LEFT JOIN episodi_visti ev
        ON ev.anime_id = e.anime_id AND ev.numero = e.numero AND ev.utente_id = $1
      WHERE e.anime_id = ANY($2::bigint[])
      ORDER BY e.anime_id, e.numero
      `,
      [utenteId, idStagioni]
    );

    // I voti si vedono in due, come in collezione.
    const { rows: voti } = await pool.query(
      `
      SELECT vo.anime_id, u.id AS utente_id, u.nickname, u.colore, vo.voto
      FROM voti_anime vo
      JOIN utenti u ON u.id = vo.utente_id
      WHERE vo.anime_id = ANY($1::bigint[])
      ORDER BY u.creato_il
      `,
      [idStagioni]
    );

    const { rows: note } = await pool.query(
      `
      SELECT n.id, n.anime_id, n.numero_episodio, n.testo, n.spoiler, n.creata_il,
             u.id AS utente_id, u.nickname, u.colore
      FROM note_anime n
      JOIN utenti u ON u.id = n.utente_id
      WHERE n.anime_id = ANY($1::bigint[])
      ORDER BY n.creata_il DESC
      `,
      [idStagioni]
    );

    const per = (righe, animeId) => righe.filter((r) => Number(r.anime_id) === Number(animeId));

    return res.json({
      ...aperta,
      // Compatibilità con chi guarda una scheda sola: le puntate, i
      // voti e le note della stagione aperta restano dove stavano.
      episodi: per(episodi, aperta.id),
      voti: per(voti, aperta.id),
      note: per(note, aperta.id),

      gruppo: aperta.gruppo_id
        ? {
            id: Number(aperta.gruppo_id),
            titolo: aperta.gruppo_titolo,
            cover_url: aperta.gruppo_cover
          }
        : null,

      stagioni: stagioni.map((s) => ({
        ...s,
        // `anime.stagioni` è la frase di AnimeClick — «Autunno (2023)
        // [...] Inverno (2026)» — e qui dentro `stagioni` è già l'elenco
        // delle stagioni vere. Due cose diverse con lo stesso nome sono
        // un errore che aspetta di succedere: la frase si chiama
        // `periodo`, e il nome vecchio resta solo per chi lo usa già.
        periodo: s.stagioni,
        episodi: per(episodi, s.id),
        voti: per(voti, s.id),
        note: per(note, s.id)
      }))
    });
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
 *
 * La serie entra nella videoteca DI CHI HA PREMUTO (`visioni`), non
 * in un elenco comune.
 *
 * E si aggiunge TUTTA: con `parti` arrivano gli id di tutte le opere
 * che compongono la serie — le stagioni, i film, gli OAV — così come
 * `GET /franchise/:id` le ha proposte e come chi guardava le ha
 * confermate. Prima ne entrava una sola e le altre andavano cercate a
 * mano una per una, il che voleva dire cercare «Mushoku Tensei» tre
 * volte per avere tre stagioni. Le parti finiscono nello stesso
 * gruppo, in ordine di uscita, e in griglia restano una copertina.
 *
 * ⚠️ Può restituire `restanti`: le parti che non sono entrate nel
 * tempo di una richiesta. Si richiama con le stesse `parti` finché
 * quell'elenco non è vuoto — le schede già scritte non si rileggono,
 * quindi il giro seguente costa poco.
 */
router.post("/", requireAuth, async (req, res) => {
  try {
    const animeclickId = numeroValido(req.body?.animeclick_id);

    if (!animeclickId) {
      return res.status(400).json({ error: "animeclick_id è obbligatorio" });
    }

    const utenteId = await utenteScrive(req);

    // `parti` è la serie intera scelta nel pannello: le stagioni, i
    // film, gli OAV. Senza, si aggancia la sola scheda chiesta — è il
    // comportamento di prima, e serve ancora a chi vuole aggiungere una
    // cosa sola (uno special, uno spin-off) senza tirarsi dietro tutto.
    //
    // Il tetto di 40 non è una difesa da un attacco: è il numero oltre
    // il quale una serie non è più una serie. Il franchise più grosso
    // che AnimeClick elenca ne conta una dozzina, e una richiesta con
    // cinquecento id dentro sarebbe un errore di chi chiama — meglio
    // troncarla che passare mezz'ora a leggere schede a caso.
    const parti = Array.isArray(req.body?.parti)
      ? [...new Set(req.body.parti.map(numeroValido).filter(Boolean))].slice(0, 40)
      : [animeclickId];

    const esito = await videoteca.agganciaFranchise(pool, {
      capo: animeclickId,
      parti,
      utenteId,
      // Il nome della serie finisce sotto una copertina: si taglia a
      // una lunghezza da titolo, non da paragrafo.
      nome: String(req.body?.nome || "").trim().slice(0, 200) || null
    });

    const { rows } = await pool.query(`SELECT * FROM anime WHERE id = $1`, [esito.animeId]);

    return res.status(201).json({
      success: true,
      anime: rows[0],
      gruppo_id: esito.gruppoId,
      aggiunte: esito.fatte,
      // Le parti che non sono entrate nel tempo di una richiesta: chi
      // ha chiamato rimanda le stesse `parti` e il giro riprende da
      // qui. Non è un errore, è una serie lunga.
      restanti: esito.restanti,
      errori: esito.errori
    });
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

/**
 * DELETE /api/anime/:id — togli questa serie dalla mia videoteca.
 *
 * Mancava, ed era il buco più fastidioso: una serie agganciata per
 * sbaglio — o semplicemente non più interessante — restava lì per
 * sempre, e l'unico modo di levarla era il database.
 *
 * Toglie la serie a CHI CHIEDE, non a tutti: spariscono la tua riga in
 * `visioni`, le tue spunte, il tuo voto e le tue note. La scheda resta
 * a chi la guarda ancora, e se ne va da sola quando non la guarda più
 * nessuno.
 */
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const utenteId = await utenteScrive(req);
    const esito = await videoteca.rimuoviDallaVideoteca(pool, Number(req.params.id), utenteId);

    if (!esito) return res.status(404).json({ error: "Anime non trovato" });

    return res.json({ success: true, ...esito });
  } catch (err) {
    console.error("ANIME DELETE ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

// ==================================================
// I GRUPPI — quando AnimeClick non basta
// ==================================================

/**
 * PUT /api/anime/gruppi/:gruppoId — il nome della serie.
 *
 * Il titolo del gruppo nasce da quello della prima stagione col numero
 * tolto in coda, che è un'ipotesi ragionevole e ogni tanto sbagliata
 * («Steins;Gate 0» non è «Steins;Gate»). Questa è la correzione.
 *
 * Sta prima di `/:id/gruppo` perché Express assegna le rotte in ordine
 * di dichiarazione, e "gruppi" non è un numero.
 */
router.put("/gruppi/:gruppoId", requireAuth, async (req, res) => {
  try {
    const titolo = String(req.body?.titolo || "").trim();

    if (titolo.length < 2) {
      return res.status(400).json({ error: "Il nome della serie è troppo corto." });
    }

    const { rowCount } = await pool.query(
      `UPDATE anime_gruppi SET titolo = $1 WHERE id = $2`,
      [titolo, Number(req.params.gruppoId)]
    );

    if (rowCount === 0) return res.status(404).json({ error: "Gruppo non trovato" });

    return res.json({ success: true, titolo });
  } catch (err) {
    console.error("GRUPPO RINOMINA ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

/**
 * PUT /api/anime/:id/gruppo — a mano: unisci, stacca, rinomina la stagione.
 *
 * Serve perché l'automatismo non arriva dappertutto: «Chainsaw Man:
 * Assassins Arc» è la seconda stagione ma su AnimeClick è elencata
 * senza nessuna parola di relazione, e nessuna lettura di quella
 * pagina potrà mai dedurlo.
 *
 *   { con: 7 }               mettila insieme alla serie 7
 *   { stacca: true }         tirala fuori dal gruppo
 *   { etichetta, ordine }    come si chiama e dove sta fra le stagioni
 */
router.put("/:id/gruppo", requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (req.body?.stacca) {
      await videoteca.stacca(pool, id);
      return res.json({ success: true, gruppo_id: null });
    }

    const con = numeroValido(req.body?.con);

    if (con) {
      if (con === id) {
        return res.status(400).json({ error: "Una serie non si unisce a sé stessa." });
      }

      const gruppoId = await videoteca.accorpaAMano(pool, id, con);

      return res.json({ success: true, gruppo_id: gruppoId });
    }

    // Né unione né distacco: si stanno correggendo il nome della
    // stagione o il suo posto in fila.
    const etichetta =
      req.body?.etichetta === undefined
        ? undefined
        : String(req.body.etichetta || "").trim() || null;

    const ordine = req.body?.ordine === undefined ? undefined : numeroValido(req.body.ordine);

    if (etichetta === undefined && ordine === undefined) {
      return res.status(400).json({ error: "Non c'è niente da cambiare." });
    }

    // Le colonne da toccare si montano qui invece di infilare dei
    // COALESCE nella query: «etichetta vuota» vuol dire *cancellala*,
    // e un COALESCE non sa distinguerlo da «non l'hai mandata».
    const pezzi = [];
    const valori = [];

    if (etichetta !== undefined) {
      valori.push(etichetta);
      pezzi.push(`etichetta = $${valori.length}`);
    }

    if (ordine !== undefined) {
      valori.push(ordine);
      pezzi.push(`ordine = $${valori.length}`);
    }

    valori.push(id);

    const { rowCount } = await pool.query(
      `UPDATE anime SET ${pezzi.join(", ")}, aggiornato_il = NOW() WHERE id = $${valori.length}`,
      valori
    );

    if (rowCount === 0) return res.status(404).json({ error: "Anime non trovato" });

    return res.json({ success: true });
  } catch (err) {
    console.error("ANIME GRUPPO ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

/**
 * POST /api/anime/riunisci — ripassa la videoteca e rimette insieme le stagioni.
 *
 * È la stessa cosa che succede da sola quando si aggiunge una serie,
 * applicata a quello che c'era già. Serve perché il riconoscimento è
 * migliorato dopo: una videoteca riempita una serie per volta si
 * ritrova Shakugan no Shana in tre copertine e Nisekoi in due, e
 * rimetterle a posto a mano è mezz'ora di clic.
 *
 * Non aggiunge e non toglie: guarda le schede che ci sono. Restituisce
 * `restanti` quando la videoteca è più lunga del tempo di una
 * richiesta, e si richiama finché è vuoto.
 *
 * Sta prima di `/:id/...` per lo stesso motivo di `cerca`: "riunisci"
 * non è un numero.
 */
router.post("/riunisci", requireAuth, async (req, res) => {
  try {
    const utenteId = await utenteScrive(req);
    const esito = await videoteca.riunisciVideoteca(pool, utenteId);

    return res.json({ success: true, ...esito });
  } catch (err) {
    console.error("ANIME RIUNISCI ERROR:", err);
    return res.status(502).json({ error: "AnimeClick non risponde" });
  }
});

/**
 * PUT /api/anime/:id/stagioni — dove finisce una stagione e comincia l'altra.
 *
 * L'altra metà del problema dei gruppi, e quella che il gruppo non
 * poteva risolvere: Frieren è UNA scheda con dentro 38 puntate che
 * sono due stagioni (28 + 10), numerate di seguito. AnimeClick non
 * segna il confine da nessuna parte — verificato riga per riga sulla
 * sua tabella degli episodi — e lo si va a prendere da AniList, che
 * tiene un media per stagione.
 *
 * Questa rotta è la correzione a mano: `{ tagli: [29] }` vuol dire
 * «la seconda stagione comincia dalla puntata 29». L'automatismo
 * accetta solo abbinamenti che tornano col conto delle puntate, quindi
 * quando non trova niente non sbaglia: lascia l'elenco unico, e resta
 * questa.
 */
router.put("/:id/stagioni", requireAuth, async (req, res) => {
  try {
    const grezzi = Array.isArray(req.body?.tagli) ? req.body.tagli : null;

    if (!grezzi) {
      return res.status(400).json({ error: "Serve `tagli`, anche vuoto." });
    }

    const { rows } = await pool.query(
      `
      SELECT (SELECT COUNT(*)::int FROM anime_episodi e
               WHERE e.anime_id = a.id AND e.numero > 0) AS disponibili
        FROM anime a WHERE a.id = $1
      `,
      [Number(req.params.id)]
    );

    if (rows.length === 0) return res.status(404).json({ error: "Anime non trovato" });

    const disponibili = rows[0].disponibili;

    // Un taglio è il NUMERO della prima puntata di una stagione nuova:
    // deve esistere, non può essere la prima (una stagione che comincia
    // dalla puntata 1 è la prima, non una nuova), e non può ripetersi.
    const tagli = [...new Set(grezzi.map(numeroValido).filter(Boolean))]
      .filter((n) => n > 1 && n <= disponibili)
      .sort((a, b) => a - b);

    await pool.query(`UPDATE anime SET tagli = $1, aggiornato_il = NOW() WHERE id = $2`, [
      tagli,
      Number(req.params.id)
    ]);

    return res.json({ success: true, tagli });
  } catch (err) {
    console.error("ANIME STAGIONI ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

/**
 * POST /api/anime/:id/stagioni/cerca — richiedi i tagli ad AniList.
 *
 * Il giro si fa già da solo agganciando e rileggendo una serie: questo
 * serve per le schede che c'erano prima che esistessero i tagli, e per
 * quelle che ci hanno provato quando AniList era a corto di fiato (90
 * richieste al minuto, e una serie ne consuma tre o quattro).
 */
router.post("/:id/stagioni/cerca", requireAuth, async (req, res) => {
  try {
    const tagli = await videoteca.calcolaTagli(pool, Number(req.params.id));

    return res.json({ success: true, tagli });
  } catch (err) {
    console.error("ANIME TAGLI ERROR:", err);
    return res.status(502).json({ error: "AniList non risponde" });
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

    // La prima spunta accende da sola la visione, perché a nessuno
    // viene in mente di dichiarare «sto guardando» prima di aver
    // guardato. Dalla 014 la riga esiste già — è la tessera della
    // videoteca — quindi non basta più un DO NOTHING: una serie
    // «da vedere» su cui si spunta una puntata è una serie che si sta
    // guardando. Gli altri stati si lasciano stare: chi l'ha messa in
    // pausa o mollata sa quello che ha fatto.
    await pool.query(
      `
      INSERT INTO visioni (anime_id, utente_id, stato, iniziata_il)
      VALUES ($1, $2, 'in_visione', NOW())
      ON CONFLICT (anime_id, utente_id) DO UPDATE SET
        stato         = 'in_visione',
        iniziata_il   = COALESCE(visioni.iniziata_il, NOW()),
        aggiornata_il = NOW()
      WHERE visioni.stato = 'da_vedere'
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

/**
 * POST /api/anime/:id/preferito — il ripiano in vetrina.
 *
 * Non è «le ho dato cinque stelle»: quella è la classifica e si
 * ricava dai voti. I preferiti sono le poche serie che uno sceglie di
 * mettere in fondo alla propria pagina, ed è una scelta a parte —
 * capita di amare qualcosa che non si voterebbe cinque, e di votare
 * cinque qualcosa che non racconta chi sei.
 *
 * Mettere e togliere sono lo stesso indirizzo per la stessa ragione
 * del cuore nel Cineforum: il bottone è uno solo.
 */
router.post("/:id/preferito", requireAuth, async (req, res) => {
  try {
    const animeId = Number(req.params.id);

    if (!Number.isInteger(animeId)) {
      return res.status(400).json({ error: "Identificativo non valido" });
    }

    const utenteId = await utenteScrive(req);

    const { rowCount } = await pool.query(
      `DELETE FROM anime_preferiti WHERE anime_id = $1 AND utente_id = $2`,
      [animeId, utenteId]
    );

    if (rowCount === 0) {
      // In fondo alla vetrina: `ordine` è il posto deciso a mano, e
      // chi non l'ha mai riordinata deve comunque ritrovare l'ultima
      // aggiunta per ultima e non in cima.
      await pool.query(
        `
        INSERT INTO anime_preferiti (anime_id, utente_id, ordine)
        VALUES ($1, $2,
          COALESCE((SELECT MAX(ordine) + 1 FROM anime_preferiti WHERE utente_id = $2), 0))
        ON CONFLICT DO NOTHING
        `,
        [animeId, utenteId]
      );
    }

    return res.json({ preferito: rowCount === 0 });
  } catch (err) {
    if (err.code === "23503") return res.status(404).json({ error: "Serie non trovata" });

    if (err.code === "42P01") {
      return res.status(503).json({ error: "Migrazione 016 non ancora eseguita" });
    }

    console.error("ANIME PREFERITO ERROR:", err);
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
