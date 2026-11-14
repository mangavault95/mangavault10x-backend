// Le regole di acquisto (come si dividono i volumi in blocchi, come si ripartisce il prezzo, quale numero è
// il primo che manca, cosa c'era già in casa, come si annulla) sono scritte DUE VOLTE: qui e in
// mangavault10x-bot/src/messaggio.js e src/collezione.js. Questa prova fa girare le due copie sugli stessi
// casi (fixtures/acquisti/casi.json, identico nei due repository) e controlla che il file non si sia separato.
//
//   node scripts/prova-regole.js
//
// Se una regola cambia, si cambia in tutti e due i posti e si aggiunge un caso.
//
// In più controlla che le rotte dell'anime riconoscano chi chiama dal token: senza, una richiesta senza
// `?utente=` riceverebbe la videoteca del proprietario anche da chi è entrato.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

process.env.JWT_SECRET = process.env.JWT_SECRET || "una-chiave-finta-lunga-almeno-trentadue-caratteri";
process.env.ADMIN_USERNAME = process.env.ADMIN_USERNAME || "prova";
process.env.ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || "00:00";

const { blocchi, ripartisci, primoMancante, giaInCasa, TOGLI_NUMERI } = require("../services/acquisti");

const file = path.join(__dirname, "..", "fixtures", "acquisti", "casi.json");

// L'impronta del file dei casi: dev'essere la stessa nel bot.
const IMPRONTA = "c214211f163aa610";

const testo = fs.readFileSync(file, "utf8");
const casi = JSON.parse(testo);

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

console.log("\nI casi condivisi");
prova("il file è lo stesso del bot (impronta)", IMPRONTA, crypto.createHash("sha256").update(testo).digest("hex").slice(0, 16));

console.log("\nBlocchi di volumi");
for (const c of casi.blocchi) prova(`${JSON.stringify(c.in)}`, c.out, blocchi([...c.in]));

console.log("\nRipartire il prezzo");
for (const c of casi.ripartisci) {
  const r = ripartisci(c.totale, c.gruppi);

  prova(`${c.totale} su ${c.gruppi.map((g) => `${g.da}-${g.a}`).join(" + ")}`, c.out, r);
  prova("   e la somma torna al totale", Math.round(c.totale * 100), Math.round(r.reduce((s, p) => s + p.prezzo, 0) * 100));
}

console.log("\nIl primo che manca");
for (const c of casi.primoMancante) prova(`${JSON.stringify(c.in)}`, c.out, primoMancante(c.in));

console.log("\nCosa c'era già in casa");
for (const c of casi.giaInCasa) prova(`${c.gruppo.da}-${c.gruppo.a} avendo ${JSON.stringify(c.avevo)}`, c.out, giaInCasa(c.gruppo, new Set(c.avevo)));

console.log("\nLa query che toglie i numeri all'annullo");
prova("è la stessa del bot", casi.togliNumeri, TOGLI_NUMERI.replace(/\s+/g, " ").trim());

console.log("\nLe rotte dell'anime");
{
  const { identificaUtente } = require("../services/auth");
  const router = require("../routes/anime");

  // Prima di ogni rotta: così `req.user` c'è anche nelle letture pubbliche, e `utenteLetto` può usarlo.
  const primo = router.stack[0];

  prova("il router parte da identificaUtente", true, primo?.handle === identificaUtente);
}

console.log(falliti ? `\n${falliti} prove fallite.\n` : "\nTutto a posto.\n");
process.exitCode = falliti ? 1 : 0;
