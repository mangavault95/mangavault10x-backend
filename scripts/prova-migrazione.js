/**
 * Esegue una migrazione e la ANNULLA, per vedere se gira.
 *
 * Uso:
 *   node scripts/prova-migrazione.js sql/009_utenti_e_voti.sql
 *
 * Perché esiste: lo script SQL lo incolla una persona nel SQL Editor
 * di Supabase, e scoprire lì che una riga è sbagliata significa
 * scoprirlo sul database vero. Qui gira dentro una transazione che
 * finisce sempre in ROLLBACK — quindi non lascia niente — e stampa
 * quello che AVREBBE fatto: quanti voti sarebbero migrati, quante
 * letture assegnate.
 *
 * `lock_timeout` è la parte importante: una DROP COLUMN prende un lock
 * esclusivo sulla tabella, e senza un limite una prova a vuoto potrebbe
 * tenere fermo il sito vero. Cinque secondi e si arrende.
 */

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const pool = require("../db");

const file = process.argv[2];

if (!file) {
  console.error("Uso: node scripts/prova-migrazione.js sql/009_utenti_e_voti.sql");
  process.exit(1);
}

const sql = fs.readFileSync(path.join(__dirname, "..", file), "utf8");

(async () => {
  const cliente = await pool.connect();

  try {
    await cliente.query("SET lock_timeout = '5s'");
    await cliente.query("SET statement_timeout = '120s'");
    await cliente.query("BEGIN");

    console.log(`▶ eseguo ${file} (in transazione, verrà annullata)…`);

    await cliente.query(sql);

    console.log("✅ nessun errore SQL.\n");

    const controlli = [
      ["utenti", `SELECT id, username, nickname, ruolo, stato, proprietario FROM utenti`],
      ["voti migrati", `SELECT COUNT(*)::int AS voti FROM voti`],
      [
        "letture assegnate",
        `SELECT utente_id, COUNT(*)::int AS righe FROM reading_history GROUP BY utente_id`
      ],
      [
        "segnalibri assegnati",
        `SELECT utente_id, COUNT(*)::int AS righe FROM reading_sessions GROUP BY utente_id`
      ],
      [
        "vincoli reading_sessions",
        `SELECT indexname FROM pg_indexes WHERE tablename = 'reading_sessions'`
      ],
      ["vista", `SELECT COUNT(*)::int AS righe FROM v_collezione_riepilogo`]
    ];

    for (const [titolo, query] of controlli) {
      const { rows } = await cliente.query(query);
      console.log(`== ${titolo}`);
      console.table(rows);
    }
  } catch (err) {
    console.error("\n❌ la migrazione si è fermata:");
    console.error(`   ${err.message}`);
    if (err.position) console.error(`   posizione: ${err.position}`);
    if (err.hint) console.error(`   suggerimento: ${err.hint}`);
    process.exitCode = 1;
  } finally {
    await cliente.query("ROLLBACK").catch(() => {});
    cliente.release();
    await pool.end();
    console.log("\n↩ annullata: il database è come prima.");
  }
})();
