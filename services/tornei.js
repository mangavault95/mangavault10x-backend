const pool = require("../db");

/**
 * Il Kachinuki-sen: le partite giocate, e il modo di fidarsene.
 *
 * La partita si gioca tutta nel browser — trentuno scelte per un
 * torneo da trentadue serie — e arriva qui una volta sola, finita.
 * È una scelta di ritmo: una richiesta per ogni scelta significherebbe
 * aspettare Render a ogni click, e questo è un gioco che si fa a
 * raffica.
 *
 * Il prezzo di quella scelta è che il tabellone arriva da fuori, e da
 * fuori può arrivare qualunque cosa. Per questo `valida` non guarda i
 * campi uno per uno ma RICOSTRUISCE il torneo: chi gioca la sfida del
 * secondo turno non è un dato da controllare, è una conseguenza di chi
 * ha vinto al primo. Se il tabellone mandato non è quello che sarebbe
 * dovuto uscire, non si scrive niente — perché una cronologia in cui
 * un titolo compare in semifinale senza aver mai giocato i quarti non
 * è una cronologia, è rumore.
 */

const TAGLIE = [32, 64, 128];

/* ==================================================
   CONTROLLO
   ================================================== */

const intero = (v) => (Number.isInteger(Number(v)) ? Number(v) : null);

/** Quanti turni servono per arrivare a uno: 32 → 5, 64 → 6, 128 → 7. */
const turniPer = (taglia) => Math.log2(taglia);

/**
 * Il tabellone come dovrebbe essere, confrontato con quello arrivato.
 *
 * Restituisce `{ errore }` oppure `{ partita }` con i dati già puliti
 * e pronti da scrivere.
 */
function valida(corpo) {
  const taglia = intero(corpo?.taglia);

  if (!TAGLIE.includes(taglia)) {
    return { errore: `Taglia non valida: ammesse ${TAGLIE.join(", ")}.` };
  }

  const tema = String(corpo?.tema || "").trim();
  const temaEtichetta = String(corpo?.temaEtichetta || "").trim();

  if (!tema || !temaEtichetta) return { errore: "Tema mancante." };

  /* ---- I partecipanti ---- */

  const grezze = Array.isArray(corpo?.serie) ? corpo.serie : [];

  if (grezze.length !== taglia) {
    return { errore: `Servono ${taglia} serie, ne sono arrivate ${grezze.length}.` };
  }

  const serie = [];
  const visti = new Set();

  for (const [posto, s] of grezze.entries()) {
    const id = intero(s?.id);
    const titolo = String(s?.titolo || "").trim();

    if (!id || !titolo) return { errore: "Una delle serie non ha id o titolo." };

    // Due volte la stessa serie vorrebbe dire che a un certo punto
    // qualcuno ha giocato contro sé stesso.
    if (visti.has(id)) return { errore: `La serie ${id} compare due volte.` };

    visti.add(id);

    serie.push({
      id,
      titolo,
      copertina: s?.copertina ? String(s.copertina) : null,
      seme: posto
    });
  }

  /* ---- Gli scontri ---- */

  const grezzi = Array.isArray(corpo?.sfide) ? corpo.sfide : [];

  if (grezzi.length !== taglia - 1) {
    return {
      errore: `Servono ${taglia - 1} sfide, ne sono arrivate ${grezzi.length}.`
    };
  }

  const perCoordinate = new Map();

  for (const s of grezzi) {
    const turno = intero(s?.turno);
    const posizione = intero(s?.posizione);

    if (turno === null || posizione === null) {
      return { errore: "Una sfida non dice a che turno e in che posizione si è giocata." };
    }

    perCoordinate.set(`${turno}:${posizione}`, s);
  }

  const sfide = [];

  // I vincitori del turno precedente, in ordine di posizione: sono
  // esattamente i giocatori del turno successivo.
  let inCampo = serie.map((s) => s.id);

  for (let turno = 1; turno <= turniPer(taglia); turno++) {
    const passati = [];

    for (let posizione = 0; posizione < inCampo.length / 2; posizione++) {
      const attesa = {
        casa: inCampo[posizione * 2],
        ospite: inCampo[posizione * 2 + 1]
      };

      const arrivata = perCoordinate.get(`${turno}:${posizione}`);

      if (!arrivata) return { errore: `Manca la sfida ${turno}-${posizione}.` };

      if (intero(arrivata.casaId) !== attesa.casa || intero(arrivata.ospiteId) !== attesa.ospite) {
        return {
          errore:
            `La sfida ${turno}-${posizione} dice di aver messo in campo altre due serie ` +
            `rispetto a chi era passato dal turno precedente.`
        };
      }

      const vincitore = intero(arrivata.vincitoreId);

      if (vincitore !== attesa.casa && vincitore !== attesa.ospite) {
        return { errore: `La sfida ${turno}-${posizione} l'ha vinta chi non stava giocando.` };
      }

      sfide.push({ turno, posizione, ...attesa, vincitore });
      passati.push(vincitore);
    }

    inCampo = passati;
  }

  return {
    partita: {
      tema,
      temaEtichetta,
      taglia,
      serie,
      sfide,
      // Alla fine ne resta uno: non lo si chiede a chi manda i dati, lo
      // si legge dal tabellone appena ricostruito.
      vincitoreId: inCampo[0]
    }
  };
}

/* ==================================================
   SCRITTURA
   ================================================== */

/**
 * Salva una partita finita.
 *
 * Tutto dentro una transazione: un torneo senza i suoi scontri, o con
 * metà tabellone, sarebbe peggio di un torneo mai salvato.
 */
async function salva(partita, utenteId) {
  const cliente = await pool.connect();

  try {
    await cliente.query("BEGIN");

    const { rows } = await cliente.query(
      `INSERT INTO tornei (utente_id, tema, tema_etichetta, taglia, vincitore_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, giocato_il`,
      [utenteId, partita.tema, partita.temaEtichetta, partita.taglia, partita.vincitoreId]
    );

    const torneoId = Number(rows[0].id);

    // Un INSERT solo per tutti i partecipanti invece di uno per riga:
    // centoventotto andate e ritorno verso Supabase per una partita
    // sarebbero l'unica parte lenta di un gioco fatto di scatti.
    await cliente.query(
      `INSERT INTO torneo_serie (torneo_id, manga_id, titolo, copertina, seme)
       SELECT $1, * FROM UNNEST($2::bigint[], $3::text[], $4::text[], $5::int[])`,
      [
        torneoId,
        partita.serie.map((s) => s.id),
        partita.serie.map((s) => s.titolo),
        partita.serie.map((s) => s.copertina),
        partita.serie.map((s) => s.seme)
      ]
    );

    await cliente.query(
      `INSERT INTO sfide (torneo_id, turno, posizione, casa_id, ospite_id, vincitore_id)
       SELECT $1, * FROM UNNEST($2::int[], $3::int[], $4::bigint[], $5::bigint[], $6::bigint[])`,
      [
        torneoId,
        partita.sfide.map((s) => s.turno),
        partita.sfide.map((s) => s.posizione),
        partita.sfide.map((s) => s.casa),
        partita.sfide.map((s) => s.ospite),
        partita.sfide.map((s) => s.vincitore)
      ]
    );

    await cliente.query("COMMIT");

    return { id: torneoId, giocatoIl: rows[0].giocato_il };
  } catch (err) {
    await cliente.query("ROLLBACK");
    throw err;
  } finally {
    cliente.release();
  }
}

/**
 * Cancella una partita.
 *
 * Solo la propria, o qualunque se sei il padrone di casa. Le serie e
 * gli scontri se ne vanno con lei (ON DELETE CASCADE).
 */
async function elimina(id, utenteId, proprietario) {
  const { rows } = await pool.query(
    `DELETE FROM tornei
      WHERE id = $1 AND ($2 OR utente_id = $3)
      RETURNING id`,
    [id, Boolean(proprietario), utenteId]
  );

  return rows.length > 0;
}

/* ==================================================
   LETTURA
   ================================================== */

/** La riga di un torneo come la legge il browser. */
function pubblico(riga) {
  return {
    id: Number(riga.id),
    tema: riga.tema,
    temaEtichetta: riga.tema_etichetta,
    taglia: Number(riga.taglia),
    giocatoIl: riga.giocato_il,
    giocatore: { id: Number(riga.utente_id), nickname: riga.nickname || "?" },
    vincitore: {
      id: Number(riga.vincitore_id),
      titolo: riga.vincitore_titolo,
      copertina: riga.vincitore_copertina
    }
  };
}

/**
 * Le partite giocate, dalla più recente.
 *
 * Si vedono tutte, di chiunque: due persone che giocano lo stesso tema
 * e fanno vincere due titoli diversi sono metà del gusto della cosa.
 */
async function elenco({ limite = 40 } = {}) {
  const { rows } = await pool.query(
    `SELECT t.id, t.tema, t.tema_etichetta, t.taglia, t.giocato_il,
            t.utente_id, u.nickname,
            t.vincitore_id,
            v.titolo    AS vincitore_titolo,
            v.copertina AS vincitore_copertina
       FROM tornei t
       JOIN utenti u       ON u.id = t.utente_id
       LEFT JOIN torneo_serie v
              ON v.torneo_id = t.id AND v.manga_id = t.vincitore_id
      ORDER BY t.giocato_il DESC
      LIMIT $1`,
    [Math.min(Math.max(Number(limite) || 40, 1), 200)]
  );

  return rows.map(pubblico);
}

/** Una partita intera: chi ha giocato, e ogni scontro. */
async function dettaglio(id) {
  const { rows } = await pool.query(
    `SELECT t.id, t.tema, t.tema_etichetta, t.taglia, t.giocato_il,
            t.utente_id, u.nickname,
            t.vincitore_id,
            v.titolo    AS vincitore_titolo,
            v.copertina AS vincitore_copertina
       FROM tornei t
       JOIN utenti u       ON u.id = t.utente_id
       LEFT JOIN torneo_serie v
              ON v.torneo_id = t.id AND v.manga_id = t.vincitore_id
      WHERE t.id = $1`,
    [id]
  );

  if (rows.length === 0) return null;

  const { rows: serie } = await pool.query(
    `SELECT manga_id, titolo, copertina, seme
       FROM torneo_serie
      WHERE torneo_id = $1
      ORDER BY seme`,
    [id]
  );

  const { rows: sfide } = await pool.query(
    `SELECT turno, posizione, casa_id, ospite_id, vincitore_id
       FROM sfide
      WHERE torneo_id = $1
      ORDER BY turno, posizione`,
    [id]
  );

  return {
    ...pubblico(rows[0]),
    serie: serie.map((s) => ({
      id: Number(s.manga_id),
      titolo: s.titolo,
      copertina: s.copertina,
      seme: Number(s.seme)
    })),
    sfide: sfide.map((s) => ({
      turno: Number(s.turno),
      posizione: Number(s.posizione),
      casaId: Number(s.casa_id),
      ospiteId: Number(s.ospite_id),
      vincitoreId: Number(s.vincitore_id)
    }))
  };
}

module.exports = { TAGLIE, valida, salva, elimina, elenco, dettaglio };
