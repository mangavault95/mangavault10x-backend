/**
 * Prova i consigli senza lasciare niente in giro.
 *
 * Applica la 021 dentro una transazione, si costruisce due persone
 * finte e una serie finta, fa il giro intero — manda, guarda cosa c'è
 * in arrivo, apre, controlla che i due avvisi della campanella
 * arrivino ai due capi giusti — e alla fine fa ROLLBACK.
 *
 * Uso:
 *   node scripts/prova-consigli.js
 *
 * ⚠️ NON tenerlo aperto mentre guardi il sito pubblicato. `CREATE
 * TABLE` è meno invasivo di un `ALTER`, ma la transazione resta
 * comunque aperta e le prove che sbagliano apposta usano dei
 * SAVEPOINT: senza, il primo errore voluto abortirebbe tutto quello
 * che viene dopo.
 */

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const pool = require("../db");
const consigli = require("../services/consigli");
const campanella = require("../services/campanella");

let passate = 0;
let fallite = 0;

function esito(cosa, andata, nota = "") {
  console.log(`  ${andata ? "✅" : "❌"} ${cosa}${nota ? ` — ${nota}` : ""}`);
  andata ? passate++ : fallite++;
}

/** Una cosa che deve fallire, senza portarsi dietro la transazione. */
async function deveFallire(cliente, cosa, azione, riconosci) {
  await cliente.query("SAVEPOINT prova");

  try {
    await azione();
    await cliente.query("RELEASE SAVEPOINT prova");
    esito(cosa, false, "non ha dato errore");
  } catch (err) {
    await cliente.query("ROLLBACK TO SAVEPOINT prova");
    esito(cosa, riconosci(err), err.message);
  }
}

(async () => {
  const cliente = await pool.connect();

  try {
    await cliente.query("SET lock_timeout = '5s'");
    await cliente.query("SET statement_timeout = '60s'");
    await cliente.query("BEGIN");

    console.log("\n══ La migrazione\n");

    await cliente.query(
      fs.readFileSync(path.join(__dirname, "..", "sql", "021_consigli.sql"), "utf8")
    );

    esito("la 021 gira", true);

    // ---- i dati finti ----

    const { rows: [mittente] } = await cliente.query(
      `INSERT INTO utenti (username, nickname, stato, colore)
       VALUES ('prova_cons_1', 'ProvaMittente', 'attivo', 'ottone') RETURNING id`
    );

    const { rows: [destinatario] } = await cliente.query(
      `INSERT INTO utenti (username, nickname, stato, colore)
       VALUES ('prova_cons_2', 'ProvaDestinatario', 'attivo', 'lilla') RETURNING id`
    );

    // Una serie che in catalogo C'È: la cartolina deve poterla
    // ritrovare e diventare cliccabile.
    const { rows: [inCatalogo] } = await cliente.query(
      `INSERT INTO anime (animeclick_id, titolo, tipo, stato)
       VALUES (-99101, 'Serie In Catalogo', 'serie_tv', 'conclusa') RETURNING id`
    );

    // ---- quello che non si può fare ----

    console.log("\n══ Quello che il database non lascia passare\n");

    await deveFallire(
      cliente,
      "non ci si consiglia qualcosa da soli",
      () =>
        cliente.query(
          `INSERT INTO consigli (da_utente_id, a_utente_id, animeclick_id, titolo)
           VALUES ($1, $1, -99101, 'Da me a me')`,
          [mittente.id]
        ),
      (err) => err.code === "23514"
    );

    await deveFallire(
      cliente,
      "non si manda a qualcuno che non c'è",
      () =>
        consigli.manda(cliente, {
          daId: mittente.id,
          aId: 999999999,
          animeclickId: -99101,
          titolo: "Nel vuoto"
        }),
      (err) => err.stato === 404
    );

    // ---- mandare ----

    console.log("\n══ Mandare una cartolina\n");

    const mandato = await consigli.manda(cliente, {
      daId: mittente.id,
      aId: destinatario.id,
      animeclickId: -99101,
      titolo: "Serie In Catalogo",
      coverUrl: "https://www.animeclick.it/finta.jpg",
      testo: "Fidati e guardala."
    });

    esito("la cartolina torna intera", Boolean(mandato.id) && mandato.titolo === "Serie In Catalogo");

    esito(
      "porta con sé chi manda e chi riceve",
      mandato.da.nickname === "ProvaMittente" && mandato.a.nickname === "ProvaDestinatario"
    );

    esito(
      "la scheda in catalogo viene ritrovata",
      mandato.anime?.id === Number(inCatalogo.id),
      "è quello che rende cliccabile la copertina sulla cartolina"
    );

    esito("nasce non aperta", mandato.aperto_il === null);

    // Il caso che una chiave esterna verso `anime` avrebbe reso
    // impossibile, ed è il più interessante: consigliare qualcosa che
    // NESSUNO dei due ha, che in catalogo non esiste affatto.
    const fuoriCatalogo = await consigli.manda(cliente, {
      daId: mittente.id,
      aId: destinatario.id,
      animeclickId: -99102,
      titolo: "Serie Che Non Abbiamo",
      coverUrl: null,
      testo: null
    });

    esito(
      "si consiglia anche quello che in catalogo non c'è",
      Boolean(fuoriCatalogo.id) && fuoriCatalogo.anime === null,
      "il titolo è copiato nella riga, non puntato"
    );

    // ---- la coda di chi riceve ----

    console.log("\n══ La posta in arrivo\n");

    const coda = await consigli.inArrivo(cliente, destinatario.id);

    esito("il destinatario ne trova due", coda.length === 2, `${coda.length} in coda`);

    esito(
      "dalla più vecchia",
      coda[0].id === mandato.id,
      "si apre la posta nell'ordine in cui è arrivata"
    );

    const nienteDiMio = await consigli.inArrivo(cliente, mittente.id);

    esito(
      "chi manda non trova la propria in arrivo",
      nienteDiMio.length === 0,
      "una cartolina è di chi la riceve"
    );

    // ---- aprire ----

    console.log("\n══ Aprire\n");

    const quando = await consigli.apri(cliente, mandato.id, destinatario.id);

    esito("l'apertura segna l'istante", Boolean(quando));

    const ancora = await consigli.apri(cliente, mandato.id, destinatario.id);

    esito(
      "la seconda apertura non riscrive niente",
      ancora === null,
      "o l'avviso del mittente direbbe «ha aperto adesso» ogni volta che la rilegge"
    );

    const diUnAltro = await consigli.apri(cliente, fuoriCatalogo.id, mittente.id);

    esito(
      "non si apre la cartolina di un altro",
      diUnAltro === null,
      "chi sei lo dice il token, non il numero nell'indirizzo"
    );

    const dopo = await consigli.inArrivo(cliente, destinatario.id);

    esito("aperta esce dalla coda", dopo.length === 1 && dopo[0].id === fuoriCatalogo.id);

    // ---- gli avvisi ai due capi ----

    console.log("\n══ La campanella, dai due capi\n");

    const suoi = await campanella.avvisi(cliente, destinatario.id);
    const miei = await campanella.avvisi(cliente, mittente.id);

    const ricevuti = suoi.avvisi.filter((a) => a.tipo === "consiglio");

    esito(
      "chi riceve li vede tutti e due",
      ricevuti.length === 2,
      "anche quello non ancora aperto: è arrivato lo stesso"
    );

    esito(
      "l'avviso dice cosa e da chi",
      ricevuti.some(
        (a) => a.anime.titolo === "Serie In Catalogo" && a.chi.nickname === "ProvaMittente"
      )
    );

    esito(
      "senza scheda in catalogo l'avviso non porta da nessuna parte",
      ricevuti.some((a) => a.anime.titolo === "Serie Che Non Abbiamo" && a.anime.id === null),
      "il frontend deve saperlo, o farebbe un link a /videoteca/null"
    );

    const aperti = miei.avvisi.filter((a) => a.tipo === "consiglio-aperto");

    esito(
      "chi manda sa che è stata aperta",
      aperti.length === 1 && aperti[0].anime.titolo === "Serie In Catalogo",
      `${aperti.length} avviso`
    );

    esito(
      "e non sa niente di quella non aperta",
      !aperti.some((a) => a.anime.titolo === "Serie Che Non Abbiamo"),
      "sarebbe una notizia falsa"
    );

    esito(
      "chi manda non riceve l'avviso di quello che ha mandato",
      miei.avvisi.every((a) => a.tipo !== "consiglio"),
      "sa già di averlo mandato"
    );

    // ---- la campanella regge la tabella che non c'è ----

    console.log("\n══ Prima che la migrazione giri\n");

    // Un finto pool che risponde «tabella inesistente» alle sole
    // query sui consigli, e passa le altre al cliente vero.
    //
    // Non un `DROP TABLE consigli` dentro la transazione, che sarebbe
    // stata la prova ovvia e sarebbe stata sbagliata: la 42P01
    // abortisce la transazione, e le altre query della campanella —
    // che partono INSIEME, in un `Promise.all` — morirebbero tutte con
    // «current transaction is aborted». Cioè la prova fallirebbe per
    // una ragione che in produzione non esiste, dove ogni `pool.query`
    // è una transazione a sé.
    const senzaTabella = {
      query: (testo, valori) => {
        if (/FROM consigli/i.test(testo)) {
          return Promise.reject(Object.assign(new Error('relation "consigli" does not exist'), {
            code: "42P01"
          }));
        }

        return cliente.query(testo, valori);
      }
    };

    const senza = await campanella.avvisi(senzaTabella, destinatario.id);

    esito(
      "senza la tabella la campanella resta in piedi",
      Array.isArray(senza.avvisi),
      "Render può servire il codice nuovo prima che la 021 sia girata"
    );

    esito(
      "e continua a dare gli altri avvisi",
      senza.avvisi.every((a) => a.tipo !== "consiglio" && a.tipo !== "consiglio-aperto"),
      "meglio zero avvisi di UN tipo che zero avvisi"
    );
  } catch (err) {
    console.error("\n❌ ERRORE:", err.message);
    fallite++;
  } finally {
    await cliente.query("ROLLBACK").catch(() => {});
    cliente.release();
    await pool.end();
  }

  console.log(`\n${fallite === 0 ? "✅" : "❌"} ${passate} passate, ${fallite} fallite.`);
  console.log("   (tutto annullato: il database è come prima)\n");

  process.exitCode = fallite === 0 ? 0 : 1;
})();
