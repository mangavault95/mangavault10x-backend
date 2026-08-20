/**
 * Gioca una partita finta contro il database VERO, e la annulla.
 *
 * Uso:
 *   node scripts/prova-tornei.js
 *
 * Perché esiste: `services/tornei.js` scrive su tre tabelle in
 * transazione e le rilegge con delle JOIN. Un controllo a memoria non
 * dice se il vincolo composto verso `torneo_serie` regge, né se
 * l'UNNEST scrive le colonne nell'ordine giusto — sono le cose che si
 * scoprono solo eseguendole.
 *
 * Come non lascia tracce: tutto gira dentro una transazione che
 * finisce sempre in ROLLBACK. Il codice sotto prova apre le proprie
 * transazioni, e un COMMIT suo confermerebbe per davvero: per questo
 * `pool.connect` viene sostituito con lo stesso client, e le sue
 * BEGIN/COMMIT tradotte in SAVEPOINT (la stessa ricetta delle prove
 * del bot).
 *
 * Se le tabelle non esistono ancora, la migrazione viene applicata qui
 * dentro — e annullata insieme al resto.
 */

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const pool = require("../db");

const TAGLIA = 32;

/** Un tabellone giocato per intero: vince sempre chi sta a sinistra. */
function partitaFinta(serie) {
  const sfide = [];

  let inCampo = serie.map((s) => s.id);

  for (let turno = 1; inCampo.length > 1; turno++) {
    const passati = [];

    for (let posizione = 0; posizione < inCampo.length / 2; posizione++) {
      const casaId = inCampo[posizione * 2];
      const ospiteId = inCampo[posizione * 2 + 1];

      // Non sempre la casa: alternare serve a vedere che il vincitore
      // propagato al turno dopo è davvero quello scelto, e non il
      // primo dei due per caso.
      const vincitoreId = posizione % 3 === 0 ? ospiteId : casaId;

      sfide.push({ turno, posizione, casaId, ospiteId, vincitoreId });
      passati.push(vincitoreId);
    }

    inCampo = passati;
  }

  return sfide;
}

(async () => {
  const cliente = await pool.connect();

  // Il codice sotto prova chiede il pool: gli si dà questo client.
  const connectVero = pool.connect.bind(pool);
  const queryVera = pool.query.bind(pool);
  const queryCliente = cliente.query.bind(cliente);

  let profondita = 0;

  cliente.query = (testo, valori) => {
    if (typeof testo === "string") {
      const comando = testo.trim().toUpperCase();

      if (comando === "BEGIN") return queryCliente(`SAVEPOINT prova_${++profondita}`);
      if (comando === "COMMIT") return queryCliente(`RELEASE SAVEPOINT prova_${profondita--}`);
      if (comando === "ROLLBACK") {
        return queryCliente(`ROLLBACK TO SAVEPOINT prova_${profondita--}`);
      }
    }

    return queryCliente(testo, valori);
  };

  pool.query = cliente.query;
  pool.connect = async () => ({ ...cliente, query: cliente.query, release() {} });

  const tornei = require("../services/tornei");

  try {
    await queryCliente("SET lock_timeout = '5s'");
    await queryCliente("BEGIN");

    // La migrazione, se non è ancora stata eseguita su Supabase.
    const { rows: esiste } = await queryCliente(
      `SELECT to_regclass('public.tornei') IS NOT NULL AS c`
    );

    if (!esiste[0].c) {
      console.log("▶ le tabelle non ci sono: applico sql/010_kachinuki.sql qui dentro.");
      await queryCliente(
        fs.readFileSync(path.join(__dirname, "..", "sql", "010_kachinuki.sql"), "utf8")
      );
    }

    /* ---- I giocatori: serie vere, prese dalla collezione ---- */

    const { rows: scelte } = await queryCliente(
      `SELECT "ID", "Titolo", "CoverURL" FROM "Manga" ORDER BY random() LIMIT $1`,
      [TAGLIA]
    );

    if (scelte.length < TAGLIA) throw new Error(`servono ${TAGLIA} serie in collezione`);

    const serie = scelte.map((r) => ({
      id: Number(r.ID),
      titolo: r.Titolo,
      copertina: r.CoverURL
    }));

    const { rows: chi } = await queryCliente(`SELECT id FROM utenti WHERE proprietario`);
    const utenteId = Number(chi[0].id);

    /* ---- Il controllo ---- */

    const corpo = {
      tema: "prova",
      temaEtichetta: "Partita di prova",
      taglia: TAGLIA,
      serie,
      sfide: partitaFinta(serie)
    };

    const { errore, partita } = tornei.valida(corpo);

    if (errore) throw new Error(`il tabellone non passa il controllo: ${errore}`);

    console.log(`✅ tabellone valido: ${partita.sfide.length} sfide, vince ${partita.vincitoreId}`);

    /* ---- La scrittura ---- */

    const salvata = await tornei.salva(partita, utenteId);

    console.log(`✅ salvata: partita #${salvata.id}`);

    /* ---- La rilettura ---- */

    const elenco = await tornei.elenco({ limite: 5 });
    const primo = elenco[0];

    console.log(
      `✅ in cronologia: «${primo.temaEtichetta}» da ${TAGLIA}, ` +
        `giocata da ${primo.giocatore.nickname}, ha vinto «${primo.vincitore.titolo}»`
    );

    const dettaglio = await tornei.dettaglio(salvata.id);

    const finale = dettaglio.sfide[dettaglio.sfide.length - 1];
    const nome = (id) => dettaglio.serie.find((s) => s.id === id)?.titolo;

    console.log(
      `✅ tabellone riletto: ${dettaglio.serie.length} serie, ${dettaglio.sfide.length} sfide`
    );
    console.log(`   finale: «${nome(finale.casaId)}» — «${nome(finale.ospiteId)}»`);
    console.log(`   vince:  «${nome(finale.vincitoreId)}»`);

    if (finale.vincitoreId !== dettaglio.vincitore.id) {
      throw new Error("il vincitore del torneo non è quello della finale");
    }

    /* ---- I rifiuti ---- */

    const storpiato = { ...corpo, sfide: corpo.sfide.map((s) => ({ ...s })) };
    storpiato.sfide[TAGLIA / 2].casaId = serie[0].id;

    const rifiuto = tornei.valida(storpiato);

    if (!rifiuto.errore) throw new Error("un tabellone falso è passato per buono");

    console.log(`✅ tabellone falso respinto: ${rifiuto.errore}`);

    /* ---- La cancellazione ---- */

    if (!(await tornei.elimina(salvata.id, utenteId, false))) {
      throw new Error("non sono riuscito a cancellare la mia partita");
    }

    const { rows: resti } = await queryCliente(
      `SELECT (SELECT COUNT(*)::int FROM torneo_serie WHERE torneo_id = $1) AS serie,
              (SELECT COUNT(*)::int FROM sfide        WHERE torneo_id = $1) AS sfide`,
      [salvata.id]
    );

    if (resti[0].serie || resti[0].sfide) {
      throw new Error(`cancellata a metà: restano ${resti[0].serie} serie e ${resti[0].sfide} sfide`);
    }

    console.log("✅ cancellata, e con lei serie e sfide");
    console.log("\nTutto a posto.");
  } catch (err) {
    console.error("\n❌ la prova si è fermata:");
    console.error(`   ${err.message}`);
    if (err.detail) console.error(`   dettaglio: ${err.detail}`);
    process.exitCode = 1;
  } finally {
    await queryCliente("ROLLBACK").catch(() => {});

    pool.connect = connectVero;
    pool.query = queryVera;

    cliente.release();
    await pool.end();

    console.log("\n↩ annullata: il database è come prima.");
  }
})();
