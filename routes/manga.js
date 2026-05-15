const express = require("express");
const router = express.Router();
const pool = require("../db");
const { translateToItalian } = require("../services/translate");
const jwt = require("jsonwebtoken");
const fetch = require("node-fetch"); // ✅ IMPORT FONDAMENTALE

//
// AUTO ENRICH
//
router.post("/enrich", async (req, res) => {
  try {
    const { titolo } = req.body;

    if (!titolo) {
      return res.status(400).json({ error: "Titolo mancante" });
    }

    const response = await fetch(
      `https://api.jikan.moe/v4/manga?q=${encodeURIComponent(titolo)}&limit=1`
    );

    const data = await response.json();

    if (!data.data || data.data.length === 0) {
      return res.status(404).json({ error: "Nessun risultato" });
    }

    const manga = data.data[0];

    // ✅ TRADUZIONE
    let tramaIT = manga.synopsis;

    if (manga.synopsis && manga.synopsis.length < 500) {
      tramaIT = await translateToItalian(manga.synopsis);
    }

    const result = {
      titolo: manga.title,
      trama: tramaIT,
      coverurl: manga.images?.jpg?.image_url,
      volumitotali: manga.volumes || 0
    };

    res.json(result);

  } catch (err) {
    console.error("❌ ERRORE ENRICH:", err);
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
// GET ALL MANGA
//
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM "Manga"
      ORDER BY "ID" DESC
    `);

    res.json(result.rows);
  } catch (err) {
    console.error("❌ ERRORE GET ALL MANGA:", err);
    res.status(500).json({ error: err.message });
  }
});

//
// STATS
//
router.get("/stats", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*) AS "totalSeries",
        COALESCE(SUM(volumiposseduti), 0) AS "totalVolumes",
        COALESCE(SUM(volumiposseduti * costo), 0) AS "totalCost",
        COALESCE(SUM(CASE WHEN concluso = false THEN 1 ELSE 0 END), 0) AS "inProgress"
      FROM "Manga"
    `);

    res.json(result.rows[0]);
  } catch (err) {
    console.error("❌ ERRORE STATS:", err);
    res.status(500).json({ error: err.message });
  }
});

//
// LATEST
//
router.get("/latest", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT *
      FROM "Manga"
      ORDER BY dataaggiunta DESC
      LIMIT 12
    `);

    res.json(result.rows);
  } catch (err) {
    console.error("❌ ERRORE LATEST:", err);
    res.status(500).json({ error: err.message });
  }
});

//
// AUTH MIDDLEWARE
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

//
// UPDATE MANGA
//
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
    console.error("❌ ERRORE UPDATE MANGA:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
