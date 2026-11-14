require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { assertConfig } = require("./services/auth");
const { saltiFidati } = require("./services/rete");

// Fallisco subito se le credenziali non sono configurate,
// invece di scoprirlo al primo tentativo di login.
assertConfig();

const app = express();
const port = process.env.PORT || 3000;

// Quanti proxy stanno davanti al server (Render ne mette almeno uno).
// Senza questa riga `req.ip` è l'indirizzo del proxy, uguale per tutti:
// i tetti alle richieste (services/limite.js) diventerebbero un tetto
// unico per l'intero sito, e dieci password sbagliate di un estraneo
// chiuderebbero fuori anche il proprietario.
//
// Il valore è il NUMERO di passaggi fidati, non «true»: con `true` si
// crede all'indirizzo più a sinistra di X-Forwarded-For, che chiunque
// può scriversi da solo e così aggirare ogni tetto. Con N si prende
// quello messo dall'N-esimo proxy da destra, che non si può falsificare.
// Un N troppo BASSO ricade nel difetto di prima (indirizzo del proxy);
// uno troppo alto è la falla. Per questo il predefinito è 1 e si cambia
// con la variabile TRUST_PROXY (0 = nessun proxy), dopo aver guardato
// nei log di Render la riga «limite: 429 ip=… xff=…».
app.set("trust proxy", saltiFidati(process.env.TRUST_PROXY));

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

// Le immagini di profilo arrivano come data URI dentro il JSON, e
// sono l'unica cosa in tutto il sito che supera i cento kilobyte di
// corpo che `express.json()` accetta di suo.
//
// Il lettore con il tetto largo va montato PRIMA di quello normale e
// solo su quei due indirizzi: body-parser marca la richiesta appena
// l'ha letta, e il secondo lettore la lascia stare. Al contrario —
// tetto largo per tutti — si aprirebbe una porta da quattro megabyte
// su ogni rotta del sito per comodo di due.
app.use(["/api/utenti/io/faccia", "/api/utenti/io/striscione"], express.json({ limit: "4mb" }));

app.use(express.json());

// --------------------------------------------------
// ROUTES
// --------------------------------------------------
// L'elenco sta in routes/montaggio.js: lo legge anche il controllo che ogni rotta
// che scrive abbia una guardia (scripts/prova-protezione.js).
for (const [indirizzo, rotte] of require("./routes/montaggio")) app.use(indirizzo, rotte);

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

// --------------------------------------------------
// ULTIMA RETE
//
// Da Node 15 una promessa rifiutata che nessuno raccoglie fa USCIRE il
// processo. Con Express 4, che non aspetta le funzioni async, basta un
// `await` fuori da un `try` in una rotta qualunque: il server cadrebbe
// per tutti a causa della richiesta di uno. Qui si scrive cos'è
// successo e si resta in piedi — l'errore va comunque corretto dove
// nasce, questa è la rete, non la soluzione.
// --------------------------------------------------
process.on("unhandledRejection", (motivo) => {
  console.error("❌ PROMESSA RIFIUTATA E NON RACCOLTA:", motivo);
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
