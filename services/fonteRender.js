// services/fonteRender.js
//
// La regola «se AnimeClick dice di no, ci si ferma» per i lavori che passano da RENDER
// (calendario degli anime, schede degli anime, rapporto dei volumi). Il giro delle uscite
// manga scarica da GitHub e ha la sua contabilità (`animeclick`, vedi routes/manga.js);
// qui la contabilità è SEPARATA (`animeclick-render`), perché Render è rifiutato da giorni
// mentre GitHub no: mescolarle farebbe mettere in pausa il giro che funziona per colpa di
// quello che non funziona, e viceversa.
//
//   - un giro che viene rifiutato conta UN fallimento (non uno per pagina);
//   - sette giri rifiutati di fila mettono Render in pausa per due settimane (stessa regola
//     di `fontiStato`) e il proprietario lo sa;
//   - in pausa i giri non fanno nessuna richiesta ad AnimeClick;
//   - un giro che riesce azzera il conto.

const fonti = require("./fontiStato");
const ac = require("./providers/animeclick");
const { avvisaProprietario } = require("./avvisoProprietario");

const FONTE = "animeclick-render";

/**
 * Da chiamare all'inizio del giro. Se la fonte è in pausa accende il freno (così nessuna
 * richiesta parte) e lo dice; altrimenti segna l'ora di partenza.
 */
async function inizia(pool) {
  const partito = Date.now();
  let stato = null;

  try {
    stato = await fonti.leggi(pool, FONTE);
  } catch (err) {
    // Nel dubbio si prova: una pausa che non si legge non deve fermare il giro.
    console.warn("Stato di AnimeClick (Render) non letto:", err.message);
  }

  if (!fonti.puoiTentare(stato)) {
    ac.sospendiFinoA(stato.in_pausa_fino);

    return { inPausa: true, fino: new Date(stato.in_pausa_fino), partito };
  }

  return { inPausa: false, fino: null, partito };
}

/**
 * Da chiamare alla fine, a giro riuscito o no. Registra un rifiuto o un successo, una volta.
 * Non lancia mai: il conto sbagliato è meglio di una risposta persa.
 */
async function concludi(pool, giro) {
  try {
    const rifiuto = ac.rifiutatoDa(giro.partito);

    if (rifiuto) {
      const dopo = await fonti.segnaFallito(pool, FONTE, `HTTP ${rifiuto.status}`);

      if (dopo.appenaInPausa) {
        await avvisaProprietario(
          pool,
          `⏸ <b>AnimeClick</b> ha rifiutato ${dopo.fallimenti_di_fila} giri di fila da Render (HTTP ${rifiuto.status}).\n` +
            `Calendario anime, schede e rapporto dei volumi non lo disturbano per ${fonti.PAUSA_GIORNI} giorni.`
        );
      }

      return { rifiuto: true, status: rifiuto.status, appenaInPausa: dopo.appenaInPausa };
    }

    if (ac.rispostoDa(giro.partito)) await fonti.segnaRiuscito(pool, FONTE);

    return { rifiuto: false };
  } catch (err) {
    console.warn("Stato di AnimeClick (Render) non aggiornato:", err.message);

    return { rifiuto: false, nonRegistrato: true };
  }
}

module.exports = { FONTE, inizia, concludi };
