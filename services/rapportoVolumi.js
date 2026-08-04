// services/rapportoVolumi.js
//
// Il giro su tutte le serie in corso mappate su AnimeClick, che
// decide cosa scrivere in "VolumiItalia". Usato da due chiamanti:
// scripts/rapporto-volumi.js (a mano, dal terminale) e la rotta
// POST /api/manga/rapporto-volumi (dal job schedulato su GitHub
// Actions) — la logica sta qui una volta sola perché uno dei due
// che la riscrivesse per conto suo finirebbe per divergere.

const { controllaSerie } = require("./volumiItaliani");

const PAUSA_MS_DEFAULT = 1500; // gentile con AnimeClick: non è un'API pensata per questo

/**
 * @param pool     connessione pg già pronta
 * @param scrivi   se falso, decide tutto ma non tocca il database
 * @param pausaMs  attesa fra una scheda e l'altra
 * @param log      chiamata una riga alla volta, per chi vuole seguirlo dal vivo
 */
async function eseguiRapportoVolumi(pool, { scrivi = false, pausaMs = PAUSA_MS_DEFAULT, log = () => {} } = {}) {
  const { rows } = await pool.query(`
    SELECT "ID", "Titolo", "Edizione", "Editore", "VolumiPosseduti",
           "VolumiItalia", "StatoSerie", "AnimeClickID"
      FROM "Manga"
     WHERE "StatoSerie" = 'in_corso'
     ORDER BY "AnimeClickID" IS NULL, "Titolo"`);

  const mappate = rows.filter((r) => r.AnimeClickID).length;

  log(`${rows.length} serie in corso — ${mappate} con AnimeClickID, ${rows.length - mappate} da mappare`);
  log(scrivi ? "MODALITÀ SCRITTURA" : "prova a vuoto: non verrà scritto niente");

  const conteggi = {};
  const daControllare = [];
  const righe = [];
  let scritte = 0;

  for (const r of rows) {
    const { esito, decisione } = await controllaSerie(r);

    conteggi[decisione.azione] = (conteggi[decisione.azione] || 0) + 1;

    if (decisione.azione === "non_mappata") continue;

    righe.push({ titolo: r.Titolo, decisione, esito });

    log(
      `  ${String(r.Titolo).trim()} — ${decisione.motivo}` +
        (esito ? ` (AC=${esito.massimo ?? "-"})` : "")
    );

    if (decisione.azione === "da_controllare") {
      daControllare.push(`${String(r.Titolo).trim()} → ${decisione.motivo} (${esito?.url || "?"})`);
    }

    if (scrivi && decisione.azione === "scrivi") {
      await pool.query('UPDATE "Manga" SET "VolumiItalia" = $1 WHERE "ID" = $2', [
        decisione.valore,
        r.ID
      ]);
      scritte++;
    }

    await new Promise((x) => setTimeout(x, pausaMs));
  }

  return {
    totale: rows.length,
    mappate,
    conteggi,
    daControllare,
    righe,
    scritte,
    scrivi
  };
}

module.exports = { eseguiRapportoVolumi };
