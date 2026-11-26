/**
 * `?utente=` non è più aperto a tutti.
 *
 * Senza database: `idProprietario` legge il pool, e qui il pool risponde
 * sempre «il proprietario è il 1». Le domande sono quelle che fa una rotta:
 * di chi sono i dati che questa richiesta vuole leggere?
 */

const assert = require("assert");
const pool = require("../db");

pool.query = async () => ({ rows: [{ id: 1, nickname: "padrone" }] });

const { utenteLetto } = require("../services/utenti");

const richiesta = (query, user) => ({ query, user });

const casi = [
  ["senza accesso, ?utente=7 → il proprietario", richiesta({ utente: "7" }, null), undefined, 1],
  ["senza accesso, ?utente=7 e token vecchio assente → il proprietario", richiesta({ utente: "7" }, undefined), undefined, 1],
  ["senza accesso e senza ?utente= → il proprietario", richiesta({}, null), undefined, 1],
  ["entrato come 3, ?utente=7 → 7 (la pagina di un altro)", richiesta({ utente: "7" }, { id: 3 }), undefined, 7],
  ["entrato come 3, senza ?utente= → 3", richiesta({}, { id: 3 }), undefined, 3],
  ["entrato come 3, ?utente=abc → 3", richiesta({ utente: "abc" }, { id: 3 }), undefined, 3],
  ["token vecchio senza id (proprietario), ?utente=7 → 7", richiesta({ utente: "7" }, { proprietario: true }), undefined, 7],
  ["feed del calendario (fidato), ?utente=7 → 7", richiesta({ utente: "7" }, null), { fidato: true }, 7],
  ["feed del calendario (fidato), senza ?utente= → il proprietario", richiesta({}, null), { fidato: true }, 1]
];

(async () => {
  for (const [nome, req, opzioni, atteso] of casi) {
    assert.strictEqual(await utenteLetto(req, opzioni), atteso, nome);
    console.log(`✅ ${nome}`);
  }

  console.log("\n✅ ?utente= vale solo per chi è entrato");
  process.exit(0);
})().catch((e) => {
  console.error("❌", e.message);
  process.exit(1);
});
