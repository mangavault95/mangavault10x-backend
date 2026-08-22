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
   IL COLORE DI CHI LEGGE
   ================================================== */

/**
 * I colori con cui si riconosce chi ha scritto una nota.
 *
 * Sono NOMI, non valori: il sito disegna solo con i token del suo
 * design system (`tailwind.config.js`), e un `#rrggbb` scritto qui
 * sarebbe l'unico colore del sito deciso fuori di lì. La stessa lista
 * sta nel frontend in `src/dati/lettori.js`, che sa come si traducono.
 *
 * L'ordine non conta — quello che conta è che siano abbastanza diversi
 * fra loro da distinguersi in un pallino da otto pixel.
 */
const COLORI_LETTORE = ["ottone", "lilla", "menta", "corallo", "cielo", "rosa"];

/**
 * Un colore ancora libero, o — se sono finiti — uno a caso.
 *
 * "Randomico" come chiesto, ma non del tutto: pescare davvero a caso
 * darebbe due lettori dello stesso colore già al terzo iscritto, che è
 * esattamente la cosa che il colore serve a evitare. Si sorteggia fra
 * quelli che nessuno sta usando, e solo quando finiscono si accetta un
 * doppione.
 */
async function coloreLibero() {
  const { rows } = await pool.query(
    `SELECT DISTINCT colore FROM utenti WHERE colore IS NOT NULL`
  );

  const presi = new Set(rows.map((r) => r.colore));
  const liberi = COLORI_LETTORE.filter((c) => !presi.has(c));
  const scelta = liberi.length ? liberi : COLORI_LETTORE;

  return scelta[Math.floor(Math.random() * scelta.length)];
}

/**
 * Dà un colore a chi non ce l'ha.
 *
 * Gira a ogni avvio insieme a `preparaUtenti`: la migrazione ne
 * assegna due, ma un utente approvato prima che questo codice
 * esistesse resterebbe senza, e una nota senza colore non si distingue
 * da quella dell'altro. Uno alla volta, così il sorteggio vede sempre
 * i colori appena assegnati.
 */
async function assegnaColoriMancanti() {
  try {
    const { rows } = await pool.query(
      `SELECT id FROM utenti WHERE colore IS NULL ORDER BY creato_il ASC`
    );

    for (const riga of rows) {
      await pool.query(`UPDATE utenti SET colore = $1 WHERE id = $2`, [
        await coloreLibero(),
        riga.id
      ]);
    }

    if (rows.length) {
      console.log(`🎨 Colore assegnato a ${rows.length} lettori.`);
    }
  } catch (err) {
    // Prima del 012 la colonna non esiste: il sito deve partire lo
    // stesso, le note semplicemente non hanno ancora un colore.
    if (err.code === "42703" || err.code === "42P01") return;
    throw err;
  }
}

/* ==================================================
   CHI È DI CASA IN BIBLIOTECA
   ================================================== */

/**
 * Le registrazioni valgono per la VIDEOTECA. La biblioteca no.
 *
 * Chi si registra dal sito vuole il Cineforum: le serie viste, i
 * commenti, il calendario. La biblioteca è un'altra cosa — è la
 * collezione di carta di casa — e chi ci ha dentro qualcosa di suo
 * (voti, letture, note, droppate) lo decide il proprietario a mano,
 * dalla Gestione. Chi non è di casa la biblioteca la VEDE, e quello
 * che vede è quella del proprietario: la stessa cosa che vede
 * chiunque passi senza entrare.
 *
 * Vive in una colonna (`utenti.biblioteca`, migrazione 018) e non in
 * `ruolo` perché non è un gradino di una scala: la videoteca ce
 * l'hanno tutti, la biblioteca è un posto in cui si è ammessi o no.
 */

// Quanto ci si fida di quello che si è già chiesto. La risposta
// cambia solo quando il proprietario apre o chiude una porta, cioè
// quasi mai — e quella volta la cache viene buttata a mano
// (`dimenticaPermessi`). Il minuto serve alle altre istanze, se un
// giorno ce ne fosse più di una.
const RICORDO_PERMESSI = 60 * 1000;

const permessiRicordati = new Map();

function dimenticaPermessi(utenteId = null) {
  if (utenteId == null) permessiRicordati.clear();
  else permessiRicordati.delete(Number(utenteId));
}

/**
 * Questa persona ha una biblioteca sua?
 *
 * NON sta nel token, ed è deliberato: il token dura trenta giorni, e
 * un permesso scritto lì dentro resterebbe quello di un mese fa. Il
 * giorno in cui il proprietario apre la porta a qualcuno, quella
 * persona deve poter scrivere subito — non al prossimo accesso.
 *
 * Prima della 018 la colonna non c'è: risponde SÌ, che è esattamente
 * come si comportava il sito ieri. Una regola nuova comincia a valere
 * quando la migrazione è passata, non prima — al contrario un push
 * arrivato per primo chiuderebbe fuori Nanaki da casa sua.
 */
async function haBiblioteca(utenteId) {
  const id = Number(utenteId);

  if (!Number.isInteger(id) || id <= 0) return false;

  const ricordo = permessiRicordati.get(id);

  if (ricordo && Date.now() - ricordo.quando < RICORDO_PERMESSI) {
    return ricordo.valore;
  }

  let valore;

  try {
    const { rows } = await pool.query(
      `SELECT biblioteca, proprietario FROM utenti WHERE id = $1 AND stato = 'attivo'`,
      [id]
    );

    valore = Boolean(rows[0]?.biblioteca || rows[0]?.proprietario);
  } catch (err) {
    if (err.code !== "42703" && err.code !== "42P01") throw err;

    valore = true;
  }

  permessiRicordati.set(id, { valore, quando: Date.now() });

  return valore;
}

/**
 * Apre o chiude la biblioteca a qualcuno.
 *
 * Il proprietario non si può togliere da solo: è l'unico che possa
 * rimettere dentro gli altri, e una casa da cui il padrone si chiude
 * fuori non si riapre più da nessuna parte.
 */
async function impostaBiblioteca(id, dentro) {
  const { rows } = await pool.query(
    `
    UPDATE utenti
    SET biblioteca = $2
    WHERE id = $1 AND NOT proprietario AND stato = 'attivo'
    RETURNING id, username, nickname, ruolo, stato, proprietario, biblioteca, colore,
              creato_il, deciso_il, visto_il
    `,
    [Number(id), Boolean(dentro)]
  );

  dimenticaPermessi(id);

  return rows.length ? pubblico(rows[0]) : null;
}

/**
 * Il proprietario ce l'ha sempre, anche se la migrazione è stata
 * eseguita a metà o la sua riga è stata rifatta a mano.
 *
 * Gira insieme a `preparaUtenti`, e come `assegnaColoriMancanti` tace
 * se la colonna non c'è ancora: il sito deve partire lo stesso.
 */
async function assicuraBibliotecaProprietario() {
  try {
    await pool.query(
      `UPDATE utenti SET biblioteca = TRUE WHERE proprietario AND NOT biblioteca`
    );
  } catch (err) {
    if (err.code === "42703" || err.code === "42P01") return;
    throw err;
  }
}

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

    await assegnaColoriMancanti();
    await assicuraBibliotecaProprietario();

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

  // `biblioteca` si chiede a parte e non nella SELECT qui sopra: quella
  // query è l'unica cosa che sta fra una persona e il proprio sito, e
  // una colonna che non c'è ancora la farebbe fallire per intero.
  // `haBiblioteca` invece sa cadere in piedi.
  return {
    token: firmaToken(utente),
    utente: {
      ...pubblico(utente),
      biblioteca: await haBiblioteca(utente.id)
    }
  };
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

  return {
    token: firmaToken(utente),
    utente: pubblico({ ...utente, id: 0, biblioteca: true })
  };
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
      INSERT INTO utenti (username, nickname, password_hash, ruolo, stato, colore)
      VALUES ($1, $2, $3, 'lettore', 'in_attesa', $4)
      RETURNING id, username, nickname, ruolo, stato, proprietario, creato_il
      `,
      [nome, soprannome, hashPassword(segreto), await coloreLibero()]
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
    SELECT id, username, nickname, ruolo, stato, proprietario, biblioteca, colore,
           creato_il, deciso_il, visto_il
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
 * Accettare dà la VIDEOTECA: la propria pagina, le spunte, i voti agli
 * anime, il Cineforum. Non dà la biblioteca — quella resta a chi ce
 * l'ha, e si apre a mano dalla Gestione (`impostaBiblioteca`). Chi è
 * appena stato accettato di qua può guardare, e quello che guarda è la
 * biblioteca del proprietario.
 *
 * `biblioteca` non si tocca apposta: se il proprietario avesse aperto
 * la porta a qualcuno e quello venisse poi rifiutato e riaccettato, il
 * permesso resterebbe quello deciso a mano, che è l'unico posto in cui
 * è stato deciso davvero.
 */
async function decidi(id, approvato) {
  const { rows } = await pool.query(
    `
    UPDATE utenti
    SET stato = $2,
        ruolo = $3,
        deciso_il = NOW()
    WHERE id = $1 AND NOT proprietario
    RETURNING id, username, nickname, ruolo, stato, proprietario, biblioteca,
              creato_il, deciso_il
    `,
    [id, approvato ? "attivo" : "rifiutato", approvato ? "admin" : "lettore"]
  );

  dimenticaPermessi(id);

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
  const elenco = (campoBiblioteca) => `
    SELECT id, nickname, proprietario, colore, faccia_il, ${campoBiblioteca},
           COALESCE(
             (SELECT array_agg(s.id ORDER BY s.ordine, s.id)
                FROM utenti_striscione s WHERE s.utente_id = utenti.id),
             '{}'
           ) AS striscione
    FROM utenti
    WHERE stato = 'attivo'
    ORDER BY proprietario DESC, creato_il ASC
  `;

  try {
    const { rows } = await pool.query(elenco("biblioteca"));

    return rows.map(aspetto);
  } catch (err) {
    if (err.code !== "42703") throw err;

    // Prima della 018 la biblioteca era di tutti quelli che erano
    // entrati: finché la colonna non c'è si risponde com'era, non a
    // metà. È la stessa scelta di `haBiblioteca`, e vale per la stessa
    // ragione — questo elenco lo chiede ogni visita, e romperlo
    // significa un sito senza nomi accanto ai voti.
    const { rows } = await pool.query(elenco("TRUE AS biblioteca"));

    return rows.map(aspetto);
  }
}

/**
 * Com'è fatta una persona, per chi la guarda.
 *
 * Delle immagini NON escono i byte ma il modo di andarli a prendere:
 * `faccia` è il momento in cui è stata messa — serve appeso
 * all'indirizzo (`?v=…`), o il browser terrebbe per un anno quella di
 * prima — e `striscione` è l'elenco degli identificativi.
 *
 * Mandare i byte qui dentro sarebbe comodo e sbagliato: questa forma
 * finisce dentro ogni post del Cineforum, dove la stessa faccia
 * compare quindici volte per pagina.
 */
function aspetto(r) {
  return {
    id: Number(r.id),
    nickname: r.nickname,
    proprietario: Boolean(r.proprietario),
    // Chi ha una biblioteca sua, e chi di qua sta solo guardando. È
    // pubblico come il colore, e per un motivo pratico: il browser lo
    // usa per sapere di chi sono i voti da accendere e per non offrire
    // un bottone che il server rifiuterebbe.
    biblioteca: Boolean(r.biblioteca || r.proprietario),
    // Il colore è pubblico per definizione: è come si riconosce chi ha
    // scritto una nota, e le note si leggono anche senza essere entrati.
    // Resta anche adesso che c'è la faccia: è il ripiego di chi non ne
    // ha messa una, e il bordo di chi ce l'ha.
    colore: r.colore || null,
    faccia: r.faccia_il ? new Date(r.faccia_il).getTime() : null,
    striscione: (r.striscione || []).map(Number)
  };
}

/* ==================================================
   LA FACCIA E LO STRISCIONE
   ================================================== */

// Quanto può pesare quello che arriva. Sono tetti larghi apposta: il
// browser ridimensiona già prima di mandare (512 pixel per la faccia,
// 1600 per lo striscione), e questi servono solo a fermare chi
// scavalca il browser — non a discutere con chi ha una foto pesante.
const PESO_FACCIA = 400 * 1024;
const PESO_IMMAGINE = 900 * 1024;

// Quante immagini stanno in uno striscione. Sei è una regola di
// prodotto, non di integrità: sta nel codice e non nel database
// proprio per poterla cambiare senza una migrazione.
const QUANTE_IMMAGINI = 6;

/** I byte di una faccia, o niente. */
async function faccia(utenteId) {
  const { rows } = await pool.query(
    `SELECT faccia, faccia_tipo, faccia_il FROM utenti WHERE id = $1`,
    [Number(utenteId)]
  );

  const r = rows[0];

  if (!r?.faccia) return null;

  return { dati: r.faccia, tipo: r.faccia_tipo, quando: r.faccia_il };
}

async function mettiFaccia(utenteId, dati, tipo) {
  await pool.query(
    `UPDATE utenti SET faccia = $1, faccia_tipo = $2, faccia_il = NOW() WHERE id = $3`,
    [dati, tipo, Number(utenteId)]
  );

  return true;
}

async function togliFaccia(utenteId) {
  await pool.query(
    `UPDATE utenti SET faccia = NULL, faccia_tipo = NULL, faccia_il = NULL WHERE id = $1`,
    [Number(utenteId)]
  );

  return true;
}

/** I byte di un'immagine di striscione, cercata per identificativo. */
async function immagineStriscione(id) {
  const { rows } = await pool.query(
    `SELECT immagine, tipo, messa_il FROM utenti_striscione WHERE id = $1`,
    [Number(id)]
  );

  const r = rows[0];

  // Anche i byte, non solo la riga: una riga senza immagine non
  // dovrebbe esistere (la colonna è NOT NULL), ma chi serve dei byte
  // non deve fidarsi — al piano di sopra `intestazioni` ne legge la
  // lunghezza, e su `undefined` cadrebbe con un 500 al posto di un 404.
  if (!r?.immagine) return null;

  return { dati: r.immagine, tipo: r.tipo, quando: r.messa_il };
}

/**
 * Riscrive lo striscione per intero.
 *
 * `pezzi` è l'elenco nell'ordine voluto, e ogni voce è o un numero —
 * un'immagine già lì dentro, da tenere — o dei byte nuovi. Riscrivere
 * tutto invece di avere «aggiungi», «togli» e «sposta» separati
 * significa che riordinare e sostituire sono lo stesso gesto, e che
 * l'ordine non può andare fuori sincrono con quello che si vede.
 *
 * Tutto dentro una transazione: uno striscione mezzo cancellato
 * perché la connessione è caduta a metà sarebbe peggio di uno vecchio.
 */
async function mettiStriscione(utenteId, pezzi) {
  const id = Number(utenteId);
  const cliente = await pool.connect();

  try {
    await cliente.query("BEGIN");

    const daTenere = pezzi.filter((p) => typeof p === "number").map(Number);

    await cliente.query(
      `DELETE FROM utenti_striscione
        WHERE utente_id = $1 AND NOT (id = ANY($2::bigint[]))`,
      [id, daTenere]
    );

    for (let posto = 0; posto < pezzi.length; posto += 1) {
      const pezzo = pezzi[posto];

      if (typeof pezzo === "number") {
        // Tenuta, ma magari spostata: conta solo il posto nuovo.
        await cliente.query(
          `UPDATE utenti_striscione SET ordine = $1 WHERE id = $2 AND utente_id = $3`,
          [posto, pezzo, id]
        );
      } else {
        await cliente.query(
          `INSERT INTO utenti_striscione (utente_id, ordine, immagine, tipo)
           VALUES ($1, $2, $3, $4)`,
          [id, posto, pezzo.dati, pezzo.tipo]
        );
      }
    }

    const { rows } = await cliente.query(
      `SELECT id FROM utenti_striscione WHERE utente_id = $1 ORDER BY ordine, id`,
      [id]
    );

    await cliente.query("COMMIT");

    return rows.map((r) => Number(r.id));
  } catch (err) {
    await cliente.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    cliente.release();
  }
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
    // Il proprietario ce l'ha per definizione: la sua riga può essere
    // stata appena riscritta dalle variabili d'ambiente, e non è una
    // cosa che debba dipendere da un UPDATE riuscito.
    biblioteca: Boolean(riga.biblioteca || riga.proprietario),
    colore: riga.colore ?? null,
    creatoIl: riga.creato_il ?? null,
    decisoIl: riga.deciso_il ?? null,
    vistoIl: riga.visto_il ?? null
  };
}

module.exports = {
  MOTIVI,
  COLORI_LETTORE,
  PESO_FACCIA,
  PESO_IMMAGINE,
  QUANTE_IMMAGINI,
  preparaUtenti,
  idProprietario,
  utenteLetto,
  utenteScrive,
  haBiblioteca,
  impostaBiblioteca,
  dimenticaPermessi,
  accedi,
  registra,
  elenco,
  richieste,
  decidi,
  pubblici,
  aspetto,
  faccia,
  mettiFaccia,
  togliFaccia,
  immagineStriscione,
  mettiStriscione
};
