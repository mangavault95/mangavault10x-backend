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

// Conversione valuta: placeholder onesto. In pratica, puntando al
// marketplace italiano (vedi sotto), i prezzi arrivano già in euro
// quasi sempre; il caso raro di valuta diversa non viene convertito.
async function convertToEUR(amount, currency) {
  if (!currency || currency === "EUR") return amount;

  return amount;
}

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
 * Cerca annunci attivi su eBay Italia.
 *
 * L'intestazione `X-EBAY-C-MARKETPLACE-ID` punta al sito italiano:
 * senza, l'API guarda di default eBay.com USA e i prezzi arrivano in
 * dollari da venditori americani, inutili per stimare cosa costa
 * comprare in Italia.
 */
async function cercaAnnunciAttivi(query, limite = 50) {
  const token = await getEbayAppToken();

  // `buyingOptions:FIXED_PRICE` esclude le aste: il rilancio corrente
  // di un'asta appena aperta non è un prezzo, è un numero che sta
  // ancora salendo, e mischiarlo alla mediana la sposterebbe in basso
  // senza motivo.
  const parametri = new URLSearchParams({
    q: query,
    limit: String(limite),
    filter: "buyingOptions:{FIXED_PRICE}"
  });

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

      const value = Number(p.value);

      if (Number.isNaN(value)) return null;

      return { value, currency: p.currency || "EUR" };
    })
    .filter(Boolean);
}

router.get("/avg-price", async (req, res) => {
  try {
    const { query, market = "ebay" } = req.query;

    if (!query) return res.status(400).json({ error: "Parametro query mancante" });

    if (market !== "ebay") {
      return res.status(400).json({ error: "Mercato non supportato", supported: ["ebay"] });
    }

    const cacheKey = `avgprice:${market}:${query}`;
    const cached = cache.get(cacheKey);

    if (cached) return res.json({ ...cached, cached: true });

    let grezzi;

    try {
      grezzi = await cercaAnnunciAttivi(query);
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

    const normalizzati = [];

    for (const p of grezzi) {
      const v = await convertToEUR(p.value, p.currency);

      if (v != null) normalizzati.push(Number(v));
    }

    if (normalizzati.length === 0) {
      const payload = { campione: 0, message: "Nessun annuncio trovato" };

      cache.set(cacheKey, payload, 60 * 10);

      return res.json(payload);
    }

    const payload = {
      mediana: Number(median(normalizzati).toFixed(2)),
      media: Number(mean(normalizzati).toFixed(2)),
      campione: normalizzati.length,
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
