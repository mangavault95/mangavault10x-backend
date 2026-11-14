// services/avvisoProprietario.js
//
// Un messaggio Telegram al proprietario, se ha collegato la chat. Non fa mai fallire chi
// lo chiama: un avviso che non parte non deve rompere il lavoro che lo ha generato.

async function avvisaProprietario(pool, testo) {
  try {
    const telegram = require("./telegram");

    if (!telegram.configurato?.()) return false;

    const { rows } = await pool.query(
      `SELECT telegram_chat_id FROM utenti WHERE proprietario AND stato = 'attivo' AND telegram_chat_id IS NOT NULL LIMIT 1`
    );

    if (!rows[0]) return false;

    return Boolean((await telegram.invia(rows[0].telegram_chat_id, testo))?.ok);
  } catch (err) {
    console.warn("Avviso al proprietario non inviato:", err.message);
    return false;
  }
}

module.exports = { avvisaProprietario };
