const express = require("express");
const cors = require("cors");
const sql = require("mssql");

const app = express();

// 🔥 PORT (OBBLIGATORIO PER RENDER)
const PORT = process.env.PORT || 3001;

// 🔥 MIDDLEWARE
app.use(cors({
  origin: [
    "http://localhost:5173",
    "https://mangavault10x.vercel.app"
  ]
}));
app.use(express.json());

// 🔥 DATABASE CONFIG (CLOUD READY)
const dbConfig = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  server: process.env.DB_SERVER,
  database: process.env.DB_DATABASE,
  options: {
    encrypt: true,
    trustServerCertificate: true
  }
};

// 🔥 CONNESSIONE DB SAFE (NON BLOCCA IL SERVER)
let pool;

async function connectDB() {
  try {
    pool = await sql.connect(dbConfig);
    console.log("✅ SQL Connected");
  } catch (err) {
    console.log("❌ SQL Error (non bloccante):", err.message);
  }
}

connectDB();

// 🔥 ROUTES
const mangaRoutes = require("./routes/manga");
app.use("/api/manga", mangaRoutes);

// 🔥 HEALTH CHECK
app.get("/", (req, res) => {
  res.send("🚀 MangaVault API attiva");
});

// 🔥 START SERVER (RENDER COMPATIBLE)
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
