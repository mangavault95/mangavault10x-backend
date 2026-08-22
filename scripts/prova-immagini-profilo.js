/**
 * Facce e striscioni sui dati veri, senza toccarli.
 *
 * Applica la migrazione 017 dentro una transazione, ci dirotta dentro
 * il servizio, mette e toglie immagini, e alla fine ROLLBACK.
 *
 * Prova due cose che a occhio non si vedono:
 *   — che i byte tornino indietro IDENTICI a come sono entrati
 *     (BYTEA e non testo: un giro sbagliato li corrompe in silenzio, e
 *     il difetto si scoprirebbe guardando un'immagine rotta);
 *   — che quello che NON è un'immagine venga rifiutato, SVG compreso.
 *
 * Uso:
 *   node scripts/prova-immagini-profilo.js
 */

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const pool = require("../db");
const immagini = require("../services/immagini");

const MIGRAZIONE = path.join(__dirname, "..", "sql", "017_facce_e_striscioni.sql");

// Un PNG vero, il più piccolo che esista: un pixel trasparente.
const PNG =
  "data:image/png;base64," +
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

// Un JPEG vero, minimo.
const JPEG =
  "data:image/jpeg;base64," +
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";

function titolo(testo) {
  console.log(`\n${"═".repeat(60)}\n${testo}\n${"═".repeat(60)}`);
}

let male = 0;

function verifica(ok, cosa) {
  if (!ok) male += 1;
  console.log(`${ok ? "✅" : "❌"} ${cosa}`);
}

(async () => {
  const cliente = await pool.connect();

  try {
    await cliente.query("SET lock_timeout = '5s'");
    await cliente.query("SET statement_timeout = '60s'");
    await cliente.query("BEGIN");

    titolo("1 · la migrazione 017");

    await cliente.query(fs.readFileSync(MIGRAZIONE, "utf8"));
    console.log("✅ nessun errore SQL");

    titolo("2 · cosa si rifiuta");

    const rifiuti = [
      ["testo qualunque", "ciao"],
      ["un indirizzo normale", "https://esempio.it/foto.png"],
      // ⚠️ La prova che conta. Un SVG è XML e può contenere `<script>`:
      // servirlo dal nostro dominio vorrebbe dire far girare codice
      // altrui su un indirizzo che ha in mano i token di tutti.
      ["un SVG", "data:image/svg+xml;base64," + Buffer.from("<svg/>").toString("base64")],
      ["un PDF travestito da PNG", "data:image/png;base64," + Buffer.from("%PDF-1.4").toString("base64")],
      ["un'immagine vuota", "data:image/png;base64,"]
    ];

    for (const [cosa, valore] of rifiuti) {
      const esito = immagini.decodifica(valore, { massimo: 400 * 1024 });

      verifica(Boolean(esito.errore), `${cosa} → rifiutato (${esito.errore || "PASSATO!"})`);
    }

    const troppoGrande = "data:image/png;base64," + "A".repeat(1_000_000);

    verifica(
      Boolean(immagini.decodifica(troppoGrande, { massimo: 400 * 1024 }).errore),
      "un'immagine oltre il tetto → rifiutata"
    );

    titolo("3 · cosa si accetta");

    for (const [cosa, valore] of [["un PNG", PNG], ["un JPEG", JPEG]]) {
      const esito = immagini.decodifica(valore, { massimo: 400 * 1024 });

      verifica(!esito.errore && Buffer.isBuffer(esito.dati), `${cosa} → accettato come ${esito.tipo}`);
    }

    titolo("4 · andata e ritorno dal database");

    const { rows: gente } = await cliente.query(
      `SELECT id, nickname FROM utenti WHERE stato = 'attivo' ORDER BY proprietario DESC LIMIT 1`
    );

    const io = gente[0];

    console.log(`(la cavia è ${io.nickname}, e alla fine si annulla tutto)\n`);

    const originale = immagini.decodifica(PNG, { massimo: 400 * 1024 });

    await cliente.query(
      `UPDATE utenti SET faccia = $1, faccia_tipo = $2, faccia_il = NOW() WHERE id = $3`,
      [originale.dati, originale.tipo, io.id]
    );

    const { rows: riletta } = await cliente.query(
      `SELECT faccia, faccia_tipo, faccia_il FROM utenti WHERE id = $1`,
      [io.id]
    );

    verifica(
      Buffer.compare(riletta[0].faccia, originale.dati) === 0,
      `i byte tornano identici (${originale.dati.length} byte, ${riletta[0].faccia_tipo})`
    );

    verifica(Boolean(riletta[0].faccia_il), "la data c'è: senza, l'indirizzo non cambierebbe mai");

    titolo("5 · lo striscione, riscritto per intero");

    const messe = [];

    for (let posto = 0; posto < 3; posto += 1) {
      const { rows } = await cliente.query(
        `INSERT INTO utenti_striscione (utente_id, ordine, immagine, tipo)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [io.id, posto, originale.dati, originale.tipo]
      );

      messe.push(Number(rows[0].id));
    }

    console.log(`   messe: ${messe.join(", ")}`);

    // Se ne tolgono due tenendo la seconda, che deve finire prima.
    const tenute = [messe[1]];

    await cliente.query(
      `DELETE FROM utenti_striscione WHERE utente_id = $1 AND NOT (id = ANY($2::bigint[]))`,
      [io.id, tenute]
    );

    await cliente.query(`UPDATE utenti_striscione SET ordine = 0 WHERE id = $1`, [messe[1]]);

    const { rows: rimaste } = await cliente.query(
      `SELECT id, ordine FROM utenti_striscione WHERE utente_id = $1 ORDER BY ordine, id`,
      [io.id]
    );

    verifica(
      rimaste.length === 1 && Number(rimaste[0].id) === messe[1],
      `ne resta una sola, quella tenuta (${rimaste.map((r) => r.id).join(", ")})`
    );

    titolo("6 · com'esce dalla lettura pubblica");

    const { rows: aspetto } = await cliente.query(
      `
      SELECT u.id, u.nickname, u.colore, u.proprietario, u.faccia_il,
             COALESCE(
               (SELECT array_agg(s.id ORDER BY s.ordine, s.id)
                  FROM utenti_striscione s WHERE s.utente_id = u.id),
               '{}'
             ) AS striscione
        FROM utenti u WHERE u.id = $1
      `,
      [io.id]
    );

    const r = aspetto[0];

    verifica(
      r.faccia_il !== null && Array.isArray(r.striscione) && r.striscione.length === 1,
      `${r.nickname}: faccia sì, striscione ${JSON.stringify(r.striscione.map(Number))}`
    );

    // I byte NON devono uscire da questa lettura: finisce dentro ogni
    // post del feed, e trenta kilobyte ripetuti quindici volte per
    // pagina sono mezzo megabyte di JSON.
    verifica(
      !("faccia" in r) || r.faccia === undefined,
      "i byte dell'immagine NON escono con l'anagrafica"
    );

    titolo("annullo tutto");

    await cliente.query("ROLLBACK");

    console.log("✅ ROLLBACK: il database è com'era.");
    console.log(male ? `\n❌ ${male} controlli falliti` : "\n✅ tutto a posto");

    process.exitCode = male ? 1 : 0;
  } catch (err) {
    await cliente.query("ROLLBACK").catch(() => {});
    console.error("\n❌", err.message);
    process.exitCode = 1;
  } finally {
    cliente.release();
    await pool.end();
  }
})();
