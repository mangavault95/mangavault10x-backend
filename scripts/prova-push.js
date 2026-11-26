/**
 * Il push, senza database e senza rete.
 *
 * Tre cose, tutte che non toccano niente di fuori:
 *
 *   1. quali indirizzi si accettano (è il freno contro «fai chiamare al server
 *      qualunque indirizzo»);
 *   2. cosa dicono i messaggi (`messaggioPush`, `episodio`);
 *   3. le rotte, con un database finto: chi può iscriversi e chi no.
 *
 * Il database vero lo prova `prova-push-db.js`.
 *
 * Uso:
 *   node scripts/prova-push.js
 */

const assert = require("assert");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const webpush = require("web-push");

// Chiavi VAPID di una sola prova, e un segreto per firmare i token: PRIMA che i
// servizi li leggano.
const chiavi = webpush.generateVAPIDKeys();
process.env.VAPID_PUBLIC_KEY = chiavi.publicKey;
process.env.VAPID_PRIVATE_KEY = chiavi.privateKey;
process.env.VAPID_SUBJECT = "mailto:prova@example.com";
process.env.JWT_SECRET = "x".repeat(48);

// Il pool finto va infilato PRIMA che le rotte lo richiedano.
const Module = require("module");
const caricaVero = Module._load;

const chiamate = [];
const sottoscrizioni = [];

const finto = {
  query: async (sql, params) => {
    chiamate.push({ sql, params });

    if (/FROM utenti\s/i.test(sql)) return { rows: [{ id: 2, nickname: "Nanaki" }] };
    if (/COUNT\(\*\)::int AS quanti FROM push_sottoscrizioni/i.test(sql)) return { rows: [{ quanti: sottoscrizioni.length }] };
    if (/FROM push_sottoscrizioni WHERE utente_id/i.test(sql)) return { rows: [] };

    return { rows: [] };
  }
};

Module._load = function (richiesta, genitore, ...resto) {
  if (richiesta === "../db" || richiesta === "./db") return finto;

  return caricaVero.call(this, richiesta, genitore, ...resto);
};

const push = require("../services/push");
const avvisi = require("../services/avvisi");
const jwt = require("jsonwebtoken");
const express = require("express");

let male = 0;

function ok(nome, vero) {
  if (!vero) male++;
  console.log(`${vero ? "✅" : "❌"} ${nome}`);
}

// ---- 1. gli indirizzi ----

const AMMESSI = [
  "https://web.push.apple.com/QAbc123",
  "https://fcm.googleapis.com/fcm/send/abc",
  "https://updates.push.services.mozilla.com/wpush/v2/abc",
  "https://wns2-par02p.notify.windows.com/w/?token=abc",
  "https://api.push.apple.com/3/device/abc"
];

const RIFIUTATI = [
  ["http invece di https", "http://web.push.apple.com/x"],
  ["un indirizzo interno", "https://localhost/x"],
  ["un indirizzo IP", "https://169.254.169.254/latest/meta-data"],
  ["un host che finge", "https://web.push.apple.com.evil.example/x"],
  ["un host che contiene il nome", "https://evil.example/web.push.apple.com"],
  ["una porta", "https://fcm.googleapis.com:8443/x"],
  ["credenziali nell'indirizzo", "https://user:pw@fcm.googleapis.com/x"],
  ["non un indirizzo", "ciao"],
  ["vuoto", ""],
  ["il backend stesso", "https://mangavault10x-api.onrender.com/api/utenti/login"]
];

for (const e of AMMESSI) ok(`ammesso: ${new URL(e).hostname}`, push.indirizzoAmmesso(e));
for (const [nome, e] of RIFIUTATI) ok(`rifiutato: ${nome}`, !push.indirizzoAmmesso(e));

const BUONA = {
  endpoint: "https://web.push.apple.com/QAbc123",
  keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" }
};

ok("una sottoscrizione vera si legge", Boolean(push.leggiSottoscrizione(BUONA)));
ok("senza chiavi non vale", !push.leggiSottoscrizione({ endpoint: BUONA.endpoint }));
ok("chiavi con caratteri strani non valgono", !push.leggiSottoscrizione({ endpoint: BUONA.endpoint, keys: { p256dh: "<script>", auth: "x" } }));
ok("un corpo vuoto non vale", !push.leggiSottoscrizione(null));

// ---- 2. i messaggi ----

ok("ep. senza stagioni", avvisi.episodio(25, []) === "ep. 25");
ok("ep. con tagli: la seconda stagione", avvisi.episodio(26, [25]) === "St. 2 · ep. 2");
ok("ep. con tagli: la terza", avvisi.episodio(51, [25, 50]) === "St. 3 · ep. 2");
ok("ep. con tagli nulli", avvisi.episodio(3, null) === "ep. 3");

const una = avvisi.messaggioPush("uscita", [
  { anime_id: 7, numero: 26, titolo: "Il ritorno", piattaforma: "Crunchyroll", serie: "Frieren", tagli: [25], uscita_italia: new Date() }
]);
ok("uscita: titolo è la serie", una.titolo === "Frieren");
ok("uscita: dice la puntata e la piattaforma", una.corpo.includes("St. 2 · ep. 2") && una.corpo.includes("Crunchyroll"));
ok("uscita: apre la scheda", una.url === "/videoteca/7");

const piu = avvisi.messaggioPush(
  "uscita",
  Array.from({ length: 6 }, (_, i) => ({ anime_id: i, numero: 1, serie: `Serie ${i}`, tagli: [], uscita_italia: new Date() }))
);
ok("più uscite: una sola notifica", piu.titolo === "Appena uscite");
ok("più uscite: tronca l'elenco", piu.corpo.split("\n").length === 5 && piu.corpo.includes("e altre 2"));

const mattina = avvisi.messaggioPush("mattina", [
  { anime_id: 1, numero: 3, serie: "Blue Box", tagli: [], uscita_italia: new Date("2026-11-26T16:00:00Z") }
]);
ok("mattina: titolo al singolare", mattina.titolo === "Oggi esce una puntata");
ok("mattina: apre il calendario", mattina.url === "/calendario");

// ---- 3. le rotte ----

const app = express();
app.use(express.json());
app.use("/api/push", require("../routes/push"));

const TOKEN = jwt.sign({ id: 2, nickname: "Nanaki", proprietario: true }, process.env.JWT_SECRET, { expiresIn: "1h" });

const server = app.listen(0, async () => {
  const porta = server.address().port;

  async function chiedi(metodo, indirizzo, corpo, conToken = false) {
    const intestazioni = corpo ? { "Content-Type": "application/json" } : {};

    if (conToken) intestazioni.Authorization = `Bearer ${TOKEN}`;

    const res = await fetch(`http://localhost:${porta}${indirizzo}`, {
      method: metodo,
      headers: intestazioni,
      body: corpo ? JSON.stringify(corpo) : undefined
    });

    return { stato: res.status, json: await res.json().catch(() => null) };
  }

  const chiave = await chiedi("GET", "/api/push/chiave");
  ok("la chiave pubblica è aperta e giusta", chiave.stato === 200 && chiave.json.chiave === chiavi.publicKey);

  ok("iscriversi senza accesso: 401", (await chiedi("POST", "/api/push/sottoscrivi", BUONA)).stato === 401);
  ok("togliersi senza accesso: 401", (await chiedi("DELETE", "/api/push/sottoscrivi", { endpoint: BUONA.endpoint })).stato === 401);
  ok("la prova senza accesso: 401", (await chiedi("POST", "/api/push/prova", {})).stato === 401);

  ok(
    "un indirizzo non ammesso: 400",
    (await chiedi("POST", "/api/push/sottoscrivi", { ...BUONA, endpoint: "https://evil.example/x" }, true)).stato === 400
  );
  ok("senza chiavi: 400", (await chiedi("POST", "/api/push/sottoscrivi", { endpoint: BUONA.endpoint }, true)).stato === 400);

  const iscritto = await chiedi("POST", "/api/push/sottoscrivi", BUONA, true);
  ok("una sottoscrizione vera: 201", iscritto.stato === 201);

  const insert = chiamate.find((c) => /INSERT INTO push_sottoscrizioni/i.test(c.sql));
  ok("viene scritta per chi è entrato (2), non per un numero dell'indirizzo", insert && insert.params[0] === 2 && insert.params[1] === BUONA.endpoint);

  ok("senza endpoint, togliersi: 400", (await chiedi("DELETE", "/api/push/sottoscrivi", {}, true)).stato === 400);

  const tolto = await chiedi("DELETE", "/api/push/sottoscrivi", { endpoint: BUONA.endpoint }, true);
  const cancella = chiamate.find((c) => /DELETE FROM push_sottoscrizioni WHERE endpoint/i.test(c.sql));
  ok("togliersi: 200, e solo le proprie", tolto.stato === 200 && /utente_id = \$2/.test(cancella?.sql || "") && cancella.params[1] === 2);

  ok("la prova senza dispositivi: 409", (await chiedi("POST", "/api/push/prova", {}, true)).stato === 409);

  server.close();

  console.log(male ? `\n❌ ${male} controlli falliti` : "\n✅ il push risponde come deve");
  process.exit(male ? 1 : 0);
});
