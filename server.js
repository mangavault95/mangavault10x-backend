const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3001;

// ✅ CORS COMPLETO (Render + Express 5)
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

// ⭐ FIX PRE-FLIGHT (Express 5 richiede un pattern valido)
app.options("/api/*", cors());

app.use(express.json());

// ROUTES
const mangaRoutes = require("./routes/manga");
app.use("/api/manga", mangaRoutes);

app.get("/", (req, res) => {
  res.send("MangaVault API attiva 🚀");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
