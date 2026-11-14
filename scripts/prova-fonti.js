// Prova del giro di AnimeClick scaricato da GitHub e della regola dei fallimenti.
//
//   PROVA_DATABASE_URL=postgres://… node scripts/prova-fonti.js
//
// La parte della regola (pausa dopo sette fallimenti, due settimane, riparte) gira ovunque.
// La parte che riceve le pagine e scrive gira su un Postgres di prova, in uno schema suo
// creato e buttato via, con i file veri di sql/ (023, 024, 029).
//
// ⚠️ L'HTML qui sotto è fatto a mano, con le stesse ancore che il lettore cerca
// (`date-separator`, `panel-evento-calendario`, `<h5>`, `<h3>`, `data-original`): NON è una
// pagina vera di AnimeClick. Dice che il lettore e il giro funzionano su quella forma; se il
// sito cambia forma lo dirà il giro vero, non questa prova.

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const fonti = require("../services/fontiStato");

let falliti = 0;

function prova(nome, atteso, ottenuto) {
  const a = JSON.stringify(atteso);
  const o = JSON.stringify(ottenuto);

  if (a === o) console.log(`  ok   ${nome}`);
  else {
    falliti += 1;
    console.log(`  NO   ${nome}\n       atteso   ${a}\n       ottenuto ${o}`);
  }
}

const GIORNO = 24 * 60 * 60 * 1000;
const t0 = new Date("2026-11-14T06:00:00Z");

console.log("\nLa regola: sette fallimenti di fila, due settimane di pausa");
{
  let stato = null;

  prova("una fonte senza storia si prova", true, fonti.puoiTentare(null, t0));

  for (let i = 1; i <= 6; i += 1) {
    stato = fonti.dopoFallimento(stato, "HTTP 403", new Date(t0.getTime() + i * GIORNO));
  }

  prova("sei fallimenti: ancora si prova", [6, null, true], [stato.fallimenti_di_fila, stato.in_pausa_fino, fonti.puoiTentare(stato, new Date(t0.getTime() + 7 * GIORNO))]);

  const settimo = new Date(t0.getTime() + 7 * GIORNO);

  stato = fonti.dopoFallimento(stato, "HTTP 403", settimo);

  prova("il settimo mette in pausa", [7, true], [stato.fallimenti_di_fila, stato.appenaInPausa]);
  prova("la pausa dura quattordici giorni", 14, Math.round((new Date(stato.in_pausa_fino) - settimo) / GIORNO));
  prova("in pausa non si prova", false, fonti.puoiTentare(stato, new Date(settimo.getTime() + 13 * GIORNO)));
  prova("finita la pausa si riprova", true, fonti.puoiTentare(stato, new Date(settimo.getTime() + 14 * GIORNO + 1000)));

  const ancora = fonti.dopoFallimento(stato, "HTTP 403", new Date(settimo.getTime() + 15 * GIORNO));

  prova("se il tentativo dopo la pausa fallisce, subito di nuovo in pausa", [8, true], [ancora.fallimenti_di_fila, ancora.appenaInPausa]);
}

const sqlDi = (nome) => fs.readFileSync(path.join(__dirname, "..", "sql", nome), "utf8");

const FIXTURE = (mese, giorno, serie, volume, immagine) => `
<html><body>
<div class="calendario-mese"><h2>${mese} 2026</h2></div>
<div class="col-12 date-separator"><div class="date">${giorno}</div><div class="month">novembre</div></div>
<div class="card panel-evento-calendario">
  <a href="/edizione/123/-/"><img data-original="${immagine}"></a>
  <h5>${serie}</h5><h3>${volume}</h3><h4>Star Comics</h4>
</div>
</body></html>`;

(async () => {
  const url = process.env.PROVA_DATABASE_URL;

  if (!url) {
    console.log("\n(PROVA_DATABASE_URL non c'è: salto la parte che usa il database.)");
  } else {
    const schema = `prova_fonti_${Math.random().toString(36).slice(2, 10)}`;
    const locale = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
    const admin = new Pool({ connectionString: url, ssl: locale ? false : { rejectUnauthorized: false }, max: 1 });

    await admin.query(`CREATE SCHEMA ${schema}`);

    // Tutte le connessioni del server (db.js) guardano nello schema di prova.
    process.env.DATABASE_URL = `${url}${url.includes("?") ? "&" : "?"}options=-c%20search_path%3D${schema}`;
    process.env.CRON_SECRET = "segreto-di-prova";
    process.env.JWT_SECRET = "una-chiave-finta-lunga-almeno-trentadue-caratteri";
    process.env.ADMIN_USERNAME = "prova";
    process.env.ADMIN_PASSWORD_HASH = "00:00";

    const scratch = new Pool({ connectionString: process.env.DATABASE_URL, ssl: locale ? false : { rejectUnauthorized: false }, max: 2 });
    let server;

    try {
      await scratch.query(`
        CREATE TABLE utenti (id bigint PRIMARY KEY, stato text, proprietario boolean, telegram_chat_id bigint);`);
      for (const f of ["023_uscite_manga.sql", "024_fonte_uscite.sql", "029_fonte_stato.sql"]) await scratch.query(sqlDi(f));

      const express = require("express");
      const app = express();

      app.use("/api/manga/uscite/animeclick", express.json({ limit: "4mb" }));
      app.use(express.json());
      app.use("/api/manga", require("../routes/manga"));
      app.use((err, req, res, next) => res.status(500).json({ error: String(err?.message || err) }));
      server = app.listen(0);

      const base = `http://127.0.0.1:${server.address().port}/api/manga/uscite/animeclick`;
      const intest = { "content-type": "application/json", "x-cron-secret": "segreto-di-prova" };
      const manda = async (corpo) => (await fetch(base, { method: "POST", headers: intest, body: JSON.stringify(corpo) })).json();
      const stato = async () => (await fetch(`${base}/stato`, { headers: intest })).json();

      console.log("\nIl giro riceve le pagine e le scrive");

      const buone = [
        { quando: null, html: FIXTURE("novembre", "20", "Frieren", "Frieren 15", "/img/frieren15.jpg") },
        { quando: "next-month", html: FIXTURE("dicembre", "10", "Berserk", "Berserk 43", "/img/berserk43.jpg") }
      ];

      const r1 = await manda({ pagine: buone });

      prova("pagine buone: successo, nessun ripiego", [true, false, 2], [r1.success, r1.fallback, r1.lette]);

      const { rows } = await scratch.query(`SELECT serie, numero, copertina, fonte FROM uscite_manga ORDER BY serie`);

      prova(
        "scritte con la copertina DEL VOLUME e la fonte",
        [
          ["Berserk", 43, "https://www.animeclick.it/img/berserk43.jpg", "animeclick"],
          ["Frieren", 15, "https://www.animeclick.it/img/frieren15.jpg", "animeclick"]
        ],
        rows.map((r) => [r.serie, r.numero, r.copertina, r.fonte])
      );

      // Una riga già scritta da Fumettologica: stessa data e stesso titolo, ma senza copertina.
      await scratch.query(`UPDATE uscite_manga SET copertina = NULL, fonte = 'fumettologica' WHERE serie = 'Frieren'`);

      const rifatto = await manda({ pagine: buone });
      const { rows: rf } = await scratch.query(`SELECT copertina, fonte FROM uscite_manga WHERE serie = 'Frieren'`);

      prova(
        "una riga di Fumettologica senza copertina la riceve da AnimeClick, anche con data e titolo uguali",
        [1, "https://www.animeclick.it/img/frieren15.jpg", "animeclick"],
        [rifatto.scritte, rf[0].copertina, rf[0].fonte]
      );

      const dopoOk = await stato();

      prova("lo stato dopo un successo: si può provare, zero fallimenti", [true, 0], [dopoOk.tentare, dopoOk.fallimenti_di_fila]);

      console.log("\nIl giro che non riesce ripiega, e dopo sette volte va in pausa");

      const bloccata = await manda({ pagine: [{ quando: null, html: "<html>Verifica che sei un essere umano</html>" }] });

      prova("la pagina della verifica anti-bot non è il calendario: ripiego", [false, true], [bloccata.success, bloccata.fallback]);

      const nonScritta = await scratch.query(`SELECT count(*)::int AS n FROM uscite_manga`);

      prova("e non scrive niente di nuovo", 2, nonScritta.rows[0].n);

      const dichiarato = await manda({ fallito: true, motivo: "HTTP 403" });

      prova("il giro che dichiara il fallimento: ripiego e conto a 2", [true, 2], [dichiarato.fallback, dichiarato.fallimenti_di_fila]);

      let ultimo;

      for (let i = 0; i < 5; i += 1) ultimo = await manda({ fallito: true, motivo: "HTTP 403" });

      prova("al settimo di fila c'è la pausa", [7, true], [ultimo.fallimenti_di_fila, Boolean(ultimo.in_pausa_fino)]);
      prova("lo stato dice «non provare»", [false, 7], [(await stato()).tentare, (await stato()).fallimenti_di_fila]);

      const riuscito = await manda({ pagine: buone });

      prova("un successo (dopo la pausa) azzera tutto", [true, 7], [riuscito.success, riuscito.dopo_fallimenti]);
      prova("…e si può provare di nuovo", [true, 0], [(await stato()).tentare, (await stato()).fallimenti_di_fila]);

      const prova2 = await manda({ pagine: buone, prova: true });

      prova("con prova:true non scrive e non cambia il conto", [true, 0], [prova2.success, (await stato()).fallimenti_di_fila]);

      console.log("\nSenza il segreto non entra nessuno");

      const senza = await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const falso = await fetch(base, { method: "POST", headers: { "content-type": "application/json", "x-cron-secret": "no" }, body: "{}" });

      prova("senza segreto e con segreto falso: 403 e 403", [403, 403], [senza.status, falso.status]);
    } finally {
      if (server) server.close();
      await scratch.end().catch(() => {});
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
      try {
        await require("../db").end?.();
      } catch {}
    }
  }

  console.log(falliti ? `\n${falliti} prove fallite.\n` : "\nTutto a posto.\n");
  process.exit(falliti ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
