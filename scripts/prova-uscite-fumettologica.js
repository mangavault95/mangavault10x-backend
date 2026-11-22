// Prova delle uscite lette da Fumettologica e abbinate alla collezione.
//
//   node scripts/prova-uscite-fumettologica.js
//
// Gira ovunque: il sito di Fumettologica e il database sono finti (un `fetch` e un `pool`
// che rispondono con righe scritte qui sotto). L'articolo è fatto a mano con la stessa forma
// che il lettore cerca («<p><strong>TITOLO</strong><br />»): NON è un articolo vero.
//
// Il caso: «SERIE 17 – ALTRO 1» (edizione abbinata) finiva in archivio come volume 1 della
// serie, e nella pagina Uscite compariva un «I diari della speziale 1» al posto del 17.

const { titoloRegolare, usciteTra } = require("../services/usciteManga");
const { usciteDellaRivista, numeroDi } = require("../services/usciteFumettologica");

let falliti = 0;

function prova(nome, atteso, ottenuto) {
  const a = JSON.stringify(atteso);
  const o = JSON.stringify(ottenuto);

  if (a === o) console.log(`  ok   ${nome}`);
  else {
    falliti += 1;
    console.log(`  NO   ${nome}\n       atteso   ${a}\n       ottenuto ${o}`);
  }
}

const SPEZIALE = { ID: 1, Titolo: "I diari della speziale", Edizione: null, Editore: "J-POP", NumeriPosseduti: [1], Costo: 6.5, CoverURL: "https://x/spez-1.jpg", SmessaIl: null };
const RENT = { ID: 2, Titolo: "Rent a Girlfriend", Edizione: null, Editore: "J-POP", NumeriPosseduti: Array.from({ length: 34 }, (_, i) => i + 1), Costo: 5.9, CoverURL: "https://x/rent-1.jpg", SmessaIl: null };

(async () => {
  console.log("\nIl titolo è «la serie + il suo numero»?");
  prova("volume normale", true, titoloRegolare("I diari della speziale 17", "I diari della speziale"));
  prova("sottotitolo senza cifre", true, titoloRegolare("Frieren – Oltre la fine del viaggio 12", "Frieren"));
  prova("edizione abbinata con un altro numero in mezzo", false, titoloRegolare("I diari della speziale 17 – Chronicle 1", "I diari della speziale"));
  prova("serie con una cifra nel nome", true, titoloRegolare("20th Century Boys 5", "20th Century Boys"));
  prova("senza titolo non si scarta", true, titoloRegolare(null, "Qualunque"));
  prova("il numero in fondo di un titolo abbinato è quello sbagliato", 1, numeroDi("I diari della speziale 17 – Chronicle 1"));

  console.log("\nLa lettura dell'articolo settimanale");
  const articolo = {
    title: { rendered: "J-Pop: i fumetti in uscita questa settimana (9 &#8211; 15 novembre 2026)" },
    link: "https://esempio.invalid/j-pop-9-15-novembre",
    content: {
      rendered: [
        "<p><strong>I DIARI DELLA SPEZIALE 17</strong><br />",
        "Prezzo: 6,50 euro</p>",
        "<p><strong>I DIARI DELLA SPEZIALE 17 – CHRONICLE 1</strong><br />",
        "Prezzo: 12,00 euro</p>",
        "<p><strong>RENT A GIRLFRIEND 35</strong><br />",
        "Prezzo: 5,90 euro</p>"
      ].join("\n")
    }
  };

  const fetchOriginale = global.fetch;

  global.fetch = async () => ({ ok: true, status: 200, json: async () => [articolo] });

  let esito;

  try {
    esito = await usciteDellaRivista("J-Pop", [SPEZIALE, RENT], { dopo: "2026-11-01", fino: "2026-11-30" });
  } finally {
    global.fetch = fetchOriginale;
  }

  prova("un articolo letto", 1, esito.lette);
  prova(
    "il volume abbinato non diventa il volume 1; gli altri restano",
    [["I diari della speziale", 17, "2026-11-12"], ["Rent a Girlfriend", 35, "2026-11-12"]],
    esito.uscite.map((u) => [u.serie, u.numero, u.data])
  );

  console.log("\nL'abbinamento alla collezione (righe già scritte in archivio)");
  const righe = [
    { data: "2026-11-12", serie: "I diari della speziale", numero: 1, titolo: "I DIARI DELLA SPEZIALE 17 – CHRONICLE 1", edizione: null, editore: "J-POP", copertina: null },
    { data: "2026-11-12", serie: "I diari della speziale", numero: 17, titolo: "I DIARI DELLA SPEZIALE 17", edizione: null, editore: "J-POP", copertina: null },
    { data: "2026-11-12", serie: "Rent a Girlfriend", numero: 35, titolo: null, edizione: null, editore: "J-POP", copertina: null }
  ];

  const pool = {
    query: async (sql) => ({ rows: /FROM uscite_manga/.test(sql) ? righe : [SPEZIALE, RENT] })
  };

  const mie = await usciteTra(pool, { dopo: "2026-11-01", fino: "2026-11-30", soloMie: true });

  prova(
    "la riga «1» scritta in precedenza non compare, il 17 sì",
    [["I diari della speziale", 17, "manca"], ["Rent a Girlfriend", 35, "prossimo"]],
    mie.map((u) => [u.serie.titolo, u.numero, u.stato])
  );

  if (falliti) {
    console.log(`\n${falliti} prove fallite.\n`);
    process.exit(1);
  }

  console.log("\nTutte le prove passano.\n");
})();
