// Prova del confine del mese (`routes/mese.js`).
//
//   PROVA_DATABASE_URL=postgres://… node scripts/prova-mese.js
//
// Senza PROVA_DATABASE_URL non fa niente. Con il database lavora in uno schema a parte, che alla fine
// si butta. Prova che una lettura a mezzanotte e mezza ITALIANA stia nel mese giusto: con la sessione
// del database in UTC, il vecchio confine (`date AT TIME ZONE`) cadeva due ore dopo la mezzanotte
// italiana e ci perdeva le letture dei primi minuti di ogni mese.

const { Pool } = require("pg");

let falliti = 0;
function prova(nome, atteso, ottenuto) {
  const bene = JSON.stringify(atteso) === JSON.stringify(ottenuto);
  console.log(`  ${bene ? "ok  " : "NO  "} ${nome}`);
  if (!bene) { falliti += 1; console.log(`       atteso:   ${JSON.stringify(atteso)}\n       ottenuto: ${JSON.stringify(ottenuto)}`); }
}

(async () => {
  const url = process.env.PROVA_DATABASE_URL;

  if (!url) {
    console.log("(PROVA_DATABASE_URL non c'è: salto la prova del confine del mese.)");
    process.exit(0);
  }

  const schema = `prova_mese_${Math.random().toString(36).slice(2, 10)}`;
  const ssl = /@(localhost|127\.0\.0\.1)[:/]/.test(url) ? false : { rejectUnauthorized: false };
  const admin = new Pool({ connectionString: url, ssl, max: 1 });

  await admin.query(`CREATE SCHEMA ${schema}`);

  process.env.DATABASE_URL = `${url}${url.includes("?") ? "&" : "?"}options=-c%20search_path%3D${schema}%20-c%20timezone%3DUTC`;
  process.env.JWT_SECRET = "una-chiave-finta-lunga-almeno-trentadue-caratteri";

  const scratch = new Pool({ connectionString: process.env.DATABASE_URL, ssl, max: 2 });
  let server;

  try {
    await scratch.query(`
      CREATE TABLE utenti (id bigint PRIMARY KEY, nickname text, colore text);
      CREATE TABLE "Manga" ("ID" integer PRIMARY KEY, "Titolo" text, "Edizione" text, "CoverURL" text, "NumeriPosseduti" integer[]);
      CREATE TABLE acquisti (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, manga_id integer, volume_da integer,
        volume_a integer, prezzo numeric(10,2), data_acquisto date);
      CREATE TABLE reading_history (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, utente_id bigint, manga_id integer,
        titolo text, volume integer, read_at timestamptz);
      CREATE TABLE anime (id bigint PRIMARY KEY, titolo text, cover_url text);
      CREATE TABLE episodi_visti (anime_id bigint, numero integer, utente_id bigint, visto_il timestamptz);

      INSERT INTO utenti VALUES (1, 'Nicer', 'ottone');
      INSERT INTO anime VALUES (1, 'Frieren', NULL);
      -- Ora italiana d'autunno = UTC+2 fino al 25 ottobre, +1 dopo.
      INSERT INTO reading_history (utente_id, manga_id, titolo, volume, read_at) VALUES
        (1, 1, 'A', 1, '2026-09-30 23:30:00+02'),   -- settembre
        (1, 1, 'A', 2, '2026-10-01 00:30:00+02'),   -- ottobre, appena dopo la mezzanotte italiana
        (1, 1, 'A', 3, '2026-10-31 23:30:00+01'),   -- ottobre, un'ora prima della mezzanotte
        (1, 1, 'A', 4, '2026-11-01 00:30:00+01');   -- novembre
      INSERT INTO episodi_visti VALUES
        (1, 1, 1, '2026-10-01 00:10:00+02'),         -- ottobre
        (1, 2, 1, '2026-09-30 23:50:00+02'),         -- settembre
        (1, 3, 1, '2026-11-01 00:10:00+01');         -- novembre
    `);

    const express = require("express");
    const app = express();

    app.use("/api/mese", require("../routes/mese"));
    server = await new Promise((ok) => { const s = app.listen(0, () => ok(s)); });

    const chiedi = async (m) => (await fetch(`http://127.0.0.1:${server.address().port}/api/mese?m=${m}`)).json();

    console.log("\nIl confine del mese è la mezzanotte italiana, anche con la sessione del database in UTC");
    const ottobre = await chiedi("2026-10");
    prova("ottobre: letture dalle 00:30 del 1° alle 23:30 del 31", 2, ottobre.letti[0]?.volumi);
    prova("ottobre: puntata delle 00:10 del 1°", 1, ottobre.puntate[0]?.puntate);

    const settembre = await chiedi("2026-09");
    prova("settembre: la lettura delle 23:30 del 30 c'è", 1, settembre.letti[0]?.volumi);
    prova("settembre: la puntata delle 23:50 del 30 c'è", 1, settembre.puntate[0]?.puntate);

    const novembre = await chiedi("2026-11");
    prova("novembre: la lettura delle 00:30 del 1° c'è", 1, novembre.letti[0]?.volumi);
    prova("novembre: la puntata delle 00:10 del 1° c'è", 1, novembre.puntate[0]?.puntate);
  } finally {
    server?.close();
    await scratch.end().catch(() => {});
    await admin.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => {});
    await admin.end();
  }

  if (falliti) { console.log(`\n${falliti} prove fallite`); process.exit(1); }
  console.log("\nTutto a posto.");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
