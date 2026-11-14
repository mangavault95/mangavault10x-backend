// Prova del registro delle migrazioni (services/migrazioni.js).
//
//   node scripts/prova-migra.js
//
// La parte che legge il SQL gira ovunque, senza database. La parte che
// esegue (baseline, applica, rollback) gira se `PROVA_DATABASE_URL` punta
// a un Postgres di prova: lavora in uno schema suo, creato e buttato via,
// e non tocca altro. Mai puntarla al database vero — per sicurezza il
// nome dello schema è casuale e la prova non esegue mai i file di `sql/`.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { Client } = require("pg");

const m = require("../services/migrazioni");

let falliti = 0;

function prova(nome, atteso, ottenuto) {
  const a = JSON.stringify(atteso);
  const o = JSON.stringify(ottenuto);

  if (a === o) console.log(`  ok   ${nome}`);
  else {
    falliti += 1;
    console.log(`  NO   ${nome}\n       atteso   ${a}\n       ottenuto ${o}`);
  }
}

const cartellaDi = (file) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "migra-"));

  for (const [nome, sql] of Object.entries(file)) fs.writeFileSync(path.join(dir, nome), sql);

  return dir;
};

const lancia = (fn) => {
  try {
    fn();
    return null;
  } catch (e) {
    return e.message;
  }
};

const nomi = (lista) => lista.map((o) => (o.tabella ? `${o.tabella}.${o.nome}` : o.nome)).sort();

(async () => {
  console.log("\nLeggere il SQL");
  {
    const pulito = m.ripulisci(`
      -- non è l'unico "caso" ; CREATE TABLE finta (x int);
      CREATE TABLE vera (x int); /* CREATE TABLE finta2 */
      INSERT INTO vera VALUES ('un -- falso commento; CREATE TABLE finta3');
      DO $$ BEGIN CREATE TABLE dentro_il_do (x int); END $$;`);

    prova("commenti, stringhe e corpi $$ non lasciano comandi finti", [false, false, false, false, true], [/finta\b/.test(pulito), /finta2/.test(pulito), /finta3/.test(pulito), /dentro_il_do/.test(pulito), /vera/.test(pulito)]);

    const o = m.leggiOggetti(`
      CREATE TABLE IF NOT EXISTS public."Serie" (id int);
      ALTER TABLE "Serie" ADD COLUMN IF NOT EXISTS "Nuova" int, ADD COLUMN altra text;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_serie ON "Serie" (id);
      ALTER TABLE ONLY altro RENAME COLUMN vecchia TO nuova;
      DROP TABLE IF EXISTS buttata, buttata2 CASCADE;
      ALTER TABLE "Serie" DROP COLUMN IF EXISTS "Vecchia";`);

    prova("crea: tabella, colonne, indice, colonna ribattezzata", ["Serie", "Serie.Nuova", "Serie.altra", "altro.nuova", "idx_serie"], nomi(o.crea));
    prova("toglie: tabelle, colonna, colonna ribattezzata", ["Serie.Vecchia", "altro.vecchia", "buttata", "buttata2"], nomi(o.toglie));

    const fatti = m.testimoni([
      { id: "001_a", sql: 'CREATE TABLE t (x int); ALTER TABLE t ADD COLUMN y int, ADD COLUMN z int; CREATE TABLE s (k int); ALTER TABLE s ADD COLUMN k2 int;' },
      { id: "002_b", sql: "ALTER TABLE t DROP COLUMN y; DROP TABLE s;" }
    ]);

    prova("un oggetto tolto dopo non è un testimone (né le colonne di una tabella tolta)", ["t", "t.z"], nomi(fatti[0].testimoni));
  }

  console.log("\nI file veri di sql/");
  {
    const vere = m.elenco();

    prova("sono tutti leggibili e hanno un id solo", true, vere.length >= 27 && new Set(vere.map((x) => x.id)).size === vere.length);
    prova("un solo 006 (l'altro, mai eseguito, è in sql/archivio e non si legge)", ["006_animeclick"], vere.filter((x) => x.numero === 6).map((x) => x.id));

    const t = Object.fromEntries(m.testimoni(vere).map((x) => [x.id, nomi(x.testimoni)]));

    prova("027 aggiunge acquisti.gia_posseduti", ["acquisti.gia_posseduti"], t["027_gia_posseduti"]);
    prova("026 aggiunge Manga.SmessaIl", ["Manga.SmessaIl"], t["026_serie_smesse"]);
    prova("nessun testimone è una colonna tolta dopo: «Valutazione» non c'è", false, Object.values(t).flat().includes("Manga.Valutazione"));
    prova("le migrazioni di soli dati non hanno testimoni", [[], []], [t["002_pulizia_tipi"], t["025_riallinea_posseduti_e_italia"]]);
    prova("una sequenza creata è un testimone", ["manga_id_seq"], nomi(m.leggiOggetti("CREATE SEQUENCE IF NOT EXISTS manga_id_seq OWNED BY x;").crea));

    prova(
      "un numero nuovo ripetuto è un errore",
      true,
      /Due migrazioni col numero 028/.test(lancia(() => m.elenco(cartellaDi({ "028_a.sql": "SELECT 1;", "028_b.sql": "SELECT 2;" }))) || "")
    );
    prova("un nome sbagliato è un errore", true, /Nome non valido/.test(lancia(() => m.elenco(cartellaDi({ "a_senza_numero.sql": "SELECT 1;" }))) || ""));
  }

  const url = process.env.PROVA_DATABASE_URL;

  if (!url) {
    console.log("\n(PROVA_DATABASE_URL non c'è: salto la parte che esegue sul database.)");
  } else {
    const schema = `prova_migra_${Math.random().toString(36).slice(2, 10)}`;
    const locale = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
    const cliente = new Client({ connectionString: url, ssl: locale ? false : { rejectUnauthorized: false } });

    await cliente.connect();

    try {
      await cliente.query(`CREATE SCHEMA ${schema}`);
      await cliente.query(`SET search_path TO ${schema}`);

      const q = async (sql) => (await cliente.query(sql)).rows;
      const esiste = async (tabella) => (await q(`SELECT to_regclass('${schema}.${tabella}') AS r`))[0].r !== null;
      const ledger = async () => (await q("SELECT id, origine FROM schema_migrations ORDER BY id")).map((r) => `${r.id}:${r.origine}`);

      const dir = cartellaDi({
        "001_base.sql": "CREATE TABLE a (id int);",
        "002_colonna.sql": "ALTER TABLE a ADD COLUMN IF NOT EXISTS b int; INSERT INTO a (id, b) VALUES (1, 42);",
        "003_tabella.sql": "CREATE TABLE c (x int);"
      });

      console.log("\nSul database: stato e baseline");

      prova("senza registro lo dice, e non lo crea", [false, false], [(await m.stato(cliente, dir)).conRegistro, await esiste("schema_migrations")]);

      await q("CREATE TABLE a (id int)");

      const rifiutata = await m.baseline(cliente, { fino: 2, si: true, cartella: dir });

      prova("baseline con un testimone che manca (a.b) rifiuta e non scrive", [true, ["colonna a.b"], false], [rifiutata.rifiutata, rifiutata.mancanti[0]?.mancanti, await esiste("schema_migrations")]);

      await q("ALTER TABLE a ADD COLUMN b int");

      const simulata = await m.baseline(cliente, { fino: 2, cartella: dir });

      prova("senza `si` è una simulazione: dice cosa segnerebbe e non scrive", [["001_base", "002_colonna"], false], [simulata.daSegnare, await esiste("schema_migrations")]);

      const fatta = await m.baseline(cliente, { fino: 2, si: true, cartella: dir });

      prova("con `si` segna, come baseline", [true, ["001_base:baseline", "002_colonna:baseline"]], [fatta.eseguita, await ledger()]);
      prova("e NON esegue: la INSERT della 002 non è partita, la 003 nemmeno", [0, false], [(await q("SELECT count(*)::int AS n FROM a"))[0].n, await esiste("c")]);

      console.log("\nSul database: applica");

      const asciutto = await m.applica(cliente, { cartella: dir });

      prova("senza `si` elenca e non applica", [["003_tabella"], false], [asciutto.daFare, await esiste("c")]);

      const applicata = await m.applica(cliente, { si: true, cartella: dir });

      prova("con `si` applica solo la mancante e la segna", [["003_tabella"], true, "003_tabella:applicata"], [applicata.eseguite, await esiste("c"), (await ledger()).pop()]);
      prova("una seconda volta non c'è niente da fare", [], (await m.applica(cliente, { si: true, cartella: dir })).eseguite);

      const dir2 = cartellaDi({
        "001_base.sql": "CREATE TABLE a (id int);",
        "002_colonna.sql": "ALTER TABLE a ADD COLUMN IF NOT EXISTS b int; INSERT INTO a (id, b) VALUES (1, 42);",
        "003_tabella.sql": "CREATE TABLE c (x int);",
        "004_rotta.sql": "CREATE TABLE d (x int); SELECT 1/0;",
        "005_dopo.sql": "CREATE TABLE e (x int);"
      });

      let errore = null;

      try {
        await m.applica(cliente, { si: true, cartella: dir2 });
      } catch (e) {
        errore = e;
      }

      prova("una migrazione che fallisce non lascia niente: né la tabella né la riga", [true, false, false, false], [/004_rotta/.test(errore?.message || ""), await esiste("d"), (await ledger()).some((r) => r.startsWith("004")), await esiste("e")]);
      prova("e si ferma lì: la 005 non è stata tentata", false, await esiste("e"));

      console.log("\nSul database: stato dopo");

      const dir3 = cartellaDi({
        "001_base.sql": "CREATE TABLE a (id int); -- cambiata dopo",
        "002_colonna.sql": "ALTER TABLE a ADD COLUMN IF NOT EXISTS b int; INSERT INTO a (id, b) VALUES (1, 42);",
        "003_tabella.sql": "CREATE TABLE c (x int);"
      });

      const s = await m.stato(cliente, dir3);

      prova("un file cambiato dopo l'esecuzione è segnalato", [true, false], [s.righe[0].modificata, s.righe[1].modificata]);
      prova("i testimoni tornano tutti", [[], [], []], s.righe.map((r) => r.testimoni.mancanti));

      const fuoriOrdine = cartellaDi({
        "001_base.sql": "CREATE TABLE a (id int);",
        "002_colonna.sql": "ALTER TABLE a ADD COLUMN IF NOT EXISTS b int; INSERT INTO a (id, b) VALUES (1, 42);",
        "003_tabella.sql": "CREATE TABLE c (x int);",
        // Un numero libero PIÙ BASSO dell'ultima applicata (003): qualcuno
        // ha aggiunto un file «nel passato».
        "000_nel_passato.sql": "SELECT 1;"
      });

      let rifiuto = null;

      try {
        await m.applica(cliente, { si: true, cartella: fuoriOrdine });
      } catch (e) {
        rifiuto = e.message;
      }

      prova("un file più vecchio dell'ultimo applicato è rifiutato", true, /più vecchie dell'ultima già applicata/.test(rifiuto || ""));

      console.log("\nSul database: la baseline da SQL (senza terminale)");

      await q("DROP TABLE schema_migrations");

      const lette = m.elenco(dir);
      const controllo = m.sqlControllo(lette, 3);

      prova("il controllo con tutto a posto non restituisce righe", 0, (await cliente.query(controllo)).rowCount);

      await q("DROP TABLE c");

      const manca = await cliente.query(controllo);

      prova("e se un oggetto manca dice quale", [["003_tabella", "tabella", "c"]], manca.rows.map((r) => [r.migrazione, r.tipo, r.manca]));

      await q("CREATE TABLE c (x int)");

      const esiti = await cliente.query(m.sqlBaseline(lette, 3));
      const ultimo = Array.isArray(esiti) ? esiti[esiti.length - 1] : esiti;

      prova("la baseline da SQL segna tutte e dice quante", 3, Number(ultimo.rows[0].segnate));
      await cliente.query(m.sqlBaseline(lette, 3));
      prova("rilanciata non raddoppia", 3, (await q("SELECT count(*)::int AS n FROM schema_migrations"))[0].n);

      const dopo = await m.stato(cliente, dir);

      prova("lo stato la vede e non dice «modificata» (non c'è un checksum da confrontare)", [[true, false], [true, false], [true, false]], dopo.righe.map((r) => [r.registrata, r.modificata]));
      prova("e non c'è niente da applicare", [], (await m.applica(cliente, { si: true, cartella: dir })).eseguite);

      await q("DELETE FROM schema_migrations");

      let vuoto = null;

      try {
        await m.applica(cliente, { si: true, cartella: dir });
      } catch (e) {
        vuoto = e.message;
      }

      prova("un registro VUOTO non è «niente da fare»: rifiuta, invece di rieseguire tutto", true, /registro è vuoto/.test(vuoto || ""));

      console.log("\nSul database: una migrazione nuova come SQL da incollare");

      // La baseline di nuovo, poi una migrazione di soli dati («028»): il SQL che si incolla da telefono.
      await cliente.query(m.sqlBaseline(lette, 3));
      await q("DELETE FROM a; INSERT INTO a (id, b) VALUES (1, 0), (2, 0)");

      const dir4 = cartellaDi({
        "001_base.sql": "CREATE TABLE a (id int);",
        "002_colonna.sql": "ALTER TABLE a ADD COLUMN IF NOT EXISTS b int; INSERT INTO a (id, b) VALUES (1, 42);",
        "003_tabella.sql": "CREATE TABLE c (x int);",
        "004_dati.sql": "-- un commento con un apostrofo: l'importante\nUPDATE a SET b = 7 WHERE id = 1;"
      });

      const nuova = m.elenco(dir4).find((x) => x.id === "004_dati");
      const incollato = m.sqlMigrazione(nuova);

      await cliente.query(incollato);

      prova("il dato è cambiato", [7, 0], (await q("SELECT b FROM a ORDER BY id")).map((r) => r.b));
      prova("e la migrazione è nel registro come «applicata», col suo checksum", ["004_dati:applicata", nuova.checksum], [(await ledger()).pop(), (await q("SELECT checksum FROM schema_migrations WHERE id = '004_dati'"))[0]?.checksum]);

      const st = await m.stato(cliente, dir4);

      prova("lo stato non la dice «modificata» e non resta niente da applicare", [true, false, []], [st.righe[3].registrata, st.righe[3].modificata, (await m.applica(cliente, { si: true, cartella: dir4 })).eseguite]);

      await q("UPDATE a SET b = 1 WHERE id = 1");
      await cliente.query(incollato);

      prova("incollata una seconda volta: il registro non ha doppioni", 1, (await q("SELECT count(*)::int AS n FROM schema_migrations WHERE id = '004_dati'"))[0].n);

      const rotta = m.sqlMigrazione({ ...nuova, id: "005_rotta", sql: "UPDATE a SET b = 99; SELECT 1/0;" });
      let erroreRotta = null;

      try {
        await cliente.query(rotta);
      } catch (e) {
        erroreRotta = e.message;
      }

      await cliente.query("ROLLBACK").catch(() => {});

      prova("una migrazione che si rompe non lascia niente: né il dato né la riga del registro", [true, [7, 0], 0], [/division by zero/.test(erroreRotta || ""), (await q("SELECT b FROM a ORDER BY id")).map((r) => r.b), (await q("SELECT count(*)::int AS n FROM schema_migrations WHERE id = '005_rotta'"))[0].n]);
    } finally {
      await cliente.query("SET search_path TO public").catch(() => {});
      await cliente.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
      await cliente.end();
    }
  }

  console.log(falliti ? `\n${falliti} prove fallite.\n` : "\nTutto a posto.\n");
  process.exitCode = falliti ? 1 : 0;
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
