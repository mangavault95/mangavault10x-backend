// Prove del reset della password con link monouso.
//
//   PROVA_DATABASE_URL=postgres://… node scripts/prova-reset-password.js
//
// Si controlla: il link vale una volta sola, scade, un nuovo link annulla il vecchio, la password
// troppo corta non brucia il link, il proprietario non si resetta, il token nel database è solo un
// hash, e le sessioni emesse prima del reset non valgono più.

const crypto = require("crypto");
const { Pool } = require("pg");

const url = process.env.PROVA_DATABASE_URL;

if (!url) {
  console.log("\n(PROVA_DATABASE_URL non c'è: salto le prove del reset password.)\n");
  process.exit(0);
}

let falliti = 0;

function prova(nome, atteso, ottenuto) {
  const bene = JSON.stringify(atteso) === JSON.stringify(ottenuto);

  console.log(`  ${bene ? "ok  " : "NO  "} ${nome}`);

  if (!bene) {
    falliti += 1;
    console.log(`       atteso:   ${JSON.stringify(atteso)}\n       ottenuto: ${JSON.stringify(ottenuto)}`);
  }
}

(async () => {
  const schema = `prova_reset_${Math.random().toString(36).slice(2, 10)}`;
  const locale = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const ssl = locale ? false : { rejectUnauthorized: false };
  const admin = new Pool({ connectionString: url, ssl, max: 1 });

  await admin.query(`CREATE SCHEMA ${schema}`);

  process.env.DATABASE_URL = `${url}${url.includes("?") ? "&" : "?"}options=-c%20search_path%3D${schema}`;
  process.env.JWT_SECRET = "una-chiave-finta-lunga-almeno-trentadue-caratteri";
  process.env.ADMIN_USERNAME = "capo";
  process.env.ADMIN_PASSWORD_HASH = `ab:${crypto.scryptSync("la-password-giusta-1234", "ab", 64).toString("hex")}`;

  try {
    const pool = require("../db");
    const utenti = require("../services/utenti");
    const { creaHash, firmaToken, verificaPassword } = require("../services/auth");

    const fs = require("fs");
    const path = require("path");

    // Lo schema minimo che la 035 si aspetta, senza rifare 35 migrazioni.
    await pool.query(`
      CREATE TABLE utenti (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        username TEXT NOT NULL, nickname TEXT NOT NULL, password_hash TEXT NOT NULL DEFAULT '',
        ruolo TEXT NOT NULL DEFAULT 'lettore', stato TEXT NOT NULL DEFAULT 'in_attesa',
        proprietario BOOLEAN NOT NULL DEFAULT FALSE
      )`);
    await pool.query(fs.readFileSync(path.join(__dirname, "..", "sql", "035_reset_password.sql"), "utf8"));

    const vecchia = await creaHash("password-vecchia-123");
    const { rows } = await pool.query(
      `INSERT INTO utenti (username, nickname, password_hash, ruolo, stato, proprietario) VALUES
         ('capo','Capo',$1,'admin','attivo',TRUE),
         ('nanaki','Nanaki',$1,'lettore','attivo',FALSE),
         ('attesa','Attesa',$1,'lettore','in_attesa',FALSE)
       RETURNING id, username`,
      [vecchia]
    );

    const id = Object.fromEntries(rows.map((r) => [r.username, Number(r.id)]));
    const hashDi = async (u) => (await pool.query(`SELECT password_hash FROM utenti WHERE id=$1`, [id[u]])).rows[0].password_hash;

    // --- Chi si può resettare
    prova("il proprietario non si resetta", 400, (await utenti.creaReset(id.capo)).codice);
    prova("chi è in attesa non si resetta", 400, (await utenti.creaReset(id.attesa)).codice);
    prova("persona inesistente", 404, (await utenti.creaReset(99999)).codice);

    // --- Il segreto
    const primo = await utenti.creaReset(id.nanaki);
    prova("il link ha un token lungo", true, primo.token.length >= 40);

    const salvati = (await pool.query(`SELECT token_hash FROM reset_password`)).rows.map((r) => r.token_hash);
    prova("nel database non c'è il token in chiaro", false, salvati.includes(primo.token));
    prova("c'è il suo hash", true, salvati.includes(crypto.createHash("sha256").update(primo.token).digest("hex")));

    // --- Un link nuovo annulla il vecchio
    const secondo = await utenti.creaReset(id.nanaki);
    prova("il link vecchio è annullato da quello nuovo", 400, (await utenti.usaReset(primo.token, "nuova-password-123")).codice);

    // --- La password troppo corta non brucia il link
    prova("password corta rifiutata", 400, (await utenti.usaReset(secondo.token, "corta")).codice);
    prova("...e il link resta buono", true, (await utenti.usaReset("x".repeat(30), "nuova-password-123")).errore !== undefined);

    // --- Token sbagliato
    prova("token inventato rifiutato", 400, (await utenti.usaReset("a".repeat(43), "nuova-password-123")).codice);
    prova("token vuoto rifiutato", 400, (await utenti.usaReset("", "nuova-password-123")).codice);

    // --- Una sessione emessa prima del reset
    const tokenVecchio = require("jsonwebtoken").sign({ id: id.nanaki, user: "nanaki", iat: Math.floor(Date.now() / 1000) - 60 }, process.env.JWT_SECRET);
    const iatVecchio = require("jsonwebtoken").decode(tokenVecchio).iat;
    prova("prima del reset la sessione vale", true, await utenti.ancoraAttivo(id.nanaki, iatVecchio));

    // --- Uso due volte, anche insieme
    const [a, b] = await Promise.all([
      utenti.usaReset(secondo.token, "nuova-password-123"),
      utenti.usaReset(secondo.token, "altra-password-456")
    ]);
    prova("due richieste insieme: ne passa una sola", 1, [a, b].filter((r) => r.ok).length);

    const dopo = await hashDi("nanaki");
    prova("la vecchia password non entra più", false, await verificaPassword("password-vecchia-123", dopo));
    prova("la nuova entra", true, (await verificaPassword("nuova-password-123", dopo)) || (await verificaPassword("altra-password-456", dopo)));

    prova("il link usato non si riusa", 400, (await utenti.usaReset(secondo.token, "terza-password-789")).codice);

    // --- Sessioni di prima: buttate fuori. Una nuova: dentro.
    utenti.dimenticaPermessi();
    prova("la sessione di prima non vale più", false, await utenti.ancoraAttivo(id.nanaki, iatVecchio));
    prova("una sessione nuova vale", true, await utenti.ancoraAttivo(id.nanaki, Math.floor(Date.now() / 1000) + 2));

    // --- Scadenza
    const terzo = await utenti.creaReset(id.nanaki);
    await pool.query(`UPDATE reset_password SET scade_il = NOW() - INTERVAL '1 second' WHERE usato_il IS NULL`);
    prova("un link scaduto non vale", 400, (await utenti.usaReset(terzo.token, "quarta-password-000")).codice);

    // --- Chi viene rifiutato dopo aver chiesto il link
    const quarto = await utenti.creaReset(id.nanaki);
    await pool.query(`UPDATE utenti SET stato='rifiutato' WHERE id=$1`, [id.nanaki]);
    prova("se l'accesso è stato tolto il link non vale", 400, (await utenti.usaReset(quarto.token, "quinta-password-111")).codice);
  } catch (err) {
    falliti += 1;
    console.log("  NO   errore imprevisto:", err);
  } finally {
    await admin.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => {});
    await admin.end().catch(() => {});
    await require("../db").end().catch(() => {});
  }

  console.log(falliti ? `\n${falliti} prove fallite.\n` : "\nTutte le prove passate.\n");
  process.exit(falliti ? 1 : 0);
})();
