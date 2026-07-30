/**
 * Configura le credenziali di accesso nel file .env locale.
 *
 * Uso:
 *   node scripts/setup-accesso.js <utente> "<password>"
 *
 * Scrive ADMIN_USERNAME, ADMIN_PASSWORD_HASH e JWT_SECRET nel .env,
 * sostituendo le righe già presenti invece di accodarne di doppie.
 *
 * Esiste perché scrivere queste righe a mano si presta a errori
 * silenziosi: virgolette che finiscono nel file, spazi attorno
 * all'uguale, il salvataggio che non va a buon fine. Qui il file
 * viene riletto e verificato dopo la scrittura.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { hashPassword } = require("../services/auth");

const [utente, password] = process.argv.slice(2);

if (!utente || !password) {
  console.error('Uso: node scripts/setup-accesso.js <utente> "<password>"');
  process.exit(1);
}

if (password.length < 12) {
  console.error("La password deve essere di almeno 12 caratteri.");
  process.exit(1);
}

if (utente.toLowerCase() === "admin") {
  console.error('Scegli un nome utente diverso da "admin".');
  process.exit(1);
}

const percorso = path.join(__dirname, "..", ".env");

const valori = {
  ADMIN_USERNAME: utente,
  ADMIN_PASSWORD_HASH: hashPassword(password),
  JWT_SECRET: crypto.randomBytes(48).toString("hex")
};

let contenuto = fs.existsSync(percorso) ? fs.readFileSync(percorso, "utf8") : "";

for (const [chiave, valore] of Object.entries(valori)) {
  // Intercetto anche le righe malformate (con virgolette iniziali)
  // lasciate da tentativi precedenti, così non restano doppioni.
  const riga = new RegExp(`^["'\\s]*${chiave}\\s*=.*$`, "m");

  contenuto = riga.test(contenuto)
    ? contenuto.replace(riga, `${chiave}=${valore}`)
    : contenuto.replace(/\s*$/, `\n${chiave}=${valore}\n`);
}

fs.writeFileSync(percorso, contenuto);

// Rileggo dal disco: scrivere e dichiarare fatto non basta, la
// verifica deve partire dal file vero.
require("dotenv").config({ path: percorso, override: true });

const mancanti = Object.keys(valori).filter((k) => !process.env[k]);

if (mancanti.length > 0) {
  console.error("❌ Scrittura non riuscita per:", mancanti.join(", "));
  process.exit(1);
}

const { verifyPassword } = require("../services/auth");

if (!verifyPassword(password, process.env.ADMIN_PASSWORD_HASH)) {
  console.error("❌ L'hash scritto non corrisponde alla password.");
  process.exit(1);
}

console.log("\n✅ Accesso locale configurato e verificato.\n");
console.log(`   utente:   ${utente}`);
console.log(`   password: quella che hai scelto (non viene mostrata)\n`);
console.log("Per Render, copia queste due righe nelle Environment Variables:\n");
console.log(`ADMIN_PASSWORD_HASH=${valori.ADMIN_PASSWORD_HASH}`);
console.log(`JWT_SECRET=${valori.JWT_SECRET}`);
console.log(`\n(ADMIN_USERNAME resta "${utente}")\n`);
