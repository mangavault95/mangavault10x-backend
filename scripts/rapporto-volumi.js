// scripts/rapporto-volumi.js
//
// Quanti volumi sono usciti in Italia delle serie IN CORSO, secondo
// AnimeClick, e cosa andrebbe scritto in "VolumiItalia".
//
//   node scripts/rapporto-volumi.js            → prova a vuoto, non tocca niente
//   node scripts/rapporto-volumi.js --scrivi   → applica le modifiche sicure
//
// Senza `--scrivi` il database non viene toccato: è la modalità con
// cui guardare cosa succederebbe. Le righe segnate "da controllare"
// non vengono mai scritte, nemmeno con `--scrivi`.
//
// La logica vera sta in services/rapportoVolumi.js: la stessa la usa
// anche la rotta POST /api/manga/rapporto-volumi, chiamata una volta
// al mese dal job schedulato su GitHub Actions (vedi
// .github/workflows/rapporto-volumi.yml).
//
// Il percorso esplicito è voluto: senza, dotenv cerca ".env" nella
// cartella da cui si lancia il comando, e lanciato da dentro
// scripts/ non lo trova — DATABASE_URL resta vuoto e pg prova a
// connettersi al Postgres locale di default invece che a Supabase.
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const { Pool } = require("pg");
const { eseguiRapportoVolumi } = require("../services/rapportoVolumi");

const SCRIVI = process.argv.includes("--scrivi");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

(async () => {
  const risultato = await eseguiRapportoVolumi(pool, {
    scrivi: SCRIVI,
    log: (riga) => console.log(riga)
  });

  console.log("\n===== RIEPILOGO =====");
  for (const [azione, n] of Object.entries(risultato.conteggi)) console.log(`  ${azione.padEnd(16)} ${n}`);

  if (risultato.daControllare.length) {
    console.log("\nDa guardare a mano prima di fidarsi:");
    risultato.daControllare.forEach((d) => console.log("  - " + d));
  }

  console.log(
    SCRIVI
      ? `\n${risultato.scritte} righe aggiornate.`
      : "\nNessuna riga modificata. Rilancia con --scrivi per applicare."
  );

  await pool.end();
})().catch((e) => {
  console.error("ERRORE:", e);
  process.exit(1);
});
