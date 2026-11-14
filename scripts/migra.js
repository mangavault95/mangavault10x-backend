// Le migrazioni del database: cosa è già stato eseguito, e cosa manca.
//
//   node scripts/migra.js                          stato (sola lettura)
//   node scripts/migra.js baseline --fino 027      cosa segnerebbe come già eseguito
//   node scripts/migra.js baseline --fino 027 --si lo segna, SENZA eseguire niente
//   node scripts/migra.js applica                  cosa applicherebbe
//   node scripts/migra.js applica --si             applica quelle che mancano
//
// Ogni comando che scrive è una SIMULAZIONE finché non si passa `--si`.
// Niente parte da solo: né all'avvio del server né al deploy.
//
// La prima volta (il registro non esiste ancora):
//
//   1. `node scripts/migra.js`  — guarda lo stato: per ogni file dice
//      quanti degli oggetti che crea sono già sul database.
//   2. `node scripts/migra.js baseline --fino 027`  — la simulazione.
//   3. `node scripts/migra.js baseline --fino 027 --si`  — segna le
//      prime 27 come già eseguite. NON le riesegue: alcune modificano
//      dati e non sono ripetibili (vedi services/migrazioni.js).
//
// Da lì, un file nuovo (`sql/028_….sql`) si applica con `applica --si`.
//
// Opzioni: `--forza` (baseline anche con testimoni mancanti; applica
// anche fuori ordine), `--cartella <dir>` (per le prove).

const path = require("path");
const { Client } = require("pg");

require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const { stato, baseline, applica, CARTELLA_SQL } = require("../services/migrazioni");

const args = process.argv.slice(2);
const comando = args[0] && !args[0].startsWith("--") ? args[0] : "stato";
const ha = (nome) => args.includes(`--${nome}`);
const valore = (nome) => {
  const i = args.indexOf(`--${nome}`);

  return i >= 0 ? args[i + 1] : undefined;
};

function collegamento() {
  const url = process.env.DATABASE_URL;

  if (!url) {
    console.error("DATABASE_URL non è impostata (di solito sta nel file .env).");
    process.exit(1);
  }

  // Un database sul proprio computer non parla SSL; Supabase sì, con un
  // certificato che qui non si verifica (come in db.js).
  const locale = /@(localhost|127\.0\.0\.1)[:/]/.test(url);

  return new Client({ connectionString: url, ssl: locale ? false : { rejectUnauthorized: false } });
}

function quanto(r) {
  const { totali, mancanti } = r.testimoni;

  if (!totali) return "nessun oggetto da controllare";

  return mancanti.length ? `${totali - mancanti.length}/${totali} oggetti — MANCANO: ${mancanti.join(", ")}` : `${totali}/${totali} oggetti`;
}

(async () => {
  const cartella = valore("cartella") || CARTELLA_SQL;
  const cliente = collegamento();

  await cliente.connect();

  try {
    // Meglio fallire che aspettare: una ALTER TABLE in coda dietro una
    // query lunga ferma il sito, e `lock_timeout` la fa arrendere.
    await cliente.query("SET lock_timeout = '10s'");

    if (comando === "stato") {
      const s = await stato(cliente, cartella);

      console.log(s.conRegistro ? "\nIl registro c'è.\n" : "\nIl registro NON c'è ancora (prima: baseline).\n");

      for (const r of s.righe) {
        const segno = r.registrata ? (r.modificata ? "~" : "✓") : " ";
        const nota = r.registrata ? `${r.origine}${r.modificata ? ", MODIFICATA dopo" : ""}` : "da fare";

        console.log(`  ${segno} ${r.id.padEnd(40)} ${nota.padEnd(22)} ${quanto(r)}`);
      }

      if (s.inRegistroSenzaFile.length) console.log(`\n  Nel registro ma senza file: ${s.inRegistroSenzaFile.join(", ")}`);

      console.log("");

      return;
    }

    if (comando === "baseline") {
      const fino = Number(valore("fino"));
      const r = await baseline(cliente, { fino, si: ha("si"), forza: ha("forza"), cartella });

      console.log(`\nBaseline fino alla ${String(fino).padStart(3, "0")}: ${r.daSegnare.length} da segnare.`);

      if (r.senzaTestimoni.length) {
        console.log(`\n  Senza niente da controllare (solo dati, o solo comandi non verificabili) — ti fidi della tua parola:`);
        for (const id of r.senzaTestimoni) console.log(`    ${id}`);
      }

      if (r.mancanti.length) {
        console.log(`\n  ⚠️  Oggetti che DOVREBBERO esserci e non ci sono:`);
        for (const m of r.mancanti) console.log(`    ${m.id}: ${m.mancanti.join(", ")}`);
      }

      if (r.rifiutata) {
        console.log("\nRifiutata: una migrazione con oggetti mancanti non è stata eseguita. Eseguila a mano, o `--forza` se lo sai.\n");
        process.exitCode = 1;
      } else if (!ha("si")) {
        console.log("\nSimulazione: non ho scritto niente. Con `--si` segno quelle elencate come già eseguite (senza eseguirle).\n");
      } else {
        console.log("\nFatto: segnate come già eseguite, nessuna riesecuzione.\n");
      }

      return;
    }

    if (comando === "applica") {
      const r = await applica(cliente, { si: ha("si"), forza: ha("forza"), cartella, scrivi: console.log });

      if (!r.daFare.length) console.log("\nNiente da applicare: il database è allineato.\n");
      else if (!ha("si")) console.log(`\nDa applicare (${r.daFare.length}):\n${r.daFare.map((id) => `  ${id}`).join("\n")}\n\nSimulazione: non ho scritto niente. Con \`--si\` le applico.\n`);
      else console.log(`\nApplicate ${r.eseguite.length}: ${r.eseguite.join(", ")}\n`);

      return;
    }

    console.error(`Comando sconosciuto: «${comando}». Usa: stato | baseline | applica`);
    process.exitCode = 1;
  } catch (errore) {
    console.error(`\n❌ ${errore.message}\n`);
    if (errore.eseguite?.length) console.error(`Applicate prima dell'errore: ${errore.eseguite.join(", ")}\n`);
    process.exitCode = 1;
  } finally {
    await cliente.end().catch(() => {});
  }
})();
