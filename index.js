require("dotenv").config();

const express = require("express");
const cors = require("cors");

const app = express();
const port = process.env.PORT || 3000;

// ✅ CORS FIX DEFINITIVO
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }

  next();
});

app.use(express.json());

// ✅ ROUTES
const mangaRouter = require("./routes/manga");
const wishlistRouter = require("./routes/wishlist");

// ✅ ROUTE ACQUISTO
const wishlistActions = require("./routes/wishlistActions");

app.use("/api/manga", mangaRouter);
app.use("/api/wishlist", wishlistRouter);
app.use("/api/wishlist-actions", wishlistActions);

app.get("/", (req, res) => {
  res.send("API OK 🚀");
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
``
