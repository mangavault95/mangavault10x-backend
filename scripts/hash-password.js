/**
 * Genera l'hash della password admin e un JWT_SECRET casuale.
 *
 * Uso:
 *   node scripts/hash-password.js "la-tua-password"
 *
 * Copia i valori stampati nelle Environment Variables di Render.
 * NON committare mai il risultato nel repository.
 */

const crypto = require("crypto");
const { hashPassword } = require("../services/auth");

const password = process.argv[2];

if (!password) {
  console.error('Uso: node scripts/hash-password.js "la-tua-password"');
  process.exit(1);
}

if (password.length < 12) {
  console.error("La password deve essere di almeno 12 caratteri.");
  process.exit(1);
}

console.log("\nIncolla questi valori nelle Environment Variables di Render:\n");
console.log(`ADMIN_PASSWORD_HASH=${hashPassword(password)}`);
console.log(`JWT_SECRET=${crypto.randomBytes(48).toString("hex")}`);
console.log("\nRicorda di impostare anche ADMIN_USERNAME.\n");
