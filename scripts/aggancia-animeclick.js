// scripts/aggancia-animeclick.js
//
// Trova la scheda AnimeClick di ogni serie in collezione e scrive
// `"AnimeClickID"` in tabella.
//
// A cosa serve, oggi: quella colonna nacque per contare i volumi usciti
// in Italia (sql/006_animeclick.sql) e fu riempita a mano per le 34
// serie che erano in corso. Adesso la usa anche il sito, per chiedere i
// consigli dei lettori italiani senza dover ricercare il titolo a ogni
// apertura di una scheda — tre richieste al loro sito invece di una, e
// una cache che su Render si svuota a ogni risveglio. Riempirla per
// tutte le serie fa sparire quel costo una volta sola.
//
// COME SI USA
//
//   node scripts/aggancia-animeclick.js            ricognizione: dice
//                                                  cosa scriverebbe e
//                                                  non tocca niente
//   node scripts/aggancia-animeclick.js --scrivi   applica
//   node scripts/aggancia-animeclick.js --quante 20  si ferma prima
//
// SUL TRAFFICO: una serie costa da 2 a 5 richieste, con una pausa fra
// una e l'altra. Sull'intera collezione sono una decina di minuti al
// ritmo di una persona che sfoglia il sito, una volta sola. Il ritmo è
// deliberato: `PAUSA` non va abbassata per fare prima.
//
// SULLA PRUDENZA: si scrive solo quando l'aggancio è verificato — la
// firma dell'autore combacia, oppure il titolo è identico ed è l'unico
// risultato. Un id sbagliato qui non sbaglia un consiglio, sbaglia il
// conteggio dei volumi italiani, che è un numero che si guarda per
// decidere cosa comprare. Le serie ambigue restano vuote e finiscono
// nel rapporto, da guardare a mano.

require("dotenv").config();

const pool = require("../db");
const { trovaOpera } = require("../services/providers/animeclick");

const PAUSA = 900;

const attesa = (ms) => new Promise((r) => setTimeout(r, ms));

const scrivi = process.argv.includes("--scrivi");
const quante = Number(process.argv[process.argv.indexOf("--quante") + 1]) || Infinity;

async function main() {
  const { rows } = await pool.query(
    `SELECT "ID", "Titolo", "Autore", "AnimeClickID"
       FROM "Manga"
      WHERE "AnimeClickID" IS NULL
      ORDER BY "ID"`
  );

  const daFare = rows.slice(0, quante);

  console.log(
    `${rows.length} serie senza aggancio, ne guardo ${daFare.length}.` +
      (scrivi ? " Scrivo in tabella." : " RICOGNIZIONE: non scrivo niente.")
  );
  console.log("");

  const agganciate = [];
  const dubbie = [];
  const perse = [];

  for (const s of daFare) {
    const titolo = (s.Titolo || "").trim();

    try {
      const opera = await trovaOpera({ titolo, autore: s.Autore });

      if (!opera) {
        perse.push(s);
        console.log(`✗  ${titolo}  —  nessuna scheda con quella firma`);
      } else if (opera.ambigua) {
        // Più opere sue si somigliano tutte: la scelta è venuta da una
        // regola (la più vecchia è l'originale, i derivati vengono
        // dopo), non da un fatto. Va guardata da una persona.
        dubbie.push({ serie: s, opera });
        console.log(
          `?  ${titolo}  →  ${opera.id} ${opera.titolo}` +
            `  [scartate: ${opera.alternative.map((a) => a.titolo).join(", ")}]`
        );
      } else {
        agganciate.push({ serie: s, opera });
        console.log(`✓  ${titolo}  →  ${opera.id} ${opera.titolo}`);
      }
    } catch (e) {
      perse.push(s);
      console.log(`!  ${titolo}  —  ${e.message}`);
    }

    await attesa(PAUSA);
  }

  // Si scrive solo quello che non ha bisogno di un'opinione: le
  // ambigue restano vuote in tabella e stampate qui sopra, da
  // sistemare a mano come furono sistemate le prime trentaquattro.
  const daScrivere = agganciate;

  console.log("");
  console.log(
    `RIEPILOGO: ${agganciate.length} sicure, ${dubbie.length} ambigue (da guardare), ${perse.length} non trovate.`
  );

  if (dubbie.length) {
    console.log("");
    console.log("DA GUARDARE A MANO (non le scrivo):");
    for (const { serie, opera } of dubbie) {
      console.log(`  ${serie.Titolo}  →  proposta ${opera.id} ${opera.titolo}`);
    }
  }

  if (perse.length) {
    console.log("");
    console.log("NON TROVATE:");
    for (const s of perse) console.log(`  ${s.Titolo} (${s.Autore})`);
  }

  if (!scrivi) {
    console.log("");
    console.log(`Rilancia con --scrivi per scrivere i ${daScrivere.length} agganci sicuri.`);
    return;
  }

  for (const { serie, opera } of daScrivere) {
    await pool.query(`UPDATE "Manga" SET "AnimeClickID" = $1 WHERE "ID" = $2`, [opera.id, serie.ID]);
  }

  console.log(`Scritti ${daScrivere.length} agganci.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
