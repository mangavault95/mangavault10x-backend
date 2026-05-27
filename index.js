require("dotenv").config();

const express = require("express");
const cors = require("cors");

const app = express();
const port = process.env.PORT || 3000;

// ✅ CORS FIX COMPLETO
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json());

// ✅ ROUTES
const mangaRouter = require("./routes/manga");
const wishlistRouter = require("./routes/wishlist");

// usa le route
app.use("/api/manga", mangaRouter);
app.use("/api/wishlist", wishlistRouter);

// ✅ TEST ROUTE
app.get("/", (req, res) => {
  res.send("API OK 🚀");
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
