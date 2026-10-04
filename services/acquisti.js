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
 *     proporzione ai volumi, con i centesimi che avanzano sul primo;
 *   - il contatore dei posseduti si INCREMENTA, non si porta al numero
 *     del volume: chi ne ha 41 e compra il 45 ne ha 42, e il buco va
 *     detto (lo dice chi chiama, con `mancano`), non nascosto.
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
 * Registra uno o più volumi di una serie.
 *
 * `volumi` vuoto vuol dire «il prossimo» (posseduti + 1), come nel bot.
 * `prezzo` è il totale; `null` usa la stima della scheda.
 */
async function registraAcquisto(pool, { mangaId, volumi = null, prezzo = null, data = null }) {
  const cliente = await pool.connect();

  try {
    await cliente.query("BEGIN");

    const { rows } = await cliente.query(
      `SELECT "ID", "Titolo", "VolumiPosseduti", "VolumiItalia", "VolumiTotali", "PrezzoCopertina", "Costo"
         FROM "Manga" WHERE "ID" = $1 FOR UPDATE`,
      [mangaId]
    );

    if (!rows.length) throw new AcquistoNonValido("Questa serie non è in collezione");

    const serie = rows[0];
    const posseduti = Number(serie.VolumiPosseduti) || 0;

    const numeri = (volumi && volumi.length ? volumi : [posseduti + 1]).map(Number);

    if (numeri.some((n) => !Number.isInteger(n) || n < 1)) throw new AcquistoNonValido("Volumi non validi");
    if (numeri.length > MASSIMO_VOLUMI) throw new AcquistoNonValido("Troppi volumi in un acquisto solo");

    const unitario = Number(serie.PrezzoCopertina) || Number(serie.Costo) || 0;
    const totale = prezzo == null ? unitario * new Set(numeri).size : Number(prezzo);

    if (!Number.isFinite(totale) || totale < 0) throw new AcquistoNonValido("Prezzo non valido");

    const giorno = /^\d{4}-\d{2}-\d{2}$/.test(String(data || "")) ? data : oggiInItalia();
    const gruppi = ripartisci(totale, blocchi(numeri));
    const scritti = [];

    for (const g of gruppi) {
      const { rows: riga } = await cliente.query(
        `INSERT INTO acquisti (manga_id, volume_da, volume_a, prezzo, data_acquisto, condizione)
         VALUES ($1, $2, $3, $4, $5, 'nuovo')
         RETURNING id, volume_da, volume_a, prezzo, data_acquisto`,
        [mangaId, g.da, g.a, g.prezzo, giorno]
      );

      scritti.push(riga[0]);
    }

    const quanti = gruppi.reduce((s, g) => s + (g.a - g.da + 1), 0);

    const { rows: aggiornata } = await cliente.query(
      `UPDATE "Manga" SET "VolumiPosseduti" = COALESCE("VolumiPosseduti", 0) + $1
        WHERE "ID" = $2 RETURNING "VolumiPosseduti"`,
      [quanti, mangaId]
    );

    await cliente.query("COMMIT");

    const primo = Math.min(...numeri);

    return {
      serie: { id: Number(serie.ID), titolo: serie.Titolo, posseduti: Number(aggiornata[0].VolumiPosseduti) },
      acquisti: scritti.map((r) => Number(r.id)),
      volumi: [...new Set(numeri)].sort((a, b) => a - b),
      totale,
      stimato: prezzo == null,
      // Il buco prima del primo volume comprato: chi chiama lo dice.
      mancano: primo > posseduti + 1 ? { da: posseduti + 1, a: primo - 1 } : null
    };
  } catch (errore) {
    await cliente.query("ROLLBACK");
    throw errore;
  } finally {
    cliente.release();
  }
}

/**
 * Disfa degli acquisti appena registrati: toglie le righe e restituisce
 * i volumi al contatore. Solo le righe nominate, e solo se esistono
 * ancora — un secondo tocco su «Annulla» non deve scalare due volte.
 */
async function annullaAcquisti(pool, ids) {
  const numeri = (Array.isArray(ids) ? ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);

  if (!numeri.length) throw new AcquistoNonValido("Niente da annullare");

  const cliente = await pool.connect();

  try {
    await cliente.query("BEGIN");

    const { rows } = await cliente.query(
      `DELETE FROM acquisti WHERE id = ANY($1::bigint[]) RETURNING manga_id, volume_da, volume_a`,
      [numeri]
    );

    const perSerie = new Map();

    for (const r of rows) {
      perSerie.set(r.manga_id, (perSerie.get(r.manga_id) || 0) + (r.volume_a - r.volume_da + 1));
    }

    for (const [mangaId, quanti] of perSerie) {
      await cliente.query(
        `UPDATE "Manga" SET "VolumiPosseduti" = GREATEST(0, COALESCE("VolumiPosseduti", 0) - $1) WHERE "ID" = $2`,
        [quanti, mangaId]
      );
    }

    await cliente.query("COMMIT");

    return { annullati: rows.length };
  } catch (errore) {
    await cliente.query("ROLLBACK");
    throw errore;
  } finally {
    cliente.release();
  }
}

module.exports = { registraAcquisto, annullaAcquisti, blocchi, ripartisci, AcquistoNonValido };
