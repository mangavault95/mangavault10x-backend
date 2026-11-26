/**
 * Gli avvisi delle uscite — il bot che dice "è appena uscita".
 *
 * Il giro non parte da qui: parte da GitHub Actions, che chiama
 * `POST /api/anime/uscite/avvisa` come già chiama il calendario. Qui
 * c'è solo cosa mandare e a chi.
 *
 * ------------------------------------------------------------
 * DUE CANALI (26/11/2026)
 *
 * Gli stessi due avvisi partono su Telegram e, per chi ha iscritto un
 * dispositivo, come notifica push dall'app installata (`services/push.js`).
 * Sono indipendenti: ognuno ha il suo registro di cosa è già partito
 * (`avvisi_uscite` per Telegram, `push_inviati` per il push), così una puntata
 * già annunciata su un canale parte comunque sull'altro, e se uno dei due è
 * spento — o manca la configurazione — l'altro non se ne accorge.
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
const push = require("./push");

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
async function daAvvisare(pool, tipo, canale = "telegram") {
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
      a.titolo AS serie, a.tagli
    FROM anime_episodi e
    JOIN anime   a ON a.id = e.anime_id
    JOIN visioni v ON v.anime_id = a.id AND v.stato <> 'droppata'
    JOIN utenti  u ON u.id = v.utente_id
                  AND u.stato = 'attivo'
                  AND ${
                    canale === "push"
                      ? "EXISTS (SELECT 1 FROM push_sottoscrizioni s WHERE s.utente_id = u.id)"
                      : "u.telegram_chat_id IS NOT NULL"
                  }
    WHERE e.uscita_italia IS NOT NULL
      AND ${finestra}
      AND NOT EXISTS (
        SELECT 1 FROM ${canale === "push" ? "push_inviati" : "avvisi_uscite"} x
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
// Come si scrive per il push
// --------------------------------------------------

/**
 * «ep. 25», oppure «St. 3 · ep. 3» se la scheda tiene più stagioni (`tagli`):
 * la stessa regola del sito (`formatEpisodio` nel frontend), così la notifica e
 * l'app dicono la stessa puntata con le stesse parole.
 */
function episodio(numero, tagli) {
  const t = (tagli || []).map(Number).filter(Boolean).sort((a, b) => a - b);

  if (!t.length) return `ep. ${numero}`;

  const stagione = 1 + t.filter((x) => x <= numero).length;
  const inizio = stagione === 1 ? 1 : t[stagione - 2];

  return `St. ${stagione} · ep. ${numero - inizio + 1}`;
}

/** Quante righe di elenco in una notifica: oltre, non si leggono. */
const RIGHE_PUSH = 4;

function elencoPush(righe) {
  const visibili = righe.slice(0, RIGHE_PUSH);
  const altre = righe.length - visibili.length;

  return [...visibili, ...(altre > 0 ? [`e altre ${altre}`] : [])].join("\n");
}

/** Il messaggio push per una persona: testo semplice (niente HTML come su Telegram). */
function messaggioPush(tipo, puntate) {
  if (tipo === "mattina") {
    return {
      titolo: puntate.length === 1 ? "Oggi esce una puntata" : `Oggi escono ${puntate.length} puntate`,
      corpo: elencoPush(
        puntate.map((p) => `${ora(p.uscita_italia)} · ${p.serie}, ${episodio(p.numero, p.tagli)}`)
      ),
      url: "/calendario",
      tag: "mattina"
    };
  }

  if (puntate.length === 1) {
    const p = puntate[0];

    return {
      titolo: p.serie,
      corpo: [
        `${episodio(p.numero, p.tagli)}${p.titolo ? ` — «${p.titolo}»` : ""}`,
        p.piattaforma ? `È appena uscito su ${p.piattaforma}.` : "È appena uscito."
      ].join("\n"),
      url: `/videoteca/${p.anime_id}`,
      tag: `uscita-${p.anime_id}-${p.numero}`
    };
  }

  return {
    titolo: "Appena uscite",
    corpo: elencoPush(puntate.map((p) => `${p.serie}, ${episodio(p.numero, p.tagli)}`)),
    url: "/videoteca/io",
    tag: "uscite"
  };
}

// --------------------------------------------------
// Il giro
// --------------------------------------------------

// I due registri, per nome: il nome della tabella finisce dentro l'SQL, quindi
// si sceglie da questa lista e non si compone mai da una stringa che arriva da fuori.
const REGISTRI = { avvisi_uscite: "avvisi_uscite", push_inviati: "push_inviati" };

/**
 * Segna le puntate come annunciate e restituisce quelle che ha
 * segnato davvero.
 *
 * `ON CONFLICT DO NOTHING RETURNING` è tutto il meccanismo: se due
 * giri si accavallano, uno solo si porta a casa le righe e l'altro
 * torna con le mani vuote — e chi torna a mani vuote non manda
 * niente. Non serve un lucchetto, lo fa la chiave primaria.
 */
async function segna(pool, utenteId, puntate, tipo, tabella = "avvisi_uscite") {
  const { rows } = await pool.query(
    `
    INSERT INTO ${REGISTRI[tabella]} (utente_id, anime_id, numero, tipo)
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
async function disdici(pool, utenteId, puntate, tipo, tabella = "avvisi_uscite") {
  await pool.query(
    `
    DELETE FROM ${REGISTRI[tabella]}
     WHERE utente_id = $1 AND tipo = $4
       AND (anime_id, numero) IN (
         SELECT x.anime_id, x.numero FROM UNNEST($2::bigint[], $3::int[]) AS x(anime_id, numero)
       )
    `,
    [utenteId, puntate.map((p) => p.anime_id), puntate.map((p) => p.numero), tipo]
  );
}

/**
 * Il giro su Telegram. Come è sempre stato: si segna, si manda, e se non parte
 * si disdice.
 */
async function avvisaTelegram(pool, { tipo, prova, silenzioso }) {
  const righe = await daAvvisare(pool, tipo, "telegram");
  const persone = perPersona(righe);

  const esito = {
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

/**
 * Il giro push: le stesse puntate, a chi ha iscritto un dispositivo.
 *
 * Stessa regola di ordine di Telegram (si segna prima, si manda dopo), con una
 * differenza: una persona può avere più dispositivi, e la puntata si considera
 * annunciata se ALMENO UNO l'ha ricevuta. Se nessuno la riceve — guasto del
 * servizio, o tutte le sottoscrizioni scadute — la riga si disdice e il giro
 * dopo riprova.
 */
async function avvisaPush(pool, { tipo, prova, silenzioso }) {
  const righe = await daAvvisare(pool, tipo, "push");
  const persone = perPersona(righe);

  const esito = {
    trovate: righe.length,
    persone: persone.length,
    inviati: 0,
    falliti: 0,
    dettaglio: []
  };

  for (const persona of persone) {
    const puntate = prova
      ? persona.puntate
      : await segna(pool, persona.utenteId, persona.puntate, tipo, "push_inviati");

    if (puntate.length === 0) continue;

    const messaggio = messaggioPush(tipo, puntate);

    if (prova) {
      esito.dettaglio.push({ a: persona.nickname, puntate: puntate.length, messaggio });
      continue;
    }

    const notte = tipo === "uscita" && silenzioso;

    const consegnati = await push.inviaAPersona(
      pool,
      persona.utenteId,
      { ...messaggio, silenzioso: notte },
      { urgenza: notte ? "low" : "normal" }
    );

    if (consegnati > 0) {
      esito.inviati++;
      esito.dettaglio.push({ a: persona.nickname, puntate: puntate.length, dispositivi: consegnati });
      continue;
    }

    await disdici(pool, persona.utenteId, puntate, tipo, "push_inviati");

    esito.falliti++;
    esito.dettaglio.push({ a: persona.nickname, puntate: puntate.length, errore: "nessun dispositivo ha ricevuto" });

    console.error(`🔔 Push a ${persona.nickname} non partito`);
  }

  return esito;
}

/**
 * Il lavoro intero.
 *
 * Con `prova: true` non segna e non manda: dice soltanto cosa
 * manderebbe, e a chi. È il modo di provarlo senza svegliare nessuno.
 *
 * I due canali sono indipendenti: ne basta UNO configurato. Un guasto di uno
 * non impedisce all'altro di partire, e la risposta li tiene separati — i campi
 * di sempre (`trovate`, `persone`, `inviati`, `falliti`, `dettaglio`) sono
 * quelli di Telegram, `push` è quello del push (assente se è spento).
 */
async function avvisa(pool, { tipo = "uscita", prova = false } = {}) {
  if (!["uscita", "mattina"].includes(tipo)) {
    throw new Error(`tipo sconosciuto: ${tipo}`);
  }

  const conTelegram = telegram.configurato();
  const conPush = push.configurato();

  if (!conTelegram && !conPush) {
    throw new Error("TELEGRAM_USCITE_TOKEN e VAPID_* non configurati: gli avvisi sono spenti");
  }

  // Di notte l'avviso arriva lo stesso, ma zitto. Vale per "è uscita",
  // non per il promemoria del mattino — che a quell'ora non parte.
  const adesso = oraDiRoma();
  const silenzioso = adesso < SVEGLIA || adesso >= BUONANOTTE;

  const esito = {
    tipo,
    trovate: 0,
    persone: 0,
    inviati: 0,
    falliti: 0,
    dettaglio: []
  };

  if (conTelegram) Object.assign(esito, await avvisaTelegram(pool, { tipo, prova, silenzioso }));

  if (conPush) {
    try {
      esito.push = await avvisaPush(pool, { tipo, prova, silenzioso });
    } catch (err) {
      // 42P01: la migrazione 037 non è ancora stata eseguita. Telegram è già
      // partito: il push dice perché non c'è, e il giro non fallisce.
      if (err.code !== "42P01") throw err;

      esito.push = { errore: "migrazione 037 non eseguita" };
    }
  }

  return esito;
}

module.exports = {
  avvisa,
  FINESTRA_MINUTI,
  messaggioMattina,
  messaggioUscita,
  messaggioPush,
  episodio
};
