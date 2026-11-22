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
// RITENTA_GIORNI se non aveva trovato niente. Una serie letta con una versione del
// lettore più vecchia di quella di oggi (`VERSIONE_LETTURA`) si rilegge comunque:
// le correzioni al lettore non arrivavano mai alle serie concluse.
// Davanti a tutte, le serie con un volume in uscita senza copertina (`conUsciteSenzaCopertina`).

const { copertineVolumi, indirizzoImmagine } = require("./providers/animeclick");

/**
 * Un indirizzo salvato prima del 15/11/2026 può avere ancora le entità HTML dentro
 * (`Yu-Gi-Oh&#33;1.jpg`: vedi `indirizzoImmagine`). Si ripara leggendolo, così si
 * aggiustano anche le serie concluse, che il giro non rilegge più.
 */
const riparato = (indirizzo) => (/&(#\d+|#x[0-9a-f]+|[a-z]+);/i.test(indirizzo) ? indirizzoImmagine(indirizzo) || indirizzo : indirizzo);

const RILEGGI_GIORNI = 30;
const RITENTA_GIORNI = 60;

// Una serie con un volume in uscita senza copertina si rilegge al massimo ogni tre giorni:
// AnimeClick mette la miniatura di un volume nuovo qualche giorno prima o dopo l'uscita,
// e rileggere ogni giorno sarebbe chiedere troppo al sito per una pagina che non cambia.
const USCITA_GIORNI = 3;

/**
 * La versione del lettore delle pagine (`copertineVolumi` in providers/animeclick.js).
 * SI ALZA quando il lettore cambia in un modo che può cambiare le copertine scelte
 * (nuove regole su edizione, editore, variant): le serie lette con una versione più
 * bassa tornano in coda e si rileggono, anche se sono concluse. Colonna: sql/036.
 *
 *   1  edizione esatta, editore, edizione base davanti alle variant (14-17/11/2026)
 */
const VERSIONE_LETTURA = 1;

const assente = (err) => err?.code === "42P01";
const colonnaAssente = (err) => err?.code === "42703";

/**
 * Le prossime serie da leggere, al massimo `quanti`.
 *
 * Con `titolo` (un pezzo del titolo, senza badare alle maiuscole) si saltano le regole
 * di sopra e si dà quella serie, o quelle: serve a rileggerne una a mano, o a guardare
 * cosa scrive il lettore (lavoro «Copertine dei volumi», campo «titolo»).
 */
async function daLeggere(pool, { quanti = 20, titolo = null } = {}) {
  const limite = Math.max(1, Math.min(40, Number(quanti) || 20));
  const cercato = String(titolo ?? "").trim();

  if (cercato) {
    // `%` e `_` del titolo cercato valgono come lettere, non come jolly.
    const pezzo = `%${cercato.slice(0, 80).replace(/[\\%_]/g, "\\$&")}%`;
    const { rows } = await pool.query(
      `SELECT "ID" AS manga_id, "AnimeClickID" AS animeclick_id
         FROM "Manga"
        WHERE "AnimeClickID" IS NOT NULL AND "Titolo" ILIKE $1
        ORDER BY "ID"
        LIMIT $2`,
      [pezzo, limite]
    );

    return rows.map((r) => ({ manga_id: Number(r.manga_id), animeclick_id: Number(r.animeclick_id) }));
  }

  // Prima le serie con un volume in uscita (da un mese fa a sei settimane) che non ha
  // ancora la sua copertina: sono quelle che si vedono nella pagina Uscite e nella home.
  const urgenti = await conUsciteSenzaCopertina(pool, limite);

  const query = (conVersione) =>
    pool.query(
      `SELECT m."ID" AS manga_id, m."AnimeClickID" AS animeclick_id
         FROM "Manga" m
         LEFT JOIN copertine_giri g ON g.manga_id = m."ID"
        WHERE m."AnimeClickID" IS NOT NULL
          AND (g.manga_id IS NULL
               OR (m."StatoSerie" = 'in_corso' AND g.letta_il < NOW() - ($2 || ' days')::interval)
               OR (g.trovate = 0 AND g.letta_il < NOW() - ($3 || ' days')::interval)
               ${conVersione ? "OR g.versione < $4" : ""})
        ORDER BY g.letta_il NULLS FIRST, m."ID"
        LIMIT $1`,
      [limite, String(RILEGGI_GIORNI), String(RITENTA_GIORNI), ...(conVersione ? [VERSIONE_LETTURA] : [])]
    );

  let esito;

  try {
    esito = await query(true);
  } catch (err) {
    // La 036 non è ancora passata: valgono le regole di prima.
    if (!colonnaAssente(err)) throw err;

    esito = await query(false);
  }

  const visti = new Set(urgenti.map((r) => r.manga_id));
  const altre = esito.rows
    .map((r) => ({ manga_id: Number(r.manga_id), animeclick_id: Number(r.animeclick_id) }))
    .filter((r) => !visti.has(r.manga_id));

  return [...urgenti, ...altre].slice(0, limite);
}

/**
 * Le serie della collezione con un volume in uscita che non ha copertina in
 * `copertine_volumi`, lette da più di `USCITA_GIORNI` giorni (o mai). Al massimo `quanti`.
 *
 * È un anticipo, non una regola: se l'archivio delle uscite non c'è o la lettura non
 * riesce, la coda è quella di sempre.
 */
async function conUsciteSenzaCopertina(pool, quanti) {
  try {
    const { abbinaAllaCollezione, oggiInItalia, piuGiorni } = require("./usciteManga");
    const oggi = oggiInItalia();
    const { rows } = await pool.query(
      `SELECT data::text AS data, serie, numero, titolo, edizione, editore, copertina
         FROM uscite_manga
        WHERE data > $1::date AND data <= $2::date`,
      [piuGiorni(oggi, -30), piuGiorni(oggi, 45)]
    );

    const uscite = await abbinaAllaCollezione(pool, rows);

    if (uscite.length === 0) return [];

    const { rows: presenti } = await pool.query(
      `SELECT manga_id, numero FROM copertine_volumi WHERE manga_id = ANY($1::int[])`,
      [[...new Set(uscite.map((u) => u.serie.id))]]
    );

    const ci = new Set(presenti.map((r) => `${r.manga_id}:${r.numero}`));
    const senza = [...new Set(uscite.filter((u) => !ci.has(`${u.serie.id}:${u.numero}`)).map((u) => u.serie.id))];

    if (senza.length === 0) return [];

    const { rows: serie } = await pool.query(
      `SELECT m."ID" AS manga_id, m."AnimeClickID" AS animeclick_id
         FROM "Manga" m
         LEFT JOIN copertine_giri g ON g.manga_id = m."ID"
        WHERE m."ID" = ANY($1::int[])
          AND m."AnimeClickID" IS NOT NULL
          AND (g.manga_id IS NULL OR g.letta_il < NOW() - ($2 || ' days')::interval)
        ORDER BY g.letta_il NULLS FIRST, m."ID"
        LIMIT $3`,
      [senza, String(USCITA_GIORNI), quanti]
    );

    return serie.map((r) => ({ manga_id: Number(r.manga_id), animeclick_id: Number(r.animeclick_id) }));
  } catch (err) {
    // Senza archivio delle uscite (o con un database più vecchio) non c'è niente da anticipare.
    if (!assente(err) && !colonnaAssente(err)) console.error("COPERTINE USCITE IN CODA ERROR:", err.message);

    return [];
  }
}

/** Scrive com'è andata la lettura di una serie, senza toccare le copertine. */
async function segnaGiro(pool, mangaId, esito, trovate = 0) {
  const scrivi = (conVersione) =>
    pool.query(
      `INSERT INTO copertine_giri (manga_id, letta_il, esito, trovate${conVersione ? ", versione" : ""})
       VALUES ($1, NOW(), $2, $3${conVersione ? ", $4" : ""})
       ON CONFLICT (manga_id) DO UPDATE
          SET letta_il = NOW(), esito = EXCLUDED.esito,
              -- Una lettura andata male non cancella quello che si sapeva.
              trovate = GREATEST(copertine_giri.trovate, EXCLUDED.trovate)${conVersione ? ", versione = EXCLUDED.versione" : ""}`,
      [mangaId, String(esito).slice(0, 200), trovate, ...(conVersione ? [VERSIONE_LETTURA] : [])]
    );

  try {
    await scrivi(true);
  } catch (err) {
    // La 036 non è ancora passata.
    if (!colonnaAssente(err)) throw err;

    await scrivi(false);
  }
}

/**
 * La copertina della SERIE è quella del suo primo volume, da AnimeClick.
 *
 * `"Manga"."CoverURL"` nasceva da AniList, MyAnimeList o da una ricerca immagini:
 * copertine dell'edizione giapponese o americana, o di un'altra serie con lo
 * stesso titolo, a volte un indirizzo scaduto. In `copertine_volumi` c'è invece
 * la copertina dell'edizione italiana che si possiede (scelta con l'editore).
 * Qui la si porta nella serie: il volume 1, e se manca quello col numero più
 * basso (è sempre meglio di una copertina estera).
 *
 * Non tocca le serie che non hanno nessuna copertina di volume: per quelle resta
 * quella che c'era finché il giro di AnimeClick non le legge. Una copertina messa
 * a mano nella scheda della serie si perde alla prossima lettura: per sceglierla
 * a mano si sceglie quella del volume 1 (`scegli`), e la serie la segue.
 *
 * `mangaId` null = tutte le serie. `scrivi:false` conta e non scrive.
 * Restituisce `{ esaminate, cambiate, elenco: [{ manga_id, titolo, da, a }] }`.
 */
async function allineaSerie(pool, { mangaId = null, scrivi = true } = {}) {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (c.manga_id) c.manga_id, m."Titolo" AS titolo, c.copertina, m."CoverURL" AS attuale
       FROM copertine_volumi c
       JOIN "Manga" m ON m."ID" = c.manga_id
      WHERE ($1::int IS NULL OR c.manga_id = $1)
      ORDER BY c.manga_id, c.numero`,
    [mangaId]
  );

  const elenco = rows
    .map((r) => ({ manga_id: Number(r.manga_id), titolo: r.titolo, da: r.attuale || null, a: riparato(r.copertina) }))
    .filter((r) => r.da !== r.a);

  if (scrivi && elenco.length) {
    await pool.query(
      `UPDATE "Manga" m SET "CoverURL" = x.copertina
         FROM UNNEST($1::int[], $2::text[]) AS x(id, copertina)
        WHERE m."ID" = x.id`,
      [elenco.map((r) => r.manga_id), elenco.map((r) => r.a)]
    );
  }

  return { esaminate: rows.length, cambiate: elenco.length, elenco };
}

/**
 * Riceve la pagina delle edizioni di una serie e scrive le copertine dei volumi.
 * Restituisce `{ trovate, scritte }`. Una pagina che non è la tabella delle
 * edizioni lancia: chi chiama lo segna come giro fallito. Con `diagnosi` aggiunge
 * `diagnosi`: cosa ha visto il lettore (vedi `copertineVolumi`).
 */
async function registraPagina(pool, mangaId, html, { scrivi = true, diagnosi = false } = {}) {
  const { rows } = await pool.query(`SELECT "ID", "Titolo", "Edizione", "Editore" FROM "Manga" WHERE "ID" = $1`, [mangaId]);

  if (!rows[0]) throw new Error("serie non trovata");

  const nota = diagnosi ? {} : null;
  const volumi = copertineVolumi(html, { edizione: rows[0].Edizione || null, editore: rows[0].Editore || null, titolo: rows[0].Titolo || null, diagnosi: nota });

  if (!scrivi) return { trovate: volumi.length, scritte: 0, ...(nota ? { diagnosi: nota } : {}) };

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

  // La copertina della serie segue il volume 1. Se non riesce, le copertine dei volumi
  // sono già scritte e il giro è già segnato: non si fa fallire la lettura per questo.
  let copertinaSerie = false;

  try {
    copertinaSerie = (await allineaSerie(pool, { mangaId })).cambiate > 0;
  } catch (err) {
    console.error("COPERTINA SERIE ERROR:", err.message);
  }

  return { trovate: volumi.length, scritte, copertinaSerie, ...(nota ? { diagnosi: nota } : {}) };
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

  // Il volume 1 scelto a mano è anche la copertina della serie.
  const serie = await allineaSerie(pool, { mangaId });

  return { ok: true, scritta: esito.rowCount > 0, copertinaSerie: serie.cambiate > 0 };
}

module.exports = { riparato, allineaSerie, scegli, daLeggere, conUsciteSenzaCopertina, registraPagina, segnaGiro, tutte, RILEGGI_GIORNI, RITENTA_GIORNI, USCITA_GIORNI, VERSIONE_LETTURA };
