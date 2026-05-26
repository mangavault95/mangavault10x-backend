// index.js - backend entrypoint
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// importa le tue route esistenti
try {
  const mangaRouter = require("./routes/manga");
  app.use("/api/manga", mangaRouter);
} catch (err) {
  console.warn("Warning: routes/manga.js non trovata o errore import:", err.message);
}

// importa la nuova route marketplace
try {
  const marketplaceRouter = require("./routes/marketplace");
  app.use("/api/marketplace", marketplaceRouter);
} catch (err) {
  console.warn("Warning: routes/marketplace.js non trovata o errore import:", err.message);
}

// healthcheck
app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
