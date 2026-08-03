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

/* ==================================================
   FILTRI SUGLI ANNUNCI
   ================================================== */

const PAROLE_COMPLETEZZA = /completa|integrale|cofanetto|box\s*set|raccolta/i;

/** Cerca un intervallo tipo "1-18" / "1/18" / "1 – 18" nel titolo. */
function ampiezzaIntervallo(titolo) {
  const m = titolo.match(/(\d{1,3})\s*[-/–]\s*(\d{1,3})/);

  if (!m) return null;

  const a = Number(m[1]);
  const b = Number(m[2]);

  return Number.isFinite(a) && Number.isFinite(b) && b > a ? b - a + 1 : null;
}

/** "10 volumi" / "in 10 vol": il numero totale scritto per esteso. */
function menzionaTotaleVolumi(titolo, volumiTotali) {
  if (!volumiTotali) return false;

  return new RegExp(`\\b${volumiTotali}\\s*(volumi|vol\\.?)\\b`, "i").test(titolo);
}

/**
 * Un annuncio "sembra" la serie completa solo se c'è un segnale
 * POSITIVO in questo senso: una parola di completezza, un intervallo
 * di volumi ampio quanto la serie (tolleranza 2, i box set aggiungono
 * spesso un volume bonus o un omaggio), o il totale scritto per
 * esteso ("10 volumi").
 *
 * Senza nessuno di questi, un numero isolato nel titolo — con o senza
 * "vol."/"n." davanti, es. "Titolo 5" o "Titolo #5" — è quasi sempre
 * IL volume 5, non la serie: prima venivano inclusi per errore
 * (nessuna parola "vol." da riconoscere) e trascinavano giù la
 * mediana verso il prezzo di un volume singolo. Solo un titolo senza
 * numeri né parole chiave (raro: di solito una foto senza descrizione
 * in più) resta ambiguo e viene incluso.
 */
function sembraSerieCompleta(titoloAnnuncio, volumiTotali) {
  const titolo = titoloAnnuncio || "";

  if (PAROLE_COMPLETEZZA.test(titolo)) return true;
  if (menzionaTotaleVolumi(titolo, volumiTotali)) return true;

  const ampiezza = ampiezzaIntervallo(titolo);

  if (ampiezza != null) {
    return volumiTotali ? Math.abs(ampiezza - volumiTotali) <= 2 : ampiezza >= 3;
  }

  const numeriNelTitolo = (titolo.match(/\d{1,3}/g) || []).map(Number);
  const sembraNumeroDiVolume = numeriNelTitolo.some(
    (n) => n >= 1 && n <= (volumiTotali || 60)
  );

  return !sembraNumeroDiVolume;
}

/** True se il titolo dell'annuncio nomina esplicitamente un'altra edizione. */
function nominaEdizione(titoloAnnuncio, etichetta) {
  if (!etichetta) return false;

  return (titoloAnnuncio || "").toLowerCase().includes(etichetta.toLowerCase().trim());
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
 *
 * Il limite grezzo è più alto di quanti risultati serviranno davvero:
 * il filtro per completezza/edizione ne scarta una parte, quindi si
 * parte con più materiale per non restare con un campione minuscolo.
 */
async function cercaAnnunciAttivi(query, limite = 200) {
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

      return { value, currency: p.currency || "EUR", title: it.title || "" };
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
    const queryEbay = etichettaEdizione ? `${query} "${etichettaEdizione}"` : query;

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

    const normalizzati = [];

    for (const p of filtrati) {
      const v = await convertToEUR(p.value, p.currency);

      if (v != null) normalizzati.push(Number(v));
    }

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
