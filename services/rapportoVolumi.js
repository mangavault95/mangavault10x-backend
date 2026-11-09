// services/rapportoVolumi.js
//
// Il giro su tutte le serie in corso mappate su AnimeClick, che
// decide cosa scrivere in "VolumiItalia". Usato da due chiamanti:
// scripts/rapporto-volumi.js (a mano, dal terminale) e la rotta
// POST /api/manga/rapporto-volumi (dal job schedulato su GitHub
// Actions) — la logica sta qui una volta sola perché uno dei due
// che la riscrivesse per conto suo finirebbe per divergere.

const { controllaSerie, decidiStato } = require("./volumiItaliani");
const { statoItalianoDi } = require("./providers/animeclick");

const PAUSA_MS_DEFAULT = 1500; // gentile con AnimeClick: non è un'API pensata per questo

/**
 * @param pool          connessione pg già pronta
 * @param scrivi        se falso, decide tutto ma non tocca il database
 * @param pausaMs       attesa fra una scheda e l'altra
 * @param controllaStato  il giro mensile: per ogni serie in corso legge anche
 *                      lo stato dell'edizione italiana, e quelle concluse
 *                      passano a «conclusa»
 * @param log           chiamata una riga alla volta, per chi vuole seguirlo dal vivo
 */
async function eseguiRapportoVolumi(
  pool,
  { scrivi = false, pausaMs = PAUSA_MS_DEFAULT, controllaStato = false, log = () => {} } = {}
) {
  const { rows } = await pool.query(`
    SELECT "ID", "Titolo", "Edizione", "Editore", "VolumiPosseduti",
           "VolumiItalia", "VolumiTotali", "StatoSerie", "AnimeClickID"
      FROM "Manga"
     WHERE "StatoSerie" = 'in_corso'
        OR ("AnimeClickID" IS NOT NULL
            AND COALESCE("VolumiTotali", 0) > COALESCE("VolumiPosseduti", 0))
     ORDER BY "AnimeClickID" IS NULL, "Titolo"`);

  const mappate = rows.filter((r) => r.AnimeClickID).length;

  log(`${rows.length} serie in corso — ${mappate} con AnimeClickID, ${rows.length - mappate} da mappare`);
  log(scrivi ? "MODALITÀ SCRITTURA" : "prova a vuoto: non verrà scritto niente");

  const conteggi = {};
  const daControllare = [];
  const righe = [];
  const concluse = [];
  const statoNonLetto = [];
  const etichetteViste = new Set();
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

    // Il giro mensile: la serie in corso la cui edizione italiana è
    // finita smette di essere «in corso». Un errore qui non ferma il giro.
    if (controllaStato && r.StatoSerie === "in_corso" && esito) {
      try {
        const letto = await statoItalianoDi(r.AnimeClickID);

        for (const e of letto.etichette) etichetteViste.add(e);

        const verdetto = decidiStato({
          statoAttuale: r.StatoSerie,
          statoItalia: letto.stato,
          ultimoVolume: Math.max(esito.massimo || 0, Number(r.VolumiItalia) || 0) || null
        });

        if (verdetto.azione === "concludi") {
          concluse.push(`${String(r.Titolo).trim()} → ${verdetto.motivo}`);
          log(`  ${String(r.Titolo).trim()} — ${verdetto.motivo}${scrivi ? "" : " (prova)"}`);

          if (scrivi) {
            await pool.query(
              `UPDATE "Manga"
                  SET "StatoSerie" = 'conclusa',
                      "VolumiItalia" = GREATEST(COALESCE("VolumiItalia", 0), $1),
                      "VolumiTotali" = COALESCE("VolumiTotali", $1)
                WHERE "ID" = $2 AND "StatoSerie" = 'in_corso'`,
              [verdetto.valore, r.ID]
            );
          }
        } else if (verdetto.azione === "da_controllare") {
          daControllare.push(`${String(r.Titolo).trim()} → ${verdetto.motivo}`);
        } else if (letto.stato == null) {
          statoNonLetto.push(String(r.Titolo).trim());
        }

        await new Promise((x) => setTimeout(x, Math.min(pausaMs, 800)));
      } catch (e) {
        statoNonLetto.push(`${String(r.Titolo).trim()} (${e.message})`);
      }
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
    scrivi,
    controllaStato,
    // Serie passate (o da passare, in prova) a «conclusa».
    concluse,
    // Serie di cui la scheda non dice lo stato italiano: se sono molte,
    // il parser non riconosce la voce giusta e va guardato `etichetteStato`.
    statoNonLetto,
    etichetteStato: [...etichetteViste].slice(0, 12)
  };
}

module.exports = { eseguiRapportoVolumi };
