/**
 * Il push sul database vero: la migrazione 037 e le query degli avvisi.
 *
 * Serve un Postgres vuoto (`PROVA_DATABASE_URL`, come `prova-migra.js`); senza,
 * salta. Lavora in uno SCHEMA suo, creato e buttato via: non tocca altro. Le
 * tabelle che la 037 richiama (`utenti`, `anime`) e quelle che le query leggono
 * sono ridotte alle sole colonne che servono — il vero schema parte da una
 * tabella creata a mano e non si ricostruisce da capo — ma la 037 si esegue
 * AL NATURALE, il file così com'è, ed è quello che qui si prova davvero.
 *
 * Il servizio push è finto (`sendNotification` registra e basta): nessuna rete.
 *
 * Uso:
 *   PROVA_DATABASE_URL=postgres://… node scripts/prova-push-db.js
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

if (!process.env.PROVA_DATABASE_URL) {
  console.log("(PROVA_DATABASE_URL non c'è: salto le prove del push sul database.)");
  process.exit(0);
}

const webpush = require("web-push");

const chiavi = webpush.generateVAPIDKeys();
process.env.VAPID_PUBLIC_KEY = chiavi.publicKey;
process.env.VAPID_PRIVATE_KEY = chiavi.privateKey;
process.env.VAPID_SUBJECT = "mailto:prova@example.com";
// Telegram spento: qui si prova il canale push da solo.
delete process.env.TELEGRAM_USCITE_TOKEN;

const { Client } = require("pg");

const inviate = [];
let comportamento = () => {};

webpush.sendNotification = async (sottoscrizione, corpo, opzioni) => {
  inviate.push({ endpoint: sottoscrizione.endpoint, messaggio: JSON.parse(corpo), opzioni });
  return comportamento(sottoscrizione);
};

const avvisi = require("../services/avvisi");
const push = require("../services/push");
const { avvisaVolumi } = require("../services/avvisiVolumi");

const SCHEMA = `prova_push_${process.pid}`;
let male = 0;

function ok(nome, vero) {
  if (!vero) male++;
  console.log(`${vero ? "✅" : "❌"} ${nome}`);
}

(async () => {
  const db = new Client({ connectionString: process.env.PROVA_DATABASE_URL });

  await db.connect();

  try {
    await db.query(`CREATE SCHEMA ${SCHEMA}`);
    await db.query(`SET search_path TO ${SCHEMA}`);

    // Le tabelle di cui la 037 e le query hanno bisogno, ridotte all'osso.
    await db.query(`
      CREATE TABLE utenti (
        id BIGINT PRIMARY KEY, nickname TEXT NOT NULL, stato TEXT NOT NULL DEFAULT 'attivo',
        telegram_chat_id BIGINT, proprietario BOOLEAN NOT NULL DEFAULT FALSE
      );
      CREATE TABLE anime (id BIGINT PRIMARY KEY, titolo TEXT NOT NULL, tagli INTEGER[]);
      CREATE TABLE anime_episodi (
        anime_id BIGINT NOT NULL REFERENCES anime(id), numero INTEGER NOT NULL, titolo TEXT,
        uscita_italia TIMESTAMPTZ, piattaforma TEXT, PRIMARY KEY (anime_id, numero)
      );
      CREATE TABLE visioni (
        anime_id BIGINT NOT NULL REFERENCES anime(id), utente_id BIGINT NOT NULL REFERENCES utenti(id) ON DELETE CASCADE,
        stato TEXT NOT NULL DEFAULT 'in_visione', PRIMARY KEY (anime_id, utente_id)
      );
    `);

    // ---- la migrazione, il file vero, due volte ----
    const sql037 = fs.readFileSync(path.join(__dirname, "..", "sql", "037_push.sql"), "utf8");

    await db.query(sql037);
    await db.query(sql037);
    ok("la 037 si applica, e si può ripetere", true);

    // ---- i dati ----
    await db.query(`
      INSERT INTO utenti (id, nickname) VALUES (1, 'Nicer'), (2, 'Nanaki'), (3, 'Senzapush');
      INSERT INTO anime (id, titolo, tagli) VALUES (10, 'Frieren', '{25}'), (11, 'Blue Box', NULL);
      INSERT INTO anime_episodi (anime_id, numero, titolo, uscita_italia, piattaforma) VALUES
        (10, 26, 'Il ritorno', NOW() - interval '10 minutes', 'Crunchyroll'),
        (11, 5, NULL, NOW() - interval '5 hours', 'Netflix');
      INSERT INTO visioni (anime_id, utente_id, stato) VALUES
        (10, 1, 'in_visione'), (10, 2, 'in_visione'), (10, 3, 'in_visione'), (11, 1, 'in_visione');
      INSERT INTO push_sottoscrizioni (utente_id, endpoint, p256dh, auth) VALUES
        (1, 'https://web.push.apple.com/uno', 'k', 'a'),
        (1, 'https://fcm.googleapis.com/due', 'k', 'a'),
        (2, 'https://web.push.apple.com/scaduto', 'k', 'a');
    `);

    // ---- chi viene scelto ----
    const prova = await avvisi.avvisa(db, { tipo: "uscita", prova: true });

    ok("a vuoto: trova solo chi ha un dispositivo (Nicer e Nanaki, non Senzapush)", prova.push.persone === 2);
    ok("a vuoto: la puntata di 5 ore fa è fuori dalla finestra", prova.push.trovate === 2);
    ok("a vuoto: non manda niente", inviate.length === 0);
    ok(
      "a vuoto: non segna niente",
      (await db.query("SELECT COUNT(*)::int AS n FROM push_inviati")).rows[0].n === 0
    );
    ok(
      "il messaggio dice la seconda stagione (tagli [25])",
      prova.push.dettaglio.some((d) => d.messaggio.corpo.includes("St. 2 · ep. 2"))
    );

    // ---- la consegna ----
    // Nanaki ha un dispositivo che il servizio dice scaduto (410).
    comportamento = (s) => {
      if (s.endpoint.endsWith("/scaduto")) {
        const e = new Error("gone");
        e.statusCode = 410;
        throw e;
      }
    };

    const giro = await avvisi.avvisa(db, { tipo: "uscita" });

    ok("manda a Nicer su entrambi i dispositivi", inviate.filter((i) => i.endpoint.includes("/uno") || i.endpoint.includes("/due")).length === 2);
    ok("una persona con un dispositivo che consegna conta una volta", giro.push.inviati === 1);
    ok("chi non riceve da nessuno (Nanaki) è un fallito", giro.push.falliti === 1);

    const segnati = (await db.query("SELECT utente_id FROM push_inviati ORDER BY utente_id")).rows.map((r) => Number(r.utente_id));

    ok("segnata solo la puntata di chi l'ha ricevuta (Nicer)", JSON.stringify(segnati) === "[1]");
    ok(
      "la sottoscrizione scaduta (410) si cancella da sola",
      (await db.query("SELECT COUNT(*)::int AS n FROM push_sottoscrizioni WHERE endpoint LIKE '%/scaduto'")).rows[0].n === 0
    );
    ok(
      "chi non ha ricevuto non è segnato: il giro dopo riprova (ma senza dispositivi non c'è più chi avvisare)",
      (await avvisi.avvisa(db, { tipo: "uscita", prova: true })).push.persone === 0
    );

    // ---- niente doppioni ----
    const prima = inviate.length;
    const secondo = await avvisi.avvisa(db, { tipo: "uscita" });

    ok("un secondo giro non rimanda la stessa puntata", inviate.length === prima && secondo.push.inviati === 0);

    // ---- il canale Telegram non c'entra ----
    ok(
      "il registro di Telegram non esiste qui e non serve: i canali sono indipendenti",
      (await db.query("SELECT to_regclass('avvisi_uscite') AS t")).rows[0].t === null
    );

    // ---- la notte ----
    await db.query(`
      INSERT INTO push_sottoscrizioni (utente_id, endpoint, p256dh, auth) VALUES (2, 'https://web.push.apple.com/nuovo', 'k', 'a');
      INSERT INTO anime_episodi (anime_id, numero, titolo, uscita_italia, piattaforma) VALUES (10, 27, NULL, NOW() - interval '2 minutes', NULL);
    `);
    comportamento = () => {};
    inviate.length = 0;
    await avvisi.avvisa(db, { tipo: "uscita" });

    ok("la puntata nuova parte a tutti e due", new Set(inviate.map((i) => i.endpoint.split("/")[2] + i.endpoint.split("/")[3])).size >= 2);
    ok("ogni invio porta il TTL e l'urgenza", inviate.every((i) => i.opzioni.TTL > 0 && ["normal", "low"].includes(i.opzioni.urgency)));

    // ---- la cancellazione a cascata ----
    await db.query("DELETE FROM utenti WHERE id = 1");
    ok(
      "se la persona se ne va, i suoi dispositivi se ne vanno con lei",
      (await db.query("SELECT COUNT(*)::int AS n FROM push_sottoscrizioni WHERE utente_id = 1")).rows[0].n === 0
    );

    // ---- inviaAPersona ripulisce ----
    await db.query(`INSERT INTO push_sottoscrizioni (utente_id, endpoint, p256dh, auth) VALUES (3, 'https://web.push.apple.com/morto', 'k', 'a')`);
    comportamento = () => {
      const e = new Error("not found");
      e.statusCode = 404;
      throw e;
    };
    const consegnati = await push.inviaAPersona(db, 3, { titolo: "x", corpo: "y", url: "/" });

    ok(
      "404 = dispositivo sparito: nessuna consegna e riga cancellata",
      consegnati === 0 && (await db.query("SELECT COUNT(*)::int AS n FROM push_sottoscrizioni WHERE utente_id = 3")).rows[0].n === 0
    );

    // ---- un guasto che passa NON cancella ----
    await db.query(`INSERT INTO push_sottoscrizioni (utente_id, endpoint, p256dh, auth) VALUES (3, 'https://web.push.apple.com/giu', 'k', 'a')`);
    comportamento = () => {
      const e = new Error("bad gateway");
      e.statusCode = 502;
      throw e;
    };
    await push.inviaAPersona(db, 3, { titolo: "x", corpo: "y", url: "/" });

    ok(
      "502 = guasto passeggero: la riga resta",
      (await db.query("SELECT COUNT(*)::int AS n FROM push_sottoscrizioni WHERE utente_id = 3")).rows[0].n === 1
    );

    {
    // ---- «Domani esce il vol. N» ----
    await db.query(`DELETE FROM push_sottoscrizioni; DELETE FROM push_inviati;`);
    await db.query(`
      INSERT INTO utenti (id, nickname) VALUES (4, 'Casa'), (5, 'Fuori');
      INSERT INTO push_sottoscrizioni (utente_id, endpoint, p256dh, auth) VALUES
        (2, 'https://web.push.apple.com/vol-nanaki', 'k', 'a'),
        (4, 'https://web.push.apple.com/vol-casa', 'k', 'a'),
        (5, 'https://web.push.apple.com/vol-fuori', 'k', 'a');
    `);
    comportamento = () => {};
    inviate.length = 0;

    const serie = (id, titolo, edizione = null) => ({ id, titolo, edizione });
    const uscite = [
      { data: "2026-11-27", numero: 12, stato: "prossimo", mancanti: 0, serie: serie(100, "Berserk", "Deluxe") },
      { data: "2026-11-27", numero: 5, stato: "manca", mancanti: 2, serie: serie(101, "Vagabond") },
      { data: "2026-11-27", numero: 9, stato: "gia", mancanti: 0, serie: serie(102, "Monster") }
    ];
    let richiesta = null;
    const leggiUscite = async (_pool, opzioni) => ((richiesta = opzioni), uscite);
    // Nanaki (2) e Casa (4) hanno la biblioteca; Fuori (5) no.
    const haAccesso = async (id) => Number(id) !== 5;

    const vuoto = await avvisaVolumi(db, { prova: true, oggi: "2026-11-26", leggiUscite, haAccesso });

    ok("guarda solo il giorno di domani (dopo = oggi, fino = domani)", richiesta.dopo === "2026-11-26" && richiesta.fino === "2026-11-27" && richiesta.soloMie === true);
    ok("non parla dei volumi che hai già (3 uscite, 2 da avvisare)", vuoto.volumi === 2);
    ok("a chi non ha la biblioteca non scrive (3 persone iscritte, 2 destinatari)", vuoto.persone === 2);
    ok("a vuoto non manda e non segna", inviate.length === 0 && (await db.query("SELECT COUNT(*)::int AS n FROM push_volumi_inviati")).rows[0].n === 0);

    const girovolumi = await avvisaVolumi(db, { oggi: "2026-11-26", leggiUscite, haAccesso });
    const msg = inviate[0]?.messaggio;

    ok("manda a Nanaki e a Casa, non a Fuori", girovolumi.inviati === 2 && !inviate.some((i) => i.endpoint.endsWith("/vol-fuori")));
    ok("più volumi: una sola notifica con il conto", msg?.titolo === "Domani escono 2 volumi");
    ok("l'elenco segna con ⚠️ quello con i buchi prima", msg?.corpo.includes("Vagabond 5 ⚠️") && msg.corpo.includes("Berserk · Deluxe 12"));
    ok("più volumi: apre le uscite", msg?.url === "/uscite");
    ok("ogni persona è segnata per ogni volume (2 persone × 2 volumi)", (await db.query("SELECT COUNT(*)::int AS n FROM push_volumi_inviati")).rows[0].n === 4);

    const prima = inviate.length;
    const bis = await avvisaVolumi(db, { oggi: "2026-11-26", leggiUscite, haAccesso });

    ok("lanciato due volte, non rimanda", inviate.length === prima && bis.inviati === 0);

    // Un'uscita che si sposta di giorno merita un avviso nuovo.
    inviate.length = 0;
    const spostata = [{ ...uscite[0], data: "2026-11-28" }];
    await avvisaVolumi(db, { oggi: "2026-11-26", leggiUscite: async () => spostata, haAccesso });

    ok("se la data cambia, riavvisa (la data è nella chiave)", inviate.length === 2);

    // Un solo volume: titolo e corpo precisi.
    inviate.length = 0;
    await db.query("DELETE FROM push_volumi_inviati");
    await avvisaVolumi(db, { oggi: "2026-11-26", leggiUscite: async () => [uscite[1]], haAccesso });

    ok(
      "un solo volume con dei buchi: «Domani esce il vol. 5», e quanti ne mancano",
      inviate[0]?.messaggio.titolo === "Domani esce il vol. 5" && inviate[0].messaggio.corpo.includes("Prima te ne mancano 2.") && inviate[0].messaggio.url === "/serie/101"
    );

    inviate.length = 0;
    await db.query("DELETE FROM push_volumi_inviati");
    await avvisaVolumi(db, { oggi: "2026-11-26", leggiUscite: async () => [uscite[0]], haAccesso });

    ok("un solo volume che è il prossimo: lo dice", inviate[0]?.messaggio.corpo.includes("È il prossimo che ti serve."));

    // Nessuna uscita domani: nessuna notifica.
    inviate.length = 0;
    const niente = await avvisaVolumi(db, { oggi: "2026-11-26", leggiUscite: async () => [], haAccesso });

    ok("senza uscite domani non manda niente", niente.volumi === 0 && inviate.length === 0);

    // Se nessun dispositivo riceve, il segno si toglie e il giro dopo riprova.
    await db.query("DELETE FROM push_volumi_inviati");
    comportamento = () => {
      const e = new Error("bad gateway");
      e.statusCode = 502;
      throw e;
    };
    const guasto = await avvisaVolumi(db, { oggi: "2026-11-26", leggiUscite: async () => [uscite[0]], haAccesso });

    ok(
      "se non parte, non resta segnato",
      guasto.falliti === 2 && (await db.query("SELECT COUNT(*)::int AS n FROM push_volumi_inviati")).rows[0].n === 0
    );
    }
  } finally {
    await db.query(`DROP SCHEMA ${SCHEMA} CASCADE`).catch(() => {});
    await db.end();
  }

  console.log(male ? `\n❌ ${male} controlli falliti` : "\n✅ il push sul database funziona");
  process.exit(male ? 1 : 0);
})().catch((e) => {
  console.error("❌", e);
  process.exit(1);
});
