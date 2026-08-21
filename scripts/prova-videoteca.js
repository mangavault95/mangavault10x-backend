// Prova del provider degli anime, senza toccare il database.
//
// Legge davvero da AnimeClick e stampa quello che finirebbe nelle
// tabelle della Videoteca: serve a vedere con gli occhi se l'italiano
// arriva tutto e se i numeri tornano, prima di scrivere una riga.
//
// Uso:
//   node scripts/prova-videoteca.js
//   node scripts/prova-videoteca.js "Berserk" "Blue Lock"
//
// L'ultima parte controlla che la ricerca dei MANGA continui a
// funzionare: `cerca` adesso prende un tipo, e il percorso vecchio non
// deve essersene accorto.

const ac = require("../services/providers/animeclickAnime");
const { cerca } = require("../services/providers/animeclick");

const TITOLI_PREDEFINITI = ["Frieren", "L'attacco dei giganti", "Chainsaw Man"];

const pausa = (ms) => new Promise((r) => setTimeout(r, ms));

function riga(etichetta, valore) {
  console.log(`   ${etichetta.padEnd(20)} ${valore ?? "—"}`);
}

async function provaTitolo(titolo) {
  console.log(`\n══ ${titolo}`);

  const candidati = await ac.cercaAnime(titolo, { quanti: 3 });

  if (!candidati.length) {
    console.log("   nessun risultato");
    return;
  }

  console.log("   candidati:");
  for (const c of candidati) {
    console.log(`     ${String(c.punteggio).padStart(3)} · ${c.id} · ${c.titolo}${c.anno ? ` (${c.anno})` : ""}`);
  }

  const scelto = candidati[0];
  await pausa(1000);

  const s = await ac.scheda(scelto.id);

  console.log("   scheda:");
  riga("titolo", s.titolo);
  riga("originale", s.titolo_originale);
  riga("tipo", s.tipo);
  riga("anni", [s.anno_inizio, s.anno_fine].filter(Boolean).join(" – "));
  riga("episodi", `${s.episodi_totali} (dichiarati: ${s.episodi_dichiarati})`);
  riga("stato", s.stato);
  riga("stato in Italia", s.stato_italia);
  riga("generi", s.generi.join(", "));
  riga("dove si vede", s.distributori.join(", "));
  riga("copertina", s.cover_url ? "sì" : "NO");
  riga("trama", s.trama ? `${s.trama.slice(0, 90)}…` : "NO");

  await pausa(1000);

  const puntate = await ac.episodi(scelto.id);
  const senzaTitolo = puntate.filter((p) => !p.titolo).length;

  console.log("   episodi:");
  riga("letti", `${puntate.length}${senzaTitolo ? ` (senza titolo: ${senzaTitolo})` : ""}`);
  if (puntate.length) {
    riga("primo", `${puntate[0].numero}. ${puntate[0].titolo}`);
    riga("ultimo", `${puntate.at(-1).numero}. ${puntate.at(-1).titolo}`);
  }

  // Il controllo che conta davvero: nessuna parola inglese di servizio
  // deve essere entrata al posto dell'italiano.
  // "Fantasy" non è nella lista: in italiano quel genere si chiama
  // proprio così, e segnalarlo sarebbe un falso allarme a ogni serie.
  const sospetti = [s.stato_italia, ...s.generi].filter((t) =>
    /\b(ongoing|finished|completed|airing|action|comedy|adventure|supernatural|romance)\b/i.test(t || "")
  );

  if (sospetti.length) console.log("   ⚠ testo non italiano:", sospetti.join(", "));
}

async function provaCalendario() {
  console.log("\n══ Calendario delle uscite in Italia");

  const uscite = await ac.calendario();

  console.log(`   ${uscite.length} uscite lette`);

  for (const u of uscite.slice(0, 6)) {
    const quando = u.quando.toLocaleString("it-IT", {
      timeZone: "Europe/Rome",
      weekday: "short", day: "2-digit", month: "short",
      hour: "2-digit", minute: "2-digit"
    });

    console.log(`   ${quando}  ${String(u.piattaforma || "?").padEnd(14)} ep ${String(u.numero ?? "?").padStart(3)} · ${u.serie || "?"} — ${u.titolo || ""}`);
  }
}

async function provaCheIManganonSianoRotti() {
  console.log("\n══ Controllo: la ricerca dei manga funziona ancora");

  const trovati = await cerca("Berserk", { quanti: 2 });

  for (const t of trovati) {
    console.log(`   ${t.id} · ${t.titolo} · ${t.url}`);
  }

  const rotti = trovati.filter((t) => !t.url.includes("/manga/"));

  console.log(rotti.length ? "   ⚠ QUALCOSA SI È ROTTO" : "   ✓ i manga puntano ancora a /manga/");
}

(async () => {
  const titoli = process.argv.slice(2).length ? process.argv.slice(2) : TITOLI_PREDEFINITI;

  for (const titolo of titoli) {
    try {
      await provaTitolo(titolo);
    } catch (e) {
      console.log("   ERRORE:", e.message);
    }
    await pausa(1500);
  }

  try {
    await provaCalendario();
  } catch (e) {
    console.log("   ERRORE calendario:", e.message);
  }

  await pausa(1500);

  try {
    await provaCheIManganonSianoRotti();
  } catch (e) {
    console.log("   ERRORE manga:", e.message);
  }
})();
