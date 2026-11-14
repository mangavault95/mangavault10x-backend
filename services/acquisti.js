/**
 * Gli acquisti registrati dal sito.
 *
 * Fino al 04/10/2026 l'unico modo di registrare un volume comprato era
 * il bot di Telegram (`mangavault10x-bot`): «berserk 42» e via. Adesso
 * lo stesso gesto si fa anche dalla casella Cerca del sito, e le regole
 * sono LE STESSE del bot — copiate apposta, non reinventate, perché due
 * modi di scrivere la stessa riga in `acquisti` con due logiche diverse
 * vorrebbero dire due conti della spesa che non tornano:
 *
 *   - i volumi contigui vanno in un acquisto solo (42-44), quelli con un
 *     buco in mezzo in acquisti separati: la tabella ragiona per
 *     intervalli e non saprebbe rappresentare un salto;
 *   - il prezzo scritto è il TOTALE della riga, diviso fra i blocchi in
 *     proporzione ai volumi, con i centesimi che avanzano sull'ultimo;
 *   - il volume comprato entra nell'ELENCO dei posseduti (dal 02/11/2026,
 *     migrazione 022): chi ha 1-41 e compra il 45 ha 1-41 e 45, e il
 *     buco 42-44 va detto (lo dice chi chiama, con `mancano`), non
 *     nascosto. Il conteggio lo ricava da sé il trigger della 022.
 *
 * Una differenza voluta: senza prezzo il bot va a cercarlo su
 * AnimeClick; qui si usa il prezzo di copertina della scheda, e se non
 * c'è nemmeno quello il costo di sempre. Dal sito la stima si vede
 * prima di premere, e chi la vuole diversa la scrive.
 */

const MASSIMO_VOLUMI = 60;

/** 42,43,44,46 → [{da:42,a:44},{da:46,a:46}] */
function blocchi(volumi) {
  const gruppi = [];

  for (const v of [...new Set(volumi)].sort((a, b) => a - b)) {
    const ultimo = gruppi[gruppi.length - 1];

    if (ultimo && v === ultimo.a + 1) ultimo.a = v;
    else gruppi.push({ da: v, a: v });
  }

  return gruppi;
}

/** Il totale diviso fra i blocchi; la somma dei pezzi torna sempre al totale. */
function ripartisci(totale, gruppi) {
  const volumiTotali = gruppi.reduce((s, g) => s + (g.a - g.da + 1), 0);
  const centesimi = Math.round(totale * 100);

  let assegnati = 0;

  return gruppi.map((g, i) => {
    const quanti = g.a - g.da + 1;
    const quota =
      i === gruppi.length - 1 ? centesimi - assegnati : Math.round((centesimi * quanti) / volumiTotali);

    assegnati += quota;

    return { ...g, prezzo: quota / 100 };
  });
}

function oggiInItalia() {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Rome" }).format(new Date());
}

class AcquistoNonValido extends Error {}

/**
 * I numeri di un blocco che in casa c'erano già prima dell'acquisto.
 *
 * Si scrivono accanto all'acquisto (migrazione 027) perché l'annullo
 * deve togliere solo quello che l'acquisto ha PORTATO: un doppione
 * registrato apposta parla di un volume che c'era, e disfarlo non deve
 * far sparire anche la copia di prima.
 *
 * ⚠️ gemella: `giaInCasa` in mangavault10x-bot/src/collezione.js.
 */
function giaInCasa(gruppo, avevo) {
  const numeri = [];

  for (let n = gruppo.da; n <= gruppo.a; n += 1) if (avevo.has(n)) numeri.push(n);

  return numeri;
}

/**
 * Toglie dai posseduti i numeri di un acquisto annullato, tranne quelli
 * che c'erano già ($4). Per gli acquisti di prima della 027 la colonna
 * è vuota e si toglie tutto l'intervallo, come si è sempre fatto.
 *
 * ⚠️ gemella: `TOGLI_NUMERI` in mangavault10x-bot/src/collezione.js.
 */
const TOGLI_NUMERI = `
  UPDATE "Manga"
     SET "NumeriPosseduti" = ARRAY(
           SELECT n FROM unnest("NumeriPosseduti") AS n
            WHERE NOT (n BETWEEN $1 AND $2 AND n <> ALL($4::int[]))
            ORDER BY n
         )
   WHERE "ID" = $3`;

/** Il primo numero che non c'è: in [1,2,3,4,5,11] è il 6, non il 12. */
function primoMancante(posseduti) {
  const presenti = new Set(posseduti);
  let n = 1;

  while (presenti.has(n)) n += 1;

  return n;
}

/**
 * Registra uno o più volumi di una serie.
 *
 * `volumi` vuoto vuol dire «il prossimo», cioè il primo che manca: per
 * una serie sparsa è il primo buco, non quello dopo il più alto.
 * `prezzo` è il totale; `null` usa la stima della scheda.
 */
async function registraAcquisto(pool, { mangaId, volumi = null, prezzo = null, data = null }) {
  const cliente = await pool.connect();

  try {
    await cliente.query("BEGIN");

    const { rows } = await cliente.query(
      `SELECT "ID", "Titolo", "NumeriPosseduti", "VolumiItalia", "VolumiTotali", "PrezzoCopertina", "Costo"
         FROM "Manga" WHERE "ID" = $1 FOR UPDATE`,
      [mangaId]
    );

    if (!rows.length) throw new AcquistoNonValido("Questa serie non è in collezione");

    const serie = rows[0];
    const posseduti = (serie.NumeriPosseduti || []).map(Number);

    const numeri = (volumi && volumi.length ? volumi : [primoMancante(posseduti)]).map(Number);

    if (numeri.some((n) => !Number.isInteger(n) || n < 1)) throw new AcquistoNonValido("Volumi non validi");
    if (numeri.length > MASSIMO_VOLUMI) throw new AcquistoNonValido("Troppi volumi in un acquisto solo");

    const unitario = Number(serie.PrezzoCopertina) || Number(serie.Costo) || 0;
    const totale = prezzo == null ? unitario * new Set(numeri).size : Number(prezzo);

    if (!Number.isFinite(totale) || totale < 0) throw new AcquistoNonValido("Prezzo non valido");

    const giorno = /^\d{4}-\d{2}-\d{2}$/.test(String(data || "")) ? data : oggiInItalia();
    const gruppi = ripartisci(totale, blocchi(numeri));
    const scritti = [];
    const avevo = new Set(posseduti);

    for (const g of gruppi) {
      const { rows: riga } = await cliente.query(
        `INSERT INTO acquisti (manga_id, volume_da, volume_a, prezzo, data_acquisto, condizione, gia_posseduti)
         VALUES ($1, $2, $3, $4, $5, 'nuovo', $6::int[])
         RETURNING id, volume_da, volume_a, prezzo, data_acquisto`,
        [mangaId, g.da, g.a, g.prezzo, giorno, giaInCasa(g, avevo)]
      );

      scritti.push(riga[0]);
    }

    // Ordine, doppioni e conteggio li sistema il trigger della 022.
    const { rows: aggiornata } = await cliente.query(
      `UPDATE "Manga" SET "NumeriPosseduti" = "NumeriPosseduti" || $1::int[]
        WHERE "ID" = $2 RETURNING "VolumiPosseduti", "NumeriPosseduti"`,
      [numeri, mangaId]
    );

    await cliente.query("COMMIT");

    // Il buco prima del primo volume comprato, cioè quelli sotto di lui
    // che ancora mancano: chi chiama lo dice.
    const primo = Math.min(...numeri);
    const dopo = new Set(aggiornata[0].NumeriPosseduti.map(Number));
    const buchi = [];

    for (let n = 1; n < primo; n += 1) if (!dopo.has(n)) buchi.push(n);

    return {
      serie: {
        id: Number(serie.ID),
        titolo: serie.Titolo,
        posseduti: Number(aggiornata[0].VolumiPosseduti),
        numeri: [...dopo]
      },
      acquisti: scritti.map((r) => Number(r.id)),
      volumi: [...new Set(numeri)].sort((a, b) => a - b),
      totale,
      stimato: prezzo == null,
      mancano: buchi.length ? { da: buchi[0], a: buchi[buchi.length - 1], quanti: buchi.length } : null
    };
  } catch (errore) {
    await cliente.query("ROLLBACK").catch(() => {});
    throw errore;
  } finally {
    cliente.release();
  }
}

/**
 * Disfa degli acquisti appena registrati: toglie le righe e toglie dai
 * posseduti i numeri che quelle righe avevano portato. Solo le righe
 * nominate, e solo se esistono ancora — un secondo tocco su «Annulla»
 * non deve togliere due volte.
 */
async function annullaAcquisti(pool, ids) {
  const numeri = (Array.isArray(ids) ? ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);

  if (!numeri.length) throw new AcquistoNonValido("Niente da annullare");

  const cliente = await pool.connect();

  try {
    await cliente.query("BEGIN");

    const { rows } = await cliente.query(
      `DELETE FROM acquisti WHERE id = ANY($1::bigint[]) RETURNING manga_id, volume_da, volume_a, gia_posseduti`,
      [numeri]
    );

    for (const r of rows) {
      await cliente.query(TOGLI_NUMERI, [r.volume_da, r.volume_a, r.manga_id, r.gia_posseduti || []]);
    }

    await cliente.query("COMMIT");

    return { annullati: rows.length };
  } catch (errore) {
    await cliente.query("ROLLBACK").catch(() => {});
    throw errore;
  } finally {
    cliente.release();
  }
}

module.exports = {
  registraAcquisto,
  annullaAcquisti,
  blocchi,
  ripartisci,
  primoMancante,
  giaInCasa,
  TOGLI_NUMERI,
  AcquistoNonValido
};
