// services/calendarioIcs.js
//
// Il calendario delle uscite in formato iCalendar (.ics), da aggiungere al
// Calendario dell'iPhone come «calendario con abbonamento»: il telefono lo
// richiede da solo ogni tanto, e le uscite delle vostre serie compaiono senza
// installare niente.
//
// Questo file non tocca il database: riceve le uscite già pronte e scrive il testo.
// Le regole del formato che contano (RFC 5545):
//   - le righe finiscono con CRLF e non superano 75 byte: oltre, si va a capo
//     con uno spazio davanti;
//   - `\`, `;`, `,` e a capo dentro un testo vanno protetti;
//   - un'uscita di manga è un evento «tutto il giorno» (`VALUE=DATE`, e la fine è
//     il giorno dopo), una puntata anime ha un'ora precisa, scritta in UTC.

const crypto = require("crypto");

function protetto(testo) {
  return String(testo ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/** Spezza una riga a 75 byte (non a metà di un carattere), come chiede il formato. */
function piegata(riga) {
  const byte = Buffer.from(riga, "utf8");

  if (byte.length <= 75) return riga;

  const pezzi = [];
  let corrente = "";
  let lunghezza = 0;
  let limite = 75;

  for (const carattere of riga) {
    const l = Buffer.byteLength(carattere, "utf8");

    if (lunghezza + l > limite) {
      pezzi.push(corrente);
      corrente = "";
      lunghezza = 1; // lo spazio iniziale della riga che continua
      limite = 75;
    }

    corrente += carattere;
    lunghezza += l;
  }

  pezzi.push(corrente);

  return pezzi.join("\r\n ");
}

const giornoCompatto = (aaaaMmGg) => String(aaaaMmGg).slice(0, 10).replace(/-/g, "");

function giornoDopo(aaaaMmGg) {
  const d = new Date(`${String(aaaaMmGg).slice(0, 10)}T00:00:00Z`);

  d.setUTCDate(d.getUTCDate() + 1);

  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

const istante = (data) => new Date(data).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

function identificativo(tipo, ...parti) {
  const impronta = crypto.createHash("sha1").update(parti.join("|")).digest("hex").slice(0, 20);

  return `${tipo}-${impronta}@mangavault`;
}

/** Un volume in uscita (forma di `usciteTra`). I volumi che avete già non hanno bisogno di un promemoria. */
function eventoManga(uscita, ora) {
  if (!uscita.serie || uscita.stato === "gia") return null;

  const titolo = `${uscita.serie.titolo} ${uscita.numero}`;
  const note = [];

  if (uscita.stato === "prossimo") note.push("È il prossimo volume per voi.");
  if (uscita.stato === "manca") note.push(`Prima ne mancano ${uscita.mancanti}.`);
  if (uscita.editore) note.push(`Editore: ${uscita.editore}.`);
  if (uscita.serie.prezzo_stimato != null) note.push(`Prezzo stimato: ${uscita.serie.prezzo_stimato} €.`);

  return [
    "BEGIN:VEVENT",
    `UID:${identificativo("manga", uscita.serie.id, uscita.numero)}`,
    `DTSTAMP:${ora}`,
    `DTSTART;VALUE=DATE:${giornoCompatto(uscita.data)}`,
    `DTEND;VALUE=DATE:${giornoDopo(uscita.data)}`,
    `SUMMARY:${protetto(`📚 ${titolo}`)}`,
    note.length ? `DESCRIPTION:${protetto(note.join(" "))}` : null,
    "TRANSP:TRANSPARENT",
    "END:VEVENT"
  ].filter(Boolean);
}

/** Una puntata anime (forma delle righe di `anime_episodi` con `serie`, `numero`, `uscita_italia`). */
function eventoAnime(episodio, ora) {
  const inizio = new Date(episodio.uscita_italia);

  if (Number.isNaN(inizio.getTime())) return null;

  const fine = new Date(inizio.getTime() + 30 * 60 * 1000);
  const titolo = `${episodio.serie} ep. ${episodio.numero}`;

  return [
    "BEGIN:VEVENT",
    `UID:${identificativo("anime", episodio.anime_id, episodio.numero)}`,
    `DTSTAMP:${ora}`,
    `DTSTART:${istante(inizio)}`,
    `DTEND:${istante(fine)}`,
    `SUMMARY:${protetto(`📺 ${titolo}`)}`,
    episodio.piattaforma ? `DESCRIPTION:${protetto(`Su ${episodio.piattaforma}.`)}` : null,
    "TRANSP:TRANSPARENT",
    "END:VEVENT"
  ].filter(Boolean);
}

/**
 * @param {{uscite?: object[], episodi?: object[], adesso?: Date}} dati
 * @returns {string} il file .ics, con le righe terminate da CRLF
 */
function costruisciCalendario({ uscite = [], episodi = [], adesso = new Date() } = {}) {
  const ora = istante(adesso);

  const righe = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//MangaVault//Uscite//IT",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:MangaVault, uscite",
    "X-WR-TIMEZONE:Europe/Rome",
    // Ogni sei ore il telefono può richiederlo: le uscite cambiano di rado.
    "REFRESH-INTERVAL;VALUE=DURATION:PT6H",
    "X-PUBLISHED-TTL:PT6H"
  ];

  for (const u of uscite) righe.push(...(eventoManga(u, ora) || []));
  for (const e of episodi) righe.push(...(eventoAnime(e, ora) || []));

  righe.push("END:VCALENDAR");

  return righe.map(piegata).join("\r\n") + "\r\n";
}

module.exports = { costruisciCalendario, protetto, piegata };
