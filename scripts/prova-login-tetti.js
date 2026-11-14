// Prove del login e dei suoi tetti: il tetto per indirizzo, quello sulle password sbagliate in tutto il
// sito, e quello della raffica.
//
//   PROVA_DATABASE_URL=postgres://… node scripts/prova-login-tetti.js
//
// Il caso che ha fatto cambiare tutto (14/11/2026): quaranta password sbagliate da quattro indirizzi e il
// proprietario, con la password GIUSTA, restava fuori per un quarto d'ora. Qui si rifà, e si controlla che
// una password giusta passi sempre, mentre una sbagliata no.
//
// Il database di prova è uno schema VUOTO: la tabella `utenti` non c'è, e il login ripiega sul proprietario
// delle variabili d'ambiente (`accessoDiRipiego`), che è quello che serve qui. Gli indirizzi diversi si
// simulano con `X-Forwarded-For` e `trust proxy`, come davanti a Render.

const crypto = require("crypto");
const { Pool } = require("pg");

const url = process.env.PROVA_DATABASE_URL;

if (!url) {
  console.log("\n(PROVA_DATABASE_URL non c'è: salto le prove del login.)\n");
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

(async () => {
  const schema = `prova_login_${Math.random().toString(36).slice(2, 10)}`;
  const locale = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const ssl = locale ? false : { rejectUnauthorized: false };
  const admin = new Pool({ connectionString: url, ssl, max: 1 });

  await admin.query(`CREATE SCHEMA ${schema}`);

  const sale = crypto.randomBytes(8).toString("hex");

  process.env.DATABASE_URL = `${url}${url.includes("?") ? "&" : "?"}options=-c%20search_path%3D${schema}`;
  process.env.JWT_SECRET = "una-chiave-finta-lunga-almeno-trentadue-caratteri";
  process.env.ADMIN_USERNAME = "capo";
  process.env.ADMIN_PASSWORD_HASH = `${sale}:${crypto.scryptSync("la-password-giusta-1234", sale, 64).toString("hex")}`;

  const veroErrore = console.error;
  const veroAvviso = console.warn;
  let server;

  try {
    console.error = () => {};
    console.warn = () => {};

    const express = require("express");
    const utenti = require("../routes/utenti");
    const app = express();

    app.set("trust proxy", 1);
    app.use(express.json());
    app.use("/api/utenti", utenti);
    server = app.listen(0);

    const { sbagliate, raffica } = utenti.tettiAccesso;
    const base = `http://127.0.0.1:${server.address().port}/api/utenti/login`;
    const entra = async (ip, password) => {
      const r = await fetch(base, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": ip },
        body: JSON.stringify({ username: "capo", password })
      });

      return { codice: r.status, attesa: r.headers.get("retry-after"), corpo: await r.json() };
    };
    const GIUSTA = "la-password-giusta-1234";
    const SBAGLIATA = "una-password-sbagliata";

    console.log("\nIl caso di prima: troppe password sbagliate in tutto il sito");
    sbagliate.massimo = 5;

    const prime = [];

    for (let i = 1; i <= 5; i++) prime.push((await entra(`10.0.0.${i}`, SBAGLIATA)).codice);

    prova("le prime cinque, da cinque indirizzi diversi, ricevono 401", [401, 401, 401, 401, 401], prime);

    const sesta = await entra("10.0.0.6", SBAGLIATA);

    prova("la sesta sbagliata riceve 429, con Retry-After", [429, true], [sesta.codice, Number(sesta.attesa) >= 1]);

    const giusta = await entra("10.0.0.99", GIUSTA);

    prova("il proprietario con la password GIUSTA, da un indirizzo nuovo, entra lo stesso", [200, true], [giusta.codice, typeof giusta.corpo.token === "string"]);

    const ancora = await entra("10.0.0.7", SBAGLIATA);

    prova("e un'altra sbagliata continua a ricevere 429", 429, ancora.codice);

    console.log("\nIl tetto per indirizzo resta");
    sbagliate.massimo = 100000;

    const unIndirizzo = [];

    for (let i = 0; i < 10; i++) unIndirizzo.push((await entra("20.0.0.1", SBAGLIATA)).codice);

    prova("dieci sbagliate da un indirizzo ricevono 401", true, unIndirizzo.every((c) => c === 401));

    const bloccato = await entra("20.0.0.1", GIUSTA);

    prova("la undicesima da quello stesso indirizzo è bloccata PRIMA di guardare la password, anche se giusta", 429, bloccato.codice);

    const altro = await entra("20.0.0.2", GIUSTA);

    prova("da un altro indirizzo la password giusta entra", 200, altro.codice);

    console.log("\nLa raffica protegge la CPU");
    raffica.massimo = 0;

    const raf = await entra("30.0.0.1", GIUSTA);

    prova("oltre il tetto della raffica anche la password giusta aspetta, senza essere verificata", [429, true], [raf.codice, Number(raf.attesa) >= 1]);

    raffica.massimo = 2000;
    prova("tornato il tetto largo, si entra di nuovo", 200, (await entra("30.0.0.2", GIUSTA)).codice);
  } catch (err) {
    falliti += 1;
    veroErrore("ERRORE NELLA PROVA:", err);
  } finally {
    console.error = veroErrore;
    console.warn = veroAvviso;
    server?.close();
    await require("../db").end().catch(() => {});
    await admin.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => {});
    await admin.end().catch(() => {});
  }

  console.log(falliti ? `\n${falliti} prove NON passano.` : "\nTutto a posto.");
  process.exit(falliti ? 1 : 0);
})();
