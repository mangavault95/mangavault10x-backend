// routes/autore.js
//
// Le opere di un autore uscite in Italia.
//
// La domanda che si fa aprendo il pannello di un autore non è "cosa ha
// disegnato in vita sua" ma "cosa di suo posso comprare": un elenco
// pieno di titoli mai arrivati qui è tempo perso per chi lo legge. La
// risposta esatta ce l'ha solo AnimeClick, che sa quali edizioni
// italiane esistono — e la dà in una richiesta, grazie al filtro
// "Editi in Italia" della loro ricerca.
//
// Passa dal server per le stesse ragioni della rotta dei simili:
// niente CORS dall'altra parte, e la ricerca costa due richieste
// (modulo per il token, poi la POST) che qui si fanno una volta sola.
const express = require("express");
const router = express.Router();
const NodeCache = require("node-cache");
const { opereDiAutore, autoriDi } = require("../services/providers/animeclick");

// Una settimana: la bibliografia di un autore cambia quando esce un
// volume nuovo, non da un'ora all'altra.
const cache = new NodeCache({ stdTTL: 60 * 60 * 24 * 7, maxKeys: 300 });

router.get("/opere", async (req, res) => {
  const nome = (req.query.nome || "").trim();
  // L'identificativo AnimeClick di una serie che sappiamo essere sua:
  // serve solo come piano B, per leggere il nome com'è scritto da loro.
  const riferimento = Number(req.query.riferimento) || null;

  if (!nome) return res.status(400).json({ error: "Serve il nome dell'autore" });

  const chiave = `autore:${nome.toLowerCase()}`;
  const inCache = cache.get(chiave);

  if (inCache !== undefined) return res.json(inCache);

  try {
    let opere = await opereDiAutore(nome);

    // Il campo autore della ricerca è testuale e non perdona la
    // romanizzazione: "Toru Fujisawa" non trova le opere che loro
    // firmano "Tōru Fujisawa", e il pannello restava vuoto per un
    // autore di cui hanno venti schede. La grafia giusta però è scritta
    // sulla scheda di una serie sua che già conosciamo: si legge da lì e
    // si richiede con quella.
    if (!opere.length && riferimento) {
      for (const firma of await autoriDi(riferimento).catch(() => [])) {
        if (firma.toLowerCase() === nome.toLowerCase()) continue;

        opere = await opereDiAutore(firma);

        if (opere.length) break;
      }
    }

    const risposta = { nome, opere };

    // Anche l'elenco vuoto si ricorda, ma per poco: un autore che oggi
    // AnimeClick non trova può essere lo stesso di cui domani esce il
    // primo volume italiano.
    cache.set(chiave, risposta, opere.length ? undefined : 60 * 60 * 6);

    return res.json(risposta);
  } catch (err) {
    console.error("AnimeClick opere autore:", err.message);

    return res.json({ nome, opere: [], errore: "AnimeClick non ha risposto" });
  }
});

module.exports = router;
