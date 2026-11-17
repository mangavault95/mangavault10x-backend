// Porta la copertina di ogni serie a quella del suo volume 1 di AnimeClick.
//
//   node scripts/allinea-copertine.js        simulazione: elenca cosa cambierebbe
//   node scripts/allinea-copertine.js --si   scrive
//
// PERCHÉ: `"Manga"."CoverURL"` viene in gran parte da AniList, MyAnimeList o da
// una ricerca immagini: copertine di altre edizioni (giapponese, americana) o di
// un'altra serie, a volte indirizzi scaduti. `copertine_volumi` ha la copertina
// italiana di ogni volume (sql/030), e `services/copertineVolumi.allineaSerie`
// la porta nella serie. Da ora lo fa da sola ogni volta che il giro legge la
// pagina di una serie; questo script serve una volta, per quelle già lette
// (le concluse non si rileggono più).
//
// Una serie senza nessuna copertina di volume non si tocca: la prende appena
// il giro di AnimeClick la legge (`copertine-volumi.yml`, venti serie al giorno;
// a mano «Run workflow» con quarantina).

const path = require("path");
const { Client } = require("pg");

require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const { allineaSerie } = require("../services/copertineVolumi");

const scrivi = process.argv.includes("--si");
const url = process.env.DATABASE_URL;

if (!url) {
  console.error("DATABASE_URL non è impostata (di solito sta nel file .env).");
  process.exit(1);
}

const locale = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
const cliente = new Client({ connectionString: url, ssl: locale ? false : { rejectUnauthorized: false } });

(async () => {
  await cliente.connect();

  try {
    const esito = await allineaSerie(cliente, { scrivi });

    for (const r of esito.elenco) {
      console.log(`${String(r.manga_id).padStart(5)}  ${r.titolo}\n       da ${r.da || "(vuota)"}\n       a  ${r.a}`);
    }

    console.log(
      `\n${esito.esaminate} serie con copertine di volume, ${esito.cambiate} ${scrivi ? "aggiornate" : "da aggiornare"}.` +
        (scrivi || !esito.cambiate ? "\n" : "\nÈ una simulazione: per scrivere, aggiungi --si.\n")
    );
  } finally {
    await cliente.end();
  }
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
