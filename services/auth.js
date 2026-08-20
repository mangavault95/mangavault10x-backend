const crypto = require("crypto");
const jwt = require("jsonwebtoken");

// --------------------------------------------------
// CONFIG — tutto da variabili d'ambiente.
// Niente valori di default: se manca qualcosa il server
// deve fermarsi subito, non ripiegare su credenziali deboli.
//
// Le credenziali qui dentro sono quelle del PROPRIETARIO, e sono
// rimaste dov'erano apposta: cambiare la propria password resta una
// cosa che si fa da Render, non una riga di database. Gli altri utenti
// invece vivono interamente nella tabella `utenti` (vedi utenti.js).
// --------------------------------------------------
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH;
const ADMIN_NICKNAME = process.env.ADMIN_NICKNAME || "Nicer";

// Trenta giorni, non otto ore. Con un solo utente la sessione serviva
// solo a firmare una modifica; adesso dice anche CHI SEI — quali voti
// sono i tuoi e quali letture vedi. Scadere dopo un pomeriggio
// significherebbe ritrovarsi a guardare la libreria di un altro senza
// aver fatto niente.
const TOKEN_TTL = process.env.JWT_TTL || "30d";

function assertConfig() {
  const missing = [];

  if (!JWT_SECRET) missing.push("JWT_SECRET");
  if (!ADMIN_USERNAME) missing.push("ADMIN_USERNAME");
  if (!ADMIN_PASSWORD_HASH) missing.push("ADMIN_PASSWORD_HASH");

  if (missing.length > 0) {
    throw new Error(
      `Variabili d'ambiente mancanti: ${missing.join(", ")}. ` +
        `Genera l'hash con: node scripts/hash-password.js "la-tua-password"`
    );
  }

  if (JWT_SECRET.length < 32) {
    throw new Error("JWT_SECRET troppo corto: servono almeno 32 caratteri.");
  }
}

const credenzialiProprietario = () => ({
  username: ADMIN_USERNAME,
  passwordHash: ADMIN_PASSWORD_HASH,
  nickname: ADMIN_NICKNAME
});

// --------------------------------------------------
// PASSWORD — scrypt, formato "salt:hash" in esadecimale.
// --------------------------------------------------
const SCRYPT_KEYLEN = 64;

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString("hex");
  return `${salt}:${derived}`;
}

function verifyPassword(password, stored) {
  const [salt, expected] = String(stored || "").split(":");

  if (!salt || !expected) return false;

  const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  const expectedBuffer = Buffer.from(expected, "hex");

  // Lunghezze diverse ⇒ timingSafeEqual lancerebbe: esco prima.
  if (derived.length !== expectedBuffer.length) return false;

  return crypto.timingSafeEqual(derived, expectedBuffer);
}

// --------------------------------------------------
// TOKEN
//
// Dentro ci va l'identificativo dell'utente, non solo il nome: è quello
// che lega un voto o una lettura a una persona, e il nome può cambiare.
// --------------------------------------------------
function firmaToken(utente) {
  assertConfig();

  return jwt.sign(
    {
      id: utente.id,
      user: utente.username,
      nickname: utente.nickname,
      role: utente.ruolo,
      proprietario: Boolean(utente.proprietario)
    },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
}

function leggiToken(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) return null;

  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

// --------------------------------------------------
// MIDDLEWARE
// --------------------------------------------------

/** Serve un accesso valido. */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "Token mancante" });
  }

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    return next();
  } catch (err) {
    return res.status(403).json({ error: "Token non valido o scaduto" });
  }
}

/**
 * Serve essere il padrone di casa.
 *
 * Approvare chi si registra non è un potere da amministratore
 * qualunque: chi è appena stato accettato non deve poter accettare
 * altri a sua volta.
 */
function requireProprietario(req, res, next) {
  return requireAuth(req, res, () => {
    if (!req.user?.proprietario) {
      return res.status(403).json({ error: "Riservato al proprietario" });
    }

    return next();
  });
}

/**
 * Chi sei, se me lo dici.
 *
 * Per le rotte che si possono leggere senza accesso ma che, se
 * l'accesso c'è, devono rispondere sulla persona giusta. Non blocca
 * nessuno: lascia `req.user` a `null` e chi la usa decide.
 */
function identificaUtente(req, res, next) {
  req.user = leggiToken(req);
  return next();
}

module.exports = {
  assertConfig,
  credenzialiProprietario,
  hashPassword,
  verifyPassword,
  firmaToken,
  requireAuth,
  requireProprietario,
  identificaUtente
};
