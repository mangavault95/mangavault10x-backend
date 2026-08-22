const { requireAuth } = require("./auth");
const { haBiblioteca, idProprietario, utenteLetto, utenteScrive } = require("./utenti");

/**
 * La porta della biblioteca.
 *
 * Da quando le registrazioni valgono per la videoteca (migrazione
 * 018), il sito ha due stanze con due regole diverse:
 *
 *   VIDEOTECA   chi entra ce l'ha sua: le sue serie, le sue spunte,
 *               i suoi commenti. È quello che la registrazione compra.
 *
 *   BIBLIOTECA  è di casa. Ci si sta in due, e chi altro può entrarci
 *               lo decide il proprietario a mano. Gli altri la vedono
 *               — tutta, com'è sempre stato per chi passa senza
 *               entrare — ma quello che vedono è la biblioteca del
 *               proprietario, e non ci lasciano niente.
 *
 * Qui dentro c'è solo quella regola, applicata alle richieste. Il
 * "chi ce l'ha" sta in `utenti.js` insieme alle altre cose che si
 * sanno di una persona.
 *
 * Tre funzioni, che sono le tre domande che una rotta può fare:
 *
 *   lettoreBiblioteca(req)   di chi sono i dati che vado a leggere
 *   richiediBiblioteca       middleware: di qua non passa chi non è di casa
 *   scriveInBiblioteca(req)  chi sta scrivendo, dopo il middleware
 */

/**
 * Di chi sono i dati personali della biblioteca che questa richiesta
 * vuole leggere.
 *
 * Parte dalla regola di sempre (`?utente=`, poi il token, poi il
 * proprietario) e aggiunge l'unica cosa nuova: se la persona che ne
 * viene fuori una biblioteca sua non ce l'ha, si legge quella del
 * proprietario.
 *
 * Vale anche per il numero nell'indirizzo, e non è un dettaglio: `?utente=7`
 * dove 7 è qualcuno che in biblioteca non ha niente darebbe una
 * cronologia vuota, cioè una pagina che sembra rotta invece di una
 * pagina che dice le cose di casa.
 */
async function lettoreBiblioteca(req) {
  const chiesto = await utenteLetto(req);

  if (await haBiblioteca(chiesto)) return chiesto;

  return idProprietario();
}

/**
 * Chi sta scrivendo in biblioteca.
 *
 * Da usare solo dopo `richiediBiblioteca`: è lui che ha già detto di
 * sì. Qui si risponde soltanto alla domanda "sotto quale nome va
 * questa riga", che è la stessa di sempre.
 */
const scriveInBiblioteca = (req) => utenteScrive(req);

/**
 * Di qua non passa chi in biblioteca sta solo guardando.
 *
 * Il permesso si chiede al database e NON al token: i token durano
 * trenta giorni, e uno firmato prima che il proprietario aprisse la
 * porta continuerebbe a dire di no per un mese.
 *
 * Il `motivo` nella risposta serve al browser: un 403 senza altro è
 * "il tuo accesso è scaduto, rientra", e chi ha il token buono
 * finirebbe davanti a un modulo che non risolve niente. Con questo
 * invece si può dire la cosa vera — la biblioteca è di casa, la
 * videoteca è tua.
 */
function richiediBiblioteca(req, res, next) {
  return requireAuth(req, res, async () => {
    try {
      // Il proprietario non si controlla: la sua riga potrebbe non
      // esserci ancora (vedi `accessoDiRipiego`), e il token che lo
      // dice l'ha firmato il server.
      if (req.user?.proprietario) return next();

      const id = await utenteScrive(req);

      if (await haBiblioteca(id)) return next();

      return res.status(403).json({
        motivo: "biblioteca",
        error:
          "La biblioteca è di casa: di qua si può guardare, non scrivere. La videoteca invece è tua."
      });
    } catch (err) {
      console.error("❌ PERMESSO BIBLIOTECA ERROR:", err);

      return res.status(500).json({ error: "Errore server" });
    }
  });
}

module.exports = {
  lettoreBiblioteca,
  scriveInBiblioteca,
  richiediBiblioteca
};
