/**
 * La biblioteca riservata, sui dati veri, senza toccarli.
 *
 * Applica la 018 dentro una transazione, ci dirotta dentro il `pool`
 * dei servizi e fa le domande che il sito farà davvero: chi è di casa,
 * di chi sono le letture che vede una persona, quali voti restano
 * attaccati alle schede. Alla fine ROLLBACK, quindi il database resta
 * com'era.
 *
 * Serve perché il difetto tipico di un permesso non è un errore SQL ma
 * una risposta plausibile e sbagliata: una cronologia vuota invece di
 * quella del proprietario, un voto che sparisce a chi ce l'ha.
 *
 * ⚠️ La 018 fa `ALTER TABLE utenti`, che prende un lock esclusivo: non
 * lasciare questa transazione aperta mentre il sito pubblicato lavora.
 * Lo script dura qualche secondo e `lock_timeout` si arrende dopo
 * cinque, ma è il motivo per cui non va messo in pausa a metà.
 *
 * Uso:
 *   node scripts/prova-permessi.js
 */

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const pool = require("../db");

const MIGRAZIONE = path.join(__dirname, "..", "sql", "018_biblioteca_riservata.sql");

function titolo(testo) {
  console.log(`\n${"═".repeat(64)}\n${testo}\n${"═".repeat(64)}`);
}

(async () => {
  const cliente = await pool.connect();

  // Le NOTICE della migrazione sono metà del suo valore: dicono chi
  // resta fuori pur avendo già scritto qualcosa.
  cliente.on("notice", (n) => console.log(`   · ${n.message}`));

  // Da qui in poi i servizi parlano col client dentro la transazione e
  // non col pool: è l'unico modo di provarli sopra uno schema che non
  // esiste ancora davvero.
  const veraQuery = pool.query.bind(pool);
  const veroConnect = pool.connect.bind(pool);

  try {
    await cliente.query("SET lock_timeout = '5s'");
    await cliente.query("SET statement_timeout = '120s'");
    await cliente.query("BEGIN");

    titolo("1 · com'è adesso");

    const { rows: prima } = await cliente.query(`
      SELECT u.nickname, u.proprietario, u.stato,
             (SELECT COUNT(*)::int FROM voti            v WHERE v.utente_id = u.id) AS voti,
             (SELECT COUNT(*)::int FROM reading_history h WHERE h.utente_id = u.id) AS letture,
             (SELECT COUNT(*)::int FROM visioni         s WHERE s.utente_id = u.id) AS anime
        FROM utenti u ORDER BY u.proprietario DESC, u.creato_il
    `);

    console.table(prima);

    titolo("2 · la migrazione 018");

    await cliente.query(fs.readFileSync(MIGRAZIONE, "utf8"));

    console.log("✅ nessun errore SQL\n");

    const { rows: dopo } = await cliente.query(
      `SELECT id, nickname, proprietario, biblioteca FROM utenti
        ORDER BY proprietario DESC, creato_il`
    );

    console.table(dopo);

    // ---- da qui in poi si parla dentro la transazione ----
    pool.query = (...a) => cliente.query(...a);
    pool.connect = async () => cliente;

    const utenti = require("../services/utenti");
    const biblioteca = require("../services/biblioteca");

    utenti.dimenticaPermessi();

    titolo("3 · chi è di casa (services/utenti.haBiblioteca)");

    for (const u of dopo) {
      const risposta = await utenti.haBiblioteca(u.id);
      const atteso = Boolean(u.biblioteca);

      console.log(
        `${risposta === atteso ? "✅" : "❌"} ${u.nickname}: ${risposta ? "dentro" : "solo videoteca"}`
      );
    }

    titolo("4 · di chi sono le letture che vede (lettoreBiblioteca)");

    const proprietario = dopo.find((u) => u.proprietario);
    const nomeDi = (id) => dopo.find((u) => Number(u.id) === Number(id))?.nickname ?? `#${id}`;

    for (const u of dopo) {
      // La finta richiesta: com'è dopo `identificaUtente`, cioè col
      // token già letto. `?utente=` non c'è: è il caso normale.
      const finta = { query: {}, user: { id: Number(u.id), proprietario: u.proprietario } };
      const visto = await biblioteca.lettoreBiblioteca(finta);
      const atteso = u.biblioteca ? Number(u.id) : Number(proprietario.id);

      console.log(
        `${Number(visto) === atteso ? "✅" : "❌"} ${u.nickname} legge la biblioteca di ${nomeDi(visto)}`
      );
    }

    titolo("5 · e se il numero se lo scrive nell'indirizzo?");

    // `?utente=<qualcuno che non è di casa>`: deve rispondere lo
    // stesso col proprietario, o si otterrebbe una pagina vuota che
    // sembra un guasto.
    const fuori = dopo.find((u) => !u.biblioteca);

    if (!fuori) {
      console.log("   (sono tutti di casa: niente da provare)");
    } else {
      const finta = { query: { utente: String(fuori.id) }, user: null };
      const visto = await biblioteca.lettoreBiblioteca(finta);

      console.log(
        `${Number(visto) === Number(proprietario.id) ? "✅" : "❌"} ` +
          `?utente=${fuori.id} (${fuori.nickname}) → biblioteca di ${nomeDi(visto)}`
      );
    }

    titolo("6 · cosa resta attaccato alle schede");

    // La stessa domanda che fa `GET /api/manga`, ridotta all'osso.
    const conteggio = async (filtro) => {
      const { rows } = await cliente.query(`
        SELECT COUNT(*)::int AS voti FROM voti v
          JOIN utenti u ON u.id = v.utente_id
         WHERE ${filtro}
      `);

      return rows[0].voti;
    };

    const tutti = await conteggio("TRUE");
    const diCasa = await conteggio("u.biblioteca");

    console.log(`voti in tutto: ${tutti}`);
    console.log(`voti che restano visibili: ${diCasa}`);
    console.log(`voti nascosti (non cancellati): ${tutti - diCasa}`);

    const { rows: chiPerde } = await cliente.query(`
      SELECT u.nickname, COUNT(*)::int AS voti
        FROM voti v JOIN utenti u ON u.id = v.utente_id
       WHERE NOT u.biblioteca
       GROUP BY u.nickname
    `);

    if (chiPerde.length) console.table(chiPerde);

    titolo("7 · la videoteca non si tocca");

    const { rows: visioni } = await cliente.query(`
      SELECT u.nickname, COUNT(*)::int AS serie
        FROM visioni s JOIN utenti u ON u.id = s.utente_id
       GROUP BY u.nickname ORDER BY 2 DESC
    `);

    console.table(visioni);
    console.log("(nessuna riga di qui viene filtrata: la videoteca è di tutti quelli che entrano)");
  } catch (err) {
    console.error("\n❌ la prova si è fermata:");
    console.error(`   ${err.message}`);
    if (err.position) console.error(`   posizione: ${err.position}`);
    process.exitCode = 1;
  } finally {
    pool.query = veraQuery;
    pool.connect = veroConnect;

    await cliente.query("ROLLBACK").catch(() => {});
    cliente.release();
    await pool.end();

    console.log("\n↩︎  ROLLBACK: il database è come prima.");
  }
})();
