// services/rete.js
//
// Quanti proxy stanno davanti al server, per `app.set("trust proxy", N)`.
// Sta qui e non dentro index.js perché index.js parte appena lo si
// richiede, e così non si poteva provare.
//
// Il motivo del numero (e non di `true`) è scritto in index.js.

const PREDEFINITO = 1;

/** TRUST_PROXY → numero di passaggi fidati; ciò che non è un intero ≥ 0 vale 1. */
function saltiFidati(valore) {
  if (valore === undefined || valore === "") return PREDEFINITO;

  const n = Number(valore);

  return Number.isInteger(n) && n >= 0 ? n : PREDEFINITO;
}

module.exports = { saltiFidati, PREDEFINITO };
