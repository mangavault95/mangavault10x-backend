// Chi non è entrato può guardare, ma non può aggiungere, togliere o modificare niente.
//
//   node scripts/prova-protezione.js        (gira da sola a ogni push, vedi npm test)
//
// La regola è del 14/11/2026: il sito è di due persone e si legge liberamente, ma ogni
// scrittura chiede un accesso. Qui si PROVA, senza fidarsi dei nomi dei controlli: si avvia
// l'app vera, si prende ogni rotta che non è una lettura (POST, PUT, DELETE, PATCH), e le si
// manda una richiesta SENZA credenziali e poi con un token falso. Tutte devono rispondere
// 401 o 403. Una rotta nuova, aggiunta senza guardia, fa fallire questa prova.
//
// Non serve il database: ogni guardia scatta prima di toccarlo.
//
// Le eccezioni sono poche, scritte qui sotto, ognuna col suo perché. Se ne serve una nuova
// bisogna aggiungerla a mano, ed è giusto che si veda in una revisione.

process.env.JWT_SECRET = process.env.JWT_SECRET || "una-chiave-finta-lunga-almeno-trentadue-caratteri";
process.env.ADMIN_USERNAME = process.env.ADMIN_USERNAME || "prova";
process.env.ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || "00:00";
// Nessun database: se una guardia mancasse, la rotta proverebbe a usarlo e fallirebbe con 500.
process.env.DATABASE_URL = "postgres://nessuno:nessuna@127.0.0.1:9/inesistente";
// Le registrazioni devono essere chiuse di default, quindi la prova parte senza la variabile.
delete process.env.REGISTRAZIONI_APERTE;
// I lavori programmati chiedono un segreto: ne serve uno (finto) perché rispondano come in produzione,
// cioè 403. Senza, rispondono 500 «non configurato», che rifiuta lo stesso ma non è quello che si vuole provare.
process.env.CRON_SECRET = "un-segreto-finto-solo-per-la-prova";

const express = require("express");
const fs = require("fs");
const path = require("path");

const montaggio = require("../routes/montaggio");

// Le uniche rotte che scrivono (o sembrano) e non chiedono un accesso.
const ECCEZIONI = new Map([
  // Per entrare bisogna poterlo fare senza essere già dentro. Il tetto ai tentativi sbagliati è in routes/utenti.js.
  ["POST /api/utenti/login", "è la porta d'ingresso"],
  ["POST /api/manga/login", "il vecchio indirizzo dell'ingresso, tenuto per i browser con la pagina in cache"],
  // Non scrive nel database: interroga AniList, Google Books e il traduttore e restituisce il risultato. La usa
  // il banco del bibliotecario anche per chi non è entrato. Ha un tetto alle richieste (services/limite.js).
  ["POST /api/manga/enrich", "solo lettura da fonti esterne, con un tetto alle richieste"]
]);

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

/** Tutte le rotte di un router (anche quelle dentro router annidati), con indirizzo, metodi e sorgente. */
function rotteDi(prefisso, stack, uscita = []) {
  for (const strato of stack) {
    if (strato.route) {
      const metodi = Object.keys(strato.route.methods).filter((m) => strato.route.methods[m]).map((m) => m.toUpperCase());

      uscita.push({
        percorso: (prefisso + strato.route.path).replace(/\/+$/, "") || "/",
        metodi,
        sorgente: strato.route.stack.map((s) => s.handle.toString()).join("\n")
      });
    } else if (strato.name === "router" && strato.handle?.stack) {
      rotteDi(prefisso, strato.handle.stack, uscita);
    }
  }

  return uscita;
}

const rotte = montaggio.flatMap(([indirizzo, router]) => rotteDi(indirizzo, router.stack));
const LETTURE = ["GET", "HEAD", "OPTIONS"];
const scritture = rotte.flatMap((r) => r.metodi.filter((m) => !LETTURE.includes(m)).map((metodo) => ({ ...r, metodo })));

(async () => {
  console.log("\nIl controllo guarda la cosa giusta");
  prova("trova le rotte (se questo numero crolla, il controllo non sta più guardando niente)", true, rotte.length >= 100 && scritture.length >= 70);

  const app = express();

  app.use(express.json());

  for (const [indirizzo, router] of montaggio) app.use(indirizzo, router);

  app.use((err, req, res, next) => res.status(500).json({ error: String(err?.message || err) }));

  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  const manda = (metodo, percorso, intestazioni = {}) =>
    fetch(base + percorso.replace(/:[A-Za-z]+/g, "1"), {
      method: metodo,
      headers: { "content-type": "application/json", ...intestazioni },
      body: ["POST", "PUT", "PATCH"].includes(metodo) ? "{}" : undefined
    });

  try {
    console.log("\nSenza credenziali e con un token falso, ogni scrittura è rifiutata");

    const scoperte = [];
    const conTokenFalso = [];

    for (const r of scritture) {
      const chiave = `${r.metodo} ${r.percorso}`;

      if (ECCEZIONI.has(chiave)) continue;

      const senza = (await manda(r.metodo, r.percorso)).status;
      const falso = (await manda(r.metodo, r.percorso, { authorization: "Bearer questo.non.vale" })).status;

      if (![401, 403].includes(senza)) scoperte.push(`${chiave} → ${senza}`);
      if (![401, 403].includes(falso)) conTokenFalso.push(`${chiave} → ${falso}`);
    }

    prova(`senza credenziali: ${scritture.length - ECCEZIONI.size} rotte rifiutate con 401 o 403`, [], scoperte);
    prova("con un token falso: lo stesso", [], conTokenFalso);

    console.log("\nLe eccezioni sono quelle scritte, e non una di più");

    const trovate = scritture.map((r) => `${r.metodo} ${r.percorso}`);

    prova("ogni eccezione esiste ancora (una che sparisce va tolta da questa lista)", [], [...ECCEZIONI.keys()].filter((k) => !trovate.includes(k)));

    const registrazione = await manda("POST", "/api/utenti/registrazione");

    prova("la registrazione è chiusa di default (403), e lo dice", [403, "registrazioni_chiuse"], [registrazione.status, (await registrazione.json()).motivo]);

    process.env.REGISTRAZIONI_APERTE = "1";

    const aperta = await manda("POST", "/api/utenti/registrazione");

    delete process.env.REGISTRAZIONI_APERTE;

    prova("con REGISTRAZIONI_APERTE=1 la guardia si toglie (la richiesta arriva alla rotta)", true, aperta.status !== 403);
  } finally {
    server.close();
  }

  console.log("\nLe letture non scrivono di nascosto");
  {
    // Controllo sul testo: una rotta di lettura che contiene SQL di scrittura, o che chiama una funzione dei
    // servizi che ne contiene, è sospetta. Non vede tutto (una funzione che ne chiama un'altra che scrive), ma
    // prende il caso più probabile: qualcuno che aggiunge un `INSERT` dentro un GET.
    const SCRIVE = /\b(INSERT\s+INTO|UPDATE\s+["a-z_]|DELETE\s+FROM|TRUNCATE)\b/i;
    const scrittori = new Set();

    for (const f of fs.readdirSync(path.join(__dirname, "..", "services")).filter((x) => x.endsWith(".js"))) {
      let modulo;

      try {
        modulo = require(path.join(__dirname, "..", "services", f));
      } catch {
        continue;
      }

      for (const [nome, funzione] of Object.entries(modulo)) if (typeof funzione === "function" && SCRIVE.test(funzione.toString())) scrittori.add(nome);
    }

    // `accedi` aggiorna «visto il» al login: è un POST, non una lettura.
    const sospette = rotte
      .filter((r) => r.metodi.every((m) => LETTURE.includes(m)))
      .filter((r) => SCRIVE.test(r.sorgente) || [...scrittori].some((n) => new RegExp(`\\b${n}\\(`).test(r.sorgente)))
      .map((r) => `${r.metodi.join(",")} ${r.percorso}`);

    prova("nessuna rotta di sola lettura contiene scritture", [], sospette);
  }

  console.log(falliti ? `\n${falliti} prove fallite.\n` : "\nTutto a posto.\n");
  process.exitCode = falliti ? 1 : 0;
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
