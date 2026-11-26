/**
 * «La tua settimana» sul database vero: i bordi della finestra.
 *
 * Serve un Postgres vuoto (`PROVA_DATABASE_URL`, come `prova-migra.js`); senza,
 * salta. Lavora in uno SCHEMA suo, creato e buttato via. Le tabelle sono ridotte
 * alle sole colonne che la query legge.
 *
 * Quello che si prova è dove cade il confine: giorni di calendario ITALIANO,
 * quindi la puntata vista alle 23:30 di Roma conta in quel giorno anche se in UTC
 * è già un altro, d'inverno (+01) e d'estate (+02).
 *
 * Uso:
 *   PROVA_DATABASE_URL=postgres://… node scripts/prova-settimana.js
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

if (!process.env.PROVA_DATABASE_URL) {
  console.log("(PROVA_DATABASE_URL non c'è: salto le prove della settimana.)");
  process.exit(0);
}

const { Client } = require("pg");
const { settimana } = require("../services/settimana");

const SCHEMA = `prova_settimana_${process.pid}`;
let male = 0;

function ok(nome, vero) {
  if (!vero) male++;
  console.log(`${vero ? "✅" : "❌"} ${nome}`);
}

(async () => {
  const db = new Client({ connectionString: process.env.PROVA_DATABASE_URL });

  await db.connect();

  try {
    await db.query(`CREATE SCHEMA ${SCHEMA}`);
    await db.query(`SET search_path TO ${SCHEMA}`);
    await db.query(`
      CREATE TABLE episodi_visti (anime_id BIGINT NOT NULL, numero INT NOT NULL, utente_id BIGINT NOT NULL, visto_il TIMESTAMPTZ NOT NULL);
      CREATE TABLE reading_history (id SERIAL PRIMARY KEY, utente_id BIGINT NOT NULL, read_at TIMESTAMPTZ NOT NULL);
      CREATE TABLE acquisti (id SERIAL PRIMARY KEY, manga_id INT, volume_da INT, volume_a INT, prezzo NUMERIC, data_acquisto DATE NOT NULL);
    `);

    // ---- INVERNO: oggi = domenica 29/11/2026, la finestra è 23/11 - 29/11 (Roma = UTC+1) ----
    await db.query(`
      INSERT INTO episodi_visti (anime_id, numero, utente_id, visto_il) VALUES
        (1, 1, 1, '2026-11-22 23:30:00+01'),  -- il giorno PRIMA: fuori
        (1, 2, 1, '2026-11-23 00:10:00+01'),  -- il primo giorno, appena dopo mezzanotte: dentro
        (2, 1, 1, '2026-11-29 23:30:00+01'),  -- l'ultimo giorno, a fine serata: dentro
        (2, 2, 1, '2026-11-30 00:10:00+01'),  -- il giorno DOPO: fuori
        (3, 1, 2, '2026-11-25 12:00:00+01');  -- di un'altra persona: non conta
      INSERT INTO reading_history (utente_id, read_at) VALUES
        (1, '2026-11-22 23:59:00+01'), (1, '2026-11-23 00:01:00+01'), (1, '2026-11-29 22:00:00+01'),
        (1, '2026-11-30 00:00:00+01'), (2, '2026-11-26 10:00:00+01');
      INSERT INTO acquisti (manga_id, volume_da, volume_a, prezzo, data_acquisto) VALUES
        (1, 1, 2, 10, '2026-11-22'), (1, 3, 4, 10, '2026-11-23'), (2, 1, 2, 12.5, '2026-11-29'), (2, 3, 4, 10, '2026-11-30'),
        (3, NULL, NULL, 7, '2026-11-26');  -- «serie intera»: nei soldi sì, nei volumi no
    `);

    const inverno = await settimana(db, { utenteId: 1, oggi: "2026-11-29" });

    ok("la finestra sono sette giorni, oggi compreso", inverno.dal === "2026-11-23" && inverno.al === "2026-11-29");
    ok("puntate: dentro le due al bordo, fuori quelle di prima e di dopo, e non quelle di un altro", inverno.puntate === 2);
    ok("le puntate sono di due serie diverse", inverno.serie === 2);
    ok("letture: solo quelle di questa persona dentro la finestra", inverno.letti === 2);
    ok("spesa: della casa, dentro la finestra (10 + 12,5 + 7)", inverno.spesa === 29.5);
    ok("volumi comprati: a numeri, la riga senza numeri non si conta", inverno.volumiComprati === 4);

    const altra = await settimana(db, { utenteId: 2, oggi: "2026-11-29" });

    ok("un'altra persona ha le sue puntate e le sue letture", altra.puntate === 1 && altra.letti === 1);
    ok("ma la stessa spesa: gli acquisti sono della casa", altra.spesa === inverno.spesa);

    // ---- ESTATE: oggi = domenica 05/07/2026, Roma = UTC+2 ----
    await db.query(`
      DELETE FROM episodi_visti;
      INSERT INTO episodi_visti (anime_id, numero, utente_id, visto_il) VALUES
        (1, 1, 1, '2026-06-28 23:30:00+02'),  -- 28/6 a Roma (finestra 29/6-5/7): fuori
        (1, 2, 1, '2026-06-29 00:10:00+02'),  -- dentro
        (1, 3, 1, '2026-07-05 23:30:00+02'),  -- dentro: in UTC sono le 21:30, ma il giorno è lo stesso
        (1, 4, 1, '2026-07-06 00:10:00+02');  -- fuori
    `);

    const estate = await settimana(db, { utenteId: 1, oggi: "2026-07-05" });

    ok("d'estate (+02) il confine resta a mezzanotte italiana", estate.dal === "2026-06-29" && estate.puntate === 2);

    // ---- niente ----
    const vuota = await settimana(db, { utenteId: 99, oggi: "2026-01-04" });

    ok("una settimana senza niente dà tutti zeri", vuota.puntate === 0 && vuota.letti === 0 && vuota.spesa === 0 && vuota.volumiComprati === 0);
  } finally {
    await db.query(`DROP SCHEMA ${SCHEMA} CASCADE`).catch(() => {});
    await db.end();
  }

  console.log(male ? `\n❌ ${male} controlli falliti` : "\n✅ la settimana conta come deve");
  process.exit(male ? 1 : 0);
})().catch((e) => {
  console.error("❌", e);
  process.exit(1);
});
