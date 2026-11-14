// Rimette i dati di una copia di sicurezza (il file che scarica la Gestione) in un
// database VUOTO che ha già lo schema (le migrazioni, `npm run migra`).
//
//   DATABASE_URL=postgres://… node scripts/ripristina-copia.js copia.json          # a vuoto
//   DATABASE_URL=postgres://… node scripts/ripristina-copia.js copia.json --si     # scrive
//
// Quello che fa, nell'ordine:
//  1. rifiuta se il database non è vuoto: mescolare una copia con dati vivi dà
//     doppioni che nessuno saprebbe più distinguere;
//  2. inserisce le tabelle in un ordine che rispetta le chiavi esterne;
//  3. riallinea i contatori (le serie e gli acquisti nuovi non devono ripartire da 1);
//  4. controlla che ogni tabella abbia lo stesso numero di righe del file, e se una
//     non torna annulla TUTTO: o ritorna intero o non cambia niente.
//
// ⚠️ La copia non contiene le password né le chat Telegram (vedi services/esportazione.js).
// Chi si ripristina entra con una password inutilizzabile: il proprietario ha la sua
// nelle variabili d'ambiente di Render e non cambia; l'altra persona va rifatta
// (`scripts/hash-password.js`), e le chat si ricollegano premendo Start sui bot.

const fs = require("fs");
const { Pool } = require("pg");

const ident = (n) => `"${String(n).replace(/"/g, '""')}"`;
const GRUPPO = 1000;

function ordina(tabelle, dipendenze) {
  const resto = new Set(tabelle);
  const ordine = [];

  while (resto.size > 0) {
    const pronte = [...resto].filter((t) => [...(dipendenze.get(t) || [])].every((d) => !resto.has(d) || d === t));

    // Un giro di chiavi che si chiamano a vicenda: si inseriscono comunque, in ordine d'elenco.
    for (const t of pronte.length ? pronte : [...resto]) {
      ordine.push(t);
      resto.delete(t);
    }
  }

  return ordine;
}

async function ripristina(pool, copia, { scrivi = false } = {}) {
  if (copia?.app !== "MangaVault" || copia?.formato !== 1) {
    throw new Error("Questo non è un file di copia di MangaVault (formato 1)");
  }

  const nomi = Object.keys(copia.tabelle);
  const cliente = await pool.connect();
  const esito = { tabelle: {}, scritto: false };

  try {
    const { rows: esistenti } = await cliente.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`
    );
    const presenti = new Set(esistenti.map((r) => r.table_name));
    const mancanti = nomi.filter((n) => !presenti.has(n));

    if (mancanti.length) {
      throw new Error(`Nel database mancano le tabelle: ${mancanti.join(", ")}. Si lancia prima \`npm run migra\`.`);
    }

    for (const n of nomi) {
      const { rows } = await cliente.query(`SELECT 1 FROM ${ident(n)} LIMIT 1`);

      if (rows.length) throw new Error(`La tabella ${n} non è vuota: ripristino solo su un database vuoto.`);
    }

    const { rows: fk } = await cliente.query(
      `SELECT c.conrelid::regclass::text AS da, c.confrelid::regclass::text AS a
         FROM pg_constraint c WHERE c.contype = 'f' AND c.connamespace = current_schema()::regnamespace`
    );
    const dipendenze = new Map();

    for (const { da, a } of fk) {
      const d = da.replace(/^"|"$/g, "");
      const b = a.replace(/^"|"$/g, "");

      if (!dipendenze.has(d)) dipendenze.set(d, new Set());
      dipendenze.get(d).add(b);
    }

    const { rows: colonneDb } = await cliente.query(
      `SELECT table_name AS t, column_name AS c, is_nullable AS nullable, column_default AS def, is_generated AS gen
         FROM information_schema.columns WHERE table_schema = current_schema()`
    );

    await cliente.query("BEGIN");

    for (const n of ordina(nomi, dipendenze)) {
      const { colonne, righe } = copia.tabelle[n];
      const generate = new Set(colonneDb.filter((c) => c.t === n && c.gen === "ALWAYS").map((c) => c.c));
      const usate = colonne.filter((c) => !generate.has(c));

      // Le colonne che la copia non ha (password, chat): se il database le vuole piene
      // e non hanno un valore di partenza, per la password se ne mette uno inutilizzabile.
      const extra = colonneDb
        .filter((c) => c.t === n && !colonne.includes(c.c) && c.nullable === "NO" && !c.def && !generate.has(c.c))
        .map((c) => {
          if (c.c !== "password_hash") throw new Error(`${n}.${c.c} è obbligatoria e la copia non ce l'ha`);

          return { nome: c.c, valore: "'!'" };
        });

      for (let i = 0; i < righe.length; i += GRUPPO) {
        await cliente.query(
          `INSERT INTO ${ident(n)} (${[...usate, ...extra.map((e) => e.nome)].map(ident).join(", ")})
             OVERRIDING SYSTEM VALUE
             SELECT ${[...usate.map(ident), ...extra.map((e) => e.valore)].join(", ")}
               FROM jsonb_populate_recordset(null::${ident(n)}, $1::jsonb)`,
          [JSON.stringify(righe.slice(i, i + GRUPPO))]
        );
      }

      // I contatori ripartono dopo l'ultima riga, non da 1.
      for (const c of usate) {
        const { rows } = await cliente.query(`SELECT pg_get_serial_sequence($1, $2) AS sequenza`, [ident(n), c]);

        if (rows[0].sequenza) {
          await cliente.query(`SELECT setval($1, COALESCE(MAX(${ident(c)}), 1), MAX(${ident(c)}) IS NOT NULL) FROM ${ident(n)}`, [
            rows[0].sequenza
          ]);
        }
      }

      const { rows: conta } = await cliente.query(`SELECT count(*)::int AS n FROM ${ident(n)}`);

      esito.tabelle[n] = { nelFile: righe.length, inseriti: conta[0].n };

      if (conta[0].n !== righe.length) {
        throw new Error(`${n}: ${righe.length} righe nel file, ${conta[0].n} nel database. Annullo tutto.`);
      }
    }

    if (scrivi) {
      await cliente.query("COMMIT");
      esito.scritto = true;
    } else {
      await cliente.query("ROLLBACK");
    }

    return esito;
  } catch (err) {
    await cliente.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    cliente.release();
  }
}

module.exports = { ripristina, ordina };

if (require.main === module) {
  require("dotenv").config();

  const file = process.argv[2];
  const scrivi = process.argv.includes("--si");

  if (!file || !process.env.DATABASE_URL) {
    console.error("Uso: DATABASE_URL=… node scripts/ripristina-copia.js copia.json [--si]");
    process.exit(2);
  }

  const locale = /@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: locale ? false : { rejectUnauthorized: false }, max: 1 });

  ripristina(pool, JSON.parse(fs.readFileSync(file, "utf8")), { scrivi })
    .then((e) => {
      for (const [n, v] of Object.entries(e.tabelle)) console.log(`  ${n.padEnd(24)} ${v.inseriti} / ${v.nelFile}`);
      console.log(e.scritto ? "\nRipristinato." : "\nA vuoto: tutto torna, non ho scritto niente. Con --si scrive davvero.");
    })
    .catch((err) => {
      console.error(`\nNON ripristinato: ${err.message}`);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
