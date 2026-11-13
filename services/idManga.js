// services/idManga.js
//
// Il prossimo identificativo di una serie.
//
// "Manga"."ID" si sceglie a mano (massimo + 1) in tre posti: la
// creazione dal sito, il passaggio dalla wishlist e il bot di Telegram.
// Leggere il massimo e scrivere il successivo sono due passi, e due
// creazioni nello stesso istante leggono lo stesso numero: la seconda
// fallisce sulla chiave primaria e la persona vede un errore per una
// serie che voleva solo aggiungere.
//
// Il lucchetto qui sotto mette in fila chi sta scegliendo un numero.
// Vale fino alla fine della transazione, quindi VA CHIAMATA DENTRO UNA
// TRANSAZIONE, con lo stesso `cliente` che poi fa l'INSERT: fuori non
// tiene niente. Non blocca chi legge o modifica le serie, solo chi ne
// crea un'altra.
//
// ⚠️ gemella: `creaSerie` in mangavault10x-bot/src/collezione.js usa lo
// stesso numero di lucchetto. Cambiato qui, va cambiato là.

const LUCCHETTO_ID_MANGA = 7226501;

async function prossimoIdManga(cliente) {
  await cliente.query("SELECT pg_advisory_xact_lock($1)", [LUCCHETTO_ID_MANGA]);

  const { rows } = await cliente.query(`SELECT COALESCE(MAX("ID"), 0) + 1 AS id FROM "Manga"`);

  return rows[0].id;
}

module.exports = { prossimoIdManga, LUCCHETTO_ID_MANGA };
