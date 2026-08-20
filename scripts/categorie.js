// scripts/categorie.js
//
// Riempie `"Manga"."Categoria"` — il pubblico a cui l'opera è stata
// scritta: shonen, shojo, seinen, josei, kodomo — leggendolo dalla
// riga "Categoria" della scheda AnimeClick.
//
// PERCHÉ ANIMECLICK E NON ANILIST: AniList questo dato non ce l'ha in
// nessuna forma. I suoi `genres` dicono di cosa parla un'opera
// ("Drama", "Horror"), mai per chi è stata scritta, e nemmeno i tag
// coprono la cosa. Il catalogo italiano invece la dichiara su ogni
// scheda, ed è la stessa fonte da cui arrivano già i volumi usciti in
// Italia.
//
// COME SI USA
//
//   node scripts/categorie.js              ricognizione: dice cosa
//                                          scriverebbe, non tocca niente
//   node scripts/categorie.js --scrivi     applica
//   node scripts/categorie.js --quante 20  si ferma prima
//   node scripts/categorie.js --tutte      riguarda anche le serie
//                                          che una categoria ce l'hanno già
//
// SUL TRAFFICO: una serie costa UNA richiesta, con una pausa fra una e
// l'altra. Sulle duecento serie della collezione sono tre minuti al
// ritmo di una persona che sfoglia il sito, una volta sola. Il ritmo è
// deliberato: `PAUSA` non va abbassata per fare prima.
//
// SERVE PRIMA: `sql/010_kachinuki.sql` eseguito su Supabase, o la
// colonna non esiste e lo script si ferma dicendolo.

require("dotenv").config();

const pool = require("../db");
const { categoriaDi } = require("../services/providers/animeclick");

const PAUSA = 900;

const attesa = (ms) => new Promise((r) => setTimeout(r, ms));

const scrivi = process.argv.includes("--scrivi");
const tutte = process.argv.includes("--tutte");
const quante = Number(process.argv[process.argv.indexOf("--quante") + 1]) || Infinity;

async function main() {
  // Senza aggancio ad AnimeClick non c'è scheda da leggere: quelle
  // serie le sistema `scripts/aggancia-animeclick.js`, non questo.
  const { rows } = await pool.query(
    `SELECT "ID", "Titolo", "AnimeClickID", "Categoria"
       FROM "Manga"
      WHERE "AnimeClickID" IS NOT NULL
        ${tutte ? "" : `AND "Categoria" IS NULL`}
      ORDER BY "Titolo"`
  );

  const daFare = rows.slice(0, quante);

  console.log(
    `${rows.length} serie da guardare, ne apro ${daFare.length}.` +
      (scrivi ? " Scrivo in tabella." : " RICOGNIZIONE: non scrivo niente.")
  );
  console.log("");

  const conteggi = new Map();
  const senza = [];
  const cambiate = [];
  let errori = 0;

  for (const s of daFare) {
    const titolo = (s.Titolo || "").trim();

    try {
      const categoria = await categoriaDi(s.AnimeClickID);

      if (!categoria) {
        senza.push(titolo);
        console.log(`   —  ${titolo}`);
      } else {
        conteggi.set(categoria, (conteggi.get(categoria) || 0) + 1);

        // Con `--tutte` si ripassa anche su chi una categoria ce
        // l'aveva: quando il valore nuovo è diverso dal vecchio è una
        // correzione, e va detto — potrebbe essere una mano cambiata
        // sul sito, o una nostra scritta a mano che si sta perdendo.
        const prima = s.Categoria;

        if (prima && prima !== categoria) {
          cambiate.push(`${titolo}: ${prima} → ${categoria}`);
          console.log(`   ~  ${titolo}  ${prima} → ${categoria}`);
        } else {
          console.log(`   ✓  ${titolo}  ${categoria}`);
        }

        if (scrivi) {
          await pool.query(`UPDATE "Manga" SET "Categoria" = $1 WHERE "ID" = $2`, [
            categoria,
            s.ID
          ]);
        }
      }
    } catch (err) {
      errori++;
      console.log(`   ✗  ${titolo}  (${err.message})`);
    }

    await attesa(PAUSA);
  }

  console.log("");
  console.log("─".repeat(50));

  for (const [categoria, n] of [...conteggi.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`${String(n).padStart(4)}  ${categoria}`);
  }

  if (senza.length) {
    console.log("");
    console.log(`${senza.length} senza categoria dichiarata sulla scheda:`);
    senza.forEach((t) => console.log(`   ${t}`));
  }

  if (cambiate.length) {
    console.log("");
    console.log(`${cambiate.length} cambiate rispetto a prima:`);
    cambiate.forEach((t) => console.log(`   ${t}`));
  }

  if (errori) {
    console.log("");
    console.log(`${errori} schede non lette: rilancia, riprende da dove si è fermato.`);
  }

  if (!scrivi) {
    console.log("");
    console.log("Era una ricognizione. Per applicare: --scrivi");
  }
}

main()
  .catch((err) => {
    if (err.code === "42703") {
      console.error(
        "❌ La colonna \"Categoria\" non esiste: esegui sql/010_kachinuki.sql su Supabase."
      );
      process.exitCode = 1;
      return;
    }

    console.error("❌", err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
