// Prova di services/limite.js e delle due funzioni pure degli acquisti.
// Non tocca rete né database: gira ovunque, e in pochi millisecondi.
//
//   node scripts/prova-limite.js

const { limite } = require("../services/limite");
const { blocchi, ripartisci, primoMancante, giaInCasa } = require("../services/acquisti");

let falliti = 0;

function prova(nome, vero, dettaglio = "") {
  console.log(`  ${vero ? "ok  " : "NO  "} ${nome}${dettaglio ? ` — ${dettaglio}` : ""}`);
  if (!vero) falliti += 1;
}

/** Una richiesta finta: basta quello che il limite legge e scrive. */
function passa(controlla, { ip = "1.1.1.1", esito = 200 } = {}) {
  const ascoltatori = [];
  let stato = 200;
  let passato = false;

  const res = {
    get statusCode() {
      return stato;
    },
    set() {},
    status(codice) {
      stato = codice;
      return res;
    },
    json() {
      return res;
    },
    on(evento, fn) {
      if (evento === "finish") ascoltatori.push(fn);
    }
  };

  controlla({ ip }, res, () => {
    passato = true;
    stato = esito;
  });

  ascoltatori.forEach((fn) => fn());

  return passato;
}

console.log("\nIl tetto per indirizzo");
{
  const c = limite({ finestraMs: 60000, massimo: 3 });

  prova("le prime tre passano", [1, 2, 3].every(() => passa(c)));
  prova("la quarta no", !passa(c));
  prova("un altro indirizzo passa ancora", passa(c, { ip: "2.2.2.2" }));
}

console.log("\nIl tetto globale");
{
  const c = limite({ finestraMs: 60000, massimo: 100, globale: 2 });

  passa(c, { ip: "a" });
  passa(c, { ip: "b" });
  prova("il terzo, da chiunque arrivi, si ferma", !passa(c, { ip: "c" }));
}

console.log("\nSolo le fallite (il login)");
{
  const c = limite({ finestraMs: 60000, massimo: 2, soloFallite: true });

  prova("dieci accessi riusciti non avvicinano al blocco", Array.from({ length: 10 }).every(() => passa(c)));
  passa(c, { esito: 401 });
  passa(c, { esito: 401 });
  prova("dopo due password sbagliate si aspetta", !passa(c));
}

console.log("\nLa finestra scade");
{
  const c = limite({ finestraMs: 1, massimo: 1 });

  passa(c);

  const fino = Date.now() + 5;
  while (Date.now() < fino); // qualche millisecondo, senza timer

  prova("passata la finestra si ricomincia", passa(c));
}

console.log("\nGli acquisti");
{
  prova("i contigui stanno insieme, i salti no", JSON.stringify(blocchi([44, 42, 43, 46, 42])) === '[{"da":42,"a":44},{"da":46,"a":46}]');

  const pezzi = ripartisci(20, blocchi([1, 2, 3, 7]));

  prova("i pezzi tornano al totale", Math.round(pezzi.reduce((s, p) => s + p.prezzo, 0) * 100) === 2000, pezzi.map((p) => p.prezzo).join(" + "));
  prova("il primo che manca è il primo buco", primoMancante([1, 2, 3, 4, 5, 11]) === 6);
  prova("si segnano solo i numeri che c'erano già", JSON.stringify(giaInCasa({ da: 5, a: 7 }, new Set([1, 2, 3, 4, 5]))) === "[5]");
}

console.log(falliti ? `\n${falliti} prove fallite.\n` : "\nTutto a posto.\n");
process.exitCode = falliti ? 1 : 0;
