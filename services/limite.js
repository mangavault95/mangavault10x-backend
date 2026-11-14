// services/limite.js
//
// Un tetto alle richieste, tenuto in memoria.
//
// Serve a due cose diverse, e conviene non confonderle:
//
//   - le porte d'ingresso (login, registrazione): chi prova password a
//     raffica deve trovarsi fermo dopo pochi tentativi;
//   - le rotte aperte che fanno lavorare il server PER CONTO di altri
//     (AnimeClick, eBay, il traduttore): chi trova l'indirizzo non
//     deve poterci far martellare un sito che ci ospita per cortesia,
//     né consumare una quota giornaliera che è di tutti.
//
// In memoria e non in tabella perché il server è uno solo: un riavvio
// azzera i conti, ed è un prezzo che per due lettori si paga volentieri
// in cambio di non avere una dipendenza e una tabella in più.
//
// Sulla CHIAVE: è l'indirizzo che Express vede (`req.ip`). Dietro il
// proxy di Render può essere quello del proxy invece di quello del
// visitatore, e allora il tetto «per indirizzo» diventa di fatto un
// tetto per tutti. Va bene lo stesso: per questo ogni limite ha anche
// un tetto GLOBALE dichiarato, che è quello che protegge davvero.

const TETTO_CHIAVI = 5000;

/**
 * @param {object} o
 * @param {number} o.finestraMs  quanto dura la finestra
 * @param {number} o.massimo     quante richieste per chiave nella finestra
 * @param {number} [o.globale]   quante in tutto, da chiunque (facoltativo)
 * @param {string} [o.messaggio]
 * @param {boolean} [o.soloFallite]  conta solo le risposte 4xx/5xx
 *        (per il login: entrare bene non deve avvicinare al blocco)
 */
function limite({ finestraMs, massimo, globale = null, messaggio, soloFallite = false }) {
  const conti = new Map(); // chiave → { n, scade }
  let tutti = { n: 0, scade: 0 };

  const errore = messaggio || "Troppe richieste. Riprova fra poco.";

  function conto(chiave, adesso) {
    let c = conti.get(chiave);

    if (!c || c.scade <= adesso) {
      // La pulizia si fa quando serve spazio, non con un timer: un
      // timer terrebbe vivo il processo anche negli script di prova.
      if (conti.size >= TETTO_CHIAVI) {
        for (const [k, v] of conti) if (v.scade <= adesso) conti.delete(k);
        if (conti.size >= TETTO_CHIAVI) conti.clear();
      }

      c = { n: 0, scade: adesso + finestraMs };
      conti.set(chiave, c);
    }

    return c;
  }

  return function controlla(req, res, next) {
    const adesso = Date.now();

    if (tutti.scade <= adesso) tutti = { n: 0, scade: adesso + finestraMs };

    const c = conto(req.ip || "?", adesso);

    if (c.n >= massimo || (globale !== null && tutti.n >= globale)) {
      const attesa = Math.max(1, Math.ceil((Math.max(c.scade, tutti.scade) - adesso) / 1000));

      // Una riga sola per blocco, e solo per i blocchi: serve a vedere nei
      // log di Render quale indirizzo il server crede di vedere (`ip`) e
      // cosa ha mandato il proxy (`xff`), per regolare TRUST_PROXY.
      console.warn(`limite: 429 ip=${req.ip} xff=${req.headers?.["x-forwarded-for"] || "-"} ${req.method} ${req.path}`);

      res.set("Retry-After", String(attesa));
      return res.status(429).json({ error: errore });
    }

    if (soloFallite) {
      // Il conto sale a risposta partita, quando si sa com'è andata.
      // Prenoto comunque il posto subito, o dieci richieste lanciate
      // insieme passerebbero tutte prima che la prima abbia risposto.
      c.n += 1;
      tutti.n += 1;

      res.on("finish", () => {
        if (res.statusCode < 400) {
          c.n = Math.max(0, c.n - 1);
          tutti.n = Math.max(0, tutti.n - 1);
        }
      });
    } else {
      c.n += 1;
      tutti.n += 1;
    }

    return next();
  };
}

// Le rotte aperte che chiamano siti di altri. Una scheda di serie ne
// apre due o tre e poi vive di cache: trenta al minuto a testa sono
// molte più di quante ne faccia chi sfoglia davvero.
const limiteFontiEsterne = limite({
  finestraMs: 60 * 1000,
  massimo: 30,
  globale: 90,
  messaggio: "Troppe ricerche in poco tempo. Riprova fra un minuto."
});

module.exports = { limite, limiteFontiEsterne };
