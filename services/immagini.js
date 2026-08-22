/**
 * Le immagini che arrivano dal browser.
 *
 * Facce e striscioni viaggiano come data URI dentro il JSON — non
 * come `multipart/form-data` — e la ragione è che qui non si carica
 * mai un file così com'è: il browser lo ridimensiona e lo riscrive in
 * WebP prima di mandarlo (`dati/immagini.js` di là). Quello che parte
 * non è più il file scelto, è un'immagine costruita dal codice, e
 * spedirla come testo evita di aggiungere una libreria di parsing per
 * un caso che non esiste.
 *
 * Questo file fa due cose sole: riconoscere un data URI valido e
 * rifiutare tutto il resto. Vale la pena essere pignoli, perché è
 * l'unico punto del sito in cui qualcuno manda dei byte che poi
 * verranno serviti ad altri.
 */

// Solo tre formati, e nessuno di questi può contenere codice.
//
// ⚠️ SVG NON C'È, ed è la riga più importante del file: un SVG è un
// documento XML che può contenere `<script>`, e servirlo dal nostro
// dominio significherebbe lasciar eseguire codice altrui su un
// indirizzo che ha in mano i token di tutti. Un'immagine di profilo
// non ha nessun bisogno di essere vettoriale.
const TIPI = new Set(["image/webp", "image/jpeg", "image/png"]);

// I primi byte di ogni formato. Il tipo dichiarato nel data URI lo
// scrive chi manda, quindi non è una prova di niente: questa lo è.
const FIRME = [
  { tipo: "image/webp", prova: (b) => b.length > 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP" },
  { tipo: "image/jpeg", prova: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { tipo: "image/png", prova: (b) => b.length > 8 && b.toString("hex", 0, 8) === "89504e470d0a1a0a" }
];

const FORMA = /^data:([a-z]+\/[a-z0-9+.-]+);base64,([A-Za-z0-9+/=\s]+)$/i;

/**
 * Da data URI a byte, o un errore da dire a voce alta.
 *
 * Restituisce `{ dati, tipo }` oppure `{ errore }`: chi chiama non
 * deve distinguere fra un'eccezione e un rifiuto, perché qui il
 * rifiuto è il caso normale — è così che si comporta davanti a una
 * richiesta storta.
 */
function decodifica(grezzo, { massimo }) {
  const testo = String(grezzo || "");
  const pezzi = FORMA.exec(testo);

  if (!pezzi) return { errore: "Non è un'immagine" };

  const dichiarato = pezzi[1].toLowerCase();

  if (!TIPI.has(dichiarato)) {
    return { errore: "Servono JPEG, PNG o WebP" };
  }

  // Il tetto si controlla PRIMA di decodificare: base64 cresce di un
  // terzo, quindi da qui si sa già quanto pesano i byte veri, e non ha
  // senso allocarli per poi buttarli via.
  const stimati = Math.floor((pezzi[2].replace(/\s/g, "").length * 3) / 4);

  if (stimati > massimo) {
    return { errore: `L'immagine supera ${Math.round(massimo / 1024)} kB` };
  }

  let dati;

  try {
    dati = Buffer.from(pezzi[2], "base64");
  } catch {
    return { errore: "Immagine illeggibile" };
  }

  if (dati.length === 0) return { errore: "Immagine vuota" };
  if (dati.length > massimo) return { errore: "Immagine troppo grande" };

  // Il tipo vero, letto dai byte. Se non combacia con quello
  // dichiarato vince il file: chi ha scritto l'intestazione può aver
  // mentito, i primi quattro byte no.
  const vero = FIRME.find((f) => f.prova(dati));

  if (!vero) return { errore: "Il file non è un'immagine" };

  return { dati, tipo: vero.tipo };
}

/**
 * Le intestazioni con cui si serve un'immagine di profilo.
 *
 * Un anno di cache e `immutable`, che sembra troppo e invece è
 * esattamente giusto: l'indirizzo porta con sé il momento in cui
 * l'immagine è stata messa (`?v=…`), quindi quel preciso indirizzo
 * non cambierà mai contenuto. Quando qualcuno cambia faccia cambia
 * l'indirizzo, e il browser va a prenderla perché è un'altra cosa.
 *
 * L'ETag resta come rete per i casi in cui il `v` non c'è.
 */
function intestazioni(dati, tipo, quando) {
  return {
    "Content-Type": tipo,
    "Content-Length": dati.length,
    "Cache-Control": "public, max-age=31536000, immutable",
    ETag: `"${quando ? new Date(quando).getTime() : dati.length}-${dati.length}"`
  };
}

module.exports = { decodifica, intestazioni, TIPI };
