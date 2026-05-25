const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3001;

// ✅ CORS CONFIGURATO CORRETTAMENTE (senza duplicati)
app.use(
  cors({
    origin: [
      "https://mangavault10x-frontend.vercel.app",
      "http://localhost:3000"
    ],
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"]
  })
);

app.use(express.json());

// ROUTES
const mangaRoutes = require("./routes/manga");
app.use("/manga", mangaRoutes); // <-- ATTENZIONE: il frontend chiama /manga/updateRating

// ROOT
app.get("/", (req, res) => {
  res.send("MangaVault API attiva 🚀");
});

// START SERVER
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
