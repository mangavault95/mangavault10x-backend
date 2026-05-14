const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({
  origin: [
    "http://localhost:5173",
    "https://mangavault10x-frontend.vercel.app"
  ],
  methods: ["GET", "POST", "PUT", "DELETE"],
  credentials: true
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
``
