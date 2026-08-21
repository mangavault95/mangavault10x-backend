// La Videoteca: agganciare una serie, tenerla aggiornata, sapere
// quando esce il prossimo episodio.
//
// Le rotte qui sopra non parlano con AnimeClick: chiedono a questo
// file, che sa leggere le pagine (services/providers/animeclickAnime)
// e sa scriverne il risultato in tabella. Stessa divisione di
// `rapportoVolumi.js` per i volumi italiani.
//
// I lavori:
//   agganciaSerie      la prima volta: scheda + elenco episodi
//   aggiornaSerie      le serie in corso, di tanto in tanto
//   aggiornaCalendario tutte le uscite italiane dei prossimi giorni
//
// Dalla 014 se ne aggiungono due, che sono l'altra faccia della stessa
// medaglia — tenere in ordine una videoteca invece che solo riempirla:
//   agganciaStagioni      unire le schede che sono la stessa serie
//   rimuoviDallaVideoteca togliersi di torno quello che non si guarda

const ac = require("./providers/animeclickAnime");
const anilist = require("./providers/anilistAnime");

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

  // Dove finisce una stagione e comincia l'altra. Va dopo gli episodi
  // perché il conto delle puntate scritte è la prova che l'abbinamento
  // con AniList è quello giusto (vedi `anilistAnime.torna`).
  let tagli = riga.tagli || [];

  if (conEpisodi) {
    tagli = await calcolaTagli(pool, riga.id);
  }

  return { anime: { ...riga, tagli }, episodi, tagli };
}

/**
 * Cerca su AniList dove finiscono le stagioni di questa scheda.
 *
 * Non solleva mai: una serie senza tagli è una serie con un elenco
 * unico di puntate, cioè esattamente com'era prima. Fallire qui non
 * deve poter far fallire un aggancio o una rilettura.
 *
 * Non tocca i tagli già scritti se AniList non risponde o non torna
 * col conto: potrebbero essere stati messi a mano dalla Gestione, e
 * cancellarli sarebbe buttare via l'unico lavoro che una persona ha
 * dovuto fare a mano.
 */
async function calcolaTagli(pool, animeId) {
  try {
    const { rows } = await pool.query(
      `
      SELECT a.id, a.titolo, a.titolo_originale, a.titolo_inglese, a.tagli,
             (SELECT COUNT(*)::int FROM anime_episodi e
               WHERE e.anime_id = a.id AND e.numero > 0) AS disponibili
        FROM anime a WHERE a.id = $1
      `,
      [animeId]
    );

    if (rows.length === 0) return [];

    const scheda = rows[0];

    // Una scheda con poche puntate non ha stagioni dentro: si evita
    // una richiesta ad AniList per ogni serie normale del mondo.
    if (scheda.disponibili < 2) return scheda.tagli || [];

    const esito = await anilist.tagliDiScheda(scheda, scheda.disponibili);

    if (!esito) return scheda.tagli || [];

    await pool.query(
      `UPDATE anime SET tagli = $1, anilist_id = COALESCE($2, anilist_id), aggiornato_il = NOW() WHERE id = $3`,
      [esito.tagli, esito.anilistId, animeId]
    );

    return esito.tagli;
  } catch (e) {
    console.error("ANIME TAGLI ERROR:", e.message);

    return [];
  }
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
// I GRUPPI — le stagioni della stessa serie
//
// La 013 aveva scommesso su una regola sola: «una scheda AnimeClick =
// una serie». Frieren le dà ragione (38 puntate su due stagioni, un
// elenco solo), Isekai Farming no — 42643 per la prima stagione, 67685
// per la seconda, e in videoteca due copertine della stessa cosa.
//
// Il gruppo è il rimedio: sopra le schede, la serie come la chiama una
// persona. Le puntate restano attaccate alla scheda che le ha davvero
// (è lì che i numeri di AnimeClick tornano), il gruppo serve solo a
// guardarle insieme.
// --------------------------------------------------

/**
 * Il titolo del gruppo, dedotto da quello della prima stagione.
 *
 * Toglie il numero in coda — «Isekai Farming - Vita contadina in un
 * altro mondo 2» → «…in un altro mondo» — perché il gruppo è la serie,
 * non una delle sue stagioni. Resta modificabile a mano: nessuna
 * regola sui titoli altrui indovina sempre.
 */
function titoloDiGruppo(titolo) {
  const pulito = String(titolo || "")
    .replace(/[\s:.–-]+(?:stagione\s*)?(?:\d+|i{1,3}|iv|v|vi{1,3}|ix|x)$/i, "")
    .trim();

  // Se il taglio lascia un moncone, il titolo intero è meglio di
  // niente: «Steins;Gate 0» non è «Steins;Gate», ma un gruppo che si
  // chiama «S» non lo è di sicuro.
  return pulito.length >= 3 ? pulito : String(titolo || "").trim();
}

/**
 * Rimette in fila le stagioni di un gruppo.
 *
 * L'ordine scritto a mano viene prima di tutto: se qualcuno ha deciso
 * che il film sta terzo, una rilettura di AnimeClick non deve
 * rispedirlo in fondo perché è uscito dopo. Le stagioni senza un ordine
 * loro si accodano per anno, e a parità di anno per numero di scheda —
 * che su AnimeClick cresce nel tempo.
 */
async function riordinaGruppo(cliente, gruppoId) {
  await cliente.query(
    `
    UPDATE anime a
       SET ordine = n.posizione, aggiornato_il = NOW()
      FROM (
        SELECT id,
               ROW_NUMBER() OVER (
                 ORDER BY ordine NULLS LAST, anno_inizio NULLS LAST, animeclick_id
               ) AS posizione
          FROM anime
         WHERE gruppo_id = $1
      ) n
     WHERE a.id = n.id
       AND a.ordine IS DISTINCT FROM n.posizione
    `,
    [gruppoId]
  );
}

/**
 * Un gruppo con una stagione sola non è un gruppo.
 *
 * Succede togliendo una serie dalla videoteca, o staccandone una a
 * mano: quello che resta è una serie normale, e lasciarle addosso un
 * gruppo vorrebbe dire un pannello che annuncia stagioni che non ci
 * sono.
 */
async function sciogliSeSolo(cliente, gruppoId) {
  if (!gruppoId) return false;

  const { rows } = await cliente.query(
    `SELECT COUNT(*)::int AS quante FROM anime WHERE gruppo_id = $1`,
    [gruppoId]
  );

  if (rows[0].quante > 1) return false;

  await cliente.query(
    `UPDATE anime SET gruppo_id = NULL, ordine = NULL, etichetta = NULL WHERE gruppo_id = $1`,
    [gruppoId]
  );

  await cliente.query(`DELETE FROM anime_gruppi WHERE id = $1`, [gruppoId]);

  return true;
}

async function gruppoDi(cliente, animeId) {
  const { rows } = await cliente.query(`SELECT gruppo_id FROM anime WHERE id = $1`, [animeId]);

  return rows[0]?.gruppo_id ? Number(rows[0].gruppo_id) : null;
}

/** Mette delle schede nello stesso gruppo, creandolo o fondendo quelli che c'erano. */
async function riunisci(cliente, idSerie) {
  const { rows: membri } = await cliente.query(
    `SELECT id, titolo, gruppo_id FROM anime WHERE id = ANY($1::bigint[])`,
    [idSerie]
  );

  if (membri.length < 2) return membri[0]?.gruppo_id ? Number(membri[0].gruppo_id) : null;

  const gruppi = [...new Set(membri.map((m) => m.gruppo_id).filter(Boolean).map(Number))];

  // Il gruppo più vecchio vince: è quello che ha già un titolo scelto
  // e, probabilmente, delle etichette scritte a mano.
  let gruppoId = gruppi.length ? Math.min(...gruppi) : null;

  if (gruppoId === null) {
    const { rows: primo } = await cliente.query(
      `
      SELECT titolo FROM anime
       WHERE id = ANY($1::bigint[])
       ORDER BY anno_inizio NULLS LAST, animeclick_id
       LIMIT 1
      `,
      [idSerie]
    );

    const { rows: creato } = await cliente.query(
      `INSERT INTO anime_gruppi (titolo) VALUES ($1) RETURNING id`,
      [titoloDiGruppo(primo[0]?.titolo) || "Serie senza nome"]
    );

    gruppoId = Number(creato[0].id);
  } else if (gruppi.length > 1) {
    // Due gruppi che si scoprono parenti: si fondono nel più vecchio.
    await cliente.query(`UPDATE anime SET gruppo_id = $1 WHERE gruppo_id = ANY($2::bigint[])`, [
      gruppoId,
      gruppi
    ]);

    await cliente.query(`DELETE FROM anime_gruppi WHERE id = ANY($1::bigint[]) AND id <> $2`, [
      gruppi,
      gruppoId
    ]);
  }

  await cliente.query(
    `
    UPDATE anime SET gruppo_id = $1, aggiornato_il = NOW()
     WHERE id = ANY($2::bigint[]) AND gruppo_id IS DISTINCT FROM $1
    `,
    [gruppoId, idSerie]
  );

  await riordinaGruppo(cliente, gruppoId);

  return gruppoId;
}

/**
 * Cerca le altre stagioni di una serie e le mette nello stesso gruppo.
 *
 * Si appoggia alla pagina `/relazioni` di AnimeClick, che dice quale
 * scheda è il seguito di quale. Non trova tutto — ci sono schede
 * elencate senza nessuna parola di relazione — ma sistema i casi
 * normali senza chiedere niente a nessuno, ed è quello che serve
 * perché la videoteca resti ordinata da sé.
 *
 * Aggancia solo schede GIÀ IN CATALOGO: aggiungere una serie non deve
 * tirarsi dietro cinque stagioni che nessuno ha chiesto.
 */
async function agganciaStagioni(pool, animeId) {
  const { rows } = await pool.query(
    `SELECT id, animeclick_id, gruppo_id FROM anime WHERE id = $1`,
    [animeId]
  );

  if (rows.length === 0) return null;

  const serie = rows[0];
  const suo = serie.gruppo_id ? Number(serie.gruppo_id) : null;

  let parenti;

  try {
    parenti = (await ac.relazioni(serie.animeclick_id)).filter((o) => ac.eStessaSerie(o.legame));
  } catch {
    // AnimeClick muto sulle relazioni non è un motivo per rifiutare
    // l'aggancio: la serie entra lo stesso e il gruppo si fa a mano.
    return suo;
  }

  if (parenti.length === 0) return suo;

  const { rows: vicine } = await pool.query(
    `SELECT id FROM anime WHERE animeclick_id = ANY($1::int[])`,
    [parenti.map((p) => p.id)]
  );

  if (vicine.length === 0) return suo;

  const cliente = await pool.connect();

  try {
    await cliente.query("BEGIN");

    const gruppoId = await riunisci(cliente, [
      Number(serie.id),
      ...vicine.map((v) => Number(v.id))
    ]);

    await cliente.query("COMMIT");

    return gruppoId;
  } catch (e) {
    await cliente.query("ROLLBACK");
    throw e;
  } finally {
    cliente.release();
  }
}

/** Mette a mano una serie nel gruppo di un'altra: il rimedio ai buchi di AnimeClick. */
async function accorpaAMano(pool, animeId, conAnimeId) {
  const cliente = await pool.connect();

  try {
    await cliente.query("BEGIN");

    const vecchio = await gruppoDi(cliente, animeId);
    const gruppoId = await riunisci(cliente, [Number(animeId), Number(conAnimeId)]);

    if (vecchio && vecchio !== gruppoId) await sciogliSeSolo(cliente, vecchio);

    await cliente.query("COMMIT");

    return gruppoId;
  } catch (e) {
    await cliente.query("ROLLBACK");
    throw e;
  } finally {
    cliente.release();
  }
}

/** Toglie una stagione dal suo gruppo. Se l'altra resta sola, il gruppo sparisce. */
async function stacca(pool, animeId) {
  const cliente = await pool.connect();

  try {
    await cliente.query("BEGIN");

    const gruppoId = await gruppoDi(cliente, animeId);

    await cliente.query(
      `
      UPDATE anime
         SET gruppo_id = NULL, ordine = NULL, etichetta = NULL, aggiornato_il = NOW()
       WHERE id = $1
      `,
      [animeId]
    );

    if (gruppoId) {
      const sciolto = await sciogliSeSolo(cliente, gruppoId);
      if (!sciolto) await riordinaGruppo(cliente, gruppoId);
    }

    await cliente.query("COMMIT");

    return true;
  } catch (e) {
    await cliente.query("ROLLBACK");
    throw e;
  } finally {
    cliente.release();
  }
}

// --------------------------------------------------
// La videoteca è di chi la guarda
// --------------------------------------------------

/** Mette la serie nella videoteca di chi ha chiesto, se non c'era già. */
async function mettiInVideoteca(pool, animeId, utenteId, stato = "da_vedere") {
  if (!utenteId) return false;

  const { rowCount } = await pool.query(
    `
    INSERT INTO visioni (anime_id, utente_id, stato)
    VALUES ($1, $2, $3)
    ON CONFLICT (anime_id, utente_id) DO NOTHING
    `,
    [animeId, utenteId, stato]
  );

  return rowCount > 0;
}

/**
 * Toglie una serie dalla TUA videoteca.
 *
 * Il più delle volte non è una cancellazione: sparisce la tua riga in
 * `visioni` — e con lei le tue spunte, il tuo voto, le tue note —
 * mentre la scheda resta a chi la guarda ancora. Solo quando non la
 * guarda più nessuno la scheda se ne va davvero, portandosi dietro
 * puntate e date: tenere il catalogo di una serie che non interessa a
 * nessuno è peso e basta.
 *
 * Note e voti si cancellano a mano invece di lasciarli alla cascata:
 * la cascata parte dalla riga `anime`, che qui quasi sempre resta in
 * piedi.
 */
async function rimuoviDallaVideoteca(pool, animeId, utenteId) {
  const cliente = await pool.connect();

  try {
    await cliente.query("BEGIN");

    const { rows: scheda } = await cliente.query(
      `SELECT id, titolo, gruppo_id FROM anime WHERE id = $1`,
      [animeId]
    );

    if (scheda.length === 0) {
      await cliente.query("ROLLBACK");
      return null;
    }

    const { rowCount: eraMia } = await cliente.query(
      `DELETE FROM visioni WHERE anime_id = $1 AND utente_id = $2`,
      [animeId, utenteId]
    );

    for (const tabella of ["episodi_visti", "voti_anime", "note_anime"]) {
      await cliente.query(
        `DELETE FROM ${tabella} WHERE anime_id = $1 AND utente_id = $2`,
        [animeId, utenteId]
      );
    }

    const { rows: restano } = await cliente.query(
      `SELECT COUNT(*)::int AS quanti FROM visioni WHERE anime_id = $1`,
      [animeId]
    );

    const senzaNessuno = restano[0].quanti === 0;

    if (senzaNessuno) {
      const gruppoId = scheda[0].gruppo_id ? Number(scheda[0].gruppo_id) : null;

      await cliente.query(`DELETE FROM anime WHERE id = $1`, [animeId]);

      if (gruppoId) {
        const sciolto = await sciogliSeSolo(cliente, gruppoId);
        if (!sciolto) await riordinaGruppo(cliente, gruppoId);
      }
    }

    await cliente.query("COMMIT");

    return {
      titolo: scheda[0].titolo,
      // Vero solo quando la scheda è sparita per tutti: sono due fatti
      // diversi, e il sito li dice diversi a chi ha premuto.
      cancellata: senzaNessuno,
      eraInVideoteca: eraMia > 0
    };
  } catch (e) {
    await cliente.query("ROLLBACK");
    throw e;
  } finally {
    cliente.release();
  }
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
  salvaEpisodi,
  // I gruppi e la videoteca di ciascuno (014)
  agganciaStagioni,
  calcolaTagli,
  accorpaAMano,
  stacca,
  titoloDiGruppo,
  mettiInVideoteca,
  rimuoviDallaVideoteca
};
