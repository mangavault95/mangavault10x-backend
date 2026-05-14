const express = require("express");
const cors = require("cors");
const sql = require("mssql");

const app = express();
const PORT = 3001;

// 🔥 MIDDLEWARE
app.use(cors());
app.use(express.json());

// 🔥 CONNESSIONE DB (se già la hai altrove puoi rimuovere questo blocco)
const dbConfig = {
  user: "sa",
  password: "manga95",
  server: "localhost",
  database: "MangaDB",
  options: {
    encrypt: false,
    trustServerCertificate: true
  }
};

// 🔥 CONNECT SQL (IMPORTANTE)
sql.connect(dbConfig)
  .then(() => console.log("SQL Connected"))
  .catch(err => console.log("SQL Error:", err));

// 🔥 ROUTES
const mangaRoutes = require("./routes/manga");

// 🔥 MOUNT ROUTES (QUESTO È FONDAMENTALE)
app.use("/api/manga", mangaRoutes);

// 🔥 TEST ROUTE
app.get("/", (req, res) => {
  res.send("MangaVault API attiva");
});

// 🔥 START SERVER
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});