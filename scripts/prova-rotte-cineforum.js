/**
 * Le rotte del Cineforum, con un database finto.
 *
 * Non controlla i DATI — quelli li prova `prova-cineforum.js` sui dati
 * veri — ma il CABLAGGIO: che ogni indirizzo esista, che i parametri
 * arrivino dove devono, che una richiesta storta risponda 400 invece
 * di 500, e soprattutto che scrivere senza token risponda 401.
 *
 * Non tocca il database e non ha bisogno di rete: gira in due secondi
 * e si può lanciare dopo ogni modifica alle rotte.
 *
 * Uso:
 *   node scripts/prova-rotte-cineforum.js
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

// Il pool finto va infilato PRIMA che le rotte lo richiedano: dopo
// sarebbe già nella cache dei moduli, e i router parlerebbero col
// database vero.
const Module = require("module");
const caricaVero = Module._load;

const finto = {
  query: async (sql) => {
    // `FROM utenti` e non `utenti`: senza lo spazio finale questo
    // ramo rispondeva anche alle letture di `utenti_striscione`,
    // consegnando una riga di persone al posto di un'immagine.
    if (/FROM utenti\s/i.test(sql)) {
      return {
        rows: [
          { id: 1, nickname: "Nicer", colore: "ottone", proprietario: true, creato_il: new Date() }
        ]
      };
    }

    if (/COUNT\(\*\)::int AS quanti/i.test(sql)) return { rows: [{ quanti: 1 }] };

    return { rows: [] };
  },
  connect: async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release() {} })
};

Module._load = function (richiesta, genitore, ...resto) {
  if (richiesta === "../db" || richiesta === "./db") return finto;

  return caricaVero.call(this, richiesta, genitore, ...resto);
};

const express = require("express");

const app = express();

// Gli stessi due lettori di corpo di `index.js`, nello stesso ordine:
// quello largo davanti e solo sugli indirizzi delle immagini. Se
// l'ordine si invertisse, una foto risponderebbe 413 invece di
// salvarsi, e questa prova è l'unica che se ne accorgerebbe.
app.use(["/api/utenti/io/faccia", "/api/utenti/io/striscione"], express.json({ limit: "4mb" }));
app.use(express.json());

app.use("/api/utenti", require("../routes/utenti"));
app.use("/api/cineforum", require("../routes/cineforum"));
app.use("/api/anime", require("../routes/anime"));

// Il pool finto risponde «Nicer» a qualunque soprannome, quindi il
// confronto fra due nomi diversi finisce per essere fra due volte la
// stessa persona: 400 è la risposta giusta, ed è anche la prova che
// quel controllo esiste.
const PROVE = [
  ["GET", "/api/cineforum", null, 200, "il feed"],
  ["GET", "/api/cineforum?prima=non-una-data", null, 400, "un istante storto"],
  ["GET", "/api/cineforum?utente=1&quanti=5", null, 200, "il feed di una persona"],
  ["GET", "/api/cineforum/chi", null, 200, "chi c'è"],
  ["GET", "/api/cineforum/io", null, 200, "chi sono"],
  ["GET", "/api/cineforum/profilo/Nicer", null, 200, "una pagina personale"],
  ["GET", "/api/cineforum/commenti/Nicer", null, 200, "i commenti di qualcuno"],
  ["GET", "/api/cineforum/confronto/Nicer/Nanaki", null, 400, "confronto con sé stessi"],
  ["POST", "/api/cineforum/messaggi", { testo: "ciao" }, 401, "scrivere senza token"],
  ["POST", "/api/cineforum/cuore", { chiave: "giornata:1:2026-08-22" }, 401, "cuore senza token"],
  ["POST", "/api/cineforum/risposte", { chiave: "messaggio:1", testo: "x" }, 401, "rispondere senza token"],
  ["DELETE", "/api/cineforum/messaggi/9", null, 401, "cancellare senza token"],
  ["POST", "/api/anime/12/preferito", {}, 401, "preferiti senza token"],

  // I consigli. Tutti e tre sotto token, compresa la lettura: una
  // cartolina ha un destinatario, e senza sapere chi sei non c'è
  // niente da consegnare.
  [
    "POST",
    "/api/cineforum/consigli",
    { a: 2, animeclickId: 45427, titolo: "Frieren" },
    401,
    "consigliare senza token"
  ],
  ["GET", "/api/cineforum/consigli/in-arrivo", null, 401, "la posta senza token"],
  ["POST", "/api/cineforum/consigli/9/aperto", {}, 401, "aprire senza token"],

  ["GET", "/api/utenti/1/faccia", null, 404, "la faccia di chi non ne ha"],
  ["GET", "/api/utenti/striscione/9", null, 404, "un'immagine che non c'è"],
  ["PUT", "/api/utenti/io/faccia", { immagine: "ciao" }, 401, "faccia senza token"],

  // 401 e NON 413: se il lettore di corpo largo non fosse davanti a
  // quello normale, una foto vera non arriverebbe mai al controllo del
  // token — morirebbe prima, per il tetto dei cento kilobyte.
  [
    "PUT",
    "/api/utenti/io/faccia",
    { immagine: `data:image/png;base64,${"A".repeat(400000)}` },
    401,
    "mezzo megabyte passa il lettore del corpo"
  ]
];

const server = app.listen(0, async () => {
  const porta = server.address().port;
  let male = 0;

  for (const [metodo, indirizzo, corpo, atteso, cosa] of PROVE) {
    const res = await fetch(`http://localhost:${porta}${indirizzo}`, {
      method: metodo,
      headers: corpo ? { "Content-Type": "application/json" } : {},
      body: corpo ? JSON.stringify(corpo) : undefined
    });

    const ok = res.status === atteso;

    if (!ok) male += 1;

    console.log(
      `${ok ? "✅" : "❌"} ${metodo.padEnd(6)} ${indirizzo.padEnd(46)} ${res.status} ` +
        `(atteso ${atteso}) — ${cosa}`
    );
  }

  console.log(
    male ? `\n❌ ${male} rotte fuori posto` : "\n✅ tutte le rotte rispondono come devono"
  );

  server.close();
  process.exit(male ? 1 : 0);
});
