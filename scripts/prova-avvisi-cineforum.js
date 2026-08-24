/**
 * La 020 sui dati veri, senza toccarli.
 *
 * Stesso trucco di `prova-cineforum.js`: la migrazione si applica
 * dentro una transazione, il servizio parla con quel client invece che
 * col pool, e alla fine ROLLBACK — il database resta com'era.
 *
 * Prova le tre cose che la 020 porta con sé:
 *
 *   1. lo SQL gira, e il fuoco delle immagini parte al centro
 *   2. serie e film si dividono per quante puntate hanno, non più per
 *      la colonna `tipo` (e il conto DEVE cambiare rispetto a prima,
 *      o la modifica non sta facendo niente)
 *   3. la campanella dice cose vere: chi ha risposto a chi, chi ha
 *      messo un cuore a chi, chi ha commentato una serie che l'altro
 *      ha visto
 *
 * Uso:
 *   node scripts/prova-avvisi-cineforum.js
 */

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const pool = require("../db");
const cineforum = require("../services/cineforum");
const campanella = require("../services/campanella");

const MIGRAZIONE = path.join(__dirname, "..", "sql", "020_fuoco_e_campanella.sql");

function titolo(testo) {
  console.log(`\n${"═".repeat(64)}\n${testo}\n${"═".repeat(64)}`);
}

(async () => {
  const cliente = await pool.connect();

  try {
    await cliente.query("SET lock_timeout = '5s'");
    await cliente.query("SET statement_timeout = '120s'");
    await cliente.query("BEGIN");

    titolo("1 · la migrazione 020");

    await cliente.query(fs.readFileSync(MIGRAZIONE, "utf8"));

    console.log("✅ nessun errore SQL");

    const { rows: fuochi } = await cliente.query(
      `SELECT COUNT(*)::int AS quante,
              COUNT(*) FILTER (WHERE fuoco_x <> 50 OR fuoco_y <> 50)::int AS spostate
         FROM utenti_striscione`
    );

    console.log(
      `   immagini di striscione: ${fuochi[0].quante}, non centrate: ${fuochi[0].spostate} (devono essere 0)`
    );

    // Spostarne una e rileggerla: è tutto quello che fa la rotta.
    const { rows: una } = await cliente.query(
      `SELECT id, utente_id FROM utenti_striscione ORDER BY id LIMIT 1`
    );

    if (una.length) {
      await cliente.query(`UPDATE utenti_striscione SET fuoco_y = 20 WHERE id = $1`, [una[0].id]);

      const { rows: riletta } = await cliente.query(
        `SELECT fuoco_x, fuoco_y FROM utenti_striscione WHERE id = $1`,
        [una[0].id]
      );

      console.log(`   spostata l'immagine ${una[0].id}: ${riletta[0].fuoco_x}% ${riletta[0].fuoco_y}%`);
    } else {
      console.log("   (nessuna immagine di striscione da spostare)");
    }

    const finto = { query: (...a) => cliente.query(...a), connect: async () => cliente };

    const { rows: gente } = await cliente.query(
      `SELECT id, nickname FROM utenti WHERE stato = 'attivo' ORDER BY proprietario DESC, creato_il`
    );

    titolo("2 · serie e film, divisi per quante puntate hanno");

    for (const persona of gente) {
      const s = await cineforum.statistiche(finto, persona.id);

      // Il conto vecchio, per vedere se la modifica cambia qualcosa.
      const { rows: prima } = await cliente.query(
        `
        SELECT COUNT(DISTINCT COALESCE('g' || a.gruppo_id, 'a' || a.id))::int AS serie,
               COUNT(*) FILTER (WHERE a.tipo = 'film')::int                   AS film
          FROM visioni vis JOIN anime a ON a.id = vis.anime_id
         WHERE vis.utente_id = $1
        `,
        [persona.id]
      );

      console.log(
        `── ${persona.nickname}: serie ${prima[0].serie} → ${s.serie}, film ${prima[0].film} → ${s.film}` +
          `  (visti ${s.episodi})`
      );
    }

    // Le schede che cambiano casella: quelle che AnimeClick non chiama
    // «film» ma che hanno una puntata sola, e viceversa.
    const { rows: strane } = await cliente.query(
      `
      SELECT a.tipo, a.titolo,
             COALESCE(NULLIF(a.episodi_totali, 0),
                      NULLIF((SELECT COUNT(*)::int FROM anime_episodi e WHERE e.anime_id = a.id), 0)
             ) AS puntate
        FROM anime a
       WHERE EXISTS (SELECT 1 FROM visioni v WHERE v.anime_id = a.id)
         AND (
           (a.tipo <> 'film' AND COALESCE(NULLIF(a.episodi_totali, 0),
              NULLIF((SELECT COUNT(*)::int FROM anime_episodi e WHERE e.anime_id = a.id), 0)) = 1)
           OR
           (a.tipo = 'film' AND COALESCE(NULLIF(a.episodi_totali, 0),
              NULLIF((SELECT COUNT(*)::int FROM anime_episodi e WHERE e.anime_id = a.id), 0)) > 1)
         )
       ORDER BY a.tipo, a.titolo
       LIMIT 12
      `
    );

    console.log(`\n   schede che cambiano casella (prime ${strane.length}):`);

    for (const r of strane) {
      console.log(`     · ${r.titolo} — tipo «${r.tipo}», ${r.puntate} puntate`);
    }

    titolo("3 · la campanella di ciascuno");

    for (const persona of gente) {
      const esito = await campanella.avvisi(finto, persona.id);

      console.log(
        `── ${persona.nickname}: ${esito.avvisi.length} avvisi negli ultimi ${campanella.GIORNI} giorni, ` +
          `${esito.daLeggere} da leggere`
      );

      for (const a of esito.avvisi.slice(0, 5)) {
        const quando = new Date(a.quando).toLocaleString("it-IT", { timeZone: cineforum.FUSO });

        const dice =
          a.tipo === "nota"
            ? `ha commentato ${a.anime.titolo}${a.numeroEpisodio ? ` ep. ${a.numeroEpisodio}` : ""}`
            : a.tipo === "cuore"
              ? `ha messo un cuore a ${a.post}`
              : `ha risposto a ${a.post}${a.tuo ? "" : " (non è tuo: ci hai solo scritto)"}`;

        console.log(`     · ${quando} — ${a.chi.nickname} ${dice}`);
      }
    }

    titolo("4 · «ho letto» spegne il pallino");

    if (gente.length) {
      const chi = gente[0];

      await campanella.segnaLetti(finto, chi.id);

      const dopo = await campanella.avvisi(finto, chi.id);

      console.log(
        `${chi.nickname}: da leggere dopo aver aperto la campanella → ${dopo.daLeggere} (deve essere 0)`
      );
    }

    await cliente.query("ROLLBACK");

    console.log("\n↩️  ROLLBACK: il database è rimasto com'era.\n");
  } catch (err) {
    await cliente.query("ROLLBACK").catch(() => {});
    console.error("\n❌", err.message, "\n", err.stack);
    process.exitCode = 1;
  } finally {
    cliente.release();
    await pool.end();
  }
})();
