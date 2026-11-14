// Prove del passaggio delle pagine di AnimeClick da GitHub al backend, e dei lavori che le leggono.
//
//   PROVA_DATABASE_URL=postgres://… node scripts/prova-pagine-animeclick.js
//
// Rifà il flusso su un Postgres di prova, in uno schema buttato via: GitHub manda le pagine, i
// lavori (calendario anime, schede anime, rapporto volumi) le leggono, le pagine si cancellano.
// ⚠️ La cosa che più conta: da Render NON deve partire NEMMENO UNA richiesta ad AnimeClick. `fetch`
// verso animeclick.it è sostituito da uno che conta, e alla fine si controlla che il conto sia zero.
//
// L'HTML del calendario è fatto a mano con le stesse ancore che il lettore cerca: NON è una pagina
// vera di AnimeClick (vedi prova-fonti.js per lo stesso avviso). La pagina delle edizioni è invece
// quella vera salvata in fixtures/animeclick/.

const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");

const url = process.env.PROVA_DATABASE_URL;

if (!url) {
  console.log("\n(PROVA_DATABASE_URL non c'è: salto le prove delle pagine di AnimeClick.)\n");
  process.exit(0);
}

let falliti = 0;

function prova(nome, atteso, ottenuto) {
  const bene = JSON.stringify(atteso) === JSON.stringify(ottenuto);

  console.log(`  ${bene ? "ok  " : "NO  "} ${nome}`);

  if (!bene) {
    falliti += 1;
    console.log(`       atteso:   ${JSON.stringify(atteso)}\n       ottenuto: ${JSON.stringify(ottenuto)}`);
  }
}

const CALENDARIO = `<div class="calendario-mese"><h2>Novembre 2026</h2></div>
<div class="col-12 date-separator"><div class="date">20</div><div class="month">novembre</div></div>
<div class="card panel-evento-calendario"><a href="/episodio/555/-/">x</a>
<h4 class="episodio">Venerdì alle 17:00 su Crunchyroll</h4><h5>Frieren</h5><h3>08 Il mago</h3></div>`;

(async () => {
  const schema = `prova_pagine_${Math.random().toString(36).slice(2, 10)}`;
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
  const veroAvviso = console.warn;
  let versoAnimeClick = 0;
  let server;

  try {
    const sql = (f) => fs.readFileSync(path.join(__dirname, "..", "sql", f), "utf8");

    await scratch.query(sql("029_fonte_stato.sql"));
    await scratch.query(sql("032_pagine_animeclick.sql"));
    await scratch.query(`
      CREATE TABLE utenti (id bigint PRIMARY KEY, proprietario boolean, stato text, telegram_chat_id bigint);
      CREATE TABLE anime (id bigint PRIMARY KEY, animeclick_id int UNIQUE, stato text, tipo text, anno_inizio int,
                          letto_il timestamptz, titolo text, titolo_originale text, titolo_inglese text);
      CREATE TABLE anime_episodi (anime_id bigint, numero int, titolo text, uscita_italia timestamptz,
                                  piattaforma text, aggiornato_il timestamptz DEFAULT now());
      CREATE UNIQUE INDEX ON anime_episodi (anime_id, numero) WHERE numero > 0;
      CREATE TABLE "Manga" ("ID" int PRIMARY KEY, "Titolo" text, "Autore" text, "Edizione" text, "Editore" text,
                            "VolumiPosseduti" int, "VolumiItalia" int, "VolumiTotali" int, "StatoSerie" text, "AnimeClickID" int);
      INSERT INTO anime (id, animeclick_id, stato, titolo) VALUES (1, 4001, 'in_corso', 'Frieren'), (2, 4002, 'in_corso', 'Altro');
      INSERT INTO "Manga" ("ID", "Titolo", "VolumiPosseduti", "VolumiItalia", "VolumiTotali", "StatoSerie", "AnimeClickID")
        VALUES (1, 'Berserk', 10, NULL, NULL, 'in_corso', 9607), (2, 'Senza id', 1, NULL, NULL, 'in_corso', NULL);`);

    // AnimeClick, qui, non risponde mai: ogni richiesta è un errore, e si conta.
    globalThis.fetch = async (indirizzo, opzioni) => {
      if (String(indirizzo).includes("animeclick.it")) {
        versoAnimeClick += 1;
        throw new Error("rete vietata nella prova");
      }

      return veroFetch(indirizzo, opzioni);
    };
    console.error = () => {};
    console.warn = () => {};

    const pagine = require("../services/pagineAnimeClick");
    const pool = require("../db");

    console.log("\nQuali pagine si accettano");
    const buoni = [
      "https://www.animeclick.it/calendario-anime",
      "https://www.animeclick.it/calendario-anime?paging=next-month",
      "https://www.animeclick.it/anime/42643/-/",
      "https://www.animeclick.it/anime/42643/-/episodi",
      "https://www.animeclick.it/manga/9607/-/",
      "https://www.animeclick.it/manga/9607/-/edizioni"
    ];
    const cattivi = [
      "https://www.animeclick.it/calendario-anime?paging=prev-week",
      "https://www.animeclick.it/anime/abc/-/",
      "https://www.animeclick.it/profilo/qualcuno",
      "https://www.animeclick.it.evil.example/anime/1/-/",
      "http://www.animeclick.it/anime/1/-/",
      "https://animeclick.it/anime/1/-/",
      "https://example.org/calendario-anime",
      "https://www.animeclick.it/anime/1/-/../../x"
    ];

    prova("le sei pagine che i lavori leggono", [true, true, true, true, true, true], buoni.map(pagine.urlPermesso));
    prova("tutto il resto no", Array(cattivi.length).fill(false), cattivi.map(pagine.urlPermesso));

    console.log("\nLa tabella e il finto fetch");
    await pagine.salva(pool, buoni[2], "<html>scheda</html>");

    const f = pagine.fetchDaPagine(pool);
    const r = await f(buoni[2]);

    prova("una pagina salvata si legge, con la forma di una risposta", [true, 200, "<html>scheda</html>", true], [r.ok, r.status, await r.text(), f.daPagine]);

    const assente = await f(buoni[3]).catch((e) => e);

    prova("una pagina che GitHub non ha mandato è un errore, non una richiesta", [true, 0], [assente instanceof Error, versoAnimeClick]);

    await scratch.query(`UPDATE animeclick_pagine SET scaricata_il = now() - interval '2 days'`);
    prova("una pagina vecchia di due giorni non vale più", true, (await f(buoni[2]).catch((e) => e)) instanceof Error);

    await pagine.salva(pool, buoni[2], "<html>nuova</html>");
    await pagine.salva(pool, buoni[3], "x".repeat(10));
    await scratch.query(`UPDATE animeclick_pagine SET scaricata_il = now() - interval '3 days' WHERE url = $1`, [buoni[3]]);
    await pagine.salva(pool, buoni[4], "<html>altra</html>");
    await pagine.pulisci(pool, [buoni[2]]);

    const rimaste = (await scratch.query(`SELECT url FROM animeclick_pagine ORDER BY url`)).rows.map((x) => x.url);

    prova("pulisci toglie quelle usate e quelle dimenticate da tre giorni, lascia le fresche", [buoni[4]], rimaste);

    const troppo = await pagine.salva(pool, buoni[2], "y".repeat(3_600_000)).catch((e) => e);

    prova("una pagina enorme non entra", true, troppo instanceof pagine.PaginaNonAmmessa);

    console.log("\nLe rotte");
    const express = require("express");
    const app = express();

    app.use("/api/animeclick/pagina", express.json({ limit: "4mb" }));
    app.use(express.json());
    app.use("/api/animeclick", require("../routes/animeclick"));
    app.use("/api/anime", require("../routes/anime"));
    app.use((err, req, res, next) => res.status(500).json({ error: String(err?.message || err) }));
    server = app.listen(0);

    const base = `http://127.0.0.1:${server.address().port}/api`;
    const cron = { "content-type": "application/json", "x-cron-secret": "segreto-di-prova" };
    const chiedi = async (metodo, percorso, corpo, intestazioni = cron) => {
      const r2 = await veroFetch(`${base}${percorso}`, { method: metodo, headers: intestazioni, body: corpo ? JSON.stringify(corpo) : undefined });

      return { codice: r2.status, corpo: await r2.json().catch(() => null) };
    };

    prova("senza il segreto del cron ogni rotta risponde 403", [403, 403, 403, 403], [
      (await chiedi("GET", "/animeclick/stato", null, {})).codice,
      (await chiedi("GET", "/animeclick/da-scaricare?lavoro=calendario", null, {})).codice,
      (await chiedi("POST", "/animeclick/pagina", { url: buoni[0], html: "x" }, { "content-type": "application/json" })).codice,
      (await chiedi("POST", "/animeclick/esito", { riuscito: true }, { "content-type": "application/json" })).codice
    ]);

    const cal = await chiedi("GET", "/animeclick/da-scaricare?lavoro=calendario");
    const sch = await chiedi("GET", "/animeclick/da-scaricare?lavoro=schede&quante=5");
    const rap = await chiedi("GET", "/animeclick/da-scaricare?lavoro=rapporto");
    const rapMensile = await chiedi("GET", "/animeclick/da-scaricare?lavoro=rapporto&stato=1");

    prova("da scaricare, calendario: tre pagine, dalla più vecchia", ["calendario-anime?paging=prev-month", "calendario-anime", "calendario-anime?paging=next-month"], cal.corpo.urls.map((u) => u.split("animeclick.it/")[1]));
    prova("schede: due pagine per ogni serie", [4001, 4002].flatMap((i) => [`anime/${i}/-/`, `anime/${i}/-/episodi`]), sch.corpo.urls.map((u) => u.split("animeclick.it/")[1]));
    prova("rapporto: la pagina delle edizioni, solo per chi ha l'id AnimeClick", ["manga/9607/-/edizioni"], rap.corpo.urls.map((u) => u.split("animeclick.it/")[1]));
    prova("rapporto mensile: anche la pagina dello stato", ["manga/9607/-/edizioni", "manga/9607/-/"], rapMensile.corpo.urls.map((u) => u.split("animeclick.it/")[1]));
    prova("un lavoro che non esiste è un errore", 400, (await chiedi("GET", "/animeclick/da-scaricare?lavoro=boh")).codice);

    const male = await chiedi("POST", "/animeclick/pagina", { url: "https://www.animeclick.it/profilo/x", html: "<p>" });

    prova("una pagina che non è fra quelle ammesse: 400", 400, male.codice);

    console.log("\nIl calendario degli anime legge le pagine di GitHub");
    const senza = await chiedi("POST", "/anime/calendario/aggiorna", { scrivi: true });

    prova("senza pagine il giro fallisce e non va a cercarle", [502, 0], [senza.codice, versoAnimeClick]);

    await chiedi("POST", "/animeclick/pagina", { url: "https://www.animeclick.it/calendario-anime", html: CALENDARIO });
    const giro = await chiedi("POST", "/anime/calendario/aggiorna", { scrivi: true });

    prova("con una pagina sola scrive l'uscita riconosciuta", [200, 1, 1, 1], [giro.codice, giro.corpo.pagine, giro.corpo.riconosciute, giro.corpo.scritte]);

    const uscita = (await scratch.query(`SELECT numero, piattaforma FROM anime_episodi WHERE anime_id = 1`)).rows;

    prova("e l'episodio è in tabella con piattaforma e numero", [{ numero: 8, piattaforma: "Crunchyroll" }], uscita);
    prova("la pagina usata è stata cancellata", 0, (await scratch.query(`SELECT 1 FROM animeclick_pagine WHERE url LIKE '%calendario%'`)).rowCount);

    console.log("\nLe schede degli anime");
    const schede = await chiedi("POST", "/anime/serie/aggiorna", { quante: 5 });

    prova("senza le pagine: nessuna scheda letta, un errore per serie, nessuna richiesta", [200, 0, 2, 0], [schede.codice, schede.corpo.lette, schede.corpo.errori.length, versoAnimeClick]);

    console.log("\nIl rapporto dei volumi, con la pagina vera delle edizioni");
    const { eseguiRapportoVolumi } = require("../services/rapportoVolumi");
    const { volumiUsciti } = require("../services/providers/animeclick");
    const html = fs.readFileSync(path.join(__dirname, "..", "fixtures", "animeclick", "edizioni-berserk.html"), "utf8");

    await pagine.salva(pool, "https://www.animeclick.it/manga/9607/-/edizioni", html);

    const diretto = await volumiUsciti(9607, { fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => html }) });
    const daTabella = await volumiUsciti(9607, { fetchImpl: pagine.fetchDaPagine(pool) });

    prova("leggere la pagina dalla tabella dà lo stesso risultato che leggerla dalla rete", diretto.massimo, daTabella.massimo);

    const t0 = Date.now();
    const rapporto = await eseguiRapportoVolumi(pool, { scrivi: false, fetchImpl: pagine.fetchDaPagine(pool) });

    prova("il rapporto gira sulla pagina scaricata: una serie controllata, una senza id", [1, 1], [rapporto.righe.length, rapporto.conteggi.non_mappata || 0]);
    prova("senza attese e senza rete", [true, 0], [Date.now() - t0 < 3000, versoAnimeClick]);

    console.log("\nL'esito di GitHub");
    const esito = (corpo) => chiedi("POST", "/animeclick/esito", corpo);

    prova("un esito senza «riuscito» è un errore", 400, (await esito({ motivo: "boh" })).codice);
    prova("con «prova» non scrive niente", 0, (await esito({ riuscito: false, motivo: "HTTP 403", prova: true }), (await scratch.query(`SELECT 1 FROM fonte_stato`)).rowCount));

    let ultimo;

    for (let i = 0; i < 7; i++) ultimo = await esito({ riuscito: false, motivo: "HTTP 403", lavoro: "calendario" });

    prova("sette rifiuti di fila: pausa di due settimane", [7, true], [ultimo.corpo.fallimenti_di_fila, new Date(ultimo.corpo.in_pausa_fino) - Date.now() > 13 * 864e5]);

    const inPausa = await chiedi("GET", "/animeclick/da-scaricare?lavoro=calendario");

    prova("in pausa non c'è niente da scaricare", [false, 0], [inPausa.corpo.tentare, inPausa.corpo.urls.length]);

    await scratch.query(`UPDATE fonte_stato SET in_pausa_fino = now() - interval '1 minute'`);
    const ok = await esito({ riuscito: true });

    prova("un giro riuscito, passata la pausa, azzera il conto", [7, 0], [ok.corpo.dopo_fallimenti, (await chiedi("GET", "/animeclick/stato")).corpo.fallimenti_di_fila]);

    prova("in tutta la prova ad AnimeClick non è arrivata NEMMENO UNA richiesta", 0, versoAnimeClick);
  } catch (err) {
    falliti += 1;
    veroErrore("ERRORE NELLA PROVA:", err);
  } finally {
    globalThis.fetch = veroFetch;
    console.error = veroErrore;
    console.warn = veroAvviso;
    server?.close();
    await scratch.end().catch(() => {});
    await require("../db").end().catch(() => {});
    await admin.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => {});
    await admin.end().catch(() => {});
  }

  console.log(falliti ? `\n${falliti} prove NON passano.` : "\nTutto a posto.");
  process.exit(falliti ? 1 : 0);
})();
