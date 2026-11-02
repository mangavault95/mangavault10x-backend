/**
 * Prova la 022 (quali volumi, non quanti) sui dati veri e la ANNULLA.
 *
 * Uso:
 *   node scripts/prova-numeri-posseduti.js
 *
 * Applica la migrazione dentro una transazione, poi mette alla prova il
 * trigger con i gesti che il sito e il bot fanno davvero — compreso il
 * bot VECCHIO, che finché non viene ridistribuito scrive solo il
 * conteggio — e chiude sempre in ROLLBACK.
 *
 * Le prove che devono fallire stanno in un SAVEPOINT: il primo errore
 * voluto, altrimenti, abortirebbe la transazione e tutte le prove dopo.
 */

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const pool = require("../db");

const sql = fs.readFileSync(path.join(__dirname, "..", "sql", "022_numeri_posseduti.sql"), "utf8");

let fallite = 0;

function verifica(nome, ottenuto, atteso) {
  const ok = JSON.stringify(ottenuto) === JSON.stringify(atteso);

  if (!ok) fallite += 1;
  console.log(`${ok ? "✅" : "❌"} ${nome}${ok ? "" : `\n     atteso   ${JSON.stringify(atteso)}\n     ottenuto ${JSON.stringify(ottenuto)}`}`);
}

(async () => {
  const cliente = await pool.connect();

  const riga = async (id) => {
    const { rows } = await cliente.query(
      `SELECT "VolumiPosseduti"::int AS conteggio, "NumeriPosseduti" AS numeri FROM "Manga" WHERE "ID" = $1`,
      [id]
    );
    return rows[0];
  };

  try {
    await cliente.query("SET lock_timeout = '5s'");
    await cliente.query("SET statement_timeout = '120s'");
    await cliente.query("BEGIN");

    // Prima: il conteggio di ogni serie, per confrontarlo dopo.
    const { rows: prima } = await cliente.query(`SELECT "ID", "VolumiPosseduti"::int AS n FROM "Manga"`);

    await cliente.query(sql);
    console.log("▶ 022 applicata (in transazione, verrà annullata)\n");

    // ---- Il riempimento ----
    const { rows: dopo } = await cliente.query(
      `SELECT "ID", "VolumiPosseduti"::int AS n, "NumeriPosseduti" AS numeri FROM "Manga"`
    );
    const perId = new Map(prima.map((r) => [r.ID, r.n]));

    verifica("nessun conteggio è cambiato", dopo.filter((r) => perId.get(r.ID) !== r.n).length, 0);
    verifica(
      "ogni elenco va da 1 a N",
      dopo.filter((r) => r.numeri.length !== r.n || r.numeri.some((v, i) => v !== i + 1)).length,
      0
    );
    verifica(
      "volumi in elenco = volumi contati",
      dopo.reduce((s, r) => s + r.numeri.length, 0),
      prima.reduce((s, r) => s + r.n, 0)
    );

    const { rows: yu } = await cliente.query(`SELECT "ID" FROM "Manga" WHERE "Titolo" ILIKE 'yu-gi-oh%' LIMIT 1`);
    const id = yu[0].ID;

    verifica("Yu-gi-oh dopo la migrazione", await riga(id), { conteggio: 6, numeri: [1, 2, 3, 4, 5, 6] });

    // ---- Il sito scrive l'elenco ----
    await cliente.query(`UPDATE "Manga" SET "NumeriPosseduti" = '{1,2,3,4,5,11}' WHERE "ID" = $1`, [id]);
    verifica("l'elenco sparso detta il conteggio", await riga(id), { conteggio: 6, numeri: [1, 2, 3, 4, 5, 11] });

    await cliente.query(`UPDATE "Manga" SET "NumeriPosseduti" = '{11,3,1,3,2}' WHERE "ID" = $1`, [id]);
    verifica("disordine e doppioni si sistemano", await riga(id), { conteggio: 4, numeri: [1, 2, 3, 11] });

    await cliente.query(
      `UPDATE "Manga" SET "NumeriPosseduti" = '{2,4}', "VolumiPosseduti" = 10 WHERE "ID" = $1`,
      [id]
    );
    verifica("se cambiano tutti e due vince l'elenco", await riga(id), { conteggio: 2, numeri: [2, 4] });

    // Come scrive il backend nuovo un acquisto: aggiunge numeri all'elenco.
    await cliente.query(
      `UPDATE "Manga" SET "NumeriPosseduti" = "NumeriPosseduti" || $1::int[] WHERE "ID" = $2`,
      [[4, 6], id]
    );
    verifica("acquisto dal sito (già posseduto + nuovo)", await riga(id), { conteggio: 3, numeri: [2, 4, 6] });

    // ---- Il bot vecchio scrive solo il conteggio ----
    await cliente.query(`UPDATE "Manga" SET "NumeriPosseduti" = '{1,2,3,4,5,11}' WHERE "ID" = $1`, [id]);
    await cliente.query(
      `UPDATE "Manga" SET "VolumiPosseduti" = COALESCE("VolumiPosseduti", 0) + 2 WHERE "ID" = $1`,
      [id]
    );
    verifica("+2 dal bot vecchio: entrano i primi buchi", await riga(id), {
      conteggio: 8,
      numeri: [1, 2, 3, 4, 5, 6, 7, 11]
    });

    await cliente.query(
      `UPDATE "Manga" SET "VolumiPosseduti" = GREATEST(COALESCE("VolumiPosseduti", 0) - 3, 0) WHERE "ID" = $1`,
      [id]
    );
    verifica("−3 dal bot vecchio: escono i più alti", await riga(id), { conteggio: 5, numeri: [1, 2, 3, 4, 5] });

    await cliente.query(`UPDATE "Manga" SET "VolumiPosseduti" = 0 WHERE "ID" = $1`, [id]);
    verifica("a zero l'elenco si svuota", await riga(id), { conteggio: 0, numeri: [] });

    // ---- Una colonna qualsiasi non tocca niente ----
    await cliente.query(`UPDATE "Manga" SET "NumeriPosseduti" = '{1,5,9}' WHERE "ID" = $1`, [id]);
    await cliente.query(`UPDATE "Manga" SET "Trama" = "Trama" WHERE "ID" = $1`, [id]);
    verifica("cambiare la trama lascia stare i volumi", await riga(id), { conteggio: 3, numeri: [1, 5, 9] });

    // ---- Le serie nuove ----
    const { rows: prossimo } = await cliente.query(`SELECT COALESCE(MAX("ID"), 0) + 1 AS id FROM "Manga"`);
    const nuovo = prossimo[0].id;

    await cliente.query(
      `INSERT INTO "Manga" ("ID", "Titolo", "VolumiPosseduti") VALUES ($1, 'Prova 022', 4)`,
      [nuovo]
    );
    verifica("serie nuova col solo conteggio (wishlist)", await riga(nuovo), { conteggio: 4, numeri: [1, 2, 3, 4] });

    await cliente.query(
      `INSERT INTO "Manga" ("ID", "Titolo", "VolumiPosseduti") VALUES ($1, 'Prova 022 bis', 0)`,
      [nuovo + 1]
    );
    verifica("serie nuova vuota (bot)", await riga(nuovo + 1), { conteggio: 0, numeri: [] });

    // ---- Gli acquisti del sito (services/acquisti.js) ----
    // Il servizio apre e chiude la sua transazione: qui gli si passa un
    // pool finto che traduce BEGIN/COMMIT/ROLLBACK in un SAVEPOINT,
    // altrimenti il suo COMMIT confermerebbe per davvero.
    const { registraAcquisto, annullaAcquisti } = require("../services/acquisti");
    const finto = {
      connect: async () => ({
        query: (testo, valori) => {
          const parola = String(testo).trim().toUpperCase();

          if (parola === "BEGIN") return cliente.query("SAVEPOINT servizio");
          if (parola === "COMMIT") return cliente.query("RELEASE SAVEPOINT servizio");
          if (parola === "ROLLBACK") return cliente.query("ROLLBACK TO SAVEPOINT servizio");

          return cliente.query(testo, valori);
        },
        release: () => {}
      })
    };

    await cliente.query(`UPDATE "Manga" SET "NumeriPosseduti" = '{1,2,3,4,5,11}' WHERE "ID" = $1`, [id]);

    const prossimo6 = await registraAcquisto(finto, { mangaId: id, prezzo: 0 });
    verifica("«il prossimo» è il primo buco, il 6", prossimo6.volumi, [6]);
    verifica("dopo il 6 nessun buco sotto", prossimo6.mancano, null);

    const salto = await registraAcquisto(finto, { mangaId: id, volumi: [9], prezzo: 0 });
    verifica("comprando il 9 si segnalano 7 e 8", salto.mancano, { da: 7, a: 8, quanti: 2 });
    verifica("elenco dopo gli acquisti", await riga(id), { conteggio: 8, numeri: [1, 2, 3, 4, 5, 6, 9, 11] });

    await annullaAcquisti(finto, salto.acquisti);
    verifica("annullare toglie proprio il 9", await riga(id), { conteggio: 7, numeri: [1, 2, 3, 4, 5, 6, 11] });

    // ---- Quello che deve essere rifiutato ----
    await cliente.query("SAVEPOINT rifiuto");
    try {
      await cliente.query(`UPDATE "Manga" SET "NumeriPosseduti" = '{0,1}' WHERE "ID" = $1`, [id]);
      verifica("il volume 0 viene rifiutato", "accettato", "rifiutato");
    } catch (e) {
      verifica("il volume 0 viene rifiutato", e.code, "23514");
    }
    await cliente.query("ROLLBACK TO SAVEPOINT rifiuto");

    // ---- Le viste che leggono il conteggio girano ancora ----
    const { rows: vista } = await cliente.query(`SELECT COUNT(*)::int AS righe FROM v_collezione_riepilogo`);
    verifica("v_collezione_riepilogo risponde", vista[0].righe > 0, true);
  } catch (err) {
    fallite += 1;
    console.error(`\n❌ la prova si è fermata: ${err.message}`);
    if (err.position) console.error(`   posizione: ${err.position}`);
  } finally {
    await cliente.query("ROLLBACK").catch(() => {});
    cliente.release();
    await pool.end();
    console.log(`\n↩ annullata: il database è come prima. ${fallite ? `${fallite} prove fallite.` : "Tutte le prove passate."}`);
    process.exitCode = fallite ? 1 : 0;
  }
})();
