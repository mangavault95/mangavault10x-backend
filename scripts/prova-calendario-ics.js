// Prove del calendario .ics (nessun database).   node scripts/prova-calendario-ics.js
const { costruisciCalendario, protetto, piegata } = require("../services/calendarioIcs");

let falliti = 0;
function prova(nome, ok, dettaglio = "") {
  console.log(`  ${ok ? "ok  " : "NO  "} ${nome}`);
  if (!ok) { falliti += 1; if (dettaglio) console.log(`       ${dettaglio}`); }
}

const adesso = new Date("2026-11-14T10:00:00Z");
const ics = costruisciCalendario({
  adesso,
  uscite: [
    { data: "2026-11-20", numero: 12, editore: "Panini, Planet", stato: "prossimo", mancanti: 0,
      serie: { id: 7, titolo: "Berserk; Deluxe", prezzo_stimato: 6.5 } },
    { data: "2026-11-21", numero: 3, stato: "gia", mancanti: 0, serie: { id: 8, titolo: "Già mio", prezzo_stimato: null } },
    { data: "2026-11-22", numero: 1, stato: null, serie: null, serieNome: "Non mia" }
  ],
  episodi: [{ anime_id: 5, numero: 4, uscita_italia: "2026-11-15T17:30:00Z", piattaforma: "Crunchyroll", serie: "Frieren" }]
});

console.log("\nIl file iCalendar");
prova("inizia e finisce come un calendario, con CRLF", ics.startsWith("BEGIN:VCALENDAR\r\n") && ics.endsWith("END:VCALENDAR\r\n"));
prova("niente a capo senza CR", !/[^\r]\n/.test(ics));
prova("il volume in uscita è un evento tutto il giorno", ics.includes("DTSTART;VALUE=DATE:20261120") && ics.includes("DTEND;VALUE=DATE:20261121"));
prova("il titolo protegge il punto e virgola", ics.includes("SUMMARY:📚 Berserk\; Deluxe 12"));
prova("la descrizione protegge la virgola", ics.includes("Editore: Panini\\, Planet."));
prova("un volume già in casa non genera eventi", !ics.includes("Già mio"));
prova("un'uscita non in collezione non genera eventi", !ics.includes("Non mia"));
prova("la puntata ha ora precisa in UTC e dura mezz'ora", ics.includes("DTSTART:20261115T173000Z") && ics.includes("DTEND:20261115T180000Z"));
prova("due eventi in tutto", (ics.match(/BEGIN:VEVENT/g) || []).length === 2);
prova("gli UID sono stabili fra due richieste", costruisciCalendario({ adesso, uscite: [{ data: "2026-11-20", numero: 12, stato: "prossimo", mancanti: 0, serie: { id: 7, titolo: "x" } }] }).match(/UID:.*/)[0] ===
  costruisciCalendario({ adesso: new Date(), uscite: [{ data: "2026-11-20", numero: 12, stato: "prossimo", mancanti: 0, serie: { id: 7, titolo: "x" } }] }).match(/UID:.*/)[0]);

console.log("\nLe righe lunghe");
const lunga = piegata("SUMMARY:" + "è".repeat(60));
prova("nessuna riga supera 75 byte", lunga.split("\r\n").every((r) => Buffer.byteLength(r) <= 75));
prova("la riga piegata si ricompone", lunga.replace(/\r\n /g, "") === "SUMMARY:" + "è".repeat(60));
prova("un testo con a capo e barra si protegge", protetto("a\nb\\c") === "a\\nb\\\\c");

if (falliti) { console.log(`\n${falliti} prove fallite`); process.exit(1); }
console.log("\nTutto a posto.");
