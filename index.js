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
app.use("/api/utenti", require("./routes/utenti"));
app.use("/api/manga", require("./routes/manga"));
app.use("/api/wishlist", require("./routes/wishlist"));
app.use("/api/wishlist-actions", require("./routes/wishlistActions"));
app.use("/api/reading-history", require("./routes/readingHistory"));
app.use("/api/reading-sessions", require("./routes/readingSessions"));
app.use("/api/letture-droppate", require("./routes/droppate"));
app.use("/api/note", require("./routes/note"));
app.use("/api/marketplace", require("./routes/marketplace"));
app.use("/api/cover", require("./routes/cover"));
app.use("/api/simili", require("./routes/simili"));
app.use("/api/tornei", require("./routes/tornei"));
app.use("/api/autore", require("./routes/autore"));
app.use("/api/anime", require("./routes/anime"));

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

  // La riga del proprietario si riallinea alle variabili d'ambiente a
  // ogni avvio: le sue credenziali restano su Render, il database ne
  // tiene solo l'identificativo e il soprannome. Dopo l'ascolto e non
  // prima, perché un database lento non deve ritardare il momento in
  // cui il server risponde — e se la migrazione 009 non è ancora stata
  // eseguita si limita a dirlo.
  require("./services/utenti")
    .preparaUtenti()
    .catch((err) => console.error("❌ PREPARA UTENTI:", err.message));
});
