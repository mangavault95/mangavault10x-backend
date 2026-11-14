// routes/animeclick.js
//
// Il passaggio delle pagine di AnimeClick da GitHub Actions al backend, per i lavori che da
// Render verrebbero rifiutati (403): calendario degli anime, schede degli anime, rapporto dei
// volumi. Il perché e il flusso sono in `services/pagineAnimeClick.js` e in sql/032.
//
//   GET  /api/animeclick/stato          la fonte è in pausa?
//   GET  /api/animeclick/da-scaricare   quali indirizzi scaricare per un lavoro (o: in pausa)
//   POST /api/animeclick/pagina         una pagina scaricata, da tenere in attesa del lavoro
//   POST /api/animeclick/esito          com'è andato lo scaricamento: un rifiuto o un successo
//
// Tutte protette dal segreto del cron. La contabilità dei fallimenti è quella di sempre
// (`animeclick`, services/fontiStato.js): è la stessa fonte, dallo stesso GitHub, con la stessa
// regola: sette giri rifiutati di fila, due settimane di pausa.

const express = require("express");
const pool = require("../db");
const { richiedeSegretoCron } = require("../services/segretoCron");
const fonti = require("../services/fontiStato");
const pagine = require("../services/pagineAnimeClick");
const { avvisaProprietario } = require("../services/avvisoProprietario");
const { serieDaAggiornare } = require("../services/videoteca");
const { serieDaControllare } = require("../services/rapportoVolumi");

const router = express.Router();

router.use(richiedeSegretoCron);

/** Nel dubbio si prova: una pausa che non si legge non deve fermare il lavoro. */
async function statoFonte() {
  try {
    return await fonti.leggi(pool, "animeclick");
  } catch (err) {
    console.warn("Stato di AnimeClick non letto:", err.message);

    return null;
  }
}

router.get("/stato", async (req, res) => {
  const stato = await statoFonte();

  return res.json({
    tentare: fonti.puoiTentare(stato),
    in_pausa_fino: stato?.in_pausa_fino || null,
    fallimenti_di_fila: Number(stato?.fallimenti_di_fila || 0)
  });
});

router.get("/da-scaricare", async (req, res) => {
  const lavoro = String(req.query.lavoro || "");

  if (!["calendario", "schede", "rapporto"].includes(lavoro)) {
    return res.status(400).json({ error: "lavoro deve essere calendario, schede o rapporto" });
  }

  try {
    const stato = await statoFonte();

    if (!fonti.puoiTentare(stato)) {
      return res.json({ tentare: false, in_pausa_fino: stato.in_pausa_fino, urls: [] });
    }

    let urls;

    if (lavoro === "calendario") {
      urls = pagine.urlsCalendario();
    } else if (lavoro === "schede") {
      const quante = Math.min(40, Math.max(1, Number(req.query.quante) || 10));
      const serie = await serieDaAggiornare(pool, { giorni: 7, quante });

      urls = serie.filter((s) => s.animeclick_id).flatMap((s) => pagine.urlsScheda(s.animeclick_id));
    } else {
      const controllaStato = req.query.stato === "1";
      const serie = await serieDaControllare(pool);

      urls = serie.flatMap((s) => pagine.urlsRapportoSerie(s, { controllaStato }));
    }

    return res.json({ tentare: true, in_pausa_fino: null, urls });
  } catch (err) {
    console.error("ANIMECLICK DA SCARICARE ERROR:", err.message);

    return res.status(500).json({ error: "Errore server" });
  }
});

router.post("/pagina", async (req, res) => {
  try {
    const byte = await pagine.salva(pool, req.body?.url, req.body?.html);

    return res.json({ success: true, byte });
  } catch (err) {
    if (err instanceof pagine.PaginaNonAmmessa) return res.status(400).json({ error: err.message });

    console.error("ANIMECLICK PAGINA ERROR:", err.message);

    return res.status(500).json({ error: "Errore server" });
  }
});

/**
 * Body: { riuscito: boolean, motivo?: string, lavoro?: string, prova?: boolean }
 * Un rifiuto conta UN fallimento per giro (non uno per pagina); sette di fila mettono la fonte in
 * pausa e avvisano il proprietario. Con `prova` non si scrive niente.
 */
router.post("/esito", async (req, res) => {
  const { riuscito, motivo, lavoro, prova } = req.body || {};

  if (typeof riuscito !== "boolean") return res.status(400).json({ error: "riuscito deve essere vero o falso" });

  try {
    if (prova === true) return res.json({ success: true, prova: true });

    if (riuscito) {
      const eraInErrore = await fonti.segnaRiuscito(pool, "animeclick");

      return res.json({ success: true, dopo_fallimenti: eraInErrore });
    }

    const stato = await fonti.segnaFallito(pool, "animeclick", String(motivo || "rifiutato").slice(0, 200));

    if (stato.appenaInPausa) {
      await avvisaProprietario(
        pool,
        `⚠️ AnimeClick non si riesce a leggere da ${stato.fallimenti_di_fila} giri di fila` +
          `${lavoro ? ` (ultimo: ${String(lavoro).slice(0, 40)})` : ""}. ` +
          `Smetto di provare per ${fonti.PAUSA_GIORNI} giorni; poi riprovo. Ultimo errore: ${String(motivo || "rifiutato").slice(0, 100)}`
      );
    }

    return res.json({
      success: true,
      fallimenti_di_fila: stato.fallimenti_di_fila,
      in_pausa_fino: stato.in_pausa_fino || null
    });
  } catch (err) {
    console.error("ANIMECLICK ESITO ERROR:", err.message);

    return res.status(500).json({ error: "Errore server" });
  }
});

module.exports = router;
