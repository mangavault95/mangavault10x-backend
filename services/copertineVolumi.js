// Una copertina per ogni volume (sql/030_copertine_volumi.sql).
//
// Le pagine delle edizioni di AnimeClick le scarica il giro di GitHub
// (`.github/workflows/copertine-volumi.yml`): poche serie al giorno, una
// richiesta ogni tanti secondi, con la firma dichiarata del progetto. Qui si
// dice quali serie leggere, si riceve l'HTML e si scrive.
//
// Chi si rilegge: una serie mai letta viene prima di tutte; una serie in corso
// si rilegge dopo RILEGGI_GIORNI (escono volumi nuovi); una conclusa non si
// rilegge più se l'ultima lettura ha trovato qualcosa, e si riprova dopo
// RITENTA_GIORNI se non aveva trovato niente.

const { copertineVolumi, indirizzoImmagine } = require("./providers/animeclick");

/**
 * Un indirizzo salvato prima del 15/11/2026 può avere ancora le entità HTML dentro
 * (`Yu-Gi-Oh&#33;1.jpg`: vedi `indirizzoImmagine`). Si ripara leggendolo, così si
 * aggiustano anche le serie concluse, che il giro non rilegge più.
 */
const riparato = (indirizzo) => (/&(#\d+|#x[0-9a-f]+|[a-z]+);/i.test(indirizzo) ? indirizzoImmagine(indirizzo) || indirizzo : indirizzo);

const RILEGGI_GIORNI = 30;
const RITENTA_GIORNI = 60;

const assente = (err) => err?.code === "42P01";

/** Le prossime serie da leggere, al massimo `quanti`. */
async function daLeggere(pool, { quanti = 20 } = {}) {
  const { rows } = await pool.query(
    `SELECT m."ID" AS manga_id, m."AnimeClickID" AS animeclick_id
       FROM "Manga" m
       LEFT JOIN copertine_giri g ON g.manga_id = m."ID"
      WHERE m."AnimeClickID" IS NOT NULL
        AND (g.manga_id IS NULL
             OR (m."StatoSerie" = 'in_corso' AND g.letta_il < NOW() - ($2 || ' days')::interval)
             OR (g.trovate = 0 AND g.letta_il < NOW() - ($3 || ' days')::interval))
      ORDER BY g.letta_il NULLS FIRST, m."ID"
      LIMIT $1`,
    [Math.max(1, Math.min(40, Number(quanti) || 20)), String(RILEGGI_GIORNI), String(RITENTA_GIORNI)]
  );

  return rows.map((r) => ({ manga_id: Number(r.manga_id), animeclick_id: Number(r.animeclick_id) }));
}

/** Scrive com'è andata la lettura di una serie, senza toccare le copertine. */
async function segnaGiro(pool, mangaId, esito, trovate = 0) {
  await pool.query(
    `INSERT INTO copertine_giri (manga_id, letta_il, esito, trovate) VALUES ($1, NOW(), $2, $3)
     ON CONFLICT (manga_id) DO UPDATE
        SET letta_il = NOW(), esito = EXCLUDED.esito,
            -- Una lettura andata male non cancella quello che si sapeva.
            trovate = GREATEST(copertine_giri.trovate, EXCLUDED.trovate)`,
    [mangaId, String(esito).slice(0, 200), trovate]
  );
}

/**
 * Riceve la pagina delle edizioni di una serie e scrive le copertine dei volumi.
 * Restituisce `{ trovate, scritte }`. Una pagina che non è la tabella delle
 * edizioni lancia: chi chiama lo segna come giro fallito.
 */
async function registraPagina(pool, mangaId, html, { scrivi = true } = {}) {
  const { rows } = await pool.query(`SELECT "ID", "Edizione" FROM "Manga" WHERE "ID" = $1`, [mangaId]);

  if (!rows[0]) throw new Error("serie non trovata");

  const volumi = copertineVolumi(html, { edizione: rows[0].Edizione || null });

  if (!scrivi) return { trovate: volumi.length, scritte: 0 };

  let scritte = 0;

  if (volumi.length) {
    const esito = await pool.query(
      `INSERT INTO copertine_volumi (manga_id, numero, copertina)
       SELECT $1, n, c FROM UNNEST($2::int[], $3::text[]) AS x(n, c)
       ON CONFLICT (manga_id, numero) DO UPDATE
          SET copertina = EXCLUDED.copertina, aggiornata_il = NOW()
        -- Una copertina scelta a mano (034) non si riscrive.
        WHERE copertine_volumi.copertina IS DISTINCT FROM EXCLUDED.copertina
          AND NOT copertine_volumi.manuale`,
      [mangaId, volumi.map((v) => v.numero), volumi.map((v) => v.copertina)]
    );

    scritte = esito.rowCount;
  }

  await segnaGiro(pool, mangaId, "ok", volumi.length);

  return { trovate: volumi.length, scritte };
}

/**
 * Tutte le copertine, per il sito: `{ [mangaId]: { [numero]: indirizzo } }`.
 * Gli indirizzi sono tutti di AnimeClick e cominciano uguale: si manda solo
 * quello che cambia (`base` + percorso), che su quattromila righe è metà del peso.
 */
async function tutte(pool) {
  const base = "https://www.animeclick.it";

  try {
    const { rows } = await pool.query(`SELECT manga_id, numero, copertina FROM copertine_volumi ORDER BY manga_id, numero`);
    const copertine = {};

    for (const r of rows) {
      const copertina = riparato(r.copertina);

      (copertine[r.manga_id] ||= {})[r.numero] = copertina.startsWith(base) ? copertina.slice(base.length) : copertina;
    }

    return { base, copertine };
  } catch (err) {
    // La 030 non è ancora passata: il sito mostra la copertina della serie, come prima.
    if (assente(err)) return { base, copertine: {} };
    throw err;
  }
}

/**
 * Mette a mano la copertina di un volume (`indirizzo` testo) o la toglie
 * (`indirizzo` null): toglierla rimette la serie in testa al prossimo giro,
 * che la rilegge da AnimeClick. Restituisce `{ errore }` o `{ ok: true }`.
 */
async function scegli(pool, mangaId, numero, indirizzo) {
  if (!Number.isInteger(numero) || numero < 1) return { errore: "Il volume è un numero intero dall'1 in su" };

  if (indirizzo == null || String(indirizzo).trim() === "") {
    const { rowCount } = await pool.query(
      `DELETE FROM copertine_volumi WHERE manga_id = $1 AND numero = $2 AND manuale`,
      [mangaId, numero]
    );

    // Rilettura alla prossima occasione: senza riga, il volume resterebbe vuoto fino ai 30 giorni.
    if (rowCount) await pool.query(`DELETE FROM copertine_giri WHERE manga_id = $1`, [mangaId]);

    return { ok: true, tolta: rowCount > 0 };
  }

  const testo = String(indirizzo).trim();
  let url;

  try {
    url = new URL(testo);
  } catch {
    return { errore: "L'indirizzo della copertina non è valido" };
  }

  if (url.protocol !== "https:" || testo.length > 2000) {
    return { errore: "L'indirizzo deve cominciare con https:// ed essere più corto di 2000 caratteri" };
  }

  const esito = await pool.query(
    `INSERT INTO copertine_volumi (manga_id, numero, copertina, manuale)
     VALUES ($1, $2, $3, TRUE)
     ON CONFLICT (manga_id, numero) DO UPDATE
        SET copertina = EXCLUDED.copertina, manuale = TRUE, aggiornata_il = NOW()`,
    [mangaId, numero, testo]
  );

  return { ok: true, scritta: esito.rowCount > 0 };
}

module.exports = { riparato, scegli, daLeggere, registraPagina, segnaGiro, tutte, RILEGGI_GIORNI, RITENTA_GIORNI };
