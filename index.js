require("dotenv").config();

const express = require("express");
const cors = require("cors");

const app = express();
const port = process.env.PORT || 3000;

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }

  next();
});

app.use(cors());
app.use(express.json());

const mangaRouter = require("./routes/manga");
const wishlistRouter = require("./routes/wishlist");
const wishlistActionsRouter = require("./routes/wishlistActions");
const readingHistoryRouter = require("./routes/readingHistory");
const readingSessionsRouter = require("./routes/readingSessions");

app.use("/api/manga", mangaRouter);
app.use("/api/wishlist", wishlistRouter);
app.use("/api/wishlist-actions", wishlistActionsRouter);
app.use("/api/reading-history", readingHistoryRouter);
app.use("/api/reading-sessions", readingSessionsRouter);

app.get("/", (req, res) => {
  res.send("MangaVault API attiva 🚀");
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
