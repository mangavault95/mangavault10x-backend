// routes/simili.js
//
// I titoli che i lettori italiani accostano a una serie, presi da
// AnimeClick.
//
// Perché passa dal server e non dal browser: AnimeClick non manda gli
// header CORS — una fetch dalla pagina verrebbe rifiutata — e la
// risposta va comunque costruita con tre richieste in fila (ricerca,
// verifica dell'autore, pagina dei consigli). Farle una volta qui e
// tenerle in cache è anche il modo di restare gli ospiti discreti che
// il resto del progetto è già con questo sito.
//
// Il sito non aspetta questa risposta per disegnare la sezione: mostra
// subito i consigli di AniList (che il browser chiede da sé) e infila
// questi quando arrivano. Un Render addormentato quindi non si vede.
const express = require("express");
const router = express.Router();
const NodeCache = require("node-cache");
const { trovaOpera, consigli } = require("../services/providers/animeclick");

// Un giorno: i consigli sono scritti dagli utenti nel giro di anni, non
// cambiano da un'ora all'altra. La chiave è la serie, non il titolo
// cercato, così due edizioni della stessa opera non ripetono il lavoro.
const cache = new NodeCache({ stdTTL: 60 * 60 * 24, maxKeys: 500 });

// Anche il "non l'ho trovata" va ricordato, altrimenti ogni apertura
// della scheda di una serie che AnimeClick non conosce ripaga le tre
// richieste per riscoprire la stessa cosa. Ma per meno tempo: una
// serie appena uscita in Italia potrebbe comparire domani.
const TTL_NIENTE = 60 * 60 * 6;

router.get("/animeclick", async (req, res) => {
  const titolo = (req.query.titolo || "").trim();
  const autore = (req.query.autore || "").trim() || null;
  const idDichiarato = Number(req.query.id) || null;

  if (!titolo && !idDichiarato) {
    return res.status(400).json({ error: "Serve almeno un titolo o un id AnimeClick" });
  }

  const chiave = `simili:${idDichiarato || `${titolo}|${autore || ""}`}`;
  const inCache = cache.get(chiave);

  if (inCache !== undefined) return res.json(inCache);

  try {
    // `"AnimeClickID"` in tabella è già stato verificato a mano a suo
    // tempo (vedi sql/006_animeclick.sql): quando c'è, cercare il
    // titolo sarebbe solo un modo di sbagliare.
    const opera = idDichiarato
      ? { id: idDichiarato, titolo, url: null }
      : await trovaOpera({ titolo, autore });

    if (!opera) {
      const vuoto = { opera: null, simili: [] };

      cache.set(chiave, vuoto, TTL_NIENTE);

      return res.json(vuoto);
    }

    const simili = await consigli(opera.id, { quanti: 12 });
    const risposta = { opera: { id: opera.id, titolo: opera.titolo, url: opera.url }, simili };

    cache.set(chiave, risposta, simili.length ? undefined : TTL_NIENTE);

    return res.json(risposta);
  } catch (err) {
    // Una fonte esterna che non risponde non è un guasto del sito: la
    // sezione dei simili resta con i soli consigli di AniList, e chi
    // guarda non deve nemmeno accorgersene.
    console.error("AnimeClick simili:", err.message);

    return res.json({ opera: null, simili: [], errore: "AnimeClick non ha risposto" });
  }
});

module.exports = router;
