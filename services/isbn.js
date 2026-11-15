// services/isbn.js
//
// «CE L'HO GIÀ?» COL CODICE A BARRE.
//
// Dal retro di un volume il sito legge il codice e chiede qui cos'è. Si risponde in
// quest'ordine:
//
//   1. un codice già collegato (`isbn_volumi`, migrazione 033): immediato, senza chiedere
//      niente a nessuno. È la strada che conta: ogni conferma fatta dal sito finisce qui;
//   2. se è un ISBN (comincia per 978 o 979): Google Books, e se Google non lo conosce
//      Open Library. Dal titolo si toglie il numero di volume («Berserk. Vol. 12») e si
//      cerca la serie fra le vostre (vedi `abbina`);
//   3. niente: il sito chiede a voi di dire che volume è, e il collegamento si ricorda (1).
//
// I CODICI CHE NON SONO ISBN. Non tutti i volumi hanno un ISBN sul retro: un codice che
// non comincia per 978/979 (quelli da edicola cominciano per 977) è comunque un codice
// valido, solo che nessun catalogo di libri lo conosce. Qui non si rifiuta: si salta il
// punto 2 e lo si collega a mano. Un codice da edicola è lo stesso per tutti i numeri di
// una collana, e il numero sta nelle cifre piccole accanto (l'«aggiunta»):
//   - con un'aggiunta di CINQUE cifre, la chiave è `codice-aggiunta` e vale per quel volume;
//   - senza, la chiave è il codice solo e vale per la SERIE (`numero` vuoto): la volta
//     dopo il sito sa già che serie è e chiede soltanto il numero.
// Un'aggiunta di due cifre vale come nessuna: ha un controllo debole e il lettore la
// confonde con una da cinque letta male (vedi `cifrePiccole.js` nel frontend). Una chiave
// sbagliata vorrebbe dire rispondere «ce l'hai» per un altro numero: meglio chiederlo.
//
// COSA RISPONDE (`stato`):
//   ce_l_hai            quel numero è fra i posseduti
//   ti_manca            non c'è; `mancanti` dice quanti ne mancano prima di lui
//   che_volume          la serie si sa, il numero no (codice da edicola, o catalogo che non
//                       lo scrive): lo dice chi ha il volume in mano
//   scegli              la serie non è sicura (più edizioni, titolo solo simile, editore
//                       diverso, numero illeggibile): `candidate` sono le proposte
//   non_in_collezione   il catalogo lo conosce, ma nessuna vostra serie gli somiglia
//   non_riconosciuto    nessuno lo conosce (`periodico: true` se non è un ISBN)
//   codice_non_valido   non è un codice a barre (cifra di controllo sbagliata)
//
// Le funzioni che chiedono ai cataloghi si possono passare dall'esterno (`cataloghi`),
// così si prova senza rete.

const { ossa, edizioneDi, editoreDi } = require("./usciteManga");

/* ==================================================
   IL CODICE
   ================================================== */

const controlloEan = (dodici) =>
  (10 - ([...dodici].reduce((s, c, i) => s + Number(c) * (i % 2 ? 3 : 1), 0) % 10)) % 10;

/**
 * Un codice letto o scritto a mano, ridotto a tredici cifre.
 *
 * Accetta un EAN-13 qualsiasi (con la cifra di controllo giusta) e un ISBN-10, che
 * diventa il suo ISBN-13. `libro` dice se è un ISBN, cioè se ha senso chiederlo a un
 * catalogo di libri. Restituisce null se non è un codice.
 */
function leggiCodice(grezzo) {
  const testo = String(grezzo ?? "").replace(/[\s-]/g, "").toUpperCase();

  if (/^\d{13}$/.test(testo)) {
    if (controlloEan(testo.slice(0, 12)) !== Number(testo[12])) return null;

    return { codice: testo, libro: /^97[89]/.test(testo) };
  }

  if (/^\d{9}[\dX]$/.test(testo)) {
    const somma = [...testo].slice(0, 9).reduce((s, c, i) => s + Number(c) * (10 - i), 0);
    const controllo = (11 - (somma % 11)) % 11;

    if ((controllo === 10 ? "X" : String(controllo)) !== testo[9]) return null;

    const dodici = `978${testo.slice(0, 9)}`;

    return { codice: `${dodici}${controlloEan(dodici)}`, libro: true };
  }

  return null;
}

/** Solo l'ISBN-13, o null: per chi vuole sapere soltanto «è un libro?». */
function normalizzaIsbn(grezzo) {
  const letto = leggiCodice(grezzo);

  return letto?.libro ? letto.codice : null;
}

/** Le cifre piccole accanto al codice: cinque, altrimenti niente (vedi in testa perché non due). */
function leggiAggiunta(grezzo) {
  const testo = String(grezzo ?? "").replace(/\s/g, "");

  return /^\d{5}$/.test(testo) ? testo : null;
}

/* ==================================================
   LA SERIE
   ================================================== */

// Parole che dicono QUALE edizione è, non quale serie: «One Piece. New Edition» è One Piece.
const PAROLE_EDIZIONE =
  /\b(new edition|nuova edizione|perfect edition|ultimate edition|deluxe edition|complete edition|collector'?s edition|final edition|kanzenban|deluxe|ultimate|perfect|omnibus|collection|color|colour|full color|variant|limited|edition|edizione|ristampa)\b/gi;

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

/**
 * Cerca fra le vostre serie quella di cui parla il catalogo.
 *
 * Restituisce `{ sicura, candidate }`:
 *   - `sicura` è la serie, quando non c'è dubbio: stesso titolo (tolte le parole di
 *     edizione), una sola edizione possibile, editore non in contrasto;
 *   - altrimenti `candidate` sono le proposte da confermare a mano, le più probabili prima.
 *
 * La prudenza è voluta. «Dragon Ball Super 5» comincia come «Dragon Ball», ma dire «ce
 * l'hai» a chi ha solo Dragon Ball sarebbe la risposta sbagliata nel momento peggiore
 * (davanti allo scaffale): un titolo solo SIMILE non è mai sicuro, si propone e basta.
 */
function abbina(libro, serie) {
  const intero = ossa(libro.titoloIntero || libro.titolo || libro.serie);
  const titolo = ossa(libro.serie);
  const senzaEdizione = ossa(String(libro.serie || "").replace(PAROLE_EDIZIONE, " "));

  if (!titolo) return { sicura: null, candidate: [] };

  const uguali = serie.filter((s) => {
    const t = ossa(s.Titolo);

    return t && (t === titolo || t === senzaEdizione);
  });

  if (!uguali.length) {
    // Titoli che cominciano allo stesso modo, in un verso o nell'altro. Almeno quattro
    // lettere in comune: «Ai» non deve proporre «Aishiteruze Baby».
    const simili = serie
      .filter((s) => {
        const t = ossa(s.Titolo);

        return t.length >= 4 && senzaEdizione.length >= 4 && (senzaEdizione.startsWith(t) || t.startsWith(senzaEdizione));
      })
      .sort((a, b) => ossa(b.Titolo).length - ossa(a.Titolo).length);

    return { sicura: null, candidate: simili };
  }

  const b = editoreDi(libro.editore);
  const stessoEditore = (s) => {
    const a = editoreDi(s.Editore);

    return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
  };
  // Tutti e due dicono l'editore e non è lo stesso: può essere un'altra edizione, che non
  // avete. Si chiede conferma invece di rispondere per quella che avete.
  const contrasto = (s) => Boolean(editoreDi(s.Editore) && b && !stessoEditore(s));
  const seSicura = (s) => (contrasto(s) ? { sicura: null, candidate: uguali } : { sicura: s, candidate: uguali });

  // Un solo titolo uguale fra le vostre serie: è quella, anche se il catalogo scrive un altro
  // editore (li scrive in cento modi). Se è sbagliata si corregge dalla pagina.
  if (uguali.length === 1) return { sicura: uguali[0], candidate: uguali };

  // Più edizioni con lo stesso titolo. Prima il nome dell'edizione, se il catalogo lo scrive…
  const perNome = uguali.filter((s) => edizioneDi(s.Edizione) && intero.includes(edizioneDi(s.Edizione)));

  if (perNome.length === 1) return seSicura(perNome[0]);

  // …poi l'editore, ma solo se lo dicono tutti e due: «non lo so» non è una prova…
  const perEditore = (perNome.length ? perNome : uguali).filter(stessoEditore);

  if (perEditore.length === 1) return { sicura: perEditore[0], candidate: uguali };

  // …e infine: il catalogo non nomina nessuna edizione, e fra le vostre ce n'è una sola
  // «normale» (senza nome). Un titolo nudo è l'edizione nuda.
  const semplici = (perEditore.length ? perEditore : uguali).filter((s) => !edizioneDi(s.Edizione));

  if (!perNome.length && titolo === senzaEdizione && semplici.length === 1) return seSicura(semplici[0]);

  return { sicura: null, candidate: perEditore.length ? perEditore : perNome.length ? perNome : uguali };
}

/* ==================================================
   I CATALOGHI
   ================================================== */

// Lo stesso codice inquadrato due volte in fumetteria non deve costare due richieste: Google
// Books ha una quota al giorno. Un giorno per le risposte, un'ora per i «non lo conosco»
// (potrebbe essere stato un momento storto). Sta in memoria: si svuota a ogni riavvio.
const MEMORIA = new Map();
const MEMORIA_MASSIMA = 500;
const UN_GIORNO = 24 * 60 * 60 * 1000;

function ricorda(codice, libro) {
  if (MEMORIA.size >= MEMORIA_MASSIMA) MEMORIA.delete(MEMORIA.keys().next().value);

  MEMORIA.set(codice, { libro, scade: Date.now() + (libro ? UN_GIORNO : UN_GIORNO / 24) });
}

function svuotaMemoria() {
  MEMORIA.clear();
}

const cataloghiVeri = () => [
  require("./providers/googleBooks").perIsbn,
  require("./providers/openLibrary").perIsbn
];

/**
 * Chiede il codice ai cataloghi, uno dopo l'altro, e si ferma al primo che risponde.
 * Restituisce `{ libro, motivo }`: `motivo` c'è solo se nessuno ha risposto E almeno uno
 * ha dato errore (quota finita, rete giù), cioè quando «non lo conosco» non è una risposta
 * vera e non va ricordata.
 */
async function chiediAiCataloghi(codice, cataloghi) {
  const inMemoria = MEMORIA.get(codice);

  if (inMemoria && inMemoria.scade > Date.now()) return { libro: inMemoria.libro };

  let motivo = null;

  for (const cerca of cataloghi) {
    try {
      const libro = await cerca(codice);

      if (libro?.serie) {
        ricorda(codice, libro);

        return { libro };
      }
    } catch (err) {
      motivo = motivo || err.message;
    }
  }

  if (!motivo && cataloghi.length) ricorda(codice, null);

  return { libro: null, motivo };
}

/* ==================================================
   LA RISPOSTA
   ================================================== */

const COLONNE = `"ID", "Titolo", "Edizione", "Editore", "CoverURL", "NumeriPosseduti"`;
const COLONNE_M = COLONNE.split(", ")
  .map((c) => `m.${c}`)
  .join(", ");

/**
 * @param {object} pool
 * @param {string} grezzo     il codice, letto o scritto
 * @param {object} [opzioni]
 * @param {string} [opzioni.aggiunta]   le cinque cifre piccole accanto al codice
 * @param {number} [opzioni.numero]     il volume, detto a mano: serve quando il codice vale per la serie
 * @param {Function[]} [opzioni.cataloghi]  per le prove
 */
async function riconosci(pool, grezzo, { aggiunta: aggiuntaGrezza, numero: numeroDetto, cataloghi } = {}) {
  const letto = leggiCodice(grezzo);

  if (!letto) return { codice: null, stato: "codice_non_valido" };

  const { codice, libro: eUnLibro } = letto;
  const aggiunta = eUnLibro ? null : leggiAggiunta(aggiuntaGrezza);
  const base = { codice, aggiunta, libro: eUnLibro };

  // 1. Già collegato: prima il volume preciso (codice + aggiunta), poi il codice solo.
  const chiavi = aggiunta ? [`${codice}-${aggiunta}`, codice] : [codice];
  const { rows: noti } = await pool.query(
    `SELECT ${COLONNE_M}, i.isbn AS chiave, i.numero
       FROM isbn_volumi i JOIN "Manga" m ON m."ID" = i.manga_id
      WHERE i.isbn = ANY($1::text[])`,
    [chiavi]
  );

  const noto = chiavi.map((k) => noti.find((r) => r.chiave === k)).find(Boolean);

  if (noto) {
    const numero = noto.numero ?? (Number.isInteger(numeroDetto) && numeroDetto > 0 ? numeroDetto : null);
    const risposta = { ...base, fonte: "collegato", serie: dellaSerie(noto), numero };

    // Il codice vale per la serie e il numero non si sa ancora: lo dice chi ha il volume in mano.
    return numero ? { ...risposta, ...stato(noto, numero) } : { ...risposta, stato: "che_volume" };
  }

  // 2. Non è un ISBN: nessun catalogo di libri lo conosce, inutile (e scortese) chiedere.
  if (!eUnLibro) return { ...base, stato: "non_riconosciuto", periodico: true };

  const { libro, motivo } = await chiediAiCataloghi(codice, cataloghi || cataloghiVeri());

  if (!libro) return { ...base, stato: "non_riconosciuto", ...(motivo ? { motivo } : {}) };

  const trovato = {
    ...base,
    fonte: libro.fonte || "catalogo",
    titolo: libro.titolo,
    serieTitolo: libro.serie,
    numero: libro.numero ?? null,
    editore: libro.editore || null,
    copertina: libro.copertina || null,
    prezzoCopertina: libro.prezzoCopertina ?? null
  };

  const { rows: serie } = await pool.query(`SELECT ${COLONNE} FROM "Manga"`);
  const { sicura, candidate } = abbina(libro, serie);

  if (!candidate.length) return { ...trovato, stato: "non_in_collezione" };

  if (!sicura) return { ...trovato, stato: "scegli", candidate: candidate.slice(0, 6).map(dellaSerie) };

  // La serie è sicura ma il catalogo non dice il numero: non si rimette in dubbio la serie,
  // si chiede solo quello. (Senza numero «ce l'hai» o «ti manca» sarebbe tirare a indovinare.)
  if (!trovato.numero) return { ...trovato, serie: dellaSerie(sicura), stato: "che_volume" };

  return { ...trovato, serie: dellaSerie(sicura), ...stato(sicura, trovato.numero) };
}

class CollegamentoNonValido extends Error {}

/**
 * Ricorda che questo codice è quel volume di quella serie, e risponde subito come
 * `riconosci`. Se il codice era già collegato, vale l'ultima parola.
 *
 *   ISBN                          → `codice` = quel volume
 *   da edicola, con l'aggiunta    → `codice-aggiunta` = quel volume, e `codice` = la serie
 *                                   (se il codice solo non era già di qualcuno)
 *   da edicola, senza l'aggiunta  → `codice` = la serie; il numero vale solo per la risposta
 *
 * `cambiaSerie` serve a correggere: il codice solo passa a questa serie anche se era già di
 * un'altra («non è Berserk, è Vagabond»). Senza, la prima serie collegata resta.
 */
async function collega(pool, { codice: grezzo, isbn, aggiunta: aggiuntaGrezza, mangaId, numero, cambiaSerie = false }) {
  const letto = leggiCodice(grezzo ?? isbn);
  const n = Number(numero);
  const id = Number(mangaId);

  if (!letto) throw new CollegamentoNonValido("Codice non valido");
  if (!Number.isInteger(n) || n < 1 || n > 999) throw new CollegamentoNonValido("Numero di volume non valido");
  if (!Number.isInteger(id)) throw new CollegamentoNonValido("Serie non trovata");

  const { rowCount } = await pool.query(`SELECT 1 FROM "Manga" WHERE "ID" = $1`, [id]);

  if (!rowCount) throw new CollegamentoNonValido("Serie non trovata");

  const aggiunta = letto.libro ? null : leggiAggiunta(aggiuntaGrezza);
  const scrivi = (chiave, num) =>
    pool.query(
      `INSERT INTO isbn_volumi (isbn, manga_id, numero) VALUES ($1, $2, $3)
       ON CONFLICT (isbn) DO UPDATE SET manga_id = EXCLUDED.manga_id, numero = EXCLUDED.numero`,
      [chiave, id, num]
    );

  if (letto.libro) {
    await scrivi(letto.codice, n);
  } else if (aggiunta) {
    await scrivi(`${letto.codice}-${aggiunta}`, n);
    // Il codice solo resta della serie che aveva, se ne aveva una: una collana può ospitare
    // più serie, e la prima collegata non va scalzata da un numero di un'altra.
    if (cambiaSerie === true) await scrivi(letto.codice, null);
    else {
      await pool.query(
        `INSERT INTO isbn_volumi (isbn, manga_id, numero) VALUES ($1, $2, NULL) ON CONFLICT (isbn) DO NOTHING`,
        [letto.codice, id]
      );
    }
  } else {
    await scrivi(letto.codice, null);
  }

  return riconosci(pool, letto.codice, { aggiunta, numero: n, cataloghi: [] });
}

/**
 * Dimentica tutto quello che si sapeva di un codice: il volume (codice-aggiunta) e, per i
 * codici da edicola, anche la serie (codice solo). Chi dice «dimenticalo» ha il volume in
 * mano e ha visto una risposta sbagliata: non deve sapere in quale delle due righe stava.
 */
async function scollega(pool, { codice: grezzo, aggiunta: aggiuntaGrezza }) {
  const letto = leggiCodice(grezzo);

  if (!letto) throw new CollegamentoNonValido("Codice non valido");

  const aggiunta = letto.libro ? null : leggiAggiunta(aggiuntaGrezza);
  const { rowCount } = await pool.query(`DELETE FROM isbn_volumi WHERE isbn = ANY($1::text[])`, [
    aggiunta ? [`${letto.codice}-${aggiunta}`, letto.codice] : [letto.codice]
  ]);

  return { tolti: rowCount };
}

module.exports = {
  leggiCodice,
  leggiAggiunta,
  normalizzaIsbn,
  abbina,
  stato,
  riconosci,
  collega,
  scollega,
  svuotaMemoria,
  CollegamentoNonValido
};
