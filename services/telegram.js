/**
 * Parlare con Telegram — il minimo indispensabile, senza librerie.
 *
 * Le chiamate che servono sono POST con un JSON dentro, e una
 * dipendenza in meno è un aggiornamento in meno da rincorrere. È la
 * stessa scelta fatta in `mangavault10x-bot/src/telegram.js`, e questo
 * file gli somiglia apposta: chi ha letto quello sa già leggere questo.
 *
 * ⚠️ Una differenza che conta. Là `chiama` inghiotte gli errori,
 * perché quando Telegram rifiuta un messaggio l'acquisto è già
 * scritto e far fallire la richiesta significherebbe registrarlo due
 * volte. Qui è l'opposto: se un avviso non parte dobbiamo SAPERLO,
 * perché la riga in `avvisi_uscite` è già stata scritta e va tolta,
 * o quella puntata non verrebbe annunciata mai più.
 */

const TIMEOUT = 12000;

/** Il bot delle uscite. Vuoto = gli avvisi sono spenti, e va detto. */
function gettone() {
  return process.env.TELEGRAM_USCITE_TOKEN || "";
}

function configurato() {
  return Boolean(gettone());
}

async function chiama(metodo, corpo = {}) {
  if (!configurato()) {
    return { ok: false, descrizione: "TELEGRAM_USCITE_TOKEN non configurato" };
  }

  try {
    const risposta = await fetch(`https://api.telegram.org/bot${gettone()}/${metodo}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(corpo),
      signal: AbortSignal.timeout(TIMEOUT)
    });

    const json = await risposta.json().catch(() => ({}));

    if (!json.ok) {
      return {
        ok: false,
        descrizione: json.description || `HTTP ${risposta.status}`,
        codice: json.error_code || risposta.status
      };
    }

    return { ok: true, risultato: json.result };
  } catch (err) {
    // Rete caduta o dodici secondi passati: è un guasto nostro, non un
    // rifiuto di Telegram, e va distinto perché si può riprovare.
    return { ok: false, descrizione: err.message, codice: null };
  }
}

/**
 * Il testo viaggia in HTML: quello che arriva da fuori va disinnescato.
 *
 * I titoli degli episodi vengono da AnimeClick, cioè da fuori, e uno
 * con dentro un `<` romperebbe il messaggio — Telegram risponde
 * "can't parse entities" e l'avviso non parte affatto.
 */
function esc(testo) {
  return String(testo ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Manda un messaggio.
 *
 * `silenzioso` non lo trattiene: arriva lo stesso, ma senza far suonare
 * il telefono. È per le puntate dell'una di notte, che esistono.
 */
function invia(chatId, testo, { silenzioso = false, anteprima = false } = {}) {
  return chiama("sendMessage", {
    chat_id: chatId,
    text: testo,
    parse_mode: "HTML",
    disable_notification: silenzioso,
    link_preview_options: { is_disabled: !anteprima }
  });
}

/**
 * Chi ha scritto al bot.
 *
 * Serve a una cosa sola: leggere l'identificativo di chat di chi ha
 * appena premuto Start, per poterlo collegare a un utente. Non è un
 * ascolto — non c'è nessun webhook, e queste righe le legge una
 * persona da riga di comando.
 *
 * ⚠️ Telegram tiene gli aggiornamenti 24 ore e basta. Chi ha premuto
 * Start l'altro ieri qui non compare più: deve riscrivere qualcosa.
 */
function aggiornamenti() {
  return chiama("getUpdates", { timeout: 0, allowed_updates: ["message"] });
}

/** Chi è questo bot: la prova che il token è quello giusto. */
function chiSono() {
  return chiama("getMe");
}

module.exports = { aggiornamenti, chiSono, configurato, esc, invia };
