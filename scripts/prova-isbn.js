// Prove del codice a barre (`services/isbn.js`).
//
//   node scripts/prova-isbn.js        (nessun database, nessuna rete: tabelle e cataloghi sono finti)

const { leggiCodice, leggiAggiunta, normalizzaIsbn, abbina, riconosci, collega, scollega, svuotaMemoria } = require("../services/isbn");
const { daVolume, scegliVoce } = require("../services/providers/googleBooks");
const { daEdizione } = require("../services/providers/openLibrary");
const sbn = require("../services/providers/sbn");

let falliti = 0;
function prova(nome, atteso, ottenuto) {
  const bene = JSON.stringify(atteso) === JSON.stringify(ottenuto);
  console.log(`  ${bene ? "ok  " : "NO  "} ${nome}`);
  if (!bene) { falliti += 1; console.log(`       atteso:   ${JSON.stringify(atteso)}\n       ottenuto: ${JSON.stringify(ottenuto)}`); }
}

const ISBN = "9780306406157"; // un ISBN vero, con la cifra di controllo giusta
const EDICOLA = "9771234567003"; // un codice da edicola (977…), cifra di controllo giusta

console.log("\nIl codice si legge giusto");
prova("ISBN-13 valido", { codice: "9788891234568", libro: true }, leggiCodice("9788891234568"));
prova("un ISBN-13 con la cifra di controllo sbagliata non vale", null, leggiCodice("9788891234567"));
prova("con trattini e spazi", ISBN, leggiCodice("978-0-306-40615-7")?.codice);
prova("un ISBN-10 diventa ISBN-13", ISBN, leggiCodice("0306406152")?.codice);
prova("ISBN-10 con X finale", "9780804429573", leggiCodice("080442957X")?.codice);
prova("un ISBN-10 sbagliato non vale", null, leggiCodice("0306406153"));
prova("un codice da edicola è un codice, ma non un libro", { codice: EDICOLA, libro: false }, leggiCodice(EDICOLA));
prova("un codice da edicola con la cifra sbagliata non vale", null, leggiCodice("9771234567004"));
prova("testo, vuoto, niente", [null, null, null], [leggiCodice("abc"), leggiCodice(""), leggiCodice(undefined)]);
prova("normalizzaIsbn dice sì solo ai libri", [ISBN, null], [normalizzaIsbn(ISBN), normalizzaIsbn(EDICOLA)]);
prova("le cifre piccole: cinque, non due e non altro", [null, "00042", null, null, null], [
  leggiAggiunta("42"), leggiAggiunta("00042"), leggiAggiunta("123"), leggiAggiunta("abcde"), leggiAggiunta(undefined)
]);

console.log("\nDai cataloghi alla forma comune");
let v = daVolume({ volumeInfo: { title: "Berserk. Vol. 12", publisher: "Panini Comics", imageLinks: { thumbnail: "http://x/y" } }, saleInfo: { listPrice: { amount: 7 } } });
prova("Google: numero nel titolo", ["Berserk", 12, "https://x/y", 7], [v.serie, v.numero, v.copertina, v.prezzoCopertina]);
v = daVolume({ volumeInfo: { title: "One piece. New edition", subtitle: "Vol. 98" } });
prova("Google: numero nel sottotitolo, edizione nel titolo", ["One piece. New edition", 98], [v.serie, v.numero]);
v = daVolume({ volumeInfo: { title: "20th Century Boys" } });
prova("Google: un titolo che contiene un numero non perde pezzi", ["20th Century Boys", null], [v.serie, v.numero]);
prova("Google: senza titolo niente", null, daVolume({ volumeInfo: {} }));
prova("Google: il numero nudo nel sottotitolo", ["Blue box", 4], ((x) => [x.serie, x.numero])(daVolume({ volumeInfo: { title: "Blue box", subtitle: "4" } })));
prova("Google: il numero nella scheda della serie", 4, daVolume({ volumeInfo: { title: "Blue box", seriesInfo: { bookDisplayNumber: "4" } } }).numero);
prova("Google: …o nell'ordine della serie", 12, daVolume({ volumeInfo: { title: "Blue box", seriesInfo: { volumeSeries: [{ orderNumber: 12 }] } } }).numero);
prova("Google: nessun numero da nessuna parte", null, daVolume({ volumeInfo: { title: "Blue box", subtitle: "Un amore" } }).numero);
const voce = (titolo, ...ids) => ({ volumeInfo: { title: titolo, industryIdentifiers: ids.map((identifier) => ({ identifier })) } });
prova("Google: fra più voci si prende quella con quel codice", "giusta", scegliVoce([voce("altra", "9781111111111"), voce("giusta", "9780306406157")], ISBN, false).volumeInfo.title);
prova("Google: vale anche l'ISBN-10 corrispondente", "giusta", scegliVoce([voce("giusta", "0306406152")], ISBN, true).volumeInfo.title);
prova("Google: alla domanda precisa, senza codici dichiarati, vale la prima", "prima", scegliVoce([voce("prima")], ISBN, false).volumeInfo.title);
prova("Google: alla domanda larga, una voce senza quel codice si scarta", null, scegliVoce([voce("a caso", "9781111111111"), voce("senza")], ISBN, true));
prova("Google: nessuna voce", null, scegliVoce([], ISBN, false));

v = daEdizione({ title: "Vinland Saga 3", publishers: ["Star Comics"], covers: [123] });
prova("Open Library: titolo, numero, editore (e nessuna copertina)", ["Vinland Saga", 3, "Star Comics", null], [v.serie, v.numero, v.editore, v.copertina]);
prova("Open Library: senza titolo niente", null, daEdizione({}));

console.log("\nIl catalogo delle biblioteche italiane (SBN)");
for (const [titolo, atteso] of [
  ["Servamp / Tanaka Strike. 10", 10],
  ["Servamp. 10 / Tanaka Strike", 10],
  ["10 / Tanaka Strike", 10],
  ["10", 10],
  ["Blue box. Vol. 4 / Kouji Miura", 4],
  ["Berserk : n. 12", 12],
  ["Servamp / Tanaka Strike", null],
  ["20th century boys / Naoki Urasawa", null],
  ["Area 51 / Masato Hisa", null],
  ["1984 / George Orwell", null],
  ["", null]
]) prova(`numero in «${titolo}»`, atteso, sbn.numeroNelTitolo(titolo));
v = sbn.daRisposta({ numFound: 1, briefRecords: [{ titolo: "Servamp / Tanaka Strike. 10", pubblicazione: "Milano : Edizioni BD, 2018", autorePrincipale: "Tanaka, Strike" }] });
prova("SBN: serie, numero, editore", ["Servamp", 10, "Edizioni BD", "sbn"], [v.serie, v.numero, v.editore, v.fonte]);
v = sbn.daRisposta({ briefRecords: [{ titolo: "10 / Tanaka Strike" }] });
prova("SBN: un titolo che è solo il numero dà il numero ma non la serie", ["", 10], [v.serie, v.numero]);
prova("SBN: nessun record", [null, null], [sbn.daRisposta({ numFound: 0, briefRecords: [] }), sbn.daRisposta(null)]);

// Le vostre serie, finte.
const SERIE = [
  { ID: 1, Titolo: "Berserk", Edizione: null, Editore: "Panini Comics", CoverURL: "c1", NumeriPosseduti: [1, 2, 3, 5] },
  { ID: 2, Titolo: "One Piece", Edizione: null, Editore: "Star Comics", CoverURL: "c2", NumeriPosseduti: [1] },
  { ID: 3, Titolo: "One Piece", Edizione: "New Edition", Editore: "Star Comics", CoverURL: "c3", NumeriPosseduti: [] },
  { ID: 4, Titolo: "Dragon Ball", Edizione: null, Editore: "Star Comics", CoverURL: "c4", NumeriPosseduti: [1, 2] },
  { ID: 5, Titolo: "Vagabond", Edizione: "Deluxe", Editore: "Panini Comics", CoverURL: "c5", NumeriPosseduti: [1] },
  { ID: 6, Titolo: "Vagabond", Edizione: null, Editore: null, CoverURL: "c6", NumeriPosseduti: [] },
  { ID: 7, Titolo: "Ai", Edizione: null, Editore: null, CoverURL: null, NumeriPosseduti: [] }
];
const libro = (serie, extra = {}) => ({ serie, titolo: serie, titoloIntero: serie, numero: 1, editore: null, ...extra });
const esito = (r) => [r.sicura?.ID ?? null, r.candidate.map((s) => s.ID)];

console.log("\nQuale serie è");
prova("stesso titolo, una sola: sicura", [1, [1]], esito(abbina(libro("Berserk", { editore: "Panini" }), SERIE)));
prova("maiuscole e punteggiatura non contano", [1, [1]], esito(abbina(libro("BERSERK!"), SERIE)));
prova("stesso titolo, una sola, editore scritto diverso: è lei comunque", [1, [1]], esito(abbina(libro("Berserk", { editore: "J-Pop" }), SERIE)));
prova("due edizioni, il catalogo nomina la New Edition", [3, [2, 3]], esito(abbina(libro("One piece. New edition", { titoloIntero: "One piece. New edition. Vol. 5", editore: "Star Comics" }), SERIE)));
prova("due edizioni, il catalogo non ne nomina nessuna: è quella normale", [2, [2, 3]], esito(abbina(libro("One Piece", { editore: "Star Comics" }), SERIE)));
prova("due edizioni, l'editore ne sceglie una", [5, [5, 6]], esito(abbina(libro("Vagabond", { editore: "Panini Comics" }), SERIE)));
prova("due edizioni, il catalogo dice Deluxe", [5, [5, 6]], esito(abbina(libro("Vagabond Deluxe", { titoloIntero: "Vagabond Deluxe 4" }), SERIE)));
prova("un titolo solo simile non è mai sicuro (Dragon Ball Super non è Dragon Ball)", [null, [4]], esito(abbina(libro("Dragon Ball Super"), SERIE)));
prova("due lettere in comune non bastano a proporre", [null, []], esito(abbina(libro("Aishiteruze Baby"), SERIE)));
prova("una serie che non avete", [null, []], esito(abbina(libro("Dandadan"), SERIE)));
prova("senza titolo niente", [null, []], esito(abbina(libro(""), SERIE)));

// Una finta base di dati: le serie qui sopra e una `isbn_volumi` in memoria.
function finta() {
  const collegati = new Map();
  const query = async (q, v = []) => {
    if (/FROM isbn_volumi i JOIN/.test(q)) {
      return {
        rows: v[0]
          .filter((k) => collegati.has(k))
          .map((k) => ({ ...SERIE.find((s) => s.ID === collegati.get(k).manga_id), chiave: k, numero: collegati.get(k).numero }))
      };
    }
    if (/SELECT 1 FROM "Manga"/.test(q)) return { rowCount: SERIE.some((s) => s.ID === v[0]) ? 1 : 0 };
    if (/INSERT INTO isbn_volumi/.test(q)) {
      if (/DO NOTHING/.test(q)) { if (!collegati.has(v[0])) collegati.set(v[0], { manga_id: v[1], numero: null }); }
      else collegati.set(v[0], { manga_id: v[1], numero: v[2] });
      return { rowCount: 1 };
    }
    if (/DELETE FROM isbn_volumi/.test(q)) return { rowCount: v[0].filter((k) => collegati.delete(k)).length };
    if (/FROM "Manga"/.test(q)) return { rows: SERIE };
    throw new Error(`query non prevista: ${q}`);
  };

  return { query, collegati };
}
const catalogo = (l) => [async () => l];
let chiamate = 0;
const contato = (l) => [async () => { chiamate += 1; return l; }];

(async () => {
  console.log("\nCosa risponde a un ISBN");
  let db = finta();
  let r = await riconosci(db, "9788891234567");
  prova("codice non valido", "codice_non_valido", r.stato);

  svuotaMemoria();
  r = await riconosci(db, ISBN, { cataloghi: catalogo(libro("Berserk", { titolo: "Berserk. Vol. 4", numero: 4, editore: "Panini Comics", prezzoCopertina: 7 })) });
  prova("Berserk 4: vi manca, e prima non manca niente", ["ti_manca", 0, 1, 7], [r.stato, r.mancanti, r.serie.id, r.prezzoCopertina]);

  svuotaMemoria();
  r = await riconosci(db, ISBN, { cataloghi: catalogo(libro("Berserk", { numero: 3 })) });
  prova("Berserk 3: ce l'avete", "ce_l_hai", r.stato);

  svuotaMemoria();
  r = await riconosci(db, ISBN, { cataloghi: catalogo(libro("Berserk", { numero: 8 })) });
  prova("Berserk 8: manca, e prima mancano il 4, il 6 e il 7", ["ti_manca", 3], [r.stato, r.mancanti]);

  svuotaMemoria();
  r = await riconosci(db, ISBN, { cataloghi: catalogo(libro("Dragon Ball Super", { numero: 2 })) });
  prova("titolo simile: propone, non afferma", ["scegli", [4], 2], [r.stato, r.candidate.map((c) => c.id), r.numero]);

  svuotaMemoria();
  r = await riconosci(db, ISBN, { cataloghi: catalogo(libro("Berserk", { numero: null })) });
  prova("serie sicura ma numero non scritto: la serie non si rimette in dubbio, si chiede solo il numero", ["che_volume", 1, undefined], [r.stato, r.serie?.id, r.candidate]);

  svuotaMemoria();
  r = await riconosci(db, ISBN, { cataloghi: catalogo(libro("Dandadan", { titolo: "Dandadan 1" })) });
  prova("il catalogo lo conosce ma non è fra le vostre serie", ["non_in_collezione", "Dandadan", 1], [r.stato, r.serieTitolo, r.numero]);

  svuotaMemoria();
  r = await riconosci(db, ISBN, { cataloghi: [async () => null, async () => libro("Berserk", { numero: 3, fonte: "openlibrary" })] });
  prova("il primo catalogo non lo conosce, il secondo sì", ["ce_l_hai", "openlibrary"], [r.stato, r.fonte]);

  svuotaMemoria();
  r = await riconosci(db, ISBN, { cataloghi: catalogo(null) });
  prova("nessun catalogo lo conosce", ["non_riconosciuto", undefined], [r.stato, r.motivo]);

  svuotaMemoria();
  r = await riconosci(db, ISBN, { cataloghi: [async () => { throw new Error("Google Books: quota giornaliera esaurita"); }, async () => null] });
  prova("la quota è finita: lo dice, non crolla", ["non_riconosciuto", true], [r.stato, /quota/.test(r.motivo)]);
  r = await riconosci(db, ISBN, { cataloghi: catalogo(libro("Berserk", { numero: 3 })) });
  prova("…e un errore non viene ricordato come «non esiste»", "ce_l_hai", r.stato);

  console.log("\nIl numero da un altro catalogo");
  svuotaMemoria();
  r = await riconosci(db, ISBN, { cataloghi: [
    async () => libro("Berserk", { numero: null, fonte: "google", copertina: "cop-google", grezzo: { title: "Berserk" } }),
    async () => null,
    async () => ({ fonte: "sbn", serie: "", numero: 3, grezzo: { titolo: "3 / Miura" } })
  ] });
  prova("il primo sa la serie, il terzo il numero: risposta completa", ["ce_l_hai", 3, "sbn", "google", "cop-google"], [r.stato, r.numero, r.numeroDa, r.fonte, r.copertina]);
  prova("…e si vede cosa ha scritto ciascuno", ["Berserk", "3 / Miura"], [r.grezzo.title, r.grezzo.sbn.titolo]);

  svuotaMemoria();
  chiamate = 0;
  r = await riconosci(db, ISBN, { cataloghi: [async () => libro("Berserk", { numero: 3 }), async () => { chiamate += 1; return null; }] });
  prova("se il primo sa già il numero, gli altri non si disturbano", ["ce_l_hai", 0], [r.stato, chiamate]);

  svuotaMemoria();
  r = await riconosci(db, ISBN, { cataloghi: [async () => libro("Berserk", { numero: null }), async () => { throw new Error("SBN: non risponde"); }] });
  prova("il secondo è guasto: resta la serie e si chiede il numero, senza errori", ["che_volume", undefined], [r.stato, r.motivo]);

  svuotaMemoria();
  r = await riconosci(db, ISBN, { cataloghi: [async () => null, async () => ({ fonte: "sbn", serie: "", numero: 3 })] });
  prova("un numero senza serie non basta a riconoscere un volume", "non_riconosciuto", r.stato);

  svuotaMemoria();
  r = await riconosci(db, ISBN, { cataloghi: [async () => null, async () => ({ fonte: "sbn", serie: "Berserk", titolo: "Berserk / Miura. 3", numero: 3 })] });
  prova("solo SBN lo conosce (un volume appena uscito): basta lui", ["ce_l_hai", "sbn"], [r.stato, r.fonte]);

  console.log("\nLa memoria risparmia le richieste");
  svuotaMemoria();
  chiamate = 0;
  await riconosci(db, ISBN, { cataloghi: contato(libro("Berserk", { numero: 3 })) });
  await riconosci(db, ISBN, { cataloghi: contato(libro("Berserk", { numero: 3 })) });
  prova("lo stesso codice due volte: una sola richiesta al catalogo", 1, chiamate);
  svuotaMemoria();
  chiamate = 0;
  await riconosci(db, ISBN, { cataloghi: contato(null) });
  await riconosci(db, ISBN, { cataloghi: contato(null) });
  prova("anche un «non lo conosco» si ricorda", 1, chiamate);

  console.log("\nCollegare a mano");
  svuotaMemoria();
  db = finta();
  r = await collega(db, { codice: ISBN, mangaId: 2, numero: 7 });
  prova("collegare risponde subito come una scansione", ["collegato", 2, 7, "ti_manca", 5], [r.fonte, r.serie.id, r.numero, r.stato, r.mancanti]);
  r = await riconosci(db, ISBN, { cataloghi: [async () => { throw new Error("non deve chiedere ai cataloghi"); }] });
  prova("un codice collegato risponde senza cataloghi", ["collegato", 2, 7], [r.fonte, r.serie.id, r.numero]);
  r = await collega(db, { isbn: ISBN, mangaId: 1, numero: 3 });
  prova("ricollegare vale l'ultima parola (e accetta ancora `isbn`)", [1, 3, "ce_l_hai"], [r.serie.id, r.numero, r.stato]);
  prova("scollegare lo dimentica", { tolti: 1 }, await scollega(db, { codice: ISBN }));
  prova("scollegare due volte non è un errore", { tolti: 0 }, await scollega(db, { codice: ISBN }));

  for (const [nome, corpo] of [
    ["codice sbagliato", { codice: "123", mangaId: 1, numero: 1 }],
    ["volume zero", { codice: ISBN, mangaId: 1, numero: 0 }],
    ["volume non numero", { codice: ISBN, mangaId: 1, numero: "abc" }],
    ["serie che non c'è", { codice: ISBN, mangaId: 99, numero: 1 }],
    ["serie non numero", { codice: ISBN, mangaId: "x", numero: 1 }]
  ]) {
    let errore = null;
    try { await collega(db, corpo); } catch (e) { errore = e.constructor.name; }
    prova(`rifiuta: ${nome}`, "CollegamentoNonValido", errore);
  }

  console.log("\nI codici da edicola (non ISBN)");
  db = finta();
  r = await riconosci(db, EDICOLA, { aggiunta: "00042", cataloghi: [async () => { throw new Error("un codice da edicola non si chiede ai cataloghi"); }] });
  prova("sconosciuto: lo dice, e non disturba i cataloghi", ["non_riconosciuto", true, "00042"], [r.stato, r.periodico, r.aggiunta]);

  r = await collega(db, { codice: EDICOLA, aggiunta: "00042", mangaId: 1, numero: 4 });
  prova("collegato con le cifre piccole: è quel volume", ["ti_manca", 4, 1], [r.stato, r.numero, r.serie.id]);
  prova("…e il codice solo ricorda la serie", [[`${EDICOLA}-00042`, 4], [EDICOLA, null]], [...db.collegati].map(([k, x]) => [k, x.numero]));

  r = await riconosci(db, EDICOLA, { aggiunta: "00042" });
  prova("stesse cifre piccole: risposta diretta", ["ti_manca", 4], [r.stato, r.numero]);
  r = await riconosci(db, EDICOLA, { aggiunta: "00043" });
  prova("altre cifre piccole: la serie si sa, il numero si chiede", ["che_volume", 1, null], [r.stato, r.serie.id, r.numero]);
  r = await riconosci(db, EDICOLA);
  prova("cifre piccole non lette: la serie si sa, il numero si chiede", ["che_volume", 1], [r.stato, r.serie.id]);
  r = await riconosci(db, EDICOLA, { numero: 3 });
  prova("…e detto il numero, la risposta", ["ce_l_hai", 3], [r.stato, r.numero]);

  r = await collega(db, { codice: EDICOLA, aggiunta: "00043", mangaId: 4, numero: 5 });
  prova("un'altra serie nella stessa collana: quel volume è suo", [4, 5], [r.serie.id, r.numero]);
  prova("…ma il codice solo resta della prima", 1, db.collegati.get(EDICOLA).manga_id);

  r = await collega(db, { codice: EDICOLA, aggiunta: "00043", mangaId: 4, numero: 5, cambiaSerie: true });
  prova("…a meno di una correzione: allora passa alla nuova", 4, db.collegati.get(EDICOLA).manga_id);
  prova("dimenticare un codice da edicola toglie il volume e la serie", { tolti: 2 }, await scollega(db, { codice: EDICOLA, aggiunta: "00043" }));
  prova("…ma non gli altri volumi", [`${EDICOLA}-00042`], [...db.collegati.keys()]);

  db = finta();
  r = await collega(db, { codice: EDICOLA, mangaId: 1, numero: 2 });
  prova("collegato senza cifre piccole: vale per la serie, la risposta è per quel numero", ["ce_l_hai", 2, null], [r.stato, r.numero, db.collegati.get(EDICOLA).numero]);
  r = await riconosci(db, ISBN.replace(/^978/, "978"), { aggiunta: "12345", cataloghi: catalogo(null) });
  prova("le cifre piccole di un ISBN (il prezzo) si ignorano", null, r.aggiunta);

  db = finta();
  r = await collega(db, { codice: EDICOLA, aggiunta: "42", mangaId: 1, numero: 2 });
  prova("due cifre piccole valgono come nessuna: si ricorda la serie, non il volume", [[EDICOLA, null]], [...db.collegati].map(([k, x]) => [k, x.numero]));

  if (falliti) { console.log(`\n${falliti} prove fallite`); process.exit(1); }
  console.log("\nTutto a posto.");
})().catch((e) => { console.error(e); process.exit(1); });
