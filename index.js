require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { assertConfig } = require("./services/auth");

// Fallisco subito se le credenziali non sono configurate,
// invece di scoprirlo al primo tentativo di login.
assertConfig();

const app = express();
const port = process.env.PORT || 3000;

// --------------------------------------------------
// CORS — solo le origini dichiarate.
// In dev accetto localhost su qualsiasi porta.
// --------------------------------------------------
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

const isDev = process.env.NODE_ENV !== "production";

app.use(
  cors({
    origin(origin, callback) {
      // Richieste senza Origin (curl, health check di Render) restano permesse.
      if (!origin) return callback(null, true);

      if (allowedOrigins.includes(origin)) return callback(null, true);

      if (isDev && /^http:\/\/localhost(:\d+)?$/.test(origin)) {
        return callback(null, true);
      }

      return callback(new Error(`Origine non autorizzata: ${origin}`));
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"]
  })
);

app.use(express.json());

// --------------------------------------------------
// ROUTES
// --------------------------------------------------
app.use("/api/manga", require("./routes/manga"));
app.use("/api/wishlist", require("./routes/wishlist"));
app.use("/api/wishlist-actions", require("./routes/wishlistActions"));
app.use("/api/reading-history", require("./routes/readingHistory"));
app.use("/api/reading-sessions", require("./routes/readingSessions"));
app.use("/api/marketplace", require("./routes/marketplace"));
app.use("/api/cover", require("./routes/cover"));
app.use("/api/simili", require("./routes/simili"));

app.get("/", (req, res) => {
  res.send("MangaVault API attiva 🚀");
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// --------------------------------------------------
// ERROR HANDLER — evita che un errore CORS o un throw
// non gestito faccia cadere la risposta senza spiegazione.
// --------------------------------------------------
app.use((err, req, res, next) => {
  if (err?.message?.startsWith("Origine non autorizzata")) {
    return res.status(403).json({ error: err.message });
  }

  console.error("❌ UNHANDLED ERROR:", err);
  return res.status(500).json({ error: "Errore server" });
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  console.log(`Origini autorizzate: ${allowedOrigins.join(", ") || "(nessuna!)"}`);
});
