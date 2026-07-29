// Traduzione tramite MyMemory — gratuita, per le aggiunte occasionali.
//
// Due limiti hanno rovinato 66 trame nella versione precedente, ed
// entrambi sono gestiti qui:
//
//   1. Limite di 500 caratteri per richiesta. Superandolo il servizio
//      risponde "QUERY LENGTH LIMIT EXCEEDED", che finiva salvato
//      come trama. Qui il testo viene spezzato in blocchi.
//
//   2. Quota giornaliera esaurita. Il servizio risponde 200 OK con
//      "MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS"
//      dentro il campo della traduzione. Qui viene riconosciuto e
//      scartato: meglio nessuna trama che un messaggio di errore.

const ENDPOINT = "https://api.mymemory.translated.net/get";

// Sotto il limite dichiarato di 500: l'API conta i caratteri codificati.
const MAX_BLOCCO = 450;

// Passare un'email valida alza la quota da 5.000 a 50.000 caratteri
// al giorno. Non serve registrarsi: basta che l'indirizzo esista.
const EMAIL = process.env.MYMEMORY_EMAIL;

function isEnabled() {
  return true; // nessuna chiave richiesta
}

function quotaGiornaliera() {
  return EMAIL ? 50000 : 5000;
}

// Errore dedicato: la quota esaurita non è un guasto, è una pausa.
// Il chiamante deve fermarsi e riprendere domani, non riprovare subito.
class QuotaEsauritaError extends Error {
  constructor() {
    super(
      EMAIL
        ? "MyMemory: esauriti i 50.000 caratteri giornalieri. Riprendi domani."
        : "MyMemory: esauriti i 5.000 caratteri giornalieri. Imposta MYMEMORY_EMAIL per averne 50.000."
    );
    this.name = "QuotaEsauritaError";
    this.quotaEsaurita = true;
  }
}

const RISPOSTE_NON_VALIDE = [
  /mymemory warning/i,
  /all available free translations/i,
  /query length limit exceeded/i,
  /usagelimits\.php/i,
  /mymemory\.translated\.net/i,
  /please contact us/i
];

function rispostaValida(testo) {
  const t = String(testo || "").trim();
  if (!t) return false;
  return !RISPOSTE_NON_VALIDE.some((r) => r.test(t));
}

/**
 * Spezza il testo in blocchi sotto il limite, senza tagliare le frasi
 * a metà: una frase spezzata produce una traduzione senza senso.
 */
function dividiInBlocchi(testo) {
  const frasi = testo.match(/[^.!?]+[.!?]*\s*/g) || [testo];
  const blocchi = [];
  let corrente = "";

  for (const frase of frasi) {
    // Frase singola più lunga del limite: la spezzo sulle parole.
    if (frase.length > MAX_BLOCCO) {
      if (corrente) {
        blocchi.push(corrente.trim());
        corrente = "";
      }

      let resto = frase;
      while (resto.length > MAX_BLOCCO) {
        let taglio = resto.lastIndexOf(" ", MAX_BLOCCO);
        if (taglio <= 0) taglio = MAX_BLOCCO;
        blocchi.push(resto.slice(0, taglio).trim());
        resto = resto.slice(taglio);
      }

      corrente = resto;
      continue;
    }

    if ((corrente + frase).length > MAX_BLOCCO) {
      blocchi.push(corrente.trim());
      corrente = frase;
    } else {
      corrente += frase;
    }
  }

  if (corrente.trim()) blocchi.push(corrente.trim());

  return blocchi.filter(Boolean);
}

async function traduciBlocco(blocco) {
  const params = new URLSearchParams({ q: blocco, langpair: "en|it" });
  if (EMAIL) params.set("de", EMAIL);

  const res = await fetch(`${ENDPOINT}?${params}`);

  if (!res.ok) {
    throw new Error(`MyMemory HTTP ${res.status}`);
  }

  const json = await res.json();
  const tradotto = json?.responseData?.translatedText;

  if (/all available free translations|usagelimits/i.test(String(tradotto))) {
    throw new QuotaEsauritaError();
  }

  if (!rispostaValida(tradotto)) {
    throw new Error("MyMemory: risposta non valida");
  }

  return tradotto.trim();
}

/**
 * @returns {Promise<string|null>} testo tradotto, o null se non affidabile
 */
async function traduciInItaliano(testo) {
  const pulito = String(testo || "").replace(/\s+/g, " ").trim();
  if (pulito.length < 40) return null;

  const blocchi = dividiInBlocchi(pulito);
  const tradotti = [];

  for (const blocco of blocchi) {
    // Un blocco fallito rende l'intera trama incoerente: mi fermo.
    const risultato = await traduciBlocco(blocco);
    tradotti.push(risultato);

    // MyMemory limita anche le richieste al secondo.
    if (blocchi.length > 1) {
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  const finale = tradotti.join(" ").replace(/\s+/g, " ").trim();

  return finale.length >= 40 ? finale : null;
}

module.exports = {
  traduciInItaliano,
  isEnabled,
  quotaGiornaliera,
  QuotaEsauritaError
};
