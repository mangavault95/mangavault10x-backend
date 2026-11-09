// services/rapportoVolumi.js
//
// Il giro su tutte le serie in corso mappate su AnimeClick, che
// decide cosa scrivere in "VolumiItalia". Usato da due chiamanti:
// scripts/rapporto-volumi.js (a mano, dal terminale) e la rotta
// POST /api/manga/rapporto-volumi (dal job schedulato su GitHub
// Actions) — la logica sta qui una volta sola perché uno dei due
// che la riscrivesse per conto suo finirebbe per divergere.

const { controllaSerie, decidiStato, decidiAggiornamento } = require("./volumiItaliani");
const { riempiArchivio, ultimoVolumeUscito, SCARTO_MASSIMO } = require("./volumiDaUscite");
const { statoItalianoDi } = require("./providers/animeclick");
const { concludeSecondoAniList } = require("./concludeDaAniList");

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
    SELECT "ID", "Titolo", "Autore", "Edizione", "Editore", "VolumiPosseduti",
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

  // La riserva: se AnimeClick non risponde (verifica anti-bot, 403), il
  // numero si prende dall'archivio delle uscite di Fumettologica. L'archivio
  // si riempie una volta sola, alla prima serie che ne ha bisogno.
  let archivioPronto = false;
  let daRiserva = 0;
  let riempimento = null;

  for (const r of rows) {
    let { esito, decisione } = await controllaSerie(r);

    if (decisione.azione === "errore") {
      try {
        if (!archivioPronto) {
          archivioPronto = true;
          riempimento = await riempiArchivio(pool, rows, { scrivi });
          log(`Riserva Fumettologica: ${riempimento.lette} articoli letti, ${riempimento.nuove} uscite nuove`);
        }

        const trovato = await ultimoVolumeUscito(pool, r, { extra: riempimento?.uscite });

        const base = Math.max(Number(r.VolumiItalia) || 0, Number(r.VolumiPosseduti) || 0);

        if (trovato != null && trovato - base > SCARTO_MASSIMO) {
          // Troppo avanti per essere vero: non si scrive, lo vede una persona.
          decisione = {
            azione: "da_controllare",
            valore: trovato,
            motivo: `[Fumettologica] trovato ${trovato} contro ${base} che si sapeva: scarto di ${trovato - base}, forse un'altra edizione o la light novel`
          };
          esito = { massimo: trovato, riserva: true, url: "fumettologica" };
        } else if (trovato != null) {
          decisione = decidiAggiornamento({
            attuale: r.VolumiItalia ?? null,
            posseduti: Number(r.VolumiPosseduti) || 0,
            trovato,
            statoSerie: r.StatoSerie,
            totaleGiappone: r.VolumiTotali == null ? null : Number(r.VolumiTotali)
          });
          decisione = { ...decisione, motivo: `[Fumettologica] ${decisione.motivo}` };
          esito = { massimo: trovato, riserva: true, url: "fumettologica" };
          daRiserva++;
        }
      } catch (e) {
        decisione = { ...decisione, motivo: `${decisione.motivo}; riserva non riuscita: ${e.message}` };
      }
    }

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
    if (controllaStato && r.StatoSerie === "in_corso" && (esito || r.VolumiItalia)) {
      try {
        const ultimoVolume = Math.max(esito?.massimo || 0, Number(r.VolumiItalia) || 0) || null;

        // Prima la scheda italiana di AnimeClick, se si lascia leggere.
        let letto = { stato: null, etichette: [] };

        // Se la scheda AnimeClick non ha risposto nemmeno per i volumi, inutile riprovare per lo stato.
        if (esito && !esito.riserva) {
          letto = await statoItalianoDi(r.AnimeClickID);

          for (const e of letto.etichette) etichetteViste.add(e);
        }

        // Altrimenti (o se non ne esce niente) lo si deduce da AniList:
        // opera finita di N volumi e in Italia usciti N o più.
        let fonteStato = "AnimeClick";
        let motivoAniList = null;

        if (letto.stato == null) {
          const dedotto = await concludeSecondoAniList(r, ultimoVolume);

          motivoAniList = dedotto.motivo;

          if (dedotto.conclusa) {
            letto = { ...letto, stato: "conclusa" };
            fonteStato = `AniList: ${dedotto.motivo}`;
          }
        }

        const verdetto = decidiStato({
          statoAttuale: r.StatoSerie,
          statoItalia: letto.stato,
          ultimoVolume
        });

        if (verdetto.azione === "concludi") verdetto.motivo += ` [${fonteStato}]`;

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
          statoNonLetto.push(`${String(r.Titolo).trim()} (${motivoAniList || "stato non letto"})`);
        }

        await new Promise((x) => setTimeout(x, Math.max(pausaMs, 1500)));
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
    // Quante serie hanno avuto il numero dalla riserva e non da AnimeClick.
    daRiserva,
    riempimentoArchivio: riempimento && { lette: riempimento.lette, nuove: riempimento.nuove, errori: riempimento.errori },
    // Serie passate (o da passare, in prova) a «conclusa».
    concluse,
    // Serie di cui la scheda non dice lo stato italiano: se sono molte,
    // il parser non riconosce la voce giusta e va guardato `etichetteStato`.
    statoNonLetto,
    etichetteStato: [...etichetteViste].slice(0, 12)
  };
}

module.exports = { eseguiRapportoVolumi };
