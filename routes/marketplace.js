// routes/marketplace.js
const express = require("express");
const router = express.Router();
const axios = require("axios");
const NodeCache = require("node-cache");

const cache = new NodeCache({ stdTTL: 60 * 60 * 6 }); // 6h default

// helper: median, mean
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a,b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function mean(values) {
  if (!values.length) return null;
  return values.reduce((s,v) => s + v, 0) / values.length;
}

// convert currency if needed - placeholder (in prod usa un servizio FX)
async function convertToEUR(amount, currency) {
  if (!currency || currency === "EUR") return amount;
  // fallback: no conversion, assume same currency (documentare)
  return amount;
}

// eBay: get app token (client credentials)
async function getEbayAppToken() {
  const { EBAY_CLIENT_ID, EBAY_CLIENT_SECRET } = process.env;
  if (!EBAY_CLIENT_ID || !EBAY_CLIENT_SECRET) throw new Error("Missing eBay credentials");
  const tokenKey = `ebay_token_${EBAY_CLIENT_ID}`;
  const cached = cache.get(tokenKey);
  if (cached) return cached;
  const auth = Buffer.from(`${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`).toString("base64");
  const resp = await axios.post("https://api.ebay.com/identity/v1/oauth2/token",
    "grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope",
    { headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" } }
  );
  const token = resp.data.access_token;
  const expiresIn = resp.data.expires_in || 3600;
  cache.set(tokenKey, token, Math.max(60, expiresIn - 60));
  return token;
}

// eBay search (Browse API) - best-effort: collects itemSummaries prices
async function searchEbay(query, months = 3, limit = 50) {
  const token = await getEbayAppToken();
  const url = `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(query)}&limit=${limit}`;
  const resp = await axios.get(url, { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
  const items = resp.data.itemSummaries || [];
  const prices = items.map(it => {
    const p = it.price || it.price?.value;
    if (!p) return null;
    const value = Number(p.value ?? p);
    const currency = p.currency || p.currencyCode || "EUR";
    if (isNaN(value)) return null;
    return { value, currency };
  }).filter(Boolean);
  return prices;
}

// Route: avg-price
router.get("/avg-price", async (req, res) => {
  try {
    const { query, market = "ebay", months = 3 } = req.query;
    if (!query) return res.status(400).json({ error: "Missing query parameter" });

    const cacheKey = `avgprice:${market}:${query}:${months}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json({ ...cached, cached: true });

    let rawPrices = [];
    if (market === "ebay") {
      try {
        rawPrices = await searchEbay(query, Number(months));
      } catch (err) {
        console.error("eBay search error", err.message);
        return res.status(502).json({ error: "Errore fetching from eBay" });
      }
    } else {
      return res.status(400).json({ error: "Market non supportato", supported: ["ebay"] });
    }

    // normalize to EUR (best-effort)
    const normalized = [];
    for (const p of rawPrices) {
      const v = await convertToEUR(p.value, p.currency);
      if (v != null) normalized.push(Number(v));
    }

    if (normalized.length === 0) {
      const payload = { error: true, message: "Nessun dato disponibile", samples: 0 };
      cache.set(cacheKey, payload, 60 * 10); // cache breve
      return res.json(payload);
    }

    const med = median(normalized);
    const avg = mean(normalized);
    const payload = {
      median: Number(med.toFixed(2)),
      mean: Number(avg.toFixed(2)),
      samples: normalized.length,
      timeframe: `${months}m`,
      source: market
    };

    cache.set(cacheKey, payload, 60 * 60 * 12); // cache 12h
    return res.json(payload);
  } catch (err) {
    console.error("AVG PRICE ERROR", err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
