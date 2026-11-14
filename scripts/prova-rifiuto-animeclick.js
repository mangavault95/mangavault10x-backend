// Prove della regola «se AnimeClick dice 403 o 429, ci si ferma», per i lavori che passano da Render.
//
//   PROVA_DATABASE_URL=postgres://… node scripts/prova-rifiuto-animeclick.js
//
// La prima parte (il freno di `prendi`) gira ovunque. La seconda monta le rotte vere del
// calendario e delle schede su un Postgres di prova, con un AnimeClick finto che risponde 403, e
// CONTA le richieste che partono: prima di questa regola erano due per il calendario (misurato col
// codice di prima: la seconda pagina rifiutata interrompeva il giro) e una per ogni scheda da leggere;
// adesso è una e basta, e dopo sette giri rifiutati di fila, zero per due settimane.
// Nessuna richiesta esce davvero: `fetch` verso animeclick.it è sostituito.

const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");

const ac = require("../services/providers/animeclick");

let falliti = 0;

function prova(nome, atteso, ottenuto) {
  const bene = JSON.stringify(atteso) === JSON.stringify(ottenuto);

  console.log(`  ${bene ? "ok  " : "NO  "} ${nome}`);

  if (!bene) {
    falliti += 1;
    console.log(`       atteso:   ${JSON.stringify(atteso)}\n       ottenuto: ${JSON.stringify(ottenuto)}`);
  }
}

const risposta = (status, intestazioni = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => intestazioni[k.toLowerCase()] ?? null },
  text: async () => "<html><body></body></html>"
});

let chiamate = 0;
const finto = (status, intestazioni) => async () => {
  chiamate += 1;
  return risposta(status, intestazioni);
};
const minuti = (d) => Math.round((d.getTime() - Date.now()) / 60000);

(async () => {
  console.log("\nIl freno di prendi");
  ac.azzeraFreno();

  let errore = null;

  try {
    await ac.prendi("https://www.animeclick.it/x", {}, finto(403));
  } catch (e) {
    errore = e;
  }

  prova("un 403 lancia RifiutoFonte, senza riprovare", [true, 403, 1], [errore instanceof ac.RifiutoFonte, errore?.status, chiamate]);
  prova("e il messaggio è quello di sempre", true, /^AnimeClick HTTP 403 su /.test(errore?.message));

  const dopo = [];

  for (let i = 0; i < 34; i++) {
    try {
      await ac.prendi(`https://www.animeclick.it/manga/${i}`, {}, finto(200));
    } catch (e) {
      dopo.push(e.senzaRichiesta);
    }
  }

  prova("le 34 richieste dopo (come il rapporto dei volumi del 3 novembre) non partono: zero in più", [1, true], [chiamate, dopo.every(Boolean)]);
  prova("il freno dura circa un'ora", true, minuti(ac.frenoAcceso().fino) >= 59 && minuti(ac.frenoAcceso().fino) <= 61);

  ac.azzeraFreno();
  chiamate = 0;
  await ac.prendi("https://www.animeclick.it/x", {}, finto(429, { "retry-after": "7200" })).catch(() => {});
  prova("un 429 con Retry-After di due ore ferma per due ore", true, minuti(ac.frenoAcceso().fino) >= 119 && minuti(ac.frenoAcceso().fino) <= 121);

  ac.azzeraFreno();
  await ac.prendi("https://www.animeclick.it/x", {}, finto(429, { "retry-after": "999999999" })).catch(() => {});
  prova("un Retry-After assurdo si ferma a un giorno", true, minuti(ac.frenoAcceso().fino) <= 24 * 60 + 1);

  ac.azzeraFreno();
  chiamate = 0;
  const noTrovata = await ac.prendi("https://www.animeclick.it/x", {}, finto(404)).catch((e) => e);

  prova("un 404 NON è un rifiuto: errore normale, nessun freno", [false, null], [noTrovata instanceof ac.RifiutoFonte, ac.frenoAcceso()]);

  await ac.prendi("https://www.animeclick.it/y", {}, finto(200));
  prova("e la richiesta dopo parte", 2, chiamate);

  ac.azzeraFreno();
  ac.sospendiFinoA(new Date(Date.now() + 3600e3));
  chiamate = 0;
  const inPausa = await ac.prendi("https://www.animeclick.it/z", {}, finto(200)).catch((e) => e);

  prova("la pausa letta dal database ferma ogni richiesta", [true, 0], [inPausa instanceof ac.RifiutoFonte, chiamate]);
  ac.azzeraFreno();

  const url = process.env.PROVA_DATABASE_URL;

  if (!url) {
    console.log("\n(PROVA_DATABASE_URL non c'è: salto le rotte vere.)");
    process.exit(falliti ? 1 : 0);
  }

  // ---- le rotte vere, su un Postgres di prova
  const schema = `prova_rifiuto_${Math.random().toString(36).slice(2, 10)}`;
  const locale = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const ssl = locale ? false : { rejectUnauthorized: false };
  const admin = new Pool({ connectionString: url, ssl, max: 1 });

  await admin.query(`CREATE SCHEMA ${schema}`);

  process.env.DATABASE_URL = `${url}${url.includes("?") ? "&" : "?"}options=-c%20search_path%3D${schema}`;
  process.env.CRON_SECRET = "segreto-di-prova";
  process.env.JWT_SECRET = "una-chiave-finta-lunga-almeno-trentadue-caratteri";
  process.env.ADMIN_USERNAME = "prova";
  process.env.ADMIN_PASSWORD_HASH = "00:00";
  delete process.env.TELEGRAM_USCITE_TOKEN;

  const scratch = new Pool({ connectionString: process.env.DATABASE_URL, ssl, max: 2 });
  const veroFetch = globalThis.fetch;
  const veroErrore = console.error;
  let server;

  try {
    await scratch.query(fs.readFileSync(path.join(__dirname, "..", "sql", "029_fonte_stato.sql"), "utf8"));
    await scratch.query(`
      CREATE TABLE anime (id bigint PRIMARY KEY, animeclick_id int, stato text, tipo text, anno_inizio int, letto_il timestamptz,
                          titolo text, titolo_originale text, titolo_inglese text);`);
    await scratch.query(`INSERT INTO anime (id, animeclick_id, stato) SELECT g, 1000 + g, 'in_corso' FROM generate_series(1, 5) g`);

    // Le rotte scrivono l'errore sul registro quando AnimeClick rifiuta: qui è atteso, e copre le prove.
    console.error = () => {};
    console.warn = () => {};

    let verso = 403;
    let versoAnimeClick = 0;

    globalThis.fetch = async (indirizzo, opzioni) => {
      if (!String(indirizzo).includes("animeclick.it")) return veroFetch(indirizzo, opzioni);

      versoAnimeClick += 1;

      return risposta(verso);
    };

    const express = require("express");
    const app = express();

    app.use(express.json());
    app.use("/api/anime", require("../routes/anime"));
    app.use((err, req, res, next) => res.status(500).json({ error: String(err?.message || err) }));
    server = app.listen(0);

    const base = `http://127.0.0.1:${server.address().port}/api/anime`;
    const manda = async (percorso) => {
      const r = await fetch(`${base}${percorso}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-cron-secret": "segreto-di-prova" },
        body: "{}"
      });

      return { codice: r.status, corpo: await r.json() };
    };
    const stato = async (fonte) => (await scratch.query(`SELECT * FROM fonte_stato WHERE fonte = $1`, [fonte])).rows[0] || null;

    console.log("\nIl calendario degli anime, rifiutato da AnimeClick");
    ac.azzeraFreno();
    versoAnimeClick = 0;

    const uno = await manda("/calendario/aggiorna");

    prova("una sola richiesta, non due", 1, versoAnimeClick);
    prova("il giro risulta fallito (502) e dice che è un rifiuto", [502, true], [uno.codice, uno.corpo.rifiuto]);
    prova("si registra UN fallimento nella contabilità di Render", 1, (await stato("animeclick-render"))?.fallimenti_di_fila);
    prova("la contabilità del giro da GitHub (animeclick) non si tocca", null, await stato("animeclick"));

    console.log("\nLe schede degli anime, rifiutate da AnimeClick");
    ac.azzeraFreno();
    versoAnimeClick = 0;

    const schede = await manda("/serie/aggiorna");

    prova("una richiesta sola su cinque schede da leggere", 1, versoAnimeClick);
    prova("il giro è fermato e risulta fallito", [502, true], [schede.codice, schede.corpo.fermato]);
    prova("il secondo rifiuto di giri di fila conta due", 2, (await stato("animeclick-render"))?.fallimenti_di_fila);

    console.log("\nSette giri rifiutati di fila: pausa");
    for (let i = 0; i < 5; i++) {
      ac.azzeraFreno();
      await manda("/calendario/aggiorna");
    }

    const inPausaDb = await stato("animeclick-render");

    prova("al settimo c'è la pausa di due settimane", [7, true], [inPausaDb.fallimenti_di_fila, minuti(new Date(inPausaDb.in_pausa_fino)) > 13 * 24 * 60]);

    ac.azzeraFreno();
    versoAnimeClick = 0;

    const pausa1 = await manda("/calendario/aggiorna");
    const pausa2 = await manda("/serie/aggiorna");

    prova("in pausa il calendario risponde 200 e non fa nessuna richiesta", [200, true, 0], [pausa1.codice, pausa1.corpo.in_pausa, versoAnimeClick]);
    prova("neanche le schede", [200, true, 0], [pausa2.codice, pausa2.corpo.in_pausa, versoAnimeClick]);
    prova("e la pausa non conta altri fallimenti", 7, (await stato("animeclick-render")).fallimenti_di_fila);

    console.log("\nPassata la pausa, un giro riuscito azzera il conto");
    await scratch.query(`UPDATE fonte_stato SET in_pausa_fino = now() - interval '1 minute' WHERE fonte = 'animeclick-render'`);
    ac.azzeraFreno();
    verso = 200;
    versoAnimeClick = 0;

    const riuscito = await manda("/calendario/aggiorna");
    const dopoOk = await stato("animeclick-render");

    prova("il giro riparte e va", [200, true], [riuscito.codice, versoAnimeClick > 0]);
    prova("il conto torna a zero e la pausa è tolta", [0, null], [dopoOk.fallimenti_di_fila, dopoOk.in_pausa_fino]);
  } catch (err) {
    falliti += 1;
    console.error("ERRORE NELLA PROVA:", err);
  } finally {
    globalThis.fetch = veroFetch;
    console.error = veroErrore;
    server?.close();
    await scratch.end().catch(() => {});
    await require("../db").end().catch(() => {});
    await admin.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => {});
    await admin.end().catch(() => {});
  }

  console.log(falliti ? `\n${falliti} prove NON passano.` : "\nTutto a posto.");
  process.exit(falliti ? 1 : 0);
})();
