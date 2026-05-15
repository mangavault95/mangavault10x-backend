const express = require("express");
const router = express.Router();
const pool = require("../db");
const jwt = require("jsonwebtoken");
const { translateToItalian } = require("../services/translate");

function cleanHtml(text) {
  return text?.replace(/<[^>]*>/g, "") || "";
}

//
// ✅ ENRICH (PRECISO + TRADUZIONE)
//
router.post("/enrich", async (req, res) => {
  try {
    const { titolo, autore } = req.body;

    if (!titolo) {
      return res.status(400).json({ error: "Titolo mancante" });
    }

    const query = `
      query ($search: String) {
        Page(perPage: 10) {
          media(search: $search, type: MANGA) {
            title { romaji english }
            description
            coverImage { large }
            volumes
            staff {
              edges {
                node {
                  name { full }
                }
              }
            }
          }
        }
      }
    `;

    const response = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        variables: { search: titolo }
      })
    });

    const result = await response.json();
    const list = result.data?.Page?.media;

    if (!list || list.length === 0) {
      return res.json({ error: "Nessun risultato trovato" });
    }

    // ✅ MATCH PIÙ PRECISO
    let manga =
      list.find(m =>
        m.title.romaji?.toLowerCase().includes(titolo.toLowerCase())
      ) || list[0];

    // ✅ MATCH AUTORE
    if (autore) {
      const found = list.find(m =>
        m.staff?.edges?.some(s =>
          s.node.name.full.toLowerCase().includes(autore.toLowerCase())
        )
      );
      if (found) manga = found;
    }

    let trama = cleanHtml(manga.description);

    // ✅ LIMIT PER TRADUZIONE
    if (trama.length > 400) {
      trama = trama.substring(0, 400);
    }

    // ✅ TRADUZIONE
    try {
      trama = await translateToItalian(trama);
    } catch {}

    res.json({
      titolo: manga.title.romaji || manga.title.english,
      trama,
      coverurl: manga.coverImage?.large,
      volumitotali: manga.volumes || 0
    });

  } catch (err) {
    console.error("❌ ENRICH ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

//
// ✅ LOGIN
//
router.post("/login", (req, res) => {
  const { username, password } = req.body;

  if (username === "admin" && password === "1234") {
    const token = jwt.sign({ user: "admin" }, "SUPER_SECRET", {
      expiresIn: "2h"
    });
    return res.json({ token });
  }

  res.status(401).json({ error: "Credenziali errate" });
});

//
// ✅ AUTH
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
// ✅ UPDATE (SALVATAGGIO FIXATO)
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
    res.status(500).json({ error: "Errore server" });
  }
});

router.get("/", async (req, res) => {
  const r = await pool.query(`SELECT * FROM "Manga" ORDER BY "ID" DESC`);
  res.json(r.rows);
});

module.exports = router;
