/**
 * Gli avvisi delle uscite — il bot che dice "è appena uscita".
 *
 * Il giro non parte da qui: parte da GitHub Actions, che chiama
 * `POST /api/anime/uscite/avvisa` come già chiama il calendario. Qui
 * c'è solo cosa mandare e a chi.
 *
 * ------------------------------------------------------------
 * PERCHÉ COSTA COSÌ POCO
 *
 * Non si va a chiedere niente a nessuno. Giorno, ora e PIATTAFORMA di
 * ogni puntata sono già scritti in `anime_episodi` — ce li mette il
 * giro quotidiano del calendario, copiandoli da AnimeClick. Questo
 * lavoro legge una riga del nostro database e la manda su Telegram.
 *
 * ------------------------------------------------------------
 * DUE AVVISI, NON UNO
 *
 * `mattina`  una volta al giorno: "oggi escono queste tre, alle 17 su
 *            Crunchyroll". È quello che si legge davvero, perché la
 *            sera uno sa già cosa lo aspetta.
 * `uscita`   a puntata uscita: serve quando esce a un'ora che non ti
 *            aspettavi, ed è l'unico che arriva mentre la guardi.
 *
 * Parlano della stessa puntata e devono partire tutti e due: per
 * questo `tipo` sta nella chiave di `avvisi_uscite`.
 *
 * ------------------------------------------------------------
 * ⚠️ L'ORDINE DELLE DUE OPERAZIONI
 *
 * Si SEGNA prima e si MANDA dopo, e se la mandata fallisce si
 * cancella quello che si era segnato.
 *
 * L'ordine opposto — mando, poi segno — sembra più prudente e non lo
 * è: fra le due operazioni può passare un secondo, e in quel secondo
 * il giro successivo troverebbe la puntata ancora non segnata e la
 * manderebbe di nuovo. Segnando prima, il peggio che può capitare è
 * un avviso perso, e non capita nemmeno quello perché la riga si
 * toglie e mezz'ora dopo si riprova.
 */

const telegram = require("./telegram");

/**
 * Quanto indietro guarda l'avviso "è uscita".
 *
 * Novanta minuti per un lavoro che gira ogni trenta, cioè tre giri di
 * sovrapposizione. Non è abbondanza: il cron di GitHub Actions parte
 * quando può — cinque, dieci, venti minuti di ritardo sono normali, e
 * sotto carico un giro salta del tutto. La finestra larga fa sì che un
 * giro saltato non perda la puntata; `avvisi_uscite` fa sì che i tre
 * giri non la mandino tre volte. Mai una delle due da sola.
 */
const FINESTRA_MINUTI = 90;

/** Fuori da queste ore l'avviso arriva senza far suonare il telefono. */
const SVEGLIA = 8;
const BUONANOTTE = 23;

const SITO = (process.env.SITO_URL || "https://mangavault10x-frontend.vercel.app").replace(
  /\/$/,
  ""
);

// --------------------------------------------------
// Chi va avvisato di cosa
// --------------------------------------------------

/**
 * Le puntate da annunciare, una riga per (persona, puntata).
 *
 * Le condizioni sono quattro, e ognuna toglie qualcosa di preciso:
 * la serie dev'essere nella videoteca di quella persona e non
 * droppata (là "non l'hai vista" non è un promemoria, è una scelta
 * già fatta), la persona dev'essere attiva e avere una chat
 * collegata, e quell'avviso non dev'essere già partito.
 */
async function daAvvisare(pool, tipo) {
  const finestra =
    tipo === "mattina"
      ? // Da adesso a fine giornata ITALIANA. Il taglio va calcolato
        // sul fuso di Roma e non su quello del server: a Render è
        // notte fonda quando qui è mattina, e `CURRENT_DATE` darebbe
        // il giorno sbagliato per mezza estate.
        `e.uscita_italia >= NOW()
         AND e.uscita_italia < (
               date_trunc('day', NOW() AT TIME ZONE 'Europe/Rome') + interval '1 day'
             ) AT TIME ZONE 'Europe/Rome'`
      : `e.uscita_italia > NOW() - ($2 || ' minutes')::interval
         AND e.uscita_italia <= NOW()`;

  const parametri = tipo === "mattina" ? [tipo] : [tipo, String(FINESTRA_MINUTI)];

  const { rows } = await pool.query(
    `
    SELECT
      u.id AS utente_id, u.nickname, u.telegram_chat_id,
      e.anime_id, e.numero, e.titolo, e.uscita_italia, e.piattaforma,
      a.titolo AS serie
    FROM anime_episodi e
    JOIN anime   a ON a.id = e.anime_id
    JOIN visioni v ON v.anime_id = a.id AND v.stato <> 'droppata'
    JOIN utenti  u ON u.id = v.utente_id
                  AND u.stato = 'attivo'
                  AND u.telegram_chat_id IS NOT NULL
    WHERE e.uscita_italia IS NOT NULL
      AND ${finestra}
      AND NOT EXISTS (
        SELECT 1 FROM avvisi_uscite x
         WHERE x.utente_id = u.id
           AND x.anime_id  = e.anime_id
           AND x.numero    = e.numero
           AND x.tipo      = $1
      )
    ORDER BY u.id, e.uscita_italia, a.titolo
    `,
    parametri
  );

  return rows;
}

/** Le righe raggruppate per persona: un messaggio a testa, non uno a puntata. */
function perPersona(righe) {
  const persone = new Map();

  for (const r of righe) {
    if (!persone.has(r.utente_id)) {
      persone.set(r.utente_id, {
        utenteId: r.utente_id,
        nickname: r.nickname,
        chatId: r.telegram_chat_id,
        puntate: []
      });
    }

    persone.get(r.utente_id).puntate.push(r);
  }

  return [...persone.values()];
}

// --------------------------------------------------
// Come si scrive
// --------------------------------------------------

function ora(quando) {
  return new Date(quando).toLocaleTimeString("it-IT", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Rome"
  });
}

/** L'ora italiana di adesso, per decidere se far suonare il telefono. */
function oraDiRoma() {
  return Number(
    new Date().toLocaleString("en-US", {
      hour: "2-digit",
      hour12: false,
      timeZone: "Europe/Rome"
    })
  );
}

/**
 * Il grassetto è UNO per riga, e non è sempre lo stesso.
 *
 * Provato dal vivo: «<b>17:00</b> <b>Mushoku Tensei…</b> 6» arriva come
 * due macchie di nero attaccate e non si legge né l'ora né il titolo.
 * Quindi il grassetto va a quello che fa da àncora, che cambia col
 * messaggio: nel promemoria della mattina è l'ORA — si scorre una
 * lista di orari — e nell'avviso a puntata uscita, dove l'ora è già
 * adesso, è il TITOLO.
 */

/** "Episodio 6 — «Ancora delle difficoltà?» · Crunchyroll", con quello che c'è. */
function sottotitolo({ numero, titolo, piattaforma }) {
  const pezzi = [`Episodio ${numero}`];

  if (titolo) pezzi.push(`— «${telegram.esc(titolo)}»`);
  if (piattaforma) pezzi.push(`· ${telegram.esc(piattaforma)}`);

  return pezzi.join(" ");
}

function messaggioUscita(puntate) {
  if (puntate.length === 1) {
    const p = puntate[0];

    const dove = p.piattaforma
      ? `È appena uscito su <b>${telegram.esc(p.piattaforma)}</b>.`
      : "È appena uscito.";

    return [
      `📺 <b>${telegram.esc(p.serie)}</b>`,
      `Episodio ${p.numero}${p.titolo ? ` — «${telegram.esc(p.titolo)}»` : ""}`,
      "",
      dove,
      `${SITO}/videoteca/${p.anime_id}`
    ].join("\n");
  }

  return [
    "📺 <b>Appena uscite</b>",
    "",
    puntate
      .map((p) => [`<b>${telegram.esc(p.serie)}</b>`, sottotitolo(p)].join("\n"))
      .join("\n\n")
  ].join("\n");
}

function messaggioMattina(puntate) {
  const quante =
    puntate.length === 1 ? "Oggi esce una puntata" : `Oggi escono ${puntate.length} puntate`;

  return [
    `☀️ <b>${quante}</b>`,
    "",
    puntate
      .map((p) =>
        [`<b>${ora(p.uscita_italia)}</b> · ${telegram.esc(p.serie)}`, sottotitolo(p)].join("\n")
      )
      .join("\n\n"),
    "",
    `${SITO}/calendario`
  ].join("\n");
}

// --------------------------------------------------
// Il giro
// --------------------------------------------------

/**
 * Segna le puntate come annunciate e restituisce quelle che ha
 * segnato davvero.
 *
 * `ON CONFLICT DO NOTHING RETURNING` è tutto il meccanismo: se due
 * giri si accavallano, uno solo si porta a casa le righe e l'altro
 * torna con le mani vuote — e chi torna a mani vuote non manda
 * niente. Non serve un lucchetto, lo fa la chiave primaria.
 */
async function segna(pool, utenteId, puntate, tipo) {
  const { rows } = await pool.query(
    `
    INSERT INTO avvisi_uscite (utente_id, anime_id, numero, tipo)
    SELECT $1, x.anime_id, x.numero, $4
      FROM UNNEST($2::bigint[], $3::int[]) AS x(anime_id, numero)
    ON CONFLICT DO NOTHING
    RETURNING anime_id, numero
    `,
    [utenteId, puntate.map((p) => p.anime_id), puntate.map((p) => p.numero), tipo]
  );

  const presi = new Set(rows.map((r) => `${r.anime_id}:${r.numero}`));

  return puntate.filter((p) => presi.has(`${p.anime_id}:${p.numero}`));
}

/** Rimette le cose come stavano: quell'avviso non è partito. */
async function disdici(pool, utenteId, puntate, tipo) {
  await pool.query(
    `
    DELETE FROM avvisi_uscite
     WHERE utente_id = $1 AND tipo = $4
       AND (anime_id, numero) IN (
         SELECT x.anime_id, x.numero FROM UNNEST($2::bigint[], $3::int[]) AS x(anime_id, numero)
       )
    `,
    [utenteId, puntate.map((p) => p.anime_id), puntate.map((p) => p.numero), tipo]
  );
}

/**
 * Il lavoro intero.
 *
 * Con `prova: true` non segna e non manda: dice soltanto cosa
 * manderebbe, e a chi. È il modo di provarlo senza svegliare nessuno.
 */
async function avvisa(pool, { tipo = "uscita", prova = false } = {}) {
  if (!["uscita", "mattina"].includes(tipo)) {
    throw new Error(`tipo sconosciuto: ${tipo}`);
  }

  if (!telegram.configurato()) {
    throw new Error("TELEGRAM_USCITE_TOKEN non configurato: gli avvisi sono spenti");
  }

  const righe = await daAvvisare(pool, tipo);
  const persone = perPersona(righe);

  // Di notte l'avviso arriva lo stesso, ma zitto. Vale per "è uscita",
  // non per il promemoria del mattino — che a quell'ora non parte.
  const adesso = oraDiRoma();
  const silenzioso = adesso < SVEGLIA || adesso >= BUONANOTTE;

  const esito = {
    tipo,
    trovate: righe.length,
    persone: persone.length,
    inviati: 0,
    falliti: 0,
    dettaglio: []
  };

  for (const persona of persone) {
    const puntate = prova
      ? persona.puntate
      : await segna(pool, persona.utenteId, persona.puntate, tipo);

    if (puntate.length === 0) continue;

    const testo = tipo === "mattina" ? messaggioMattina(puntate) : messaggioUscita(puntate);

    if (prova) {
      esito.dettaglio.push({ a: persona.nickname, puntate: puntate.length, testo });
      continue;
    }

    const risposta = await telegram.invia(persona.chatId, testo, {
      silenzioso: tipo === "uscita" && silenzioso
    });

    if (risposta.ok) {
      esito.inviati++;
      esito.dettaglio.push({ a: persona.nickname, puntate: puntate.length });
      continue;
    }

    // Non è partito: la riga se ne deve andare, o quella puntata non
    // verrebbe annunciata mai più.
    await disdici(pool, persona.utenteId, puntate, tipo);

    esito.falliti++;
    esito.dettaglio.push({
      a: persona.nickname,
      puntate: puntate.length,
      errore: risposta.descrizione
    });

    console.error(`📺 Avviso a ${persona.nickname} non partito:`, risposta.descrizione);
  }

  return esito;
}

module.exports = { avvisa, FINESTRA_MINUTI, messaggioMattina, messaggioUscita };
