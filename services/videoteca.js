// La Videoteca: agganciare una serie, tenerla aggiornata, sapere
// quando esce il prossimo episodio.
//
// Le rotte qui sopra non parlano con AnimeClick: chiedono a questo
// file, che sa leggere le pagine (services/providers/animeclickAnime)
// e sa scriverne il risultato in tabella. Stessa divisione di
// `rapportoVolumi.js` per i volumi italiani.
//
// Tre lavori, tre funzioni:
//   agganciaSerie      la prima volta: scheda + elenco episodi
//   aggiornaSerie      le serie in corso, di tanto in tanto
//   aggiornaCalendario tutte le uscite italiane dei prossimi giorni

const ac = require("./providers/animeclickAnime");

// --------------------------------------------------
// Scrittura di una serie
// --------------------------------------------------

/**
 * Scrive (o riscrive) l'anagrafica.
 *
 * `animeclick_id` è la chiave: agganciare due volte la stessa scheda
 * aggiorna la riga invece di crearne una seconda, e questo rende
 * ripetibile sia il primo aggancio sia l'aggiornamento.
 *
 * Quello che NON si sovrascrive è `anilist_id` e `manga_id` quando
 * arrivano vuoti: sono legami stabiliti altrove — a mano o dalla
 * copertina — e una rilettura della scheda non deve cancellarli.
 */
async function salvaScheda(pool, scheda) {
  const { rows } = await pool.query(
    `
    INSERT INTO anime (
      animeclick_id, titolo, titolo_originale, titolo_inglese, tipo,
      anno_inizio, anno_fine, stagioni,
      episodi_totali, episodi_dichiarati,
      stato, stato_italia, generi, distributori,
      trama, cover_url, letto_il
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, NOW())
    ON CONFLICT (animeclick_id) DO UPDATE SET
      titolo             = EXCLUDED.titolo,
      titolo_originale   = EXCLUDED.titolo_originale,
      titolo_inglese     = EXCLUDED.titolo_inglese,
      tipo               = EXCLUDED.tipo,
      anno_inizio        = EXCLUDED.anno_inizio,
      anno_fine          = EXCLUDED.anno_fine,
      stagioni           = EXCLUDED.stagioni,
      episodi_totali     = EXCLUDED.episodi_totali,
      episodi_dichiarati = EXCLUDED.episodi_dichiarati,
      stato              = EXCLUDED.stato,
      stato_italia       = EXCLUDED.stato_italia,
      generi             = EXCLUDED.generi,
      distributori       = EXCLUDED.distributori,
      -- La trama e la copertina si aggiornano solo se la nuova c'è:
      -- una lettura andata storta non deve svuotare una scheda piena.
      trama              = COALESCE(EXCLUDED.trama, anime.trama),
      cover_url          = COALESCE(EXCLUDED.cover_url, anime.cover_url),
      letto_il           = NOW(),
      aggiornato_il      = NOW()
    RETURNING *
    `,
    [
      scheda.animeclick_id,
      scheda.titolo,
      scheda.titolo_originale,
      scheda.titolo_inglese,
      scheda.tipo,
      scheda.anno_inizio,
      scheda.anno_fine,
      scheda.stagioni,
      scheda.episodi_totali,
      scheda.episodi_dichiarati,
      scheda.stato,
      scheda.stato_italia,
      scheda.generi,
      scheda.distributori,
      scheda.trama,
      scheda.cover_url
    ]
  );

  return rows[0];
}

/**
 * Scrive l'elenco delle puntate.
 *
 * Si aggiorna riga per riga invece di cancellare e riscrivere: le
 * spunte puntano al numero e sopravvivrebbero comunque, ma le date del
 * calendario stanno su queste stesse righe, e un DELETE le porterebbe
 * via ogni volta.
 *
 * Gli special che AnimeClick marca tutti "Ep. 0" non hanno un vincolo
 * di unicità (indice parziale su numero > 0): si scrivono solo la
 * prima volta, quando la serie ancora non ne ha.
 */
async function salvaEpisodi(pool, animeId, puntate) {
  let scritte = 0;

  const { rows: esistenti } = await pool.query(
    `SELECT numero FROM anime_episodi WHERE anime_id = $1 AND numero = 0`,
    [animeId]
  );

  const haGiaSpeciali = esistenti.length > 0;

  for (const p of puntate) {
    if (p.numero === 0 && haGiaSpeciali) continue;

    if (p.numero === 0) {
      await pool.query(
        `
        INSERT INTO anime_episodi (anime_id, numero, titolo, durata, animeclick_id)
        VALUES ($1, 0, $2, $3, $4)
        `,
        [animeId, p.titolo, p.durata, p.animeclick_id]
      );
      scritte++;
      continue;
    }

    await pool.query(
      `
      INSERT INTO anime_episodi (anime_id, numero, titolo, durata, animeclick_id)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (anime_id, numero) WHERE numero > 0 DO UPDATE SET
        titolo        = COALESCE(EXCLUDED.titolo, anime_episodi.titolo),
        durata        = COALESCE(EXCLUDED.durata, anime_episodi.durata),
        animeclick_id = COALESCE(EXCLUDED.animeclick_id, anime_episodi.animeclick_id),
        aggiornato_il = NOW()
      `,
      [animeId, p.numero, p.titolo, p.durata, p.animeclick_id]
    );

    scritte++;
  }

  return scritte;
}

/**
 * La prima volta: si legge la scheda, si legge l'elenco delle puntate,
 * si scrive tutto.
 *
 * ⚠️ Le serie fiume sono pesanti (la pagina episodi di One Piece è di
 * 2 MB, 1197 righe): è il motivo per cui questo si fa una volta, a
 * mano, e non a ogni apertura della scheda.
 */
async function agganciaSerie(pool, animeclickId, { conEpisodi = true } = {}) {
  const scheda = await ac.scheda(animeclickId);
  const riga = await salvaScheda(pool, scheda);

  let episodi = 0;

  if (conEpisodi) {
    const puntate = await ac.episodi(animeclickId);
    episodi = await salvaEpisodi(pool, riga.id, puntate);
  }

  return { anime: riga, episodi };
}

/**
 * Rilegge le serie che possono ancora cambiare.
 *
 * Le concluse non si rileggono: quello che dicono oggi lo diranno
 * anche fra un anno, e ogni richiesta risparmiata è cortesia verso un
 * sito che ci lascia leggere senza chiederci niente.
 */
async function aggiornaSerie(pool, { giorni = 7, quante = 20 } = {}) {
  const { rows } = await pool.query(
    `
    SELECT id, animeclick_id
    FROM anime
    WHERE stato IN ('in_corso', 'in_pausa', 'inedita')
      AND (letto_il IS NULL OR letto_il < NOW() - ($1 || ' days')::interval)
    ORDER BY letto_il NULLS FIRST
    LIMIT $2
    `,
    [String(giorni), quante]
  );

  const esito = { lette: 0, errori: [] };

  for (const serie of rows) {
    try {
      await agganciaSerie(pool, serie.animeclick_id);
      esito.lette++;
    } catch (e) {
      esito.errori.push({ id: serie.id, errore: e.message });
    }

    // Una pausa fra una scheda e l'altra: è il passo di una persona
    // che sfoglia, non di uno scraper.
    await new Promise((r) => setTimeout(r, 1500));
  }

  return esito;
}

// --------------------------------------------------
// Il calendario
// --------------------------------------------------

function normalizza(testo) {
  return String(testo || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Le uscite italiane dei prossimi giorni, scritte sugli episodi delle
 * serie che abbiamo in videoteca.
 *
 * Il calendario di AnimeClick elenca tutto quello che esce in Italia —
 * 130 uscite in dieci giorni — e non dice a quale scheda appartiene
 * una card: solo il titolo, spesso quello inglese ("That Time I Got
 * Reincarnated as a Slime"). Per questo l'abbinamento si fa sui tre
 * titoli che teniamo in tabella, e per questo `titolo_inglese` sta lì.
 *
 * Le card che non somigliano a niente di nostro si buttano senza
 * aprirle: è quello che tiene il lavoro a una manciata di richieste
 * invece di centotrenta.
 */
async function aggiornaCalendario(pool, { quando = null, scrivi = true } = {}) {
  const uscite = await ac.calendario({ quando });

  const { rows: serie } = await pool.query(
    `SELECT id, titolo, titolo_originale, titolo_inglese FROM anime`
  );

  // Un indice dei titoli che conosciamo, nelle tre forme in cui una
  // stessa serie può presentarsi.
  const perTitolo = new Map();

  for (const s of serie) {
    for (const forma of [s.titolo, s.titolo_originale, s.titolo_inglese]) {
      const chiave = normalizza(forma);
      if (chiave) perTitolo.set(chiave, s.id);
    }
  }

  const esito = { lette: uscite.length, riconosciute: 0, scritte: 0, serie: [] };

  for (const u of uscite) {
    const animeId = perTitolo.get(normalizza(u.serie));

    if (!animeId || u.numero == null) continue;

    esito.riconosciute++;

    if (!scrivi) {
      esito.serie.push({ animeId, serie: u.serie, numero: u.numero, quando: u.quando });
      continue;
    }

    // L'episodio può non esistere ancora: è il caso normale, perché
    // sta uscendo adesso. Si crea con la data, e il titolo italiano
    // che il calendario porta già con sé.
    await pool.query(
      `
      INSERT INTO anime_episodi (anime_id, numero, titolo, uscita_italia, piattaforma)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (anime_id, numero) WHERE numero > 0 DO UPDATE SET
        titolo        = COALESCE(anime_episodi.titolo, EXCLUDED.titolo),
        uscita_italia = EXCLUDED.uscita_italia,
        piattaforma   = EXCLUDED.piattaforma,
        aggiornato_il = NOW()
      `,
      [animeId, u.numero, u.titolo, u.quando, u.piattaforma]
    );

    esito.scritte++;
    esito.serie.push({ animeId, serie: u.serie, numero: u.numero, quando: u.quando });
  }

  return esito;
}

module.exports = {
  agganciaSerie,
  aggiornaSerie,
  aggiornaCalendario,
  salvaScheda,
  salvaEpisodi
};
