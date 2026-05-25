const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3001;

// ✅ CORS COMPLETO (FUNZIONA SU RENDER)
app.use(
  cors({
    origin: [
      "https://mangavault10x-frontend.vercel.app",
      "http://localhost:3000"
    ],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"]
  })
);

// ⭐ FIX PRE-FLIGHT (Render lo richiede)
app.options("*", cors());

app.use(express.json());

// ✅ ROUTES CORRETTE
const mangaRoutes = require("./routes/manga");
app.use("/api/manga", mangaRoutes);

// ROOT
app.get("/", (req, res) => {
  res.send("MangaVault API attiva 🚀");
});

// START
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
