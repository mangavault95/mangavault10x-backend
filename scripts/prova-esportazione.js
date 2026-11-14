// Prove della copia di sicurezza.
//
//   PROVA_DATABASE_URL=postgres://… node scripts/prova-esportazione.js
//
// Senza PROVA_DATABASE_URL girano solo le prove del CSV, che non vogliono un database.
// Con il database lavorano in uno schema a parte, che alla fine si butta.

const { Pool } = require("pg");

let falliti = 0;

function prova(nome, atteso, ottenuto) {
  const bene = JSON.stringify(atteso) === JSON.stringify(ottenuto);

  console.log(`  ${bene ? "ok  " : "NO  "} ${nome}`);

  if (!bene) {
    falliti += 1;
    console.log(`       atteso:   ${JSON.stringify(atteso)}\n       ottenuto: ${JSON.stringify(ottenuto)}`);
  }
}

const { cella, inCsv } = require("../services/esportazione");

console.log("\nIl CSV si apre in un foglio di calcolo senza sorprese");
prova("testo semplice resta com'è", "Berserk", cella("Berserk"));
prova("una virgola mette le virgolette", '"Spy x Family, vol. 1"', cella("Spy x Family, vol. 1"));
prova("le virgolette si raddoppiano", '"Il ""grande"" gioco"', cella('Il "grande" gioco'));
prova("un titolo che comincia con = non diventa una formula", "'=SOMMA(A1:A9)", cella("=SOMMA(A1:A9)"));
prova("neppure + - @", ["'+1", "'-1", "'@x"], [cella("+1"), cella("-1"), cella("@x")]);
prova("un numero negativo resta un numero", "-5", cella(-5));
prova("vuoto e nullo sono celle vuote", ["", ""], [cella(null), cella(undefined)]);
prova("una lista di numeri si legge con il punto e virgola", "1;2;5", cella([1, 2, 5]));
prova("va a capo dentro le virgolette", '"a\nb"', cella("a\nb"));
prova("il file comincia col segno UTF-8 e finisce con un a capo", ["﻿", "\r\n"], [
  inCsv(["a"], [{ a: 1 }]).slice(0, 1),
  inCsv(["a"], [{ a: 1 }]).slice(-2)
]);

(async () => {
  const url = process.env.PROVA_DATABASE_URL;

  if (!url) {
    console.log("\n(PROVA_DATABASE_URL non c'è: salto la parte che usa il database.)");
    process.exit(falliti ? 1 : 0);
  }

  const schema = `prova_esporta_${Math.random().toString(36).slice(2, 10)}`;
  const locale = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const ssl = locale ? false : { rejectUnauthorized: false };
  const admin = new Pool({ connectionString: url, ssl, max: 1 });

  await admin.query(`CREATE SCHEMA ${schema}`);

  process.env.DATABASE_URL = `${url}${url.includes("?") ? "&" : "?"}options=-c%20search_path%3D${schema}`;
  process.env.CRON_SECRET = "segreto-di-prova";
  process.env.JWT_SECRET = "una-chiave-finta-lunga-almeno-trentadue-caratteri";
  process.env.ADMIN_USERNAME = "prova";
  process.env.ADMIN_PASSWORD_HASH = "00:00";
  delete process.env.TELEGRAM_MANGA_TOKEN;
  process.env.SITO_URL = "https://sito.esempio";

  const scratch = new Pool({ connectionString: process.env.DATABASE_URL, ssl, max: 2 });
  let server;

  try {
    await scratch.query(`
      CREATE TABLE utenti (
        id bigint PRIMARY KEY, username text, nickname text, password_hash text,
        telegram_chat_id bigint, faccia bytea, stato text, proprietario boolean);
      CREATE TABLE "Manga" (
        "ID" integer PRIMARY KEY, "Titolo" text, "Trama" text, "NumeriPosseduti" integer[]);
      CREATE TABLE acquisti (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, manga_id integer, volume_da integer,
        volume_a integer, prezzo numeric(10,2), data_acquisto date, condizione text, negozio text, note text,
        creato_il timestamptz);
      CREATE TABLE telegram_visti (update_id bigint PRIMARY KEY);

      INSERT INTO utenti VALUES
        (1, 'padrone', 'Nicer', 'SEGRETO-HASH-111', 987654321, '\\xdeadbeef', 'attivo', true),
        (2, 'lei', 'Sara', 'SEGRETO-HASH-222', 123123123, NULL, 'attivo', false);
      INSERT INTO "Manga" VALUES
        (1, '=SOMMA(A1)', 'una trama lunga', ARRAY[1,2,5]),
        (2, 'Spy x Family, vol. 1', NULL, ARRAY[]::integer[]);
      INSERT INTO acquisti (manga_id, volume_da, volume_a, prezzo, data_acquisto, negozio, creato_il)
        VALUES (2, 1, 1, 6.90, '2026-11-14', 'Fumetteria', '2026-11-14 15:31:51.569849+00');
      INSERT INTO telegram_visti VALUES (555);`);

    const esportazione = require("../services/esportazione");
    const tutto = await esportazione.esportaTutto(scratch, new Date("2026-11-14T10:00:00Z"));
    const testo = JSON.stringify(tutto);

    console.log("\nLa copia completa");
    prova("ci sono utenti, serie e acquisti", ["Manga", "acquisti", "utenti"], Object.keys(tutto.tabelle).sort());
    prova("i conteggi dicono quante righe", { Manga: 2, acquisti: 1, utenti: 2 }, tutto.conteggi);
    prova("la contabilità dei lavori non c'è", false, "telegram_visti" in tutto.tabelle);
    prova("le password non ci sono", false, testo.includes("SEGRETO-HASH"));
    prova("gli identificativi Telegram non ci sono", false, /987654321|123123123/.test(testo));
    prova("le foto non ci sono", false, /deadbeef|faccia/i.test(testo.replace(/"escluso".*$/, "")));
    prova("il file dichiara cosa non contiene", ["utenti.faccia", "utenti.password_hash", "utenti.telegram_chat_id"], tutto.escluso.colonne);
    prova("una DATE resta quel giorno, non cambia col fuso", "2026-11-14", tutto.tabelle.acquisti.righe[0].data_acquisto);
    prova("un orario conserva i microsecondi (Date di JavaScript ne taglia tre)", true,
      /\.569849/.test(tutto.tabelle.acquisti.righe[0].creato_il));
    prova("le liste di volumi restano liste", [1, 2, 5], tutto.tabelle.Manga.righe[0].NumeriPosseduti);

    const csv = await esportazione.collezioneCsv(scratch);
    console.log("\nI due fogli");
    prova("la collezione non ha la trama", false, /trama/i.test(csv));
    prova("e il titolo-formula è disinnescato", true, csv.includes("'=SOMMA(A1)"));
    prova("i volumi posseduti si leggono 1;2;5", true, csv.includes("1;2;5"));

    const acq = await esportazione.acquistiCsv(scratch);
    prova("gli acquisti hanno il titolo della serie e la data", true, acq.includes('"Spy x Family, vol. 1"') && acq.includes("2026-11-14"));

    // ----- le rotte, vere, con i gettoni veri
    const express = require("express");
    const { firmaToken } = require("../services/auth");
    const app = express();

    app.use(express.json());
    app.use("/api/esporta", require("../routes/esporta"));
    server = app.listen(0);

    const base = `http://127.0.0.1:${server.address().port}/api/esporta`;
    const gettone = (u) => ({ authorization: `Bearer ${firmaToken(u)}` });
    const padrone = gettone({ id: 1, username: "padrone", nickname: "Nicer", ruolo: "admin", proprietario: true });
    const lei = gettone({ id: 2, username: "lei", nickname: "Sara", ruolo: "admin", proprietario: false });

    console.log("\nChi può chiedere la copia");

    for (const indirizzo of ["/tutto", "/collezione.csv", "/acquisti.csv"]) {
      const senza = await fetch(base + indirizzo);
      const falso = await fetch(base + indirizzo, { headers: { authorization: "Bearer finto" } });
      const altra = await fetch(base + indirizzo, { headers: lei });
      const mia = await fetch(base + indirizzo, { headers: padrone });

      prova(
        `${indirizzo}: senza accesso 401, gettone falso 403, l'altra persona 403, il proprietario 200`,
        [401, 403, 403, 200],
        [senza.status, falso.status, altra.status, mia.status]
      );
    }

    const risposta = await fetch(`${base}/tutto`, { headers: padrone });
    const corpo = await risposta.text();

    prova("è un allegato JSON che nessuna cache tiene", true,
      /attachment; filename="mangavault-copia-\d{4}-\d\d-\d\d\.json"/.test(risposta.headers.get("content-disposition")) &&
        risposta.headers.get("cache-control") === "no-store" &&
        risposta.headers.get("content-type").startsWith("application/json"));
    prova("e dentro non c'è nessun segreto", false, /SEGRETO-HASH|987654321/.test(corpo));

    console.log("\nIl promemoria di inizio mese");
    const post = (intest, corpoRichiesta) =>
      fetch(`${base}/promemoria`, {
        method: "POST",
        headers: { "content-type": "application/json", ...intest },
        body: JSON.stringify(corpoRichiesta)
      });

    prova("senza segreto 403, col segreto del proprietario no", [403, 403], [
      (await post({}, { prova: true })).status,
      (await post(padrone, { prova: true })).status
    ]);

    const secco = await post({ "x-cron-secret": "segreto-di-prova" }, { prova: true });
    const jsonProva = await secco.json();

    prova("a vuoto dice a chi scriverebbe e non manda niente", [200, true, 0, 1], [secco.status, jsonProva.prova, jsonProva.inviati, jsonProva.destinatari]);
    prova("il messaggio rimanda alla pagina della copia", true, jsonProva.testo.includes("https://sito.esempio/gestione?sezione=copia"));

    const spento = await post({ "x-cron-secret": "segreto-di-prova" }, {});

    prova("senza il token del bot dice che è spento (il giro risulta fallito)", [503, 0], [spento.status, (await spento.json()).inviati]);

    await scratch.query(`UPDATE utenti SET telegram_chat_id = NULL WHERE id = 1`);
    const nessuno = await post({ "x-cron-secret": "segreto-di-prova" }, { prova: true });

    prova("se il proprietario non ha la chat collegata è un errore, non un successo muto", [409, false], [nessuno.status, (await nessuno.json()).success]);
  } catch (err) {
    falliti += 1;
    console.error("ERRORE NELLA PROVA:", err);
  } finally {
    server?.close();
    await scratch.end().catch(() => {});
    await require("../db").end().catch(() => {});
    await admin.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => {});
    await admin.end().catch(() => {});
  }

  console.log(falliti ? `\n${falliti} prove NON passano.` : "\nTutto a posto.");
  process.exit(falliti ? 1 : 0);
})();
