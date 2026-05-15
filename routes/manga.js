const express = require("express");
const router = express.Router();
const pool = require("../db");
const { translateToItalian } = require("../services/translate");
const jwt = require("jsonwebtoken");

//
// AUTO ENRICH (Jikan + fallback AniList)
//
router.post("/enrich", async (req, res) => {
  try {
    const { titolo } = req.body;

    if (!titolo) {
      return res.status(400).json({ error: "Titolo mancante" });
    }

    const cleanTitle = titolo.toLowerCase().trim();

    let manga = null;

    // ✅ 1. JIKAN (prova)
    try {
      const response = await fetch(
        `https://api.jikan.moe/v4/manga?q=${encodeURIComponent(cleanTitle)}&limit=3`
      );

      const data = await response.json();

      if (data.data && data.data.length > 0) {
        const m = data.data[0];

        manga = {
          titolo: m.title,
          trama: m.synopsis,
          coverurl: m.images?.jpg?.image_url,
          volumitotali: m.volumes || 0
        };
      }

    } catch (e) {
      console.log("⚠️ Jikan down");
    }

    // ✅ 2. FALLBACK ANILIST
    if (!manga) {
      const query = `
        query ($search: String) {
          Media(search: $search, type: MANGA) {
            title {
              romaji
            }
            description
            coverImage {
              large
            }
            volumes
          }
        }
      `;

      const response = await fetch("https://graphql.anilist.co", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          query,
          variables: { search: titolo }
        })
      });

      const result = await response.json();

      const m = result.data?.Media;

      if (!m) {
        return res.json({ error: "Nessun risultato trovato" });
      }

      manga = {
        titolo: m.title?.romaji,
        trama: m.description,
        coverurl: m.coverImage?.large,
        volumitotali: m.volumes || 0
      };
    }

    // ✅ traduzione
    let tramaIT = manga.trama;

    if (manga.trama && manga.trama.length < 500) {
      try {
        tramaIT = await translateToItalian(manga.trama);
      } catch {}
    }

    res.json({
      titolo: manga.titolo,
      trama: tramaIT,
      coverurl: manga.coverurl,
      volumitotali: manga.volumitotali
    });

  } catch (err) {
    console.error("❌ ENRICH ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

//
// LOGIN
//
router.post("/login", (req, res) => {
  const { username, password } = req.body;

  if (username === "admin" && password === "1234") {
    const token = jwt.sign(
      { user: "admin" },
      "SUPER_SECRET",
      { expiresIn: "2h" }
    );

    return res.json({ token });
  }

  res.status(401).json({ error: "Credenziali errate" });
});

//
// GET ALL
//
router.get("/", async (req, res) => {
  const r = await pool.query(`SELECT * FROM "Manga" ORDER BY "ID" DESC`);
  res.json(r.rows);
});

module.exports = router;
``
