// Prove del freno di `prendi`: «se AnimeClick dice 403 o 429, ci si ferma», per qualunque cosa lo chiami.
//
//   node scripts/prova-rifiuto-animeclick.js
//
// Non vuole database né rete: `fetch` è sempre finto. (La parte dei lavori che leggono le pagine
// scaricate da GitHub è in `prova-pagine-animeclick.js`.)

const ac = require("../services/providers/animeclick");

let falliti = 0;

function prova(nome, atteso, ottenuto) {
  const bene = JSON.stringify(atteso) === JSON.stringify(ottenuto);

  console.log(`  ${bene ? "ok  " : "NO  "} ${nome}`);

  if (!bene) {
    falliti += 1;
    console.log(`       atteso:   ${JSON.stringify(atteso)}\n       ottenuto: ${JSON.stringify(ottenuto)}`);
  }
}

const risposta = (status, intestazioni = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => intestazioni[k.toLowerCase()] ?? null },
  text: async () => "<html><body></body></html>"
});

let chiamate = 0;
const finto = (status, intestazioni) => async () => {
  chiamate += 1;
  return risposta(status, intestazioni);
};
const minuti = (d) => Math.round((d.getTime() - Date.now()) / 60000);

(async () => {
  console.log("\nIl freno di prendi");
  ac.azzeraFreno();

  let errore = null;

  try {
    await ac.prendi("https://www.animeclick.it/x", {}, finto(403));
  } catch (e) {
    errore = e;
  }

  prova("un 403 lancia RifiutoFonte, senza riprovare", [true, 403, 1], [errore instanceof ac.RifiutoFonte, errore?.status, chiamate]);
  prova("e il messaggio è quello di sempre", true, /^AnimeClick HTTP 403 su /.test(errore?.message));

  const dopo = [];

  for (let i = 0; i < 34; i++) {
    try {
      await ac.prendi(`https://www.animeclick.it/manga/${i}`, {}, finto(200));
    } catch (e) {
      dopo.push(e.senzaRichiesta);
    }
  }

  prova("le 34 richieste dopo (come il rapporto dei volumi del 3 novembre) non partono: zero in più", [1, true], [chiamate, dopo.every(Boolean)]);
  prova("il freno dura circa un'ora", true, minuti(ac.frenoAcceso().fino) >= 59 && minuti(ac.frenoAcceso().fino) <= 61);

  ac.azzeraFreno();
  chiamate = 0;
  await ac.prendi("https://www.animeclick.it/x", {}, finto(429, { "retry-after": "7200" })).catch(() => {});
  prova("un 429 con Retry-After di due ore ferma per due ore", true, minuti(ac.frenoAcceso().fino) >= 119 && minuti(ac.frenoAcceso().fino) <= 121);

  ac.azzeraFreno();
  await ac.prendi("https://www.animeclick.it/x", {}, finto(429, { "retry-after": "999999999" })).catch(() => {});
  prova("un Retry-After assurdo si ferma a un giorno", true, minuti(ac.frenoAcceso().fino) <= 24 * 60 + 1);

  ac.azzeraFreno();
  chiamate = 0;
  const noTrovata = await ac.prendi("https://www.animeclick.it/x", {}, finto(404)).catch((e) => e);

  prova("un 404 NON è un rifiuto: errore normale, nessun freno", [false, null], [noTrovata instanceof ac.RifiutoFonte, ac.frenoAcceso()]);

  await ac.prendi("https://www.animeclick.it/y", {}, finto(200));
  prova("e la richiesta dopo parte", 2, chiamate);

  ac.azzeraFreno();
  ac.sospendiFinoA(new Date(Date.now() + 3600e3));
  chiamate = 0;
  const inPausa = await ac.prendi("https://www.animeclick.it/z", {}, finto(200)).catch((e) => e);

  prova("la pausa letta dal database ferma ogni richiesta", [true, 0], [inPausa instanceof ac.RifiutoFonte, chiamate]);
  ac.azzeraFreno();

  // Le pagine già scaricate da GitHub non aprono la rete: il freno, che protegge AnimeClick, non le riguarda.
  ac.azzeraFreno();
  await ac.prendi("https://www.animeclick.it/x", {}, finto(403)).catch(() => {});

  const locale = async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => "pagina" });

  locale.daPagine = true;

  const daGitHub = await ac.prendi("https://www.animeclick.it/y", {}, locale).catch((e) => e);

  prova("a freno acceso una pagina già scaricata da GitHub si legge lo stesso", true, !(daGitHub instanceof Error));

  const senzaMarca = await ac.prendi("https://www.animeclick.it/y", {}, async () => risposta(200)).catch((e) => e);

  prova("mentre una vera richiesta resta ferma", true, senzaMarca instanceof ac.RifiutoFonte);
  ac.azzeraFreno();

  // Lo stesso per il calendario che GitHub manda al backend (`registraDaPagine`): il 26/11/2026
  // un rifiuto preso da Render faceva scartare tre pagine buone, «in pausa dopo un rifiuto».
  await ac.prendi("https://www.animeclick.it/x", {}, finto(403)).catch(() => {});

  const calendario = `<html><body><div class="calendario-mese"><h2>Novembre 2026</h2></div>
<div class="col-12 date-separator"><div class="date">26</div><div class="month">novembre</div></div>
<div class="card panel-evento-calendario"><a href="/edizione/1/-/"><img data-original="/x.jpg"></a>
<h5>Rent a Girlfriend</h5><h3>Rent a Girlfriend 35</h3><h4>J-POP</h4></div></body></html>`;
  const letto = await require("../services/usciteManga").registraDaPagine(null, [{ quando: null, html: calendario }], { scrivi: false }).catch((e) => e);

  prova("a freno acceso il calendario mandato da GitHub si legge lo stesso", [false, 1], [letto instanceof Error, letto?.lette]);
  ac.azzeraFreno();

  console.log(falliti ? `\n${falliti} prove NON passano.` : "\nTutto a posto.");
  process.exit(falliti ? 1 : 0);
})();
