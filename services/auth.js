const crypto = require("crypto");
const jwt = require("jsonwebtoken");

// --------------------------------------------------
// CONFIG — tutto da variabili d'ambiente.
// Niente valori di default: se manca qualcosa il server
// deve fermarsi subito, non ripiegare su credenziali deboli.
// --------------------------------------------------
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH;
const TOKEN_TTL = process.env.JWT_TTL || "8h";

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
// LOGIN
// --------------------------------------------------
function login(username, password) {
  assertConfig();

  const userMatches = username === ADMIN_USERNAME;
  const passwordMatches = verifyPassword(String(password || ""), ADMIN_PASSWORD_HASH);

  // Valuto sempre entrambi i controlli, così il tempo di risposta
  // non rivela se è sbagliato l'utente o la password.
  if (!userMatches || !passwordMatches) return null;

  return jwt.sign({ user: ADMIN_USERNAME, role: "admin" }, JWT_SECRET, {
    expiresIn: TOKEN_TTL
  });
}

// --------------------------------------------------
// MIDDLEWARE
// --------------------------------------------------
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

module.exports = {
  assertConfig,
  hashPassword,
  verifyPassword,
  login,
  requireAuth
};
