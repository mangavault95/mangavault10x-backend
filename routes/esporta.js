// routes/esporta.js
//
// La copia di sicurezza, per il solo proprietario.
//
//   GET  /api/esporta/tutto            tutto, in JSON (la copia vera)
//   GET  /api/esporta/collezione.csv   le serie, per un foglio di calcolo
//   GET  /api/esporta/acquisti.csv     gli acquisti, per un foglio di calcolo
//   POST /api/esporta/promemoria       il messaggio di Telegram del mese (cron)
//
// Solo il proprietario: nel file ci sono le letture e i voti di entrambi, e le
// letture dell'altra persona non vanno in giro con un solo accesso in più.
// I tre GET si chiedono con l'intestazione `Authorization`, quindi il sito li
// scarica con fetch e poi salva il file: un semplice link non basterebbe.

const express = require("express");
const pool = require("../db");
const { requireProprietario } = require("../services/auth");
const { limite } = require("../services/limite");
const { richiedeSegretoCron } = require("../services/segretoCron");
const esportazione = require("../services/esportazione");
const telegram = require("../services/telegram");

const router = express.Router();

// Una copia pesa qualche megabyte e costa dieci query: dieci al quarto d'ora
// bastano a chi sta provando, e fermano un token rubato che la chiede in ciclo.
const limiteCopia = limite({
  finestraMs: 15 * 60 * 1000,
  massimo: 10,
  messaggio: "Troppe copie in poco tempo. Riprova fra qualche minuto."
});

const giornoDiRoma = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Rome" });

function consegna(res, { tipo, nome, corpo }) {
  res.set({
    "Content-Type": tipo,
    "Content-Disposition": `attachment; filename="${nome}"`,
    // Dati personali: niente copie nelle cache, né del browser né di chi sta in mezzo.
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });

  return res.send(corpo);
}

function rispondi(nome, produci) {
  return async (req, res) => {
    try {
      return consegna(res, await produci());
    } catch (err) {
      console.error(`❌ ESPORTA ${nome}:`, err.message);
      return res.status(500).json({ error: "Non sono riuscito a preparare la copia" });
    }
  };
}

router.get(
  "/tutto",
  requireProprietario,
  limiteCopia,
  rispondi("tutto", async () => ({
    tipo: "application/json; charset=utf-8",
    nome: `mangavault-copia-${giornoDiRoma()}.json`,
    corpo: JSON.stringify(await esportazione.esportaTutto(pool))
  }))
);

router.get(
  "/collezione.csv",
  requireProprietario,
  limiteCopia,
  rispondi("collezione", async () => ({
    tipo: "text/csv; charset=utf-8",
    nome: `mangavault-collezione-${giornoDiRoma()}.csv`,
    corpo: await esportazione.collezioneCsv(pool)
  }))
);

router.get(
  "/acquisti.csv",
  requireProprietario,
  limiteCopia,
  rispondi("acquisti", async () => ({
    tipo: "text/csv; charset=utf-8",
    nome: `mangavault-acquisti-${giornoDiRoma()}.csv`,
    corpo: await esportazione.acquistiCsv(pool)
  }))
);

/**
 * Il promemoria di inizio mese: un messaggio sul telefono del proprietario
 * («scarica la copia»). Arriva dal bot della spesa manga, quello che il
 * proprietario ha già aperto per il riepilogo dell'8, e NON è silenzioso: deve
 * comparire sullo schermo come ogni notifica.
 *
 * `prova: true` dice cosa manderebbe e a chi, senza mandare niente.
 */
router.post("/promemoria", richiedeSegretoCron, async (req, res) => {
  const prova = req.body?.prova === true;

  try {
    const { rows } = await pool.query(
      `SELECT id, nickname, telegram_chat_id FROM utenti
        WHERE proprietario AND stato = 'attivo' AND telegram_chat_id IS NOT NULL
        LIMIT 1`
    );

    const sito = process.env.SITO_URL || "https://mangavault10x-frontend.vercel.app";
    const testo =
      `💾 <b>Copia di sicurezza del mese</b>\n\n` +
      `I dati di MangaVault stanno in un posto solo. Apri la Gestione e tocca «Scarica la copia»:\n` +
      `${telegram.esc(sito)}/gestione?sezione=copia\n\n` +
      `Salva il file nei File o su iCloud.`;

    if (rows.length === 0) {
      // Non è un successo: il promemoria non è arrivato a nessuno, e il giro
      // programmato deve risultare fallito, così GitHub lo segnala.
      return res.status(409).json({
        success: false,
        inviati: 0,
        error: "Il proprietario non ha la chat Telegram collegata (o non è attivo)"
      });
    }

    if (prova) return res.json({ success: true, prova: true, inviati: 0, destinatari: rows.length, testo });

    if (!telegram.manga.configurato()) {
      return res.status(503).json({ success: false, inviati: 0, error: "TELEGRAM_MANGA_TOKEN non configurato" });
    }

    const esito = await telegram.manga.invia(rows[0].telegram_chat_id, testo);

    if (!esito.ok) {
      console.error("❌ PROMEMORIA COPIA: Telegram ha risposto:", esito.descrizione);
      return res.status(502).json({ success: false, inviati: 0, error: "Telegram non ha consegnato il messaggio" });
    }

    return res.json({ success: true, inviati: 1 });
  } catch (err) {
    console.error("❌ PROMEMORIA COPIA:", err.message);
    return res.status(500).json({ success: false, error: "Errore server" });
  }
});

module.exports = router;
