/**
 * Le notifiche push dall'app installata.
 *
 * Il browser dà a ogni dispositivo un indirizzo («endpoint») su un servizio del
 * suo produttore (Apple, Google, Mozilla); noi gli mandiamo un messaggio
 * cifrato, firmato con le nostre chiavi VAPID, e il servizio lo consegna anche
 * a app chiusa. Qui c'è solo questo: le chiavi, la regola su CHI può iscriversi,
 * e la consegna. Cosa dire e a chi lo decide `services/avvisi.js`.
 *
 * ------------------------------------------------------------
 * SPENTO SE MANCANO LE CHIAVI
 *
 * `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` e `VAPID_SUBJECT` (un `mailto:` o un
 * indirizzo https) vengono dall'ambiente. Senza, `configurato()` è falso e le
 * rotte rispondono «push non attivo»: il resto del sito non se ne accorge. Si
 * generano con `npx web-push generate-vapid-keys`; la chiave PRIVATA non va mai
 * nel repository.
 *
 * ------------------------------------------------------------
 * ⚠️ CHI PUÒ DARCI UN INDIRIZZO
 *
 * L'indirizzo lo scrive chi si iscrive, e poi è IL SERVER a fare una richiesta
 * lì sopra. Senza un freno sarebbe un modo di far chiamare al backend qualunque
 * indirizzo (anche interno). Per questo si accettano solo i servizi push veri,
 * per nome di host, in https: `indirizzoAmmesso`.
 */

const webpush = require("web-push");

const PUBBLICA = process.env.VAPID_PUBLIC_KEY || "";
const PRIVATA = process.env.VAPID_PRIVATE_KEY || "";
const SOGGETTO = process.env.VAPID_SUBJECT || "";

let pronto = false;

function configurato() {
  return Boolean(PUBBLICA && PRIVATA && SOGGETTO);
}

function prepara() {
  if (pronto || !configurato()) return;

  webpush.setVapidDetails(SOGGETTO, PUBBLICA, PRIVATA);
  pronto = true;
}

const chiavePubblica = () => (configurato() ? PUBBLICA : null);

/**
 * I servizi push dei browser, per nome di host.
 *
 * Apple: `web.push.apple.com` (e sottodomini `*.push.apple.com`); Google:
 * `fcm.googleapis.com`; Mozilla: `updates.push.services.mozilla.com`; Edge:
 * `*.notify.windows.com`. Un host nuovo si aggiunge qui, a mano.
 */
const HOST_ESATTI = new Set(["fcm.googleapis.com", "updates.push.services.mozilla.com"]);
const HOST_CON_SUFFISSO = [".push.apple.com", ".notify.windows.com"];

function indirizzoAmmesso(endpoint) {
  let url;

  try {
    url = new URL(String(endpoint));
  } catch {
    return false;
  }

  if (url.protocol !== "https:" || url.port || url.username || url.password) return false;

  const host = url.hostname.toLowerCase();

  return (
    HOST_ESATTI.has(host) ||
    host === "web.push.apple.com" ||
    HOST_CON_SUFFISSO.some((suffisso) => host.endsWith(suffisso))
  );
}

const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/;

/**
 * Una sottoscrizione com'è arrivata dal browser (`PushSubscription.toJSON()`),
 * ridotta a quello che serve, o `null` se non regge.
 */
function leggiSottoscrizione(corpo) {
  const endpoint = String(corpo?.endpoint || "");
  const p256dh = String(corpo?.keys?.p256dh || "");
  const auth = String(corpo?.keys?.auth || "");

  if (endpoint.length > 1000 || !indirizzoAmmesso(endpoint)) return null;
  if (!p256dh || p256dh.length > 200 || !BASE64URL.test(p256dh)) return null;
  if (!auth || auth.length > 100 || !BASE64URL.test(auth)) return null;

  return { endpoint, p256dh, auth };
}

/**
 * Manda un messaggio a UNA sottoscrizione.
 *
 * `{ ok: true }`, oppure `{ ok: false, scaduta: true }` se il servizio dice che
 * quell'indirizzo non esiste più (404/410: l'app è stata disinstallata o i
 * permessi tolti) — e quella riga va cancellata — oppure `{ ok: false }` per un
 * guasto che passa da solo.
 *
 * `urgenza` "low" è per la notte: il servizio può consegnare senza svegliare.
 */
async function invia(sottoscrizione, messaggio, { urgenza = "normal" } = {}) {
  if (!configurato()) return { ok: false, errore: "push non attivo" };

  prepara();

  try {
    await webpush.sendNotification(
      {
        endpoint: sottoscrizione.endpoint,
        keys: { p256dh: sottoscrizione.p256dh, auth: sottoscrizione.auth }
      },
      JSON.stringify(messaggio),
      { TTL: 60 * 60 * 12, urgency: urgenza, timeout: 15000 }
    );

    return { ok: true };
  } catch (err) {
    const stato = err?.statusCode;

    return { ok: false, scaduta: stato === 404 || stato === 410, errore: `HTTP ${stato || "?"} ${err?.message || ""}`.trim() };
  }
}

/** Quanti dispositivi al massimo per persona: un tappo, non una politica. */
const MASSIMO_PER_PERSONA = 10;

/**
 * Manda lo stesso messaggio a tutti i dispositivi di una persona.
 * Ripulisce da sola le sottoscrizioni scadute.
 *
 * Restituisce quanti dispositivi hanno ricevuto il messaggio.
 */
async function inviaAPersona(pool, utenteId, messaggio, opzioni = {}) {
  const { rows } = await pool.query(
    `SELECT id, endpoint, p256dh, auth FROM push_sottoscrizioni WHERE utente_id = $1`,
    [utenteId]
  );

  let consegnati = 0;
  const scadute = [];

  for (const riga of rows) {
    const esito = await invia(riga, messaggio, opzioni);

    if (esito.ok) consegnati++;
    else if (esito.scaduta) scadute.push(riga.id);
    else console.error(`🔔 Push non partito (utente ${utenteId}):`, esito.errore);
  }

  if (consegnati > 0) {
    await pool.query(`UPDATE push_sottoscrizioni SET ultimo_invio_il = NOW() WHERE utente_id = $1`, [utenteId]);
  }

  if (scadute.length > 0) {
    await pool.query(`DELETE FROM push_sottoscrizioni WHERE id = ANY($1::bigint[])`, [scadute]);
  }

  return consegnati;
}

module.exports = {
  configurato,
  chiavePubblica,
  indirizzoAmmesso,
  leggiSottoscrizione,
  invia,
  inviaAPersona,
  MASSIMO_PER_PERSONA
};
