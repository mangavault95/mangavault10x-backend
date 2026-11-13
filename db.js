const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  // Senza un tetto di attesa, un database che non risponde tiene
  // appesa ogni richiesta finché non si stanca il browser. Dieci
  // secondi bastano a Supabase per svegliarsi, e oltre è un guasto
  // che conviene dire.
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 30_000,
  max: 10
});

// ⚠️ Non è una riga di cortesia. Una connessione ferma nel pool che il
// database chiude dal suo lato (riavvio di Supabase, pooler che taglia
// gli inattivi) emette `error` sul pool: senza nessuno in ascolto Node
// lo tratta come eccezione non gestita e il server CADE. La connessione
// rotta il pool la butta via da sé; qui basta non morire.
pool.on("error", (err) => {
  console.error("❌ POOL: connessione inattiva persa:", err.message);
});

module.exports = pool;
