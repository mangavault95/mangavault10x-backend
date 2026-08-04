// routes/marketplace.js
//
// Quanto costa una serie sull'usato, guardando eBay.
//
// Un limite onesto da dichiarare: l'API gratuita di eBay (Browse) vede
// solo gli ANNUNCI ATTIVI in vendita adesso, non le vendite concluse.
// La "media delle vendite concluse" richiederebbe la Marketplace
// Insights API, che eBay concede solo dietro approvazione speciale —
// quasi nessuno sviluppatore indipendente ce l'ha. Meglio dire il vero
// (prezzo chiesto dai venditori in questo momento) che promettere un
// dato che non si può avere.
const express = require("express");
const router = express.Router();
const axios = require("axios");
const NodeCache = require("node-cache");
const { sembraSerieCompleta, nominaEdizione } = require("../services/annunci");

const cache = new NodeCache({ stdTTL: 60 * 60 * 6 });

function median(values) {
  if (!values.length) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(values) {
  if (!values.length) return null;

  return values.reduce((s, v) => s + v, 0) / values.length;
}

/* ==================================================
   FILTRI SUGLI ANNUNCI
   ================================================== */

// Chi decide se un titolo è una serie completa sta in
// services/annunci.js, verificabile da solo con
// `node scripts/verifica-filtro-annunci.js`.
//
// Interessano solo i fumetti italiani: invece di convertire le altre
// valute (tasso di cambio da tenere aggiornato, per un caso raro),
// gli annunci non in EUR vengono scartati in cercaAnnunciAttivi.

// Merchandise che eBay restituisce comunque perché la ricerca è sul
// nome della serie: portachiavi, funko, felpe... Escluderlo dalla
// query (sintassi "-parola" di eBay) non serve a filtrare — a quello
// pensa services/annunci.js — ma a non sprecare i 200 annunci che
// scarichiamo, lasciandone di più a chi vende davvero i volumi.
//
// La lista tiene solo parole che in un annuncio di manga non
// compaiono MAI: niente "poster", "cover" o "custodia", che finirebbero
// per buttare via cofanetti veri venduti "con poster omaggio" o "con
// custodia".
const PAROLE_MERCHANDISE = [
  "portachiavi", "funko", "nendoroid", "statuina", "statua", "peluche",
  "felpa", "maglietta", "tazza", "spilla", "braccialetto", "collana",
  "cosplay", "dvd", "bluray", "gadget"
];

const ESCLUSIONI_MERCHANDISE = PAROLE_MERCHANDISE.map((p) => `-${p}`).join(" ");

async function getEbayAppToken() {
  const { EBAY_CLIENT_ID, EBAY_CLIENT_SECRET } = process.env;

  if (!EBAY_CLIENT_ID || !EBAY_CLIENT_SECRET) {
    const errore = new Error("Credenziali eBay non configurate");

    errore.nonConfigurato = true;
    throw errore;
  }

  const tokenKey = `ebay_token_${EBAY_CLIENT_ID}`;
  const cached = cache.get(tokenKey);

  if (cached) return cached;

  const auth = Buffer.from(`${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`).toString("base64");

  const resp = await axios.post(
    "https://api.ebay.com/identity/v1/oauth2/token",
    "grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope",
    { headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" } }
  );

  const token = resp.data.access_token;
  const expiresIn = resp.data.expires_in || 3600;

  cache.set(tokenKey, token, Math.max(60, expiresIn - 60));

  return token;
}

/**
 * Id della categoria "Manga" su eBay Italia, cercato una volta con la
 * Taxonomy API e tenuto in cache a lungo (le categorie non cambiano
 * quasi mai). Se la ricerca fallisce per qualsiasi motivo — rete,
 * risposta inattesa, nessun nodo che si chiami "Manga" — si prosegue
 * senza restringere la categoria: meglio risultati più larghi che
 * nessun risultato per un id sbagliato o non più valido.
 */
async function getCategoriaManga() {
  const cacheKey = "ebay_categoria_manga";
  const cached = cache.get(cacheKey);

  if (cached !== undefined) return cached;

  try {
    const token = await getEbayAppToken();
    const headers = { Authorization: `Bearer ${token}` };

    const albero = await axios.get(
      "https://api.ebay.com/commerce/taxonomy/v1/category_tree/get_default_category_tree_id?marketplace_id=EBAY_IT",
      { headers }
    );

    const categoryTreeId = albero.data.categoryTreeId;

    const suggerimenti = await axios.get(
      `https://api.ebay.com/commerce/taxonomy/v1/category_tree/${categoryTreeId}/get_category_suggestions?q=manga`,
      { headers }
    );

    const nodi = suggerimenti.data.categorySuggestions || [];
    const match = nodi.find((n) => /manga/i.test(n.category?.categoryName || ""));
    const id = match?.category?.categoryId || null;

    cache.set(cacheKey, id, 60 * 60 * 24 * 30);

    return id;
  } catch (err) {
    console.error("eBay categoria Manga non trovata, proseguo senza filtro categoria", err.response?.data || err.message);
    cache.set(cacheKey, null, 60 * 60 * 6);

    return null;
  }
}

/**
 * Cerca annunci attivi su eBay Italia.
 *
 * L'intestazione `X-EBAY-C-MARKETPLACE-ID` punta al sito italiano:
 * senza, l'API guarda di default eBay.com USA e i prezzi arrivano in
 * dollari da venditori americani, inutili per stimare cosa costa
 * comprare in Italia.
 *
 * Il limite grezzo è più alto di quanti risultati serviranno davvero:
 * il filtro per completezza/edizione ne scarta una parte, quindi si
 * parte con più materiale per non restare con un campione minuscolo.
 */
async function cercaAnnunciAttivi(query, limite = 200) {
  const token = await getEbayAppToken();
  const categoriaManga = await getCategoriaManga();

  // `buyingOptions:FIXED_PRICE` esclude le aste: il rilancio corrente
  // di un'asta appena aperta non è un prezzo, è un numero che sta
  // ancora salendo, e mischiarlo alla mediana la sposterebbe in basso
  // senza motivo.
  const parametri = new URLSearchParams({
    q: query,
    limit: String(limite),
    filter: "buyingOptions:{FIXED_PRICE}"
  });

  if (categoriaManga) parametri.set("category_ids", categoriaManga);

  const url = `https://api.ebay.com/buy/browse/v1/item_summary/search?${parametri.toString()}`;

  const resp = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-EBAY-C-MARKETPLACE-ID": "EBAY-IT"
    }
  });

  const items = resp.data.itemSummaries || [];

  return items
    .map((it) => {
      const p = it.price;

      if (!p?.value) return null;

      // Annuncio a varianti (il venditore mette tutti i volumi nella
      // stessa inserzione, "scegli il volume"): eBay ne riporta il
      // prezzo della variante PIÙ ECONOMICA, cioè un volume singolo,
      // anche quando il titolo dice "serie completa 1/10". È un prezzo
      // che non corrisponde a niente di acquistabile in blocco, e
      // sulle serie molto vendute era grosso abbastanza da spostare
      // la mediana da solo.
      if (it.itemGroupType) return null;

      // Solo EUR: interessano i fumetti italiani, non il tasso di
      // cambio di un annuncio da un altro paese.
      if ((p.currency || "EUR") !== "EUR") return null;

      const value = Number(p.value);

      if (Number.isNaN(value)) return null;

      return { value, title: it.title || "" };
    })
    .filter(Boolean);
}

router.get("/avg-price", async (req, res) => {
  try {
    const { query, market = "ebay", edizione, altreEdizioni, volumiTotali } = req.query;

    if (!query) return res.status(400).json({ error: "Parametro query mancante" });

    if (market !== "ebay") {
      return res.status(400).json({ error: "Mercato non supportato", supported: ["ebay"] });
    }

    const etichettaEdizione = edizione ? String(edizione).trim() : null;

    const etichetteAltreEdizioni = altreEdizioni
      ? String(altreEdizioni)
          .split(",")
          .map((e) => e.trim())
          .filter(Boolean)
      : [];

    const totaliAttesi = volumiTotali ? Number(volumiTotali) : null;

    const cacheKey = `avgprice:${market}:${query}:${etichettaEdizione || ""}:${etichetteAltreEdizioni.join("|")}:${totaliAttesi ?? ""}`;
    const cached = cache.get(cacheKey);

    if (cached) return res.json({ ...cached, cached: true });

    // Aggiungere l'edizione fra virgolette alla query spinge eBay a
    // dare più peso agli annunci che la nominano esplicitamente.
    // Le esclusioni per il merchandise vanno nella query stessa (non
    // solo nel filtro dopo): tolgono spazio ai portachiavi e simili
    // dentro il limite di annunci scaricati, lasciandone di più per i
    // volumi veri.
    const queryEbay = `${etichettaEdizione ? `${query} "${etichettaEdizione}"` : query} ${ESCLUSIONI_MERCHANDISE}`;

    let grezzi;

    try {
      grezzi = await cercaAnnunciAttivi(queryEbay);
    } catch (err) {
      if (err.nonConfigurato) {
        // Non è un guasto: è una funzione che richiede una chiave
        // gratuita da developer.ebay.com e non è stata ancora messa.
        // 501 = "non implementato", non "qualcosa si è rotto".
        return res.status(501).json({ error: "non_configurato", message: err.message });
      }

      console.error("eBay search error", err.response?.data || err.message);

      return res.status(502).json({ error: "eBay non ha risposto" });
    }

    // Tengo solo gli annunci che sembrano la serie completa e che non
    // nominano esplicitamente un'edizione diversa da quella cercata
    // (le sorelle note della stessa opera, se ce ne sono).
    const filtrati = grezzi.filter((it) => {
      if (!sembraSerieCompleta(it.title, totaliAttesi)) return false;
      if (etichetteAltreEdizioni.some((e) => nominaEdizione(it.title, e))) return false;

      return true;
    });

    // Niente conversione valuta: cercaAnnunciAttivi ha già scartato
    // tutto ciò che non è EUR.
    const normalizzati = filtrati.map((p) => p.value);

    if (normalizzati.length === 0) {
      const payload = {
        campione: 0,
        campioneGrezzo: grezzi.length,
        message: "Nessun annuncio trovato"
      };

      cache.set(cacheKey, payload, 60 * 10);

      return res.json(payload);
    }

    const payload = {
      mediana: Number(median(normalizzati).toFixed(2)),
      media: Number(mean(normalizzati).toFixed(2)),
      campione: normalizzati.length,
      // Quanti annunci c'erano prima del filtro per completezza/edizione:
      // se il calo è forte il fronte può dirlo invece di far sembrare
      // il campione più solido di quanto sia.
      campioneGrezzo: grezzi.length,
      // Il fronte usa questa etichetta per non promettere un dato che
      // l'API non fornisce: sono annunci in vendita ora, non incassi
      // passati.
      tipo: "annunci_attivi",
      source: market
    };

    cache.set(cacheKey, payload, 60 * 60 * 12);

    return res.json(payload);
  } catch (err) {
    console.error("AVG PRICE ERROR", err);
    res.status(500).json({ error: "Errore server" });
  }
});

module.exports = router;
