const axios = require("axios");
const Fuse = require("fuse.js");

function normalizeTitle(title) {
  return title
    .toLowerCase()
    .replace(/[:!?.]/g, "")
    .replace(/\(.*?\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function getMangaInfo(title, autore = "") {
  try {
    const cleanTitle = normalizeTitle(title);

    // 🔥 SEARCH JIKAN
    const res = await axios.get(
      `https://api.jikan.moe/v4/manga?q=${encodeURIComponent(cleanTitle)}&limit=15`
    );

    const results = res.data.data;

    if (!results || results.length === 0) {
      return null;
    }

    // 🔥 PREPARA DATI PER FUSE
    const searchable = results.map(r => ({
      ...r,
      authorsText: r.authors?.map(a => a.name).join(" ") || ""
    }));

    // 🔥 QUERY COMPLETA
    const searchText = `${cleanTitle} ${autore}`;

    // 🔥 FUZZY SEARCH
    const fuse = new Fuse(searchable, {
      keys: [
        "title",
        "title_english",
        "title_japanese",
        "authorsText"
      ],
      threshold: 0.4
    });

    const best = fuse.search(searchText)[0]?.item || searchable[0];

    if (!best) return null;

    return {
  Titolo: best.title,
  CoverURL: best.images?.jpg?.image_url || null,
  Trama: best.synopsis || "",
  Genere: best.genres?.map(g => g.name).join(", ") || "",
  Autore: best.authors?.map(a => a.name).join(", ") || "",
  Valutazione: best.score || null
};

  } catch (err) {
    console.log("Errore MAL:", err.message);
    return null;
  }
}

module.exports = { getMangaInfo };