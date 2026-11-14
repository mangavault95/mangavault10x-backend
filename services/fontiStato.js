// Lo stato di una fonte esterna che a volte ci chiude la porta (oggi: AnimeClick).
//
// La regola, decisa il 14/11/2026:
//   - ogni giro PROVA la fonte, se non è in pausa;
//   - se un giro fallisce, quel giro ripiega su un'altra fonte (lo fa chi chiama);
//   - dopo SOGLIA fallimenti di fila la fonte va in pausa per PAUSA_GIORNI giorni:
//     in quei giorni non la si disturba, poi si riprova;
//   - un tentativo riuscito azzera il conto.
//
// La parte che decide è pura (`dopoFallimento`, `puoiTentare`) e si prova senza
// database. La tabella è sql/029_fonte_stato.sql: se non c'è ancora, si tenta
// sempre e non si ricorda niente, come prima.

const SOGLIA = 7;
const PAUSA_GIORNI = 14;

const GIORNO = 24 * 60 * 60 * 1000;

/** Si può provare adesso? `stato` è la riga della tabella, o null se la fonte non ha ancora una storia. */
function puoiTentare(stato, adesso = new Date()) {
  const fino = stato?.in_pausa_fino ? new Date(stato.in_pausa_fino) : null;

  return !(fino && fino > adesso);
}

/** Cosa diventa lo stato dopo un tentativo fallito. */
function dopoFallimento(stato, esito, adesso = new Date()) {
  const fallimenti = Number(stato?.fallimenti_di_fila || 0) + 1;
  const andataInPausa = fallimenti >= SOGLIA;

  return {
    fallimenti_di_fila: fallimenti,
    ultimo_tentativo: adesso,
    ultimo_esito: String(esito || "fallito").slice(0, 200),
    in_pausa_fino: andataInPausa ? new Date(adesso.getTime() + PAUSA_GIORNI * GIORNO) : null,
    appenaInPausa: andataInPausa
  };
}

const tabellaAssente = (err) => err?.code === "42P01";

async function leggi(pool, fonte) {
  try {
    const { rows } = await pool.query(`SELECT * FROM fonte_stato WHERE fonte = $1`, [fonte]);

    return rows[0] || null;
  } catch (err) {
    if (tabellaAssente(err)) return null;
    throw err;
  }
}

async function scrivi(pool, fonte, s) {
  try {
    await pool.query(
      `INSERT INTO fonte_stato (fonte, fallimenti_di_fila, ultimo_tentativo, ultimo_esito, ultimo_ok, in_pausa_fino)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (fonte) DO UPDATE
          SET fallimenti_di_fila = EXCLUDED.fallimenti_di_fila,
              ultimo_tentativo = EXCLUDED.ultimo_tentativo,
              ultimo_esito = EXCLUDED.ultimo_esito,
              ultimo_ok = COALESCE(EXCLUDED.ultimo_ok, fonte_stato.ultimo_ok),
              in_pausa_fino = EXCLUDED.in_pausa_fino`,
      [fonte, s.fallimenti_di_fila, s.ultimo_tentativo, s.ultimo_esito, s.ultimo_ok || null, s.in_pausa_fino]
    );
  } catch (err) {
    if (!tabellaAssente(err)) throw err;
  }
}

async function segnaFallito(pool, fonte, esito, adesso = new Date()) {
  const prima = await leggi(pool, fonte);
  const dopo = dopoFallimento(prima, esito, adesso);

  await scrivi(pool, fonte, dopo);

  return dopo;
}

/** Un tentativo riuscito azzera il conto e toglie la pausa. Restituisce quanti fallimenti c'erano. */
async function segnaRiuscito(pool, fonte, adesso = new Date()) {
  const prima = await leggi(pool, fonte);

  await scrivi(pool, fonte, {
    fallimenti_di_fila: 0,
    ultimo_tentativo: adesso,
    ultimo_esito: "ok",
    ultimo_ok: adesso,
    in_pausa_fino: null
  });

  return Number(prima?.fallimenti_di_fila || 0);
}

module.exports = { SOGLIA, PAUSA_GIORNI, puoiTentare, dopoFallimento, leggi, segnaFallito, segnaRiuscito };
