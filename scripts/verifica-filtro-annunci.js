// scripts/verifica-filtro-annunci.js
//
// Controlla che il filtro degli annunci (services/annunci.js) sappia
// distinguere una serie completa da un volume singolo, su titoli
// scritti come li scrivono davvero i venditori su eBay Italia.
//
// Serve perché la stima del prezzo non si può provare a mano: eBay
// risponde cose diverse ogni giorno, e l'unico modo di sapere se il
// filtro è giusto è fissare i casi che l'hanno fatto sbagliare.
//
//   node scripts/verifica-filtro-annunci.js
const { sembraSerieCompleta } = require("../services/annunci");

// [titolo, volumiTotali, atteso]
const CASI = [
  // --- Serie complete vere: devono passare ---
  ["HAPPINESS 1/10 SERIE COMPLETA OSHIMI SHUZO PLANET MANGA", 10, true],
  ["Happiness serie completa vol. 1-10 Planet Manga", 10, true],
  ["HAPPINESS SERIE COMPLETA 10 VOLUMI OSHIMI PLANET MANGA", 10, true],
  ["Happiness cofanetto Oshimi Shuzo Planet Manga", 10, true],
  ["Happiness 1-10 completa Planet Manga 2016-2017", 10, true],
  ["HUNTER X HUNTER 1/38 Togashi Panini serie", null, true],

  // --- Volumi singoli travestiti: NON devono passare ---
  // Il caso che schiacciava la mediana: "serie completa" è una parola
  // chiave del venditore, non l'oggetto in vendita.
  ["Happiness vol. 3 - Planet Manga - Serie completa in 10 volumi", 10, false],
  ["HAPPINESS N. 5 PLANET MANGA OSHIMI SHUZO", 10, false],
  ["Happiness #7 Planet Manga ottimo stato", 10, false],
  ["Happiness 7 di 10 Planet Manga", 10, false],
  ["HAPPINESS OSHIMI - SCEGLI IL VOLUME - serie completa 1/10", 10, false],
  ["Happiness volumi a scelta Planet Manga completa", 10, false],
  ["Happiness 5 Planet Manga", 10, false],

  // --- Lotti parziali: NON devono passare ---
  ["LOTTO 3 VOLUMI HAPPINESS PLANET MANGA", 10, false],
  ["Happiness 5-10 Planet Manga lotto", 10, false],
  ["HUNTER X HUNTER 1-5 Panini lotto volumi", null, false],

  // --- Merchandise: NON deve passare ---
  ["Portachiavi Hunter x Hunter Gon Freecss", null, false],
  ["Poster Hunter x Hunter 50x70 anime manga", null, false],
  ["Happiness bracciale acciaio scritta happiness donna", 10, false],
  ["Hunter x Hunter", null, false]
];

let falliti = 0;

for (const [titolo, totali, atteso] of CASI) {
  const ottenuto = sembraSerieCompleta(titolo, totali);
  const ok = ottenuto === atteso;

  if (!ok) falliti++;

  console.log(
    `${ok ? "  ok  " : " FAIL "} atteso=${String(atteso).padEnd(5)} ottenuto=${String(ottenuto).padEnd(5)} ${titolo}`
  );
}

console.log(`\n${CASI.length - falliti}/${CASI.length} casi corretti`);

process.exit(falliti ? 1 : 0);
