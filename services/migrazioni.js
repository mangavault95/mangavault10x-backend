// services/migrazioni.js
//
// Il registro delle migrazioni: quali file di `sql/` sono già stati
// eseguiti sul database, e il modo di eseguire solo quelli che mancano.
//
// ---------------------------------------------------------------
// PERCHÉ ESISTE
//
// Le migrazioni 001-027 le ha incollate a mano una persona nel SQL
// Editor di Supabase. Nessuno ha scritto quali. Il codice ha imparato a
// cavarsela lo stesso: una quarantina di rami che sul codice di errore
// 42P01 (tabella assente) o 42703 (colonna assente) ripiegano su un
// comportamento vecchio. Funziona, ma serve dati degradati in silenzio
// se una migrazione è stata dimenticata, e non c'è modo di saperlo.
//
// ---------------------------------------------------------------
// COSA NON FA, E PERCHÉ
//
// NON riesegue le migrazioni vecchie, mai. Alcune non sono ripetibili:
// la 006 riscrive gli `AnimeClickID` che nel frattempo si sono corretti
// a mano, la 003 ragiona su una colonna che la 009 ha poi tolto. Il
// registro nasce quindi da una BASELINE: si dichiara «le prime N sono
// già a posto» e si segnano come tali senza eseguirle. Da lì in avanti
// ogni file nuovo si applica una volta sola.
//
// La baseline non si fida alla cieca: per ogni file legge dal SQL gli
// oggetti che crea (tabelle, colonne, indici) e controlla che sul
// database ci siano. Sono «testimoni», e non provano che la migrazione
// sia stata eseguita per intero (una che fa solo UPDATE non ne ha), ma
// se un testimone manca la migrazione di certo non è passata.
//
// NON parte da sola, né all'avvio del server né al deploy: ogni comando
// è una simulazione finché non si passa `--si`.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const CARTELLA_SQL = path.join(__dirname, "..", "sql");

// Nessun numero ripetuto è ammesso: due file con lo stesso numero sono
// quasi sempre due persone (o due rami) che hanno scelto lo stesso e vanno
// messe d'accordo. (C'è stato un 006 doppio: uno dei due non è mai stato
// eseguito ed è in `sql/archivio/`, che qui non si legge.)
const DOPPIONI_AMMESSI = new Set();

// Numero del lucchetto che impedisce due esecutori insieme. Diverso da
// `LUCCHETTO_ID_MANGA` (services/idManga.js).
const LUCCHETTO = 7226502;

// Il checksum di una riga di baseline scritta da SQL (vedi `sqlBaseline`):
// da SQL non si leggono i file, quindi non c'è niente da registrare.
const CHECKSUM_IGNOTO = "-";

const checksum = (testo) => crypto.createHash("sha256").update(testo).digest("hex").slice(0, 16);

/* ==================================================
   L'ELENCO DEI FILE
   ================================================== */

/**
 * I file `NNN_nome.sql` di una cartella, in ordine.
 *
 * L'identificativo è il nome senza estensione, non il numero: i due 006
 * si distinguono, e il registro resta leggibile a occhio.
 */
function elenco(cartella = CARTELLA_SQL) {
  const trovati = [];

  for (const file of fs.readdirSync(cartella).sort()) {
    if (!file.endsWith(".sql")) continue;

    const m = file.match(/^(\d{3})_(.+)\.sql$/);

    if (!m) throw new Error(`Nome non valido in ${cartella}: «${file}» (serve NNN_nome.sql)`);

    const sql = fs.readFileSync(path.join(cartella, file), "utf8");

    trovati.push({ id: file.replace(/\.sql$/, ""), numero: Number(m[1]), file, sql, checksum: checksum(sql) });
  }

  const visti = new Map();

  for (const mig of trovati) {
    if (visti.has(mig.numero) && !DOPPIONI_AMMESSI.has(mig.numero)) {
      throw new Error(
        `Due migrazioni col numero ${String(mig.numero).padStart(3, "0")}: ${visti.get(mig.numero)} e ${mig.file}. ` +
          `Una delle due va rinumerata.`
      );
    }

    visti.set(mig.numero, mig.file);
  }

  return trovati;
}

/* ==================================================
   LEGGERE IL SQL SENZA ESEGUIRLO
   ================================================== */

/**
 * Il SQL senza commenti, senza il contenuto delle stringhe e senza i
 * corpi `$$ … $$`: resta solo la struttura dei comandi.
 *
 * Passo unico e non tre espressioni regolari in fila, perché si
 * mangiano a vicenda: un commento con un apostrofo («l'ID») apre una
 * stringa che non esiste, e una stringa con dentro `--` apre un
 * commento che non esiste.
 *
 * I corpi `DO $$ … $$` si buttano apposta: sono condizionali, e un
 * `CREATE TABLE` lì dentro non prova niente.
 */
function ripulisci(sql) {
  const s = String(sql);
  let fuori = "";
  let i = 0;

  while (i < s.length) {
    const c = s[i];
    const due = s.slice(i, i + 2);

    if (due === "--") {
      while (i < s.length && s[i] !== "\n") i += 1;
    } else if (due === "/*") {
      const fine = s.indexOf("*/", i + 2);

      i = fine < 0 ? s.length : fine + 2;
      fuori += " ";
    } else if (c === "'") {
      i += 1;

      while (i < s.length) {
        if (s[i] === "'" && s[i + 1] === "'") i += 2;
        else if (s[i] === "'") break;
        else i += 1;
      }

      i += 1;
      fuori += "''";
    } else if (c === '"') {
      // Un identificativo fra virgolette resta così com'è.
      const fine = s.indexOf('"', i + 1);
      const pezzo = s.slice(i, fine < 0 ? s.length : fine + 1);

      fuori += pezzo;
      i += pezzo.length;
    } else if (c === "$") {
      const apertura = s.slice(i).match(/^\$([A-Za-z_]\w*)?\$/);

      if (apertura) {
        const fine = s.indexOf(apertura[0], i + apertura[0].length);

        i = fine < 0 ? s.length : fine + apertura[0].length;
        fuori += "$$$$";
      } else {
        fuori += c;
        i += 1;
      }
    } else {
      fuori += c;
      i += 1;
    }
  }

  return fuori;
}

/** `"Manga"`, `public."Manga"`, `manga` → il nome com'è per Postgres. */
function nomeDi(grezzo) {
  const pezzo = String(grezzo).split(".").pop();

  return pezzo.startsWith('"') ? pezzo.slice(1, -1) : pezzo.toLowerCase();
}

const IDENT = '("[^"]+"|[\\w]+(?:\\.[\\w]+)?)';
const IDENT_PUNTATO = '((?:"[^"]+"|\\w+)(?:\\.(?:"[^"]+"|\\w+))?)';

/**
 * Cosa un file crea e cosa toglie, dalla lettura del SQL.
 *
 * Solo ciò che si può dire con certezza: tabelle, colonne e indici
 * creati con CREATE TABLE / ADD COLUMN / CREATE INDEX, e quello che
 * DROP e RENAME portano via. Viste, funzioni e trigger no: `CREATE OR
 * REPLACE` li riscrive a ogni giro e la loro presenza non dice niente
 * su QUALE versione c'è.
 */
function leggiOggetti(sql) {
  const crea = [];
  const toglie = [];

  for (const comando of ripulisci(sql).split(";")) {
    const c = comando.trim();

    if (!c) continue;

    let m = c.match(new RegExp(`^CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${IDENT_PUNTATO}`, "i"));

    if (m) {
      crea.push({ tipo: "tabella", nome: nomeDi(m[1]) });
      continue;
    }

    m = c.match(new RegExp(`^CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?${IDENT}`, "i"));

    if (m) {
      crea.push({ tipo: "indice", nome: nomeDi(m[1]) });
      continue;
    }

    m = c.match(new RegExp(`^CREATE\\s+SEQUENCE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${IDENT_PUNTATO}`, "i"));

    if (m) {
      crea.push({ tipo: "sequenza", nome: nomeDi(m[1]) });
      continue;
    }

    m = c.match(new RegExp(`^DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?([^;]+)`, "i"));

    if (m) {
      for (const t of m[1].split(",")) toglie.push({ tipo: "tabella", nome: nomeDi(t.replace(/\b(CASCADE|RESTRICT)\b/gi, "").trim()) });
      continue;
    }

    m = c.match(new RegExp(`^DROP\\s+INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+EXISTS\\s+)?${IDENT}`, "i"));

    if (m) {
      toglie.push({ tipo: "indice", nome: nomeDi(m[1]) });
      continue;
    }

    m = c.match(new RegExp(`^ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?${IDENT_PUNTATO}`, "i"));

    if (m) {
      const tabella = nomeDi(m[1]);

      for (const col of c.matchAll(/ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?("[^"]+"|\w+)/gi)) {
        crea.push({ tipo: "colonna", tabella, nome: nomeDi(col[1]) });
      }

      for (const col of c.matchAll(/DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?("[^"]+"|\w+)/gi)) {
        toglie.push({ tipo: "colonna", tabella, nome: nomeDi(col[1]) });
      }

      const ribattezza = c.match(/RENAME\s+COLUMN\s+("[^"]+"|\w+)\s+TO\s+("[^"]+"|\w+)/i);

      if (ribattezza) {
        toglie.push({ tipo: "colonna", tabella, nome: nomeDi(ribattezza[1]) });
        crea.push({ tipo: "colonna", tabella, nome: nomeDi(ribattezza[2]) });
      } else if (/RENAME\s+TO\b/i.test(c)) {
        toglie.push({ tipo: "tabella", nome: tabella });
      }
    }
  }

  return { crea, toglie };
}

const chiave = (o) => `${o.tipo}:${o.tabella ? `${o.tabella}.` : ""}${o.nome}`;

/**
 * I testimoni di ogni migrazione: quello che crea E CHE NON È STATO
 * TOLTO DOPO. La 003 aggiunge una colonna che la 009 elimina: cercarla
 * oggi direbbe «manca» a una migrazione perfettamente eseguita.
 */
function testimoni(migrazioni) {
  const lette = migrazioni.map((m) => ({ id: m.id, ...leggiOggetti(m.sql) }));

  return lette.map((m, i) => {
    const tolti = new Set();
    const tabelleTolte = new Set();

    for (const dopo of lette.slice(i + 1)) {
      for (const t of dopo.toglie) {
        tolti.add(chiave(t));

        if (t.tipo === "tabella") tabelleTolte.add(t.nome);
      }
    }

    const visti = new Set();
    const validi = [];

    for (const o of m.crea) {
      if (tolti.has(chiave(o))) continue;
      if (o.tabella && tabelleTolte.has(o.tabella)) continue;
      if (visti.has(chiave(o))) continue;

      visti.add(chiave(o));
      validi.push(o);
    }

    return { id: m.id, testimoni: validi };
  });
}

/** Quali testimoni ci sono sul database, e quali no. */
async function controllaTestimoni(cliente, lista) {
  const presenti = [];
  const mancanti = [];

  for (const o of lista) {
    let q;

    if (o.tipo === "tabella") {
      q = ["SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1", [o.nome]];
    } else if (o.tipo === "colonna") {
      q = [
        "SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2",
        [o.tabella, o.nome]
      ];
    } else if (o.tipo === "sequenza") {
      q = ["SELECT 1 FROM information_schema.sequences WHERE sequence_schema = current_schema() AND sequence_name = $1", [o.nome]];
    } else {
      q = ["SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = $1", [o.nome]];
    }

    const { rowCount } = await cliente.query(q[0], q[1]);

    (rowCount ? presenti : mancanti).push(o);
  }

  return { presenti, mancanti };
}

const descrivi = (o) => (o.tipo === "colonna" ? `colonna ${o.tabella}.${o.nome}` : `${o.tipo} ${o.nome}`);

/* ==================================================
   IL REGISTRO
   ================================================== */

async function haIlRegistro(cliente) {
  const { rowCount } = await cliente.query(
    "SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'schema_migrations'"
  );

  return rowCount > 0;
}

async function creaIlRegistro(cliente) {
  await cliente.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          TEXT PRIMARY KEY,
      checksum    TEXT NOT NULL,
      eseguita_il TIMESTAMPTZ NOT NULL DEFAULT now(),
      -- 'baseline' = dichiarata già eseguita, non eseguita da qui;
      -- 'applicata' = eseguita da questo esecutore.
      origine     TEXT NOT NULL DEFAULT 'applicata' CHECK (origine IN ('baseline', 'applicata'))
    )`);
}

async function lettoDalRegistro(cliente) {
  if (!(await haIlRegistro(cliente))) return null;

  const { rows } = await cliente.query("SELECT id, checksum, eseguita_il, origine FROM schema_migrations");

  return new Map(rows.map((r) => [r.id, r]));
}

/* ==================================================
   LO STATO (sola lettura)
   ================================================== */

/**
 * Per ogni file: se è nel registro, se è cambiato dopo, e quanti dei
 * suoi testimoni sono sul database. Non scrive niente, nemmeno il
 * registro.
 */
async function stato(cliente, cartella = CARTELLA_SQL) {
  const migrazioni = elenco(cartella);
  const registro = await lettoDalRegistro(cliente);
  const testi = testimoni(migrazioni);
  const righe = [];

  for (let i = 0; i < migrazioni.length; i += 1) {
    const m = migrazioni[i];
    const voce = registro?.get(m.id) ?? null;
    const t = await controllaTestimoni(cliente, testi[i].testimoni);

    righe.push({
      id: m.id,
      numero: m.numero,
      registrata: Boolean(voce),
      origine: voce?.origine ?? null,
      // Una baseline fatta a mano da SQL (checksum «-») non ha un
      // checksum da confrontare: non si può dire «modificata».
      modificata: Boolean(voce) && voce.checksum !== CHECKSUM_IGNOTO && voce.checksum !== m.checksum,
      testimoni: { totali: testi[i].testimoni.length, mancanti: t.mancanti.map(descrivi) }
    });
  }

  const inRegistroSenzaFile = registro ? [...registro.keys()].filter((id) => !migrazioni.some((m) => m.id === id)) : [];

  return { conRegistro: Boolean(registro), righe, inRegistroSenzaFile };
}

/* ==================================================
   LA BASELINE
   ================================================== */

/**
 * Segna come già eseguite le migrazioni fino al numero `fino`, SENZA
 * eseguirle.
 *
 * Rifiuta se un testimone manca (la migrazione di certo non è passata)
 * a meno di `forza`. Con `si` falso non scrive niente e dice cosa
 * farebbe.
 */
async function baseline(cliente, { fino, si = false, forza = false, cartella = CARTELLA_SQL } = {}) {
  if (!Number.isInteger(fino) || fino < 1) throw new Error("Serve `--fino N`: l'ultima migrazione già eseguita.");

  const migrazioni = elenco(cartella);
  const testi = testimoni(migrazioni);
  const incluse = migrazioni.filter((m) => m.numero <= fino);

  if (!incluse.length) throw new Error(`Nessuna migrazione fino alla ${fino}.`);

  const registro = await lettoDalRegistro(cliente);
  const mancanti = [];
  const senzaTestimoni = [];

  for (const m of incluse) {
    const lista = testi[migrazioni.indexOf(m)].testimoni;

    if (!lista.length) {
      senzaTestimoni.push(m.id);
      continue;
    }

    const esito = await controllaTestimoni(cliente, lista);

    if (esito.mancanti.length) mancanti.push({ id: m.id, mancanti: esito.mancanti.map(descrivi) });
  }

  const daSegnare = incluse.filter((m) => !registro?.has(m.id));

  if (mancanti.length && !forza) {
    return { eseguita: false, rifiutata: true, mancanti, senzaTestimoni, daSegnare: daSegnare.map((m) => m.id) };
  }

  if (!si) return { eseguita: false, rifiutata: false, mancanti, senzaTestimoni, daSegnare: daSegnare.map((m) => m.id) };

  await cliente.query("BEGIN");

  try {
    await creaIlRegistro(cliente);

    for (const m of daSegnare) {
      await cliente.query(
        "INSERT INTO schema_migrations (id, checksum, origine) VALUES ($1, $2, 'baseline') ON CONFLICT (id) DO NOTHING",
        [m.id, m.checksum]
      );
    }

    await cliente.query("COMMIT");
  } catch (errore) {
    await cliente.query("ROLLBACK").catch(() => {});
    throw errore;
  }

  return { eseguita: true, rifiutata: false, mancanti, senzaTestimoni, daSegnare: daSegnare.map((m) => m.id) };
}

/* ==================================================
   LA BASELINE SENZA TERMINALE
   ================================================== */

const quota = (testo) => `'${String(testo).replace(/'/g, "''")}'`;

/**
 * Lo stesso controllo della baseline, come un SELECT da incollare nel
 * SQL Editor di Supabase. Restituisce le righe dei testimoni che
 * MANCANO: nessuna riga vuol dire che si può procedere.
 *
 * Serve a chi non ha un terminale (un telefono): il comando
 * `migra baseline` fa le stesse cose da riga di comando.
 */
function sqlControllo(migrazioni, fino) {
  const testi = testimoni(migrazioni);
  const righe = [];

  migrazioni.forEach((mig, i) => {
    if (mig.numero > fino) return;

    for (const o of testi[i].testimoni) {
      righe.push(`(${quota(mig.id)}, ${quota(o.tipo)}, ${quota(o.tabella ? `${o.tabella}.${o.nome}` : o.nome)})`);
    }
  });

  return `-- Controllo prima della baseline.
-- Deve restituire ZERO righe: ogni riga è un oggetto che una migrazione
-- avrebbe dovuto creare e non c'è. Se ne esce qualcuna, FERMATI.
SELECT m.id AS migrazione, m.tipo, m.oggetto AS manca
FROM (VALUES
  ${righe.join(",\n  ")}
) AS m(id, tipo, oggetto)
WHERE NOT CASE m.tipo
  WHEN 'tabella' THEN EXISTS (SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = m.oggetto)
  WHEN 'colonna' THEN EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = split_part(m.oggetto, '.', 1)
      AND column_name = split_part(m.oggetto, '.', 2))
  WHEN 'sequenza' THEN EXISTS (SELECT 1 FROM information_schema.sequences
    WHERE sequence_schema = current_schema() AND sequence_name = m.oggetto)
  ELSE EXISTS (SELECT 1 FROM pg_indexes
    WHERE schemaname = current_schema() AND indexname = m.oggetto)
END;`;
}

/**
 * La baseline come SQL da incollare: crea il registro e segna le
 * migrazioni fino a `fino` come già eseguite. NON esegue nessuna di
 * quelle migrazioni, e si può rilanciare senza danni.
 */
function sqlBaseline(migrazioni, fino) {
  const ids = migrazioni.filter((m) => m.numero <= fino).map((m) => quota(m.id));

  return `-- Baseline: segna come GIÀ ESEGUITE le migrazioni fino alla ${String(fino).padStart(3, "0")}.
-- Non esegue nessuna migrazione: scrive solo il registro. Si può rilanciare.
CREATE TABLE IF NOT EXISTS schema_migrations (
  id          TEXT PRIMARY KEY,
  checksum    TEXT NOT NULL,
  eseguita_il TIMESTAMPTZ NOT NULL DEFAULT now(),
  origine     TEXT NOT NULL DEFAULT 'applicata' CHECK (origine IN ('baseline', 'applicata'))
);

INSERT INTO schema_migrations (id, checksum, origine)
SELECT id, '${CHECKSUM_IGNOTO}', 'baseline'
FROM unnest(ARRAY[
  ${ids.join(",\n  ")}
]) AS id
ON CONFLICT (id) DO NOTHING;

-- Deve dire ${ids.length}.
SELECT count(*) AS segnate FROM schema_migrations;`;
}

/**
 * Una migrazione come SQL da incollare nel SQL Editor: il suo testo e, nella
 * STESSA transazione, la riga nel registro. O passa tutto e risulta applicata,
 * o non cambia niente. Con la riga del registro `ON CONFLICT DO NOTHING`, si
 * può rilanciare senza doppioni (la migrazione stessa dev'essere ripetibile).
 *
 * Per chi non ha un terminale: `migra applica --si` fa lo stesso da riga di
 * comando. Il `BEGIN`/`COMMIT` esplicito non fa male se l'editor ne apre già
 * uno (Postgres avvisa e va avanti), e tiene insieme le istruzioni se l'editor
 * le manda una per una.
 */
function sqlMigrazione(migrazione) {
  return `BEGIN;

${migrazione.sql.trim()}

INSERT INTO schema_migrations (id, checksum, origine)
VALUES (${quota(migrazione.id)}, ${quota(migrazione.checksum)}, 'applicata')
ON CONFLICT (id) DO NOTHING;

COMMIT;

-- Deve dire ${migrazione.id}, applicata.
SELECT id, origine, eseguita_il FROM schema_migrations WHERE id = ${quota(migrazione.id)};`;
}

/* ==================================================
   APPLICARE QUELLE CHE MANCANO
   ================================================== */

/**
 * Esegue, in ordine, le migrazioni che non sono nel registro. Ognuna
 * in una transazione sua insieme alla riga del registro: o passa tutta
 * e viene segnata, o non cambia niente.
 *
 * Rifiuta se il registro non c'è (prima la baseline: senza, parte da
 * 001 e riesegue tutto), e se una migrazione da applicare ha un numero
 * più basso di una già applicata (storia riscritta). Con `si` falso
 * elenca soltanto.
 */
async function applica(cliente, { si = false, forza = false, cartella = CARTELLA_SQL, scrivi = () => {} } = {}) {
  const migrazioni = elenco(cartella);
  const registro = await lettoDalRegistro(cliente);

  if (!registro) {
    throw new Error("Il registro non esiste. Prima la baseline: `node scripts/migra.js baseline --fino N --si`.");
  }

  // Un registro vuoto non è «niente da fare»: è una baseline mai fatta
  // (o una tabella che questo utente non riesce a leggere), e applicare
  // da qui vorrebbe dire rieseguire TUTTE le migrazioni, comprese
  // quelle che riscrivono dati.
  if (registro.size === 0) {
    throw new Error("Il registro è vuoto: la baseline non è stata fatta. Eseguirla prima di applicare.");
  }

  const daFare = migrazioni.filter((m) => !registro.has(m.id));
  const ultimaApplicata = Math.max(0, ...migrazioni.filter((m) => registro.has(m.id)).map((m) => m.numero));
  const fuoriOrdine = daFare.filter((m) => m.numero < ultimaApplicata);

  if (fuoriOrdine.length && !forza) {
    throw new Error(
      `Da applicare ma più vecchie dell'ultima già applicata (${String(ultimaApplicata).padStart(3, "0")}): ` +
        `${fuoriOrdine.map((m) => m.id).join(", ")}. Rinumerarle, o \`--forza\` se è voluto.`
    );
  }

  if (!si) return { eseguite: [], daFare: daFare.map((m) => m.id) };

  // Un esecutore alla volta, anche se qualcuno lancia due comandi.
  const { rows } = await cliente.query("SELECT pg_try_advisory_lock($1) AS preso", [LUCCHETTO]);

  if (!rows[0].preso) throw new Error("Un'altra esecuzione delle migrazioni è in corso.");

  const eseguite = [];

  try {
    for (const m of daFare) {
      scrivi(`  → ${m.id}`);

      await cliente.query("BEGIN");

      try {
        // `LOCAL`: vale solo dentro questa transazione. Il lucchetto
        // limita l'attesa — una ALTER TABLE ferma il sito se aspetta
        // per sempre dietro una query lunga — e lo statement il tempo.
        await cliente.query("SET LOCAL lock_timeout = '10s'");
        await cliente.query("SET LOCAL statement_timeout = '300s'");
        await cliente.query(m.sql);
        await cliente.query("INSERT INTO schema_migrations (id, checksum, origine) VALUES ($1, $2, 'applicata')", [m.id, m.checksum]);
        await cliente.query("COMMIT");

        eseguite.push(m.id);
      } catch (errore) {
        await cliente.query("ROLLBACK").catch(() => {});
        errore.message = `${m.id}: ${errore.message}`;
        errore.eseguite = eseguite;
        throw errore;
      }
    }
  } finally {
    await cliente.query("SELECT pg_advisory_unlock($1)", [LUCCHETTO]).catch(() => {});
  }

  return { eseguite, daFare: daFare.map((m) => m.id) };
}

module.exports = {
  CARTELLA_SQL,
  elenco,
  ripulisci,
  leggiOggetti,
  testimoni,
  controllaTestimoni,
  stato,
  baseline,
  applica,
  haIlRegistro,
  sqlControllo,
  sqlBaseline,
  sqlMigrazione,
  CHECKSUM_IGNOTO
};
