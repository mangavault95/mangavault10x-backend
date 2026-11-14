// services/isbn.js
//
// «CE L'HO GIÀ?» COL CODICE A BARRE.
//
// Dal retro di un volume il sito legge il codice (ISBN) e chiede qui cos'è. Si risponde in
// questo ordine:
//
//   1. un codice già collegato a mano (`isbn_volumi`, migrazione 033): immediato, senza Google;
//   2. Google Books, che per le edizioni italiane è a volte vuoto o impreciso: dal titolo si
//      toglie il numero di volume («Berserk. Vol. 12») e si cerca la serie fra le vostre, per
//      nome e, se ce n'è più d'una (edizioni diverse), per editore;
//   3. niente: il sito chiede a voi di dire che volume è, e il collegamento si ricorda (1).
//
// E dice a che punto siete: `ce_l_hai`, `ti_manca` (con i volumi che vengono prima, se ce ne
// sono), `non_in_collezione` (Google lo conosce ma non è fra le vostre serie), `scegli` (più
// edizioni possibili) o `non_riconosciuto`.
//
// La funzione che chiede a Google si può passare dall'esterno (`cerca`), così si prova senza rete.

const { ossa, stessoEditore } = require("./usciteManga");

/**
 * Un codice a barre ridotto a ISBN-13, o null se non lo è davvero (cifre sbagliate, lunghezza,
 * somma di controllo). Accetta ISBN-10 (con X finale) e ISBN-13, con o senza trattini.
 */
function normalizzaIsbn(grezzo) {
  const testo = String(grezzo ?? "").replace(/[\s-]/g, "").toUpperCase();

  if (/^\d{13}$/.test(testo)) {
    if (!/^97[89]/.test(testo)) return null;

    const somma = [...testo].slice(0, 12).reduce((s, c, i) => s + Number(c) * (i % 2 ? 3 : 1), 0);

    return (10 - (somma % 10)) % 10 === Number(testo[12]) ? testo : null;
  }

  if (/^\d{9}[\dX]$/.test(testo)) {
    const somma = [...testo].slice(0, 9).reduce((s, c, i) => s + Number(c) * (10 - i), 0);
    const controllo = (11 - (somma % 11)) % 11;

    if ((controllo === 10 ? "X" : String(controllo)) !== testo[9]) return null;

    const tredici = `978${testo.slice(0, 9)}`;
    const s13 = [...tredici].reduce((s, c, i) => s + Number(c) * (i % 2 ? 3 : 1), 0);

    return `${tredici}${(10 - (s13 % 10)) % 10}`;
  }

  return null;
}

/** Come sta la serie rispetto a quel volume. */
function stato(serie, numero) {
  const numeri = new Set((serie.NumeriPosseduti || []).map(Number));

  if (numeri.has(numero)) return { stato: "ce_l_hai", mancanti: 0 };

  let mancanti = 0;

  for (let n = 1; n < numero; n += 1) if (!numeri.has(n)) mancanti += 1;

  return { stato: "ti_manca", mancanti };
}

const dellaSerie = (s) => ({
  id: Number(s.ID),
  titolo: s.Titolo,
  edizione: s.Edizione || null,
  editore: s.Editore || null,
  copertina: s.CoverURL || null,
  posseduti: (s.NumeriPosseduti || []).length
});

async function riconosci(pool, codice, { cerca } = {}) {
  const isbn = normalizzaIsbn(codice);

  if (!isbn) return { isbn: null, stato: "codice_non_valido" };

  const colonne = `"ID", "Titolo", "Edizione", "Editore", "CoverURL", "NumeriPosseduti"`;

  // 1. Già collegato.
  const { rows: noti } = await pool.query(
    `SELECT m.${colonne.split(", ").join(", m.")}, i.numero
       FROM isbn_volumi i JOIN "Manga" m ON m."ID" = i.manga_id WHERE i.isbn = $1`,
    [isbn]
  );

  if (noti.length) {
    return { isbn, fonte: "collegato", numero: noti[0].numero, serie: dellaSerie(noti[0]), ...stato(noti[0], noti[0].numero) };
  }

  // 2. Google Books.
  let libro = null;

  try {
    libro = await (cerca || require("./providers/googleBooks").perIsbn)(isbn);
  } catch (err) {
    return { isbn, stato: "non_riconosciuto", motivo: err.message };
  }

  if (!libro || !libro.serie) return { isbn, stato: "non_riconosciuto" };

  const base = {
    isbn,
    fonte: "google",
    titolo: libro.titolo,
    numero: libro.numero,
    editore: libro.editore,
    copertina: libro.copertina,
    prezzoCopertina: libro.prezzoCopertina
  };

  const { rows: serie } = await pool.query(`SELECT ${colonne} FROM "Manga"`);
  const candidate = serie.filter((s) => ossa(s.Titolo) === ossa(libro.serie));

  if (!candidate.length) return { ...base, stato: "non_in_collezione" };

  // Più edizioni con lo stesso titolo: l'editore le distingue, se Google lo dice.
  const scelte = candidate.length > 1 ? candidate.filter((s) => stessoEditore(s.Editore, libro.editore)) : candidate;

  // Senza il numero di volume non si può dire se ce l'avete: tocca a voi.
  if (scelte.length !== 1 || !libro.numero) {
    return { ...base, stato: "scegli", candidate: (scelte.length ? scelte : candidate).map(dellaSerie) };
  }

  return { ...base, serie: dellaSerie(scelte[0]), ...stato(scelte[0], libro.numero) };
}

/** Ricorda che questo codice è quel volume di quella serie. Se c'era già, vale l'ultimo. */
async function collega(pool, { isbn, mangaId, numero }) {
  const normale = normalizzaIsbn(isbn);
  const n = Number(numero);

  if (!normale) throw new Error("Codice non valido");
  if (!Number.isInteger(n) || n < 1 || n > 999) throw new Error("Numero di volume non valido");

  const { rowCount } = await pool.query(`SELECT 1 FROM "Manga" WHERE "ID" = $1`, [Number(mangaId)]);

  if (!rowCount) throw new Error("Serie non trovata");

  await pool.query(
    `INSERT INTO isbn_volumi (isbn, manga_id, numero) VALUES ($1, $2, $3)
     ON CONFLICT (isbn) DO UPDATE SET manga_id = EXCLUDED.manga_id, numero = EXCLUDED.numero`,
    [normale, Number(mangaId), n]
  );

  return { isbn: normale };
}

module.exports = { normalizzaIsbn, riconosci, collega, stato };
