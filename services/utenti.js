const pool = require("../db");
const {
  credenzialiProprietario,
  firmaToken,
  hashPassword,
  verifyPassword
} = require("./auth");

/**
 * Chi può entrare, e chi è chi.
 *
 * Il sito è nato per una persona sola: le credenziali stavano nelle
 * variabili d'ambiente e "l'utente" non esisteva come cosa. Adesso i
 * lettori sono due — la collezione resta una, i voti e le letture no —
 * e servono delle persone vere a cui attribuire le righe.
 *
 * Il PROPRIETARIO è un caso a parte apposta: le sue credenziali restano
 * su Render, la sua riga nel database serve solo a dargli un
 * identificativo e un soprannome. Così l'accesso di chi il sito ce
 * l'aveva già non dipende da una migrazione riuscita a metà, e
 * cambiargli la password non richiede di toccare il database.
 *
 * Chi si registra dal sito nasce `in_attesa`: esiste, ma non entra.
 * Diventa `attivo` solo quando il proprietario lo accetta.
 */

/* ==================================================
   IL PROPRIETARIO
   ================================================== */

// L'identificativo non cambia mai per tutta la vita del processo:
// vale la pena non richiederlo a ogni lettura della cronologia.
let idProprietarioInCache = null;

/**
 * Allinea la riga del proprietario alle variabili d'ambiente.
 *
 * Gira a ogni avvio. Se la migrazione 009 non è stata ancora eseguita
 * la tabella non c'è: lo dico e vado avanti, perché un backend che non
 * parte è peggio di un backend senza registrazioni.
 */
async function preparaUtenti() {
  const { username, passwordHash, nickname } = credenzialiProprietario();

  try {
    const { rows } = await pool.query(
      `
      UPDATE utenti
      SET username = $1,
          password_hash = $2,
          nickname = COALESCE(NULLIF($3, ''), nickname),
          ruolo = 'admin',
          stato = 'attivo'
      WHERE proprietario
      RETURNING id, nickname
      `,
      [username, passwordHash, nickname]
    );

    if (rows.length === 0) {
      console.warn(
        "⚠️  Nessun proprietario nella tabella utenti: esegui sql/009_utenti_e_voti.sql su Supabase."
      );
      return null;
    }

    idProprietarioInCache = Number(rows[0].id);

    console.log(`👤 Proprietario: ${rows[0].nickname} (#${idProprietarioInCache})`);

    return idProprietarioInCache;
  } catch (err) {
    if (err.code === "42P01") {
      console.warn(
        "⚠️  La tabella utenti non esiste ancora: esegui sql/009_utenti_e_voti.sql su Supabase."
      );
      return null;
    }

    throw err;
  }
}

/** L'identificativo del padrone di casa: è lui il "chi" di default. */
async function idProprietario() {
  if (idProprietarioInCache) return idProprietarioInCache;

  const { rows } = await pool.query(
    `SELECT id FROM utenti WHERE proprietario LIMIT 1`
  );

  if (rows.length === 0) return null;

  idProprietarioInCache = Number(rows[0].id);

  return idProprietarioInCache;
}

/**
 * Di chi sono i dati che questa richiesta vuole leggere.
 *
 * Nell'ordine: chi è scritto nell'indirizzo (`?utente=3`), chi ha fatto
 * l'accesso, il proprietario. L'ultimo gradino è quello che tiene in
 * piedi il sito per chi lo guarda senza entrare: la biblioteca è di
 * Carmine, e da fuori si vedono le sue letture come è sempre stato.
 *
 * Vale solo in LETTURA. Chi scrive lo dice il token e nient'altro:
 * l'indirizzo è roba che chiunque può cambiare.
 */
async function utenteLetto(req) {
  const richiesto = Number(req.query?.utente);

  if (Number.isInteger(richiesto) && richiesto > 0) return richiesto;

  if (req.user?.id) return Number(req.user.id);

  return idProprietario();
}

/**
 * Chi sta scrivendo.
 *
 * Un token vecchio (firmato quando l'utente non esisteva come riga) non
 * ha `id`: può essere solo il proprietario, perché all'epoca era l'unico
 * che potesse avere un token.
 */
async function utenteScrive(req) {
  if (req.user?.id) return Number(req.user.id);

  return idProprietario();
}

/* ==================================================
   ACCESSO
   ================================================== */

const MOTIVI = {
  CREDENZIALI: "credenziali",
  IN_ATTESA: "in_attesa",
  RIFIUTATO: "rifiutato"
};

/**
 * Entra.
 *
 * Il tempo di risposta non deve dire se è sbagliato il nome o la
 * password: quando l'utente non esiste verifico comunque la password
 * contro un hash finto, così i due casi costano uguale.
 */
const HASH_FINTO = hashPassword("password-che-non-esiste");

async function accedi(username, password) {
  const nome = String(username || "").trim();

  let rows;

  try {
    ({ rows } = await pool.query(
      `
      SELECT id, username, nickname, password_hash, ruolo, stato, proprietario
      FROM utenti
      WHERE lower(username) = lower($1)
      LIMIT 1
      `,
      [nome]
    ));
  } catch (err) {
    // La tabella non c'è: il codice nuovo è già in linea ma la
    // migrazione 009 non è ancora stata eseguita su Supabase.
    //
    // In quella finestra il proprietario deve poter entrare lo stesso.
    // Restare fuori dal proprio sito perché uno script SQL non è ancora
    // partito è il modo peggiore di scoprire che serviva eseguirlo —
    // e chi lo esegue è lui, da Supabase, non il server.
    if (err.code === "42P01") return accessoDiRipiego(nome, password);

    throw err;
  }

  const utente = rows[0] || null;

  const passwordGiusta = verifyPassword(
    String(password || ""),
    utente ? utente.password_hash : HASH_FINTO
  );

  if (!utente || !passwordGiusta) return { errore: MOTIVI.CREDENZIALI };

  if (utente.stato === "in_attesa") return { errore: MOTIVI.IN_ATTESA };
  if (utente.stato !== "attivo") return { errore: MOTIVI.RIFIUTATO };

  await pool.query(`UPDATE utenti SET visto_il = NOW() WHERE id = $1`, [utente.id]);

  return { token: firmaToken(utente), utente: pubblico(utente) };
}

/**
 * L'accesso di prima, per il tempo che manca alla migrazione.
 *
 * Solo il proprietario, solo con le credenziali d'ambiente: è
 * esattamente quello che il sito faceva quando il lettore era uno.
 * Il token che ne esce non ha identificativo, e `utenteScrive` lo
 * riconosce come proprietario proprio per questo.
 */
function accessoDiRipiego(nome, password) {
  const { username, passwordHash, nickname } = credenzialiProprietario();

  const utente = {
    id: null,
    username,
    nickname,
    ruolo: "admin",
    stato: "attivo",
    proprietario: true
  };

  const giusta = verifyPassword(String(password || ""), passwordHash);

  if (nome.toLowerCase() !== String(username).toLowerCase() || !giusta) {
    return { errore: MOTIVI.CREDENZIALI };
  }

  console.warn("⚠️  Accesso col metodo vecchio: la tabella utenti non esiste ancora.");

  return { token: firmaToken(utente), utente: pubblico({ ...utente, id: 0 }) };
}

/* ==================================================
   REGISTRAZIONE
   ================================================== */

const REGOLE = {
  usernameMin: 3,
  usernameMax: 24,
  nicknameMin: 2,
  nicknameMax: 20,
  passwordMin: 8
};

/**
 * Una richiesta di accesso, non un account.
 *
 * Nasce senza poteri e senza sessione: chi si registra non entra, viene
 * messo in lista. È il proprietario a decidere, e finché non decide il
 * sito per quella persona è quello di prima.
 */
async function registra({ username, nickname, password }) {
  const nome = String(username || "").trim();
  const soprannome = String(nickname || "").trim();
  const segreto = String(password || "");

  if (nome.length < REGOLE.usernameMin || nome.length > REGOLE.usernameMax) {
    return { errore: `Il nome utente va da ${REGOLE.usernameMin} a ${REGOLE.usernameMax} caratteri.` };
  }

  if (!/^[a-zA-Z0-9._-]+$/.test(nome)) {
    return { errore: "Il nome utente può avere solo lettere, numeri, punto, trattino e trattino basso." };
  }

  if (soprannome.length < REGOLE.nicknameMin || soprannome.length > REGOLE.nicknameMax) {
    return { errore: `Il soprannome va da ${REGOLE.nicknameMin} a ${REGOLE.nicknameMax} caratteri.` };
  }

  if (segreto.length < REGOLE.passwordMin) {
    return { errore: `La password deve avere almeno ${REGOLE.passwordMin} caratteri.` };
  }

  try {
    const { rows } = await pool.query(
      `
      INSERT INTO utenti (username, nickname, password_hash, ruolo, stato)
      VALUES ($1, $2, $3, 'lettore', 'in_attesa')
      RETURNING id, username, nickname, ruolo, stato, proprietario, creato_il
      `,
      [nome, soprannome, hashPassword(segreto)]
    );

    return { utente: pubblico(rows[0]) };
  } catch (err) {
    // 23505 = unico violato. Non dico QUALE dei due è già preso solo
    // quando è l'username: sarebbe un modo per scoprire chi ha un
    // account. Il soprannome invece è pubblico per definizione — sta
    // scritto accanto ai voti — e dirlo aiuta a sceglierne un altro.
    if (err.code === "23505") {
      return err.constraint === "utenti_nickname_unico"
        ? { errore: "Questo soprannome è già usato: scegline un altro." }
        : { errore: "Nome utente non disponibile." };
    }

    if (err.code === "42P01") {
      return { errore: "Le registrazioni non sono ancora attive." };
    }

    throw err;
  }
}

/* ==================================================
   LA LISTA DEL PROPRIETARIO
   ================================================== */

/** Tutti, con lo stato: è la schermata di Gestione. */
async function elenco() {
  const { rows } = await pool.query(
    `
    SELECT id, username, nickname, ruolo, stato, proprietario, creato_il, deciso_il, visto_il
    FROM utenti
    ORDER BY proprietario DESC, creato_il ASC
    `
  );

  return rows.map(pubblico);
}

/** Solo chi aspetta una risposta: è quello che accende la pallina. */
async function richieste() {
  try {
    const { rows } = await pool.query(
      `
      SELECT id, username, nickname, ruolo, stato, proprietario, creato_il
      FROM utenti
      WHERE stato = 'in_attesa'
      ORDER BY creato_il ASC
      `
    );

    return rows.map(pubblico);
  } catch (err) {
    // Senza tabella non c'è nessuno in attesa — e non è un errore da
    // far esplodere addosso a chi sta solo guardando se qualcuno ha
    // bussato (vedi `accessoDiRipiego`).
    if (err.code === "42P01") return [];

    throw err;
  }
}

/**
 * Accetta o rifiuta.
 *
 * Accettare dà "pieni poteri" — ruolo `admin`, cioè può modificare la
 * collezione come il proprietario. Quello che resta solo del
 * proprietario è decidere di chi altro fidarsi.
 */
async function decidi(id, approvato) {
  const { rows } = await pool.query(
    `
    UPDATE utenti
    SET stato = $2,
        ruolo = $3,
        deciso_il = NOW()
    WHERE id = $1 AND NOT proprietario
    RETURNING id, username, nickname, ruolo, stato, proprietario, creato_il, deciso_il
    `,
    [id, approvato ? "attivo" : "rifiutato", approvato ? "admin" : "lettore"]
  );

  return rows.length ? pubblico(rows[0]) : null;
}

/**
 * I soprannomi, per chi guarda senza essere entrato.
 *
 * Servono a scrivere "Voto Nicer" e "Voto <lei>" sotto una serie: sono
 * etichette, non identità. Fuori di qui non esce nient'altro — niente
 * nome utente, niente date.
 */
async function pubblici() {
  const { rows } = await pool.query(
    `
    SELECT id, nickname, proprietario
    FROM utenti
    WHERE stato = 'attivo'
    ORDER BY proprietario DESC, creato_il ASC
    `
  );

  return rows.map((r) => ({
    id: Number(r.id),
    nickname: r.nickname,
    proprietario: Boolean(r.proprietario)
  }));
}

/** La riga come può vederla un browser: senza l'hash della password. */
function pubblico(riga) {
  return {
    id: Number(riga.id),
    username: riga.username,
    nickname: riga.nickname,
    ruolo: riga.ruolo,
    stato: riga.stato,
    proprietario: Boolean(riga.proprietario),
    creatoIl: riga.creato_il ?? null,
    decisoIl: riga.deciso_il ?? null,
    vistoIl: riga.visto_il ?? null
  };
}

module.exports = {
  MOTIVI,
  preparaUtenti,
  idProprietario,
  utenteLetto,
  utenteScrive,
  accedi,
  registra,
  elenco,
  richieste,
  decidi,
  pubblici
};
