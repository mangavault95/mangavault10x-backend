// services/segretoCron.js
//
// La guardia per le rotte che chiama uno scheduler (GitHub Actions) invece di
// una persona: un segreto fisso nell'intestazione `X-Cron-Secret`, mai nell'indirizzo.
//
// `timingSafeEqual` e non `===`: il tempo di risposta non deve rivelare quanti
// caratteri del segreto sono giusti. È la stessa regola di `routes/manga.js` e
// `routes/anime.js` (che ne hanno una copia ciascuna): le rotte nuove usano questa.

const crypto = require("crypto");

function richiedeSegretoCron(req, res, next) {
  const atteso = process.env.CRON_SECRET;
  const ricevuto = req.headers["x-cron-secret"] || "";

  if (!atteso) {
    return res.status(500).json({ error: "CRON_SECRET non configurato" });
  }

  const bufAtteso = Buffer.from(atteso);
  const bufRicevuto = Buffer.from(String(ricevuto));

  if (bufAtteso.length !== bufRicevuto.length || !crypto.timingSafeEqual(bufAtteso, bufRicevuto)) {
    return res.status(403).json({ error: "Segreto non valido" });
  }

  return next();
}

module.exports = { richiedeSegretoCron };
