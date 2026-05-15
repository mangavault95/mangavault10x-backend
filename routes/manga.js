const express = require("express");
const router = express.Router();
const pool = require("../db");
const { translateToItalian } = require("../services/translate");
const jwt = require("jsonwebtoken");

function cleanHtml(text) {
  return text?.replace(/<[^>]*>?/gm, "") || "";
}

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

    // ✅ JIKAN
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

    // ✅ FALLBACK ANILIST
    if (!manga) {
      const query = `
        query ($search: String) {
          Media(search: $search, type: MANGA) {
            title { romaji }
            description
            coverImage { large }
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

    // ✅ PULIZIA HTML
    manga.trama = cleanHtml(manga.trama);

    // ✅ TRADUZIONE
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
  try {
    const result = await pool.query(`
      SELECT * FROM "Manga"
      ORDER BY "ID" DESC
    `);

    res.json(result.rows);
  } catch (err) {
    console.error("❌ ERRORE GET MANGA:", err);
    res.status(500).json({ error: err.message });
  }
});

//
// UPDATE
//
function auth(req, res, next) {
  const header = req.headers.authorization;

  if (!header) return res.status(401).json({ error: "No token" });

  const token = header.split(" ")[1];

  try {
    jwt.verify(token, "SUPER_SECRET");
    next();
  } catch {
    res.status(403).json({ error: "Token non valido" });
  }
}

router.put("/:id", auth, async (req, res) => {
  try {
    const { id } = req.params;

    const {
      coverurl,
      trama,
      volumiposseduti,
      volumitotali
    } = req.body;

    await pool.query(`
      UPDATE "Manga"
      SET
        "CoverURL" = $1,
        "Trama" = $2,
        "VolumiPosseduti" = $3,
        "VolumiTotali" = $4
      WHERE "ID" = $5
    `,
    [
      coverurl || null,
      trama || null,
      volumiposseduti || 0,
      volumitotali || 0,
      id
    ]);

    res.json({ success: true });

  } catch (err) {
    console.error("❌ UPDATE ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
``
