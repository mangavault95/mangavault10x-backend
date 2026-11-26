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

// Un segreto solo per questa prova, PRIMA che `services/auth` lo legga: serve a
// firmare i token di chi «è entrato» nelle prove delle pagine degli altri.
process.env.JWT_SECRET = "x".repeat(48);

// Il pool finto va infilato PRIMA che le rotte lo richiedano: dopo
// sarebbe già nella cache dei moduli, e i router parlerebbero col
// database vero.
const Module = require("module");
const caricaVero = Module._load;

const NANAKI = { id: 2, nickname: "Nanaki", colore: "menta", proprietario: false, creato_il: new Date() };
const NICER = { id: 1, nickname: "Nicer", colore: "ottone", proprietario: true, creato_il: new Date() };

const finto = {
  query: async (sql, params) => {
    // Un soprannome «Nanaki» è una persona che NON è il proprietario.
    if (/FROM utenti u\s+WHERE lower\(u\.nickname\)/i.test(sql)) {
      return { rows: [String(params?.[0]).toLowerCase() === "nanaki" ? NANAKI : NICER] };
    }

    // L'elenco dei soprannomi: con `AND u.proprietario` solo il proprietario.
    if (/COUNT\(DISTINCT/i.test(sql)) {
      return { rows: /AND u\.proprietario/.test(sql) ? [NICER] : [NICER, NANAKI] };
    }

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
const jwt = require("jsonwebtoken");

// Chi «è entrato»: un token firmato per Nanaki (id 2, non proprietario). Il
// pool finto lo dà per attivo (`ancoraAttivo` trova la riga).
const TOKEN = jwt.sign({ id: 2, nickname: "Nanaki", proprietario: false }, process.env.JWT_SECRET, { expiresIn: "1h" });

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
  ["GET", "/api/cineforum/profilo/Nicer", null, 200, "la pagina del proprietario, a un visitatore"],
  ["GET", "/api/cineforum/commenti/Nicer", null, 200, "i commenti del proprietario, a un visitatore"],

  // Le pagine degli altri (26/11/2026): le vede solo chi è entrato. A un
  // visitatore 401, e 401 anche per un nome che non esiste, così la
  // differenza fra 401 e 404 non dice chi c'è.
  ["GET", "/api/cineforum/profilo/Nanaki", null, 401, "la pagina di un altro, senza accesso"],
  ["GET", "/api/cineforum/commenti/Nanaki", null, 401, "i commenti di un altro, senza accesso"],
  ["GET", "/api/cineforum/confronto/Nicer/Nanaki", null, 401, "un confronto, senza accesso"],
  ["GET", "/api/cineforum/profilo/Nanaki", null, 200, "la pagina di un altro, entrando", { token: true }],
  ["GET", "/api/cineforum/commenti/Nanaki", null, 200, "i commenti di un altro, entrando", { token: true }],
  ["GET", "/api/cineforum/confronto/Nicer/Nicer", null, 400, "confronto con sé stessi, entrando", { token: true }],
  [
    "GET", "/api/cineforum/chi", null, 200, "chi c'è, per un visitatore: solo il proprietario", {
      controlla: (j) => j.length === 1 && j[0].nickname === "Nicer"
    }
  ],
  [
    "GET", "/api/cineforum/chi", null, 200, "chi c'è, per chi è entrato: tutti", {
      token: true,
      controlla: (j) => j.length === 2
    }
  ],
  // Un token che non regge (firmato con un altro segreto) vale come nessun token.
  [
    "GET", "/api/cineforum/profilo/Nanaki", null, 401, "un token falso", { token: "falso" }
  ],
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

  for (const [metodo, indirizzo, corpo, atteso, cosa, opzioni = {}] of PROVE) {
    const intestazioni = corpo ? { "Content-Type": "application/json" } : {};

    if (opzioni.token === true) intestazioni.Authorization = `Bearer ${TOKEN}`;
    if (opzioni.token === "falso") {
      intestazioni.Authorization = `Bearer ${jwt.sign({ id: 2 }, "un-altro-segreto-lungo-abbastanza-per-firmare")}`;
    }

    const res = await fetch(`http://localhost:${porta}${indirizzo}`, {
      method: metodo,
      headers: intestazioni,
      body: corpo ? JSON.stringify(corpo) : undefined
    });

    let ok = res.status === atteso;

    if (ok && opzioni.controlla) ok = Boolean(opzioni.controlla(await res.json().catch(() => null)));

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
