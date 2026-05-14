const express = require("express");
const router = express.Router();
const sql = require("mssql");

//
// GET ALL MANGA
//
router.get("/", async (req, res) => {
  try {
    const result = await sql.query("SELECT * FROM Manga");
    res.json(result.recordset);
  } catch (err) {
    console.error(err);
    res.status(500).send("Errore GET manga");
  }
});

//
// STATS
//
router.get("/stats", async (req, res) => {
  try {
    const result = await sql.query(`
      SELECT
        COUNT(*) AS totalSeries,

        SUM(CAST(ISNULL(VolumiPosseduti, 0) AS INT)) AS totalVolumes,

        SUM(
          CAST(ISNULL(VolumiPosseduti, 0) AS FLOAT)
          * CAST(ISNULL(Costo, 0) AS FLOAT)
        ) AS totalCost,

        SUM(
          CASE WHEN Concluso = 0 THEN 1 ELSE 0 END
        ) AS inProgress

      FROM Manga
    `);

    res.json(result.recordset[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({});
  }
});

//
// LATEST
//
router.get("/latest", async (req, res) => {
  try {
    const result = await sql.query(`
      SELECT TOP 12 *
      FROM Manga
      ORDER BY DataAggiunta DESC
    `);

    res.json(result.recordset);
  } catch (err) {
    console.error(err);
    res.status(500).json([]);
  }
});

//
// UPDATE MANGA
//
router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const {
      CoverURL,
      Trama,
      VolumiPosseduti,
      VolumiTotali
    } = req.body;

    const request = new sql.Request();

    request.input("id", sql.Int, Number(id));
    request.input("CoverURL", sql.NVarChar(sql.MAX), CoverURL || null);
    request.input("Trama", sql.NVarChar(sql.MAX), Trama || null);
    request.input("VolumiPosseduti", sql.Int, Number(VolumiPosseduti || 0));
    request.input("VolumiTotali", sql.Int, Number(VolumiTotali || 0));

    await request.query(`
      UPDATE Manga
      SET
        CoverURL = @CoverURL,
        Trama = @Trama,
        VolumiPosseduti = @VolumiPosseduti,
        VolumiTotali = @VolumiTotali
      WHERE Id = @id
    `);

    res.json({ success: true });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
});

module.exports = router;