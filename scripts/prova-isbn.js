// Prove del codice a barre (`services/isbn.js`).
//
//   node scripts/prova-isbn.js        (nessun database, nessuna rete: tabelle e Google sono finti)

const { normalizzaIsbn, riconosci, collega } = require("../services/isbn");

let falliti = 0;
function prova(nome, atteso, ottenuto) {
  const bene = JSON.stringify(atteso) === JSON.stringify(ottenuto);
  console.log(`  ${bene ? "ok  " : "NO  "} ${nome}`);
  if (!bene) { falliti += 1; console.log(`       atteso:   ${JSON.stringify(atteso)}\n       ottenuto: ${JSON.stringify(ottenuto)}`); }
}

console.log("\nIl codice si legge giusto");
prova("ISBN-13 valido", "9788891234568", normalizzaIsbn("9788891234568"));
prova("un ISBN-13 con la cifra di controllo sbagliata non vale", null, normalizzaIsbn("9788891234567"));
prova("con trattini e spazi", "9780306406157", normalizzaIsbn("978-0-306-40615-7"));
prova("un ISBN-10 diventa ISBN-13", "9780306406157", normalizzaIsbn("0306406152"));
prova("ISBN-10 con X finale", "9780804429573", normalizzaIsbn("080442957X"));
prova("un ISBN-10 sbagliato non vale", null, normalizzaIsbn("0306406153"));
prova("un codice che non comincia per 978/979 non è un libro", null, normalizzaIsbn("5012345678900"));
prova("testo e vuoto", [null, null, null], [normalizzaIsbn("abc"), normalizzaIsbn(""), normalizzaIsbn(undefined)]);

// Una finta tabella: risponde alle due domande che il servizio fa.
const SERIE = [
  { ID: 1, Titolo: "Berserk", Edizione: null, Editore: "Panini Comics", CoverURL: "c1", NumeriPosseduti: [1, 2, 3, 5] },
  { ID: 2, Titolo: "One Piece", Edizione: null, Editore: "Star Comics", CoverURL: "c2", NumeriPosseduti: [1] },
  { ID: 3, Titolo: "One Piece", Edizione: "Color", Editore: "Panini Comics", CoverURL: "c3", NumeriPosseduti: [] }
];
const pool = (collegati = []) => ({
  query: async (q, v) => {
    if (/FROM isbn_volumi i/.test(q)) {
      const r = collegati.find((c) => c.isbn === v[0]);
      return { rows: r ? [{ ...SERIE.find((s) => s.ID === r.manga_id), numero: r.numero }] : [] };
    }
    if (/SELECT 1 FROM "Manga"/.test(q)) return { rowCount: SERIE.some((s) => s.ID === v[0]) ? 1 : 0 };
    if (/FROM "Manga"/.test(q)) return { rows: SERIE };
    return { rows: [], rowCount: 1 };
  }
});
const google = (libro) => async () => libro;
const ISBN = "9780306406157";

(async () => {
  console.log("\nCosa risponde");
  let r = await riconosci(pool(), "9788891234567");
  prova("codice non valido", "codice_non_valido", r.stato);

  r = await riconosci(pool(), ISBN, { cerca: google({ serie: "Berserk", titolo: "Berserk. Vol. 4", numero: 4, editore: "Panini Comics" }) });
  prova("Berserk 4: vi manca, e ne manca uno prima (il 4 non c'è, il 5 sì)", ["ti_manca", 0, 1], [r.stato, r.mancanti, r.serie.id]);

  r = await riconosci(pool(), ISBN, { cerca: google({ serie: "Berserk", titolo: "Berserk. Vol. 3", numero: 3, editore: "Panini" }) });
  prova("Berserk 3: ce l'avete", "ce_l_hai", r.stato);

  r = await riconosci(pool(), ISBN, { cerca: google({ serie: "Berserk", titolo: "Berserk 8", numero: 8, editore: "Panini" }) });
  prova("Berserk 8: manca, e prima mancano il 4, 6 e 7", ["ti_manca", 3], [r.stato, r.mancanti]);

  r = await riconosci(pool(), ISBN, { cerca: google({ serie: "ONE PIECE", titolo: "One piece 2", numero: 2, editore: "Star Comics" }) });
  prova("più edizioni con lo stesso titolo: l'editore sceglie", [2, "ti_manca"], [r.serie?.id, r.stato]);

  r = await riconosci(pool(), ISBN, { cerca: google({ serie: "One Piece", titolo: "One Piece 2", numero: 2, editore: null }) });
  prova("più edizioni e Google non dice l'editore: si sceglie a mano", ["scegli", 2], [r.stato, r.candidate.length]);

  r = await riconosci(pool(), ISBN, { cerca: google({ serie: "Berserk", titolo: "Berserk", numero: null, editore: "Panini" }) });
  prova("senza numero di volume non si può dire: si sceglie a mano", "scegli", r.stato);

  r = await riconosci(pool(), ISBN, { cerca: google({ serie: "Dandadan", titolo: "Dandadan 1", numero: 1, editore: "Star" }) });
  prova("Google lo conosce ma non è fra le vostre serie", ["non_in_collezione", 1], [r.stato, r.numero]);

  r = await riconosci(pool(), ISBN, { cerca: google(null) });
  prova("Google non lo conosce", "non_riconosciuto", r.stato);

  r = await riconosci(pool(), ISBN, { cerca: async () => { throw new Error("Google Books: quota giornaliera esaurita"); } });
  prova("la quota di Google è finita: lo dice, non crolla", ["non_riconosciuto", true], [r.stato, /quota/.test(r.motivo)]);

  r = await riconosci(pool([{ isbn: ISBN, manga_id: 2, numero: 7 }]), ISBN, { cerca: async () => { throw new Error("non deve chiamare Google"); } });
  prova("un codice già collegato risponde senza Google", ["collegato", 2, 7, "ti_manca"], [r.fonte, r.serie.id, r.numero, r.stato]);

  console.log("\nCollegare un codice");
  prova("collega un codice valido", { isbn: ISBN }, await collega(pool(), { isbn: ISBN, mangaId: 1, numero: 9 }));
  for (const [nome, corpo] of [
    ["codice sbagliato", { isbn: "123", mangaId: 1, numero: 1 }],
    ["volume zero", { isbn: ISBN, mangaId: 1, numero: 0 }],
    ["serie che non c'è", { isbn: ISBN, mangaId: 99, numero: 1 }]
  ]) {
    let errore = null;
    try { await collega(pool(), corpo); } catch (e) { errore = e.message; }
    prova(`rifiuta: ${nome}`, true, Boolean(errore));
  }

  if (falliti) { console.log(`\n${falliti} prove fallite`); process.exit(1); }
  console.log("\nTutto a posto.");
})();
