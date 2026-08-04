// scripts/rapporto-volumi.js
//
// Quanti volumi sono usciti in Italia delle serie IN CORSO, secondo
// AnimeClick, e cosa andrebbe scritto in "VolumiTotali".
//
//   node scripts/rapporto-volumi.js            → prova a vuoto, non tocca niente
//   node scripts/rapporto-volumi.js --scrivi   → applica le modifiche sicure
//
// Senza `--scrivi` il database non viene toccato: è la modalità con
// cui guardare cosa succederebbe. Le righe segnate "da controllare"
// non vengono mai scritte, nemmeno con `--scrivi`.
// Il percorso esplicito è voluto: senza, dotenv cerca ".env" nella
// cartella da cui si lancia il comando, e lanciato da dentro
// scripts/ non lo trova — DATABASE_URL resta vuoto e pg prova a
// connettersi al Postgres locale di default invece che a Supabase.
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const { Pool } = require("pg");
const { controllaSerie } = require("../services/volumiItaliani");

const SCRIVI = process.argv.includes("--scrivi");
const PAUSA_MS = 1500; // gentile: una richiesta ogni secondo e mezzo

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const SEGNO = {
  scrivi: "+",
  da_controllare: "?",
  niente: ".",
  saltata: "-",
  non_mappata: " ",
  errore: "!"
};

(async () => {
  const { rows } = await pool.query(`
    SELECT "ID", "Titolo", "Edizione", "Editore", "VolumiPosseduti",
           "VolumiTotali", "StatoSerie", "AnimeClickID"
      FROM "Manga"
     WHERE "StatoSerie" = 'in_corso'
     ORDER BY "AnimeClickID" IS NULL, "Titolo"`);

  const mappate = rows.filter((r) => r.AnimeClickID).length;

  console.log(
    `${rows.length} serie in corso — ${mappate} con AnimeClickID, ${rows.length - mappate} da mappare`
  );
  console.log(SCRIVI ? "MODALITÀ SCRITTURA\n" : "prova a vuoto: non verrà scritto niente\n");

  const conteggi = {};
  const daControllare = [];
  let scritte = 0;

  for (const r of rows) {
    const { esito, decisione } = await controllaSerie(r);

    conteggi[decisione.azione] = (conteggi[decisione.azione] || 0) + 1;

    if (decisione.azione === "non_mappata") continue;

    const dettaglio = esito
      ? `AC=${String(esito.massimo ?? "-").padStart(3)}${esito.completo ? " " : "~"}`
      : "AC=  - ";

    console.log(
      `  ${SEGNO[decisione.azione]} ${String(r.Titolo).trim().padEnd(42)} ` +
        `pos=${String(r.VolumiPosseduti).padStart(3)} ${dettaglio} ${decisione.motivo}`
    );

    if (decisione.azione === "da_controllare") {
      daControllare.push(`${String(r.Titolo).trim()} → ${decisione.motivo} (${esito?.url || "?"})`);
    }

    if (SCRIVI && decisione.azione === "scrivi") {
      await pool.query('UPDATE "Manga" SET "VolumiTotali" = $1 WHERE "ID" = $2', [
        decisione.valore,
        r.ID
      ]);
      scritte++;
    }

    await new Promise((x) => setTimeout(x, PAUSA_MS));
  }

  console.log("\n===== RIEPILOGO =====");
  for (const [azione, n] of Object.entries(conteggi)) console.log(`  ${azione.padEnd(16)} ${n}`);

  if (daControllare.length) {
    console.log("\nDa guardare a mano prima di fidarsi:");
    daControllare.forEach((d) => console.log("  - " + d));
  }

  console.log(
    SCRIVI
      ? `\n${scritte} righe aggiornate.`
      : "\nNessuna riga modificata. Rilancia con --scrivi per applicare."
  );

  await pool.end();
})().catch((e) => {
  console.error("ERRORE:", e);
  process.exit(1);
});
