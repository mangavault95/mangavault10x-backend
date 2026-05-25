const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3001;
const cors = require("cors");

app.use(cors({
  origin: "https://mangavault10x-frontend.vercel.app",
  methods: ["GET", "POST", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(express.json());

const mangaRoutes = require("./routes/manga");
app.use("/api/manga", mangaRoutes);

app.get("/", (req, res) => {
  res.send("MangaVault API attiva 🚀");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

