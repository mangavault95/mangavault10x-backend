const express = require("express");
const router = express.Router();
const pool = require("../db");

//
// GET ALL MANGA
//
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM "Manga"
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
// UPDATE MANGA
//
router.put("/:id", async (req, res) => {
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
    coverurl = $1,
    trama = $2,
    volumiposseduti = $3,
    volumitotali = $4
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
