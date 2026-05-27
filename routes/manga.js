const express = require("express");
const router = express.Router();
const pool = require("../db");
const jwt = require("jsonwebtoken");
const { translateToItalian } = require("../services/translate");

function cleanHtml(text) {
  return text?.replace(/<[^>]*>/g, "") || "";
}

function normalizeSpaces(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function isTranslationWarning(text) {
  const value = String(text || "").toLowerCase();

  return (
    value.includes("mymemory warning") ||
    value.includes("all available free translations") ||
    value.includes("mymemory.translated.net") ||
    value.includes("doc/usagelimits.php") ||
    value.includes("you used all available free translations")
  );
}

function uniqueStrings(list) {
  return Array.from(new Set((list || []).filter(Boolean)));
}

function getFilteredAuthors(staffEdges = []) {
  const safeEdges = Array.isArray(staffEdges) ? staffEdges : [];

  // Escludo ruoli non autoriali
  const excludedRolePattern =
    /(translator|translation|localization|lettering|letterer|assistant|editor|supervisor)/i;

  // Privilegio ruoli “creator”
  const preferredRolePattern =
    /(story|art|story & art|original creator|creator|script|illustration|manga)/i;

  const creatorEdges = safeEdges.filter((edge) => {
    const role = edge?.role || "";
    return !excludedRolePattern.test(role);
  });

  const preferredCreators = creatorEdges.filter((edge) => {
    const role = edge?.role || "";
    return preferredRolePattern.test(role);
  });

  const finalEdges = preferredCreators.length > 0 ? preferredCreators : creatorEdges;

  return uniqueStrings(
    finalEdges.map((edge) => edge?.node?.name?.full).filter(Boolean)
  );
}

// --------------------------------------------------
// ENRICH
// --------------------------------------------------
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
            title {
              romaji
              english
            }
            description
            coverImage {
              large
            }
            volumes
            genres
            staff {
              edges {
                role
                node {
                  name {
                    full
                  }
                }
              }
            }
          }
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
    const list = result?.data?.Page?.media || [];

    if (!Array.isArray(list) || list.length === 0) {
      return res.json({ error: "Nessun risultato trovato" });
    }

    const searchTitle = titolo.toLowerCase();
    const searchAuthor = normalizeSpaces(autore).toLowerCase();

    // 1) priorità al titolo
    let manga =
      list.find((m) => {
        const romaji = (m?.title?.romaji || "").toLowerCase();
        const english = (m?.title?.english || "").toLowerCase();

        return romaji.includes(searchTitle) || english.includes(searchTitle);
      }) || list[0];

    // 2) se è stato passato autore, prova a raffinare sul vero autore (filtrato)
    if (searchAuthor) {
      const foundByAuthor = list.find((m) => {
        const authors = getFilteredAuthors(m?.staff?.edges || []);
        return authors.some((name) => name.toLowerCase().includes(searchAuthor));
      });

      if (foundByAuthor) {
        manga = foundByAuthor;
      }
    }

    let trama = cleanHtml(manga?.description || "");
    trama = normalizeSpaces(trama);

    if (trama.length > 400) {
      trama = trama.substring(0, 400);
    }

    // Traduco solo se ottengo una traduzione sana.
    // Se MyMemory è a quota finita e risponde con warning, tengo la trama originale.
    let tramaFinale = trama;

    if (trama) {
      try {
        const translated = await translateToItalian(trama);

        if (translated && !isTranslationWarning(translated)) {
          tramaFinale = translated;
        }
      } catch (e) {
        // fallback silenzioso: tengo la trama originale
      }
    }

    const authors = getFilteredAuthors(manga?.staff?.edges || []);
    const autoreFinale = authors.join(", ");
    const genereFinale = uniqueStrings(manga?.genres || []).join(", ");

    return res.json({
      titolo: manga?.title?.romaji || manga?.title?.english || titolo,
      autore: autoreFinale,
      genere: genereFinale,
      trama: tramaFinale,
      coverurl: manga?.coverImage?.large || "",
      volumitotali: manga?.volumes || 0
    });
  } catch (err) {
    console.error("❌ ENRICH ERROR:", err);
    return res.status(500).json({ error: err.message });
  }
});

// --------------------------------------------------
// LOGIN
// --------------------------------------------------
router.post("/login", (req, res) => {
  const { username, password } = req.body;

  if (username === "admin" && password === "1234") {
    const token = jwt.sign({ user: "admin" }, "SUPER_SECRET", {
      expiresIn: "2h"
    });

    return res.json({ token });
  }

  return res.status(401).json({ error: "Credenziali errate" });
});

// --------------------------------------------------
// AUTH MIDDLEWARE
// --------------------------------------------------
function auth(req, res, next) {
  const header = req.headers.authorization;

  if (!header) {
    console.error("AUTH: no Authorization header");
    return res.status(401).json({ error: "No token" });
  }

  const token = header.split(" ")[1];

  try {
    const decoded = jwt.verify(token, "SUPER_SECRET");
    req.user = decoded;
    next();
  } catch (err) {
    console.error("AUTH: token verify error:", err.message);
    return res.status(403).json({ error: "Token non valido" });
  }
}

// --------------------------------------------------
// UPDATE MANGA (PUT /:id)
// --------------------------------------------------
router.put("/:id", auth, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      coverurl,
      trama,
      volumiposseduti,
      volumitotali,
      titolo,
      autore,
      genere,
      costo,
      editore
    } = req.body;

    console.log(`PUT /api/manga/${id} payload:`, req.body);

    const result = await pool.query(
      `
      UPDATE "Manga"
      SET
        "CoverURL" = $1,
        "Trama" = $2,
        "VolumiPosseduti" = $3,
        "VolumiTotali" = $4,
        "Titolo" = COALESCE($5, "Titolo"),
        "Autore" = COALESCE($6, "Autore"),
        "Genere" = COALESCE($7, "Genere"),
        "Costo" = COALESCE($8, "Costo"),
        "Editore" = COALESCE($9, "Editore")
      WHERE "ID" = $10
      RETURNING *
      `,
      [
        coverurl || null,
        trama || null,
        volumiposseduti || 0,
        volumitotali || 0,
        titolo || null,
        autore || null,
        genere || null,
        costo || null,
        editore || null,
        id
      ]
    );

    if (!result || !result.rows || result.rows.length === 0) {
      console.warn(`PUT UPDATE returned no rows for ID ${id}`);
      return res.status(404).json({ error: "Record non trovato" });
    }

    return res.json({ success: true, updated: result.rows[0] });
  } catch (err) {
    console.error("❌ PUT UPDATE MANGA ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

// --------------------------------------------------
// UPDATE MANGA via POST /update
// --------------------------------------------------
router.post("/update", auth, async (req, res) => {
  try {
    const {
      id,
      coverurl,
      trama,
      volumiposseduti,
      volumitotali,
      titolo,
      autore,
      genere,
      costo,
      editore
    } = req.body;

    if (!id) {
      return res.status(400).json({ error: "ID mancante" });
    }

    console.log(`POST /api/manga/update payload:`, req.body);

    const result = await pool.query(
      `
      UPDATE "Manga"
      SET
        "CoverURL" = $1,
        "Trama" = $2,
        "VolumiPosseduti" = $3,
        "VolumiTotali" = $4,
        "Titolo" = COALESCE($5, "Titolo"),
        "Autore" = COALESCE($6, "Autore"),
        "Genere" = COALESCE($7, "Genere"),
        "Costo" = COALESCE($8, "Costo"),
        "Editore" = COALESCE($9, "Editore")
      WHERE "ID" = $10
      RETURNING *
      `,
      [
        coverurl || null,
        trama || null,
        volumiposseduti || 0,
        volumitotali || 0,
        titolo || null,
        autore || null,
        genere || null,
        costo || null,
        editore || null,
        id
      ]
    );

    if (!result || !result.rows || result.rows.length === 0) {
      console.warn(`POST UPDATE returned no rows for ID ${id}`);
      return res.status(404).json({ error: "Record non trovato" });
    }

    return res.json({ success: true, updated: result.rows[0] });
  } catch (err) {
    console.error("❌ POST UPDATE MANGA ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

// --------------------------------------------------
// UPDATE RATING
// --------------------------------------------------
router.post("/updateRating", auth, async (req, res) => {
  const { id, rating } = req.body;

  try {
    await pool.query(
      `UPDATE "Manga" SET "Valutazione" = $1 WHERE "ID" = $2`,
      [rating, id]
    );

    return res.json({ success: true });
  } catch (err) {
    console.error("❌ UPDATE RATING ERROR:", err);
    return res.status(500).json({ error: "Errore server" });
  }
});

// --------------------------------------------------
// GET ALL
// --------------------------------------------------
router.get("/", async (req, res) => {
  const r = await pool.query(`SELECT * FROM "Manga" ORDER BY "ID" DESC`);
  return res.json(r.rows);
});

module.exports = router;
