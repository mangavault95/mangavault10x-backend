const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3001;

// 🔥 MIDDLEWARE
app.use(cors({
  origin: [
    "http://localhost:5173",
    "https://mangavault10x.vercel.app"
  ]
}));
app.use(express.json());

// 🔥 DB (Supabase via pg)
const pool = require("./db");

// 🔥 HEALTH CHECK
app.get("/", (req, res) => {
  res.send("🚀 MangaVault API attiva (Supabase)");
});

// 🔥 ROUTES
const mangaRoutes = require("./routes/manga");
app.use("/api/manga", mangaRoutes);

// 🔥 START SERVER
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
