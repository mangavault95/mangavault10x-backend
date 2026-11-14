// Prove che girano su un Postgres vero (PROVA_DATABASE_URL), in uno schema
// loro creato e buttato via:
//
//   - l'annullo di un acquisto non toglie i volumi che c'erano già;
//   - due serie create insieme non prendono lo stesso ID;
//   - un accesso tolto dal proprietario smette di valere subito;
//   - un solo indirizzo fidato per il tetto alle richieste (TRUST_PROXY).
//
// Senza PROVA_DATABASE_URL gira soltanto l'ultima parte, che non ne ha
// bisogno. Usa i file veri `sql/022` e `sql/027`: se cambiano, la prova se
// ne accorge.
//
//   PROVA_DATABASE_URL=postgres://… node scripts/prova-acquisti.js

const fs = require("fs");
const path = require("path");
const http = require("http");
const { Pool } = require("pg");

process.env.JWT_SECRET = process.env.JWT_SECRET || "una-chiave-finta-lunga-almeno-trentadue-caratteri";
process.env.ADMIN_USERNAME = process.env.ADMIN_USERNAME || "prova";
process.env.ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || "00:00";

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

const sqlDi = (nome) => fs.readFileSync(path.join(__dirname, "..", "sql", nome), "utf8");

(async () => {
  const url = process.env.PROVA_DATABASE_URL;

  if (!url) {
    console.log("\n(PROVA_DATABASE_URL non c'è: salto la parte che usa il database.)");
  } else {
    const schema = `prova_acq_${Math.random().toString(36).slice(2, 10)}`;
    const locale = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
    const ssl = locale ? false : { rejectUnauthorized: false };

    const admin = new Pool({ connectionString: url, ssl, max: 1 });

    await admin.query(`CREATE SCHEMA ${schema}`);

    // Tutte le connessioni di questa prova guardano nel suo schema.
    const pool = new Pool({ connectionString: url, ssl, max: 8, options: `-c search_path=${schema}` });

    try {
      await pool.query(`
        CREATE TABLE "Manga" (
          "ID" int PRIMARY KEY, "Titolo" text, "VolumiPosseduti" int NOT NULL DEFAULT 0,
          "VolumiItalia" int, "VolumiTotali" int, "Costo" numeric, "PrezzoCopertina" numeric,
          "StatoSerie" text, "Edizione" text, "AnimeClickID" int);
        CREATE TABLE acquisti (
          id bigserial PRIMARY KEY, manga_id int REFERENCES "Manga"("ID") ON DELETE CASCADE,
          volume_da int, volume_a int, prezzo numeric, data_acquisto date, condizione text);
        CREATE TABLE utenti (id bigint PRIMARY KEY, stato text NOT NULL);
        INSERT INTO "Manga" ("ID", "Titolo", "VolumiPosseduti", "PrezzoCopertina") VALUES (1, 'Berserk', 5, 7.5);
        INSERT INTO utenti VALUES (2, 'attivo');`);

      // I file veri: il trigger che tiene in ordine i numeri e conta i volumi (022) e la colonna nuova (027).
      await pool.query(sqlDi("022_numeri_posseduti.sql"));
      await pool.query(sqlDi("027_gia_posseduti.sql"));

      const numeri = async () => (await pool.query(`SELECT "NumeriPosseduti" AS n, "VolumiPosseduti" AS v FROM "Manga" WHERE "ID" = 1`)).rows[0];
      const dice = async (nome, atteso) => {
        const o = await numeri();

        prova(nome, [atteso, atteso.length], [o.n, o.v]);
      };

      const acq = require("../services/acquisti");

      console.log("\nAnnullare un acquisto");

      await dice("si parte da 1-5", [1, 2, 3, 4, 5]);

      let e = await acq.registraAcquisto(pool, { mangaId: 1, volumi: [5, 6, 7] });

      await dice("compro 5-7 (il 5 c'era già)", [1, 2, 3, 4, 5, 6, 7]);

      const riga = (await pool.query("SELECT gia_posseduti AS g FROM acquisti ORDER BY id DESC LIMIT 1")).rows[0];

      prova("l'acquisto ricorda che il 5 c'era già", [5], riga.g);

      await acq.annullaAcquisti(pool, e.acquisti);
      await dice("annullo: il 5 resta, il 6 e il 7 escono", [1, 2, 3, 4, 5]);

      e = await acq.registraAcquisto(pool, { mangaId: 1, volumi: [8] });
      await acq.annullaAcquisti(pool, e.acquisti);
      await dice("un acquisto tutto nuovo, annullato, torna com'era", [1, 2, 3, 4, 5]);

      const vecchia = await pool.query("INSERT INTO acquisti (manga_id, volume_da, volume_a, prezzo) VALUES (1, 4, 5, 10) RETURNING id");

      await acq.annullaAcquisti(pool, [vecchia.rows[0].id]);
      await dice("una riga di prima della 027 (colonna vuota) toglie tutto l'intervallo, come sempre", [1, 2, 3]);

      console.log("\nIl prossimo ID di una serie");
      {
        const { prossimoIdManga } = require("../services/idManga");

        const crea = async (i) => {
          const c = await pool.connect();

          try {
            await c.query("BEGIN");

            const id = await prossimoIdManga(c);

            // Un'attesa fra la lettura e la scrittura: è lì che due richieste insieme si scontrano.
            await new Promise((r) => setTimeout(r, 30));
            await c.query(`INSERT INTO "Manga" ("ID", "Titolo") VALUES ($1, $2)`, [id, `serie ${i}`]);
            await c.query("COMMIT");

            return id;
          } catch (errore) {
            await c.query("ROLLBACK").catch(() => {});
            return `ERRORE ${errore.code}`;
          } finally {
            c.release();
          }
        };

        const ids = await Promise.all([1, 2, 3, 4, 5, 6].map(crea));

        prova("sei creazioni insieme: sei ID diversi, nessun errore", [6, true], [new Set(ids).size, ids.every(Number.isInteger)]);
      }

      console.log("\nL'accesso tolto vale subito");
      {
        // `services/utenti` usa il pool di `db.js`: si sostituisce con quello di questa prova.
        const dbPath = require.resolve("../db");

        require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: pool };

        const auth = require("../services/auth");
        const utenti = require("../services/utenti");

        const provaAccesso = async (utente) => {
          const res = { code: 200, status(c) { this.code = c; return this; }, json() { return this; } };
          let passato = false;

          await auth.requireAuth({ headers: { authorization: `Bearer ${auth.firmaToken(utente)}` } }, res, () => { passato = true; });

          return passato ? "passa" : res.code;
        };

        prova("un lettore attivo passa", "passa", await provaAccesso({ id: 2, username: "l", nickname: "L", ruolo: "admin" }));

        await pool.query("UPDATE utenti SET stato = 'rifiutato' WHERE id = 2");

        prova("rifiutato ma dentro il minuto di ricordo: ancora passa", "passa", await provaAccesso({ id: 2, username: "l", nickname: "L" }));

        utenti.dimenticaPermessi(2); // quello che fa `decidi` quando il proprietario rifiuta

        prova("rifiutato e il proprietario ha deciso: 401", 401, await provaAccesso({ id: 2, username: "l", nickname: "L" }));
        prova("il proprietario non si chiede mai al database", "passa", await provaAccesso({ id: 1, username: "a", nickname: "N", proprietario: true }));
        prova("un utente che non esiste: 401", 401, await provaAccesso({ id: 99, username: "z", nickname: "Z" }));
      }

      console.log("\nLe serie nuove: data di aggiunta ed editore");
      {
        // Le rotte vere (creazione dal sito, wishlist → collezione), con un proprietario e il database di prova.
        // Il pool di `db.js` è già quello di prova (sostituito nel blocco qui sopra).
        await pool.query(`
          ALTER TABLE utenti ADD COLUMN proprietario boolean NOT NULL DEFAULT false, ADD COLUMN biblioteca boolean NOT NULL DEFAULT false;
          UPDATE utenti SET proprietario = true, stato = 'attivo' WHERE id = 1;
          ALTER TABLE "Manga" ADD COLUMN "Autore" text, ADD COLUMN "CoverURL" text, ADD COLUMN "Trama" text, ADD COLUMN "Genere" text,
            ADD COLUMN "Editore" text, ADD COLUMN "DataAggiunta" date;
          CREATE TABLE wishlist_custom (id int PRIMARY KEY, titolo text, autori text, coverurl text, trama text, generi text, volumitotali text);
          INSERT INTO wishlist_custom VALUES (1, 'Dalla wishlist', 'Autore', '', '', '', '3');`);

        const express = require("express");
        const auth = require("../services/auth");
        const { oggiInItalia } = require("../services/usciteManga");

        const app = express();

        app.use(express.json());
        app.use("/api/manga", require("../routes/manga"));
        app.use("/api/wishlist-actions", require("../routes/wishlistActions"));

        const server = app.listen(0);
        const base = `http://127.0.0.1:${server.address().port}`;
        const token = auth.firmaToken({ id: 1, username: "a", nickname: "N", ruolo: "admin", proprietario: true });
        const chiama = (percorso, corpo) =>
          fetch(base + percorso, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(corpo) });
        const riga = async (titolo) =>
          (await pool.query(`SELECT "DataAggiunta"::text AS data, "Editore" AS editore FROM "Manga" WHERE "Titolo" = $1`, [titolo])).rows[0];

        try {
          const oggi = oggiInItalia();

          const dalSito = await chiama("/api/manga", { titolo: "Serie dal sito" });

          prova("la creazione dal sito risponde 201", 201, dalSito.status);
          prova("e scrive il giorno in cui è entrata in collezione", oggi, (await riga("Serie dal sito"))?.data);

          await chiama("/api/manga", { titolo: "Con editore societario", editore: " Panini S.p.A. " });
          await chiama("/api/manga", { titolo: "Con editore in minuscolo", editore: "star comics" });
          await chiama("/api/manga", { titolo: "Con editore vuoto", editore: "   " });

          prova("l'editore «Panini S.p.A.» entra come «Panini»", "Panini", (await riga("Con editore societario"))?.editore);
          prova("«star comics» entra come «Star Comics»", "Star Comics", (await riga("Con editore in minuscolo"))?.editore);
          prova("un editore di soli spazi entra come NULL", null, (await riga("Con editore vuoto"))?.editore ?? null);

          const dallaWishlist = await chiama("/api/wishlist-actions/purchase/1", {});

          prova("il passaggio dalla wishlist risponde 200", 200, dallaWishlist.status);

          const arrivata = await riga("Dalla wishlist");

          prova("e scrive il giorno anche lì", oggi, arrivata?.data);
          prova("e l'editore è vuoto davvero (NULL), non una stringa vuota", null, arrivata?.editore ?? null);
        } finally {
          server.close();
        }
      }
    } finally {
      await pool.end().catch(() => {});
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
      await admin.end().catch(() => {});
    }
  }

  console.log("\nL'indirizzo di chi chiama (TRUST_PROXY)");
  {
    const { saltiFidati } = require("../services/rete");

    prova("predefinito: 1", [1, 1, 1], [undefined, "", "abc"].map(saltiFidati));
    prova("0 e 2 si rispettano", [0, 2], ["0", "2"].map(saltiFidati));
    prova("un numero negativo o con la virgola non vale", [1, 1], ["-1", "1.5"].map(saltiFidati));

    const express = require("express");
    const { limite } = require("../services/limite");

    const app = express();

    app.set("trust proxy", saltiFidati(undefined));
    app.get("/ip", limite({ finestraMs: 60000, massimo: 1 }), (req, res) => res.json({ ip: req.ip }));

    const server = app.listen(0);
    const porta = server.address().port;

    const chiama = (xff) =>
      new Promise((risolvi) => {
        http.get({ port: porta, path: "/ip", headers: xff ? { "x-forwarded-for": xff } : {} }, (res) => {
          let corpo = "";

          res.on("data", (d) => (corpo += d));
          res.on("end", () => risolvi({ stato: res.statusCode, corpo }));
        });
      });

    // Dietro un proxy che aggiunge l'indirizzo VERO a destra, quello a sinistra è roba che il
    // visitatore può scriversi da solo.
    const prima = await chiama("1.2.3.4, 10.0.0.9");
    const stessoProxy = await chiama("5.6.7.8, 10.0.0.9");

    prova("si prende l'indirizzo messo dal proxy, non quello scritto dal visitatore", ["10.0.0.9", 429], [JSON.parse(prima.corpo).ip, stessoProxy.stato]);

    const avvisi = [];
    const originale = console.warn;

    console.warn = (...a) => avvisi.push(a.join(" "));
    await chiama("9.9.9.9, 10.0.0.9");
    console.warn = originale;

    prova("un blocco lascia una riga nei log con ip e xff", true, avvisi.some((r) => /limite: 429 ip=10\.0\.0\.9 xff=9\.9\.9\.9, 10\.0\.0\.9 GET \/ip/.test(r)));

    server.close();
  }

  console.log(falliti ? `\n${falliti} prove fallite.\n` : "\nTutto a posto.\n");
  process.exitCode = falliti ? 1 : 0;
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
