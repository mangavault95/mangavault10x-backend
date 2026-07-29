// Traduzione delle trame in italiano tramite MyMemory.
//
// Vedi translateMyMemory.js per la gestione dei due limiti del
// servizio (500 caratteri per richiesta, quota giornaliera).

const myMemory = require("./translateMyMemory");

function isEnabled() {
  return myMemory.isEnabled();
}

function motoreAttivo() {
  return "mymemory";
}

/**
 * @param {string} testo sinossi in lingua originale
 * @returns {Promise<{testo: string, motore: string}|null>}
 */
async function traduciInItaliano(testo) {
  const risultato = await myMemory.traduciInItaliano(testo);

  return risultato ? { testo: risultato, motore: "mymemory" } : null;
}

module.exports = { traduciInItaliano, isEnabled, motoreAttivo };
