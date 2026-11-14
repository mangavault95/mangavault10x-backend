// Prova delle copertine dei volumi (services/copertineVolumi.js, sql/030).
//
//   PROVA_DATABASE_URL=postgres://… node scripts/prova-copertine.js
//
// Il lettore gira ovunque; la parte che scrive gira su un Postgres di prova, in uno
// schema suo creato e buttato via, con il file vero sql/030.
//
// ⚠️ La riga d'esempio ricalca la PRIMA riga di una pagina vera (Hunter x Hunter, letta da
// GitHub il 14/11/2026: cella nascosta con l'id, `<img class="anteprima-img" data-img=…>`,
// link a /edizione/…). Le altre righe sono costruite a mano sulla stessa forma: la colonna
// della data e quella del prezzo non le ho viste, sono come le legge `volumiUsciti`.

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const { copertineVolumi } = require("../services/providers/animeclick");

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

const riga = (titolo, immagine, { data = "01/02/2020", extra = "" } = {}) => `
<tr> <td style="display:none;">3588</td> <td>
  ${immagine === null ? "" : `<img width="32" class="anteprima-img" data-edition-cover-preview="1" data-img="${immagine}" src="${immagine}" />`}
  </td> <td class="col-lg-4"><a rel="nofollow" href="/edizione/29401/x">${titolo}</a>
  <span style='white-space: nowrap;'><a href="https://mangayo.it/r/animeclick/1" target='_blank'><img src='/bundles/accommon/images/MangaYo2.svg' height='20'></a></span></td>
  <td>${extra}</td><td>${data}</td><td>5,20</td></tr>`;

const pagina = (...righe) => `<html><table><thead><tr><th>x</th></tr></thead><tbody>${righe.join("")}</tbody></table></html>`;

const AC = "https://www.animeclick.it";

console.log("\nIl lettore");
{
  const html = pagina(
    riga("Hunter x Hunter&nbsp;1", "/images/Manga_Cover/HunterxHunter1.jpg"),
    riga("Hunter x Hunter 2", "/images/Manga_Cover/HunterxHunter2.jpg"),
    riga("Hunter x Hunter 2", "/images/Manga_Cover/HunterxHunter2-doppione.jpg"),
    riga("Hunter x Hunter 2", "/images/Manga_Cover/HunterxHunter2-ristampa.jpg", { extra: "Ristampa" }),
    riga("Hunter x Hunter 3", "/images/Manga_Cover/HxH3-ristampa.jpg", { extra: "Ristampa" }),
    riga("Hunter x Hunter Deluxe 1", "/images/Manga_Cover/HxHDeluxe1.jpg"),
    riga("Hunter x Hunter 4", null),
    riga("Hunter x Hunter 5", "https://altrove.example/img.jpg"),
    riga("Hunter x Hunter 38", "/images/Manga_Cover/Hunter x Hunter38.jpg", { data: "01/02/2099" })
  );

  prova(
    "un volume una volta: l'edizione normale, la ristampa solo se non c'è altro, il futuro sì, niente immagini di altri siti",
    [
      [1, `${AC}/images/Manga_Cover/HunterxHunter1.jpg`],
      [2, `${AC}/images/Manga_Cover/HunterxHunter2.jpg`],
      [3, `${AC}/images/Manga_Cover/HxH3-ristampa.jpg`],
      [38, `${AC}/images/Manga_Cover/Hunter%20x%20Hunter38.jpg`]
    ],
    copertineVolumi(html).map((v) => [v.numero, v.copertina])
  );

  prova("con l'etichetta dell'edizione si tiene solo quella", [[1, `${AC}/images/Manga_Cover/HxHDeluxe1.jpg`]], copertineVolumi(html, { edizione: "Deluxe" }).map((v) => [v.numero, v.copertina]));

  let errore = null;

  try {
    copertineVolumi("<html>Verifica che sei un essere umano</html>");
  } catch (e) {
    errore = e.message;
  }

  prova("una pagina senza la tabella lancia (non «zero copertine»)", true, /tabella delle edizioni/.test(errore || ""));
}

(async () => {
  const url = process.env.PROVA_DATABASE_URL;

  if (!url) {
    console.log("\n(PROVA_DATABASE_URL non c'è: salto la parte che usa il database.)");
  } else {
    const schema = `prova_cop_${Math.random().toString(36).slice(2, 10)}`;
    const locale = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
    const ssl = locale ? false : { rejectUnauthorized: false };
    const admin = new Pool({ connectionString: url, ssl, max: 1 });

    await admin.query(`CREATE SCHEMA ${schema}`);

    process.env.DATABASE_URL = `${url}${url.includes("?") ? "&" : "?"}options=-c%20search_path%3D${schema}`;
    process.env.CRON_SECRET = "segreto-di-prova";
    process.env.JWT_SECRET = "una-chiave-finta-lunga-almeno-trentadue-caratteri";
    process.env.ADMIN_USERNAME = "prova";
    process.env.ADMIN_PASSWORD_HASH = "00:00";

    const scratch = new Pool({ connectionString: process.env.DATABASE_URL, ssl, max: 2 });
    let server;

    try {
      await scratch.query(`
        CREATE TABLE "Manga" ("ID" int PRIMARY KEY, "Titolo" text, "Edizione" text, "StatoSerie" text, "AnimeClickID" int);
        INSERT INTO "Manga" VALUES
          (1, 'Hunter x Hunter', NULL, 'in_corso', 9553),
          (2, 'Berserk', 'Deluxe', 'conclusa', 9607),
          (3, 'Senza scheda', NULL, 'in_corso', NULL),
          (4, 'Frieren', NULL, 'in_corso', 7000);`);
      await scratch.query(fs.readFileSync(path.join(__dirname, "..", "sql", "030_copertine_volumi.sql"), "utf8"));

      const express = require("express");
      const app = express();

      app.use("/api/manga/copertine/pagina", express.json({ limit: "4mb" }));
      app.use(express.json());
      app.use("/api/manga", require("../routes/manga"));
      app.use((err, req, res, next) => res.status(500).json({ error: String(err?.message || err) }));
      server = app.listen(0);

      const base = `http://127.0.0.1:${server.address().port}/api/manga`;
      const intest = { "content-type": "application/json", "x-cron-secret": "segreto-di-prova" };
      const elenco = async (q = "") => (await fetch(`${base}/copertine/da-leggere${q}`, { headers: intest })).json();
      const manda = async (corpo) => {
        const r = await fetch(`${base}/copertine/pagina`, { method: "POST", headers: intest, body: JSON.stringify(corpo) });

        return { stato: r.status, ...(await r.json()) };
      };

      console.log("\nQuali serie leggere");

      prova("mai lette e con la scheda di AnimeClick, in ordine; quella senza scheda no", [[1, 9553], [2, 9607], [4, 7000]], (await elenco()).serie.map((s) => [s.manga_id, s.animeclick_id]));
      prova("«quanti» taglia l'elenco", [1], (await elenco("?quanti=1")).serie.map((s) => s.manga_id));

      console.log("\nRicevere una pagina");

      const hxh = pagina(riga("Hunter x Hunter 1", "/images/Manga_Cover/HunterxHunter1.jpg"), riga("Hunter x Hunter 2", "/images/Manga_Cover/HunterxHunter2.jpg"));

      const aVuoto = await manda({ manga_id: 1, html: hxh, prova: true });
      const nulla = await scratch.query(`SELECT (SELECT count(*)::int FROM copertine_volumi) AS c, (SELECT count(*)::int FROM copertine_giri) AS g`);

      prova("con prova:true conta e non scrive niente", [true, 2, 0, 0, 0], [aVuoto.letta, aVuoto.trovate, aVuoto.scritte, nulla.rows[0].c, nulla.rows[0].g]);

      const r1 = await manda({ manga_id: 1, html: hxh });

      prova("la pagina buona: due trovate, due scritte", [200, true, 2, 2], [r1.stato, r1.letta, r1.trovate, r1.scritte]);
      prova("rimandata uguale non riscrive", [2, 0], [(await manda({ manga_id: 1, html: hxh })).trovate, (await manda({ manga_id: 1, html: hxh })).scritte]);

      const cambiata = pagina(riga("Hunter x Hunter 1", "/images/Manga_Cover/HunterxHunter1-nuova.jpg"), riga("Hunter x Hunter 3", "/images/Manga_Cover/HunterxHunter3.jpg"));
      const r2 = await manda({ manga_id: 1, html: cambiata });
      const { rows } = await scratch.query(`SELECT numero, copertina FROM copertine_volumi WHERE manga_id = 1 ORDER BY numero`);

      prova(
        "una copertina cambiata si aggiorna, una nuova si aggiunge, quella sparita dalla pagina resta",
        [2, [1, "HunterxHunter1-nuova.jpg"], [2, "HunterxHunter2.jpg"], [3, "HunterxHunter3.jpg"]],
        [r2.scritte, ...rows.map((r) => [r.numero, r.copertina.split("/").pop()])]
      );

      const bloccata = await manda({ manga_id: 2, html: "<html>Verifica che sei un essere umano</html>" });

      prova("la pagina della verifica anti-bot: non letta, e lo dice", [200, false, true], [bloccata.stato, bloccata.letta, /tabella/.test(bloccata.motivo)]);

      const dichiarato = await manda({ manga_id: 4, fallito: true, motivo: "HTTP 404" });

      prova("il giro che dichiara il fallimento", [200, false, "HTTP 404"], [dichiarato.stato, dichiarato.letta, dichiarato.motivo]);
      prova("una serie che non esiste: 404, niente scritto", 404, (await manda({ manga_id: 99, html: hxh })).stato);
      prova("senza manga_id: 400", 400, (await manda({ html: hxh })).stato);

      console.log("\nIl giro va avanti");

      prova("le serie appena provate (anche quelle fallite) non tornano subito", [], (await elenco()).serie.map((s) => s.manga_id));

      await scratch.query(`UPDATE copertine_giri SET letta_il = NOW() - interval '31 days'`);

      prova("dopo un mese tornano quelle in corso (la conclusa rimasta a zero no)", [1, 4], (await elenco()).serie.map((s) => s.manga_id).sort());

      await scratch.query(`UPDATE copertine_giri SET letta_il = NOW() - interval '61 days'`);

      prova("dopo due mesi si riprovano anche quelle rimaste a zero", [1, 2, 4], (await elenco()).serie.map((s) => s.manga_id).sort());

      await scratch.query(`CREATE TABLE IF NOT EXISTS fonte_stato (fonte text PRIMARY KEY, fallimenti_di_fila int, ultimo_tentativo timestamptz, ultimo_esito text, ultimo_ok timestamptz, in_pausa_fino timestamptz);
        INSERT INTO fonte_stato (fonte, fallimenti_di_fila, in_pausa_fino) VALUES ('animeclick', 7, NOW() + interval '3 days')`);

      const pausa = await elenco();

      prova("con AnimeClick in pausa l'elenco è vuoto", [[], true], [pausa.serie, pausa.in_pausa]);

      console.log("\nQuello che legge il sito");

      const pubblico = await fetch(`${base}/copertine-volumi`);
      const corpo = await pubblico.json();

      prova("pubblica, con la cache di un'ora", [200, "public, max-age=3600"], [pubblico.status, pubblico.headers.get("cache-control")]);
      prova(
        "per serie e numero, col percorso accorciato",
        ["https://www.animeclick.it", { 1: { 1: "/images/Manga_Cover/HunterxHunter1-nuova.jpg", 2: "/images/Manga_Cover/HunterxHunter2.jpg", 3: "/images/Manga_Cover/HunterxHunter3.jpg" } }],
        [corpo.base, corpo.copertine]
      );

      console.log("\nSenza il segreto non entra nessuno");

      const senza = [
        (await fetch(`${base}/copertine/da-leggere`)).status,
        (await fetch(`${base}/copertine/pagina`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ manga_id: 1, html: hxh }) })).status,
        (await fetch(`${base}/copertine/pagina`, { method: "POST", headers: { "content-type": "application/json", "x-cron-secret": "no" }, body: "{}" })).status
      ];

      prova("elenco e ricezione: 403", [403, 403, 403], senza);

      await scratch.query(`DELETE FROM "Manga" WHERE "ID" = 1`);

      prova("cancellata la serie, spariscono le sue copertine", 0, (await scratch.query(`SELECT count(*)::int AS n FROM copertine_volumi`)).rows[0].n);
    } finally {
      if (server) server.close();
      await scratch.end().catch(() => {});
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  }

  console.log(falliti ? `\n${falliti} prove fallite.\n` : "\nTutto a posto.\n");
  process.exit(falliti ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
