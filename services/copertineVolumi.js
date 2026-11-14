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

const { copertineVolumi } = require("./providers/animeclick");

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
        WHERE copertine_volumi.copertina IS DISTINCT FROM EXCLUDED.copertina`,
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
      (copertine[r.manga_id] ||= {})[r.numero] = r.copertina.startsWith(base) ? r.copertina.slice(base.length) : r.copertina;
    }

    return { base, copertine };
  } catch (err) {
    // La 030 non è ancora passata: il sito mostra la copertina della serie, come prima.
    if (assente(err)) return { base, copertine: {} };
    throw err;
  }
}

module.exports = { daLeggere, registraPagina, segnaGiro, tutte, RILEGGI_GIORNI, RITENTA_GIORNI };
