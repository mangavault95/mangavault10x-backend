/**
 * Prova gli avvisi delle uscite senza mandare niente a nessuno.
 *
 * Applica la 019 dentro una transazione, si costruisce dei dati finti
 * (una persona con una chat collegata, una serie, tre puntate),
 * sostituisce Telegram con un finto che si segna cosa gli è stato
 * chiesto di mandare, e alla fine fa ROLLBACK: non resta niente, né
 * nel database né su Telegram.
 *
 * Uso:
 *   node scripts/prova-avvisi.js
 *
 * ⚠️ NON tenerlo aperto mentre guardi il sito pubblicato. La 019 fa
 * `ALTER TABLE utenti`, che prende un lock esclusivo: finché la
 * transazione è aperta, ogni accesso al sito si mette in coda. Il
 * `lock_timeout` qui sotto protegge dal caso opposto (che sia il sito
 * a tenere fermo questo script), non da quello.
 */

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const pool = require("../db");
const telegram = require("../services/telegram");
const avvisi = require("../services/avvisi");

let passate = 0;
let fallite = 0;

function esito(cosa, andata, nota = "") {
  console.log(`  ${andata ? "✅" : "❌"} ${cosa}${nota ? ` — ${nota}` : ""}`);
  andata ? passate++ : fallite++;
}

// --------------------------------------------------
// Il finto Telegram
//
// `services/avvisi` chiama `telegram.invia` attraverso l'oggetto
// esportato, e in CommonJS quell'oggetto è uno solo per tutto il
// processo: riscriverne le funzioni qui le riscrive anche là. È il
// modo di provare il giro vero — code delle query, raggruppamenti,
// ordine delle operazioni — senza rete e senza token.
// --------------------------------------------------

const mandati = [];
let telegramFunziona = true;

telegram.configurato = () => true;

telegram.invia = async (chatId, testo, opzioni = {}) => {
  if (!telegramFunziona) return { ok: false, descrizione: "prova: Telegram giù" };

  mandati.push({ chatId, testo, ...opzioni });

  return { ok: true, risultato: { message_id: mandati.length } };
};

// --------------------------------------------------

(async () => {
  const cliente = await pool.connect();

  try {
    await cliente.query("SET lock_timeout = '5s'");
    await cliente.query("SET statement_timeout = '60s'");
    await cliente.query("BEGIN");

    console.log("\n══ La migrazione\n");

    await cliente.query(
      fs.readFileSync(path.join(__dirname, "..", "sql", "019_avvisi_uscite.sql"), "utf8")
    );

    esito("la 019 gira", true);

    // ⚠️ Fuori dalla transazione ci sono persone collegate davvero, con
    // serie vere in videoteca: senza questa riga la prova conta anche
    // loro e i numeri cambiano da un giorno all'altro — «2 messaggi»
    // diventa 3 il giorno in cui qualcuno collega la sua chat. Qui
    // dentro nessuno è collegato tranne chi inventiamo noi, e il
    // ROLLBACK rimette tutto com'era.
    const { rowCount: veriCollegati } = await cliente.query(
      `UPDATE utenti SET telegram_chat_id = NULL WHERE telegram_chat_id IS NOT NULL`
    );

    console.log(
      `     (${veriCollegati} collegamenti veri messi da parte per la durata della prova)`
    );

    // ---- i dati finti ----

    const { rows: [tizio] } = await cliente.query(
      `INSERT INTO utenti (username, nickname, stato, telegram_chat_id)
       VALUES ('prova_avvisi', 'ProvaAvvisi', 'attivo', 999000001) RETURNING id`
    );

    const { rows: [caio] } = await cliente.query(
      `INSERT INTO utenti (username, nickname, stato, telegram_chat_id)
       VALUES ('prova_avvisi_2', 'ProvaAvvisi2', 'attivo', 999000002) RETURNING id`
    );

    // Senza chat collegata: non deve ricevere niente, mai.
    const { rows: [muto] } = await cliente.query(
      `INSERT INTO utenti (username, nickname, stato)
       VALUES ('prova_avvisi_3', 'ProvaAvvisi3', 'attivo') RETURNING id`
    );

    const { rows: [serie] } = await cliente.query(
      `INSERT INTO anime (animeclick_id, titolo, tipo, stato)
       VALUES (-99001, 'Serie di Prova <b>', 'serie_tv', 'in_corso') RETURNING id`
    );

    // Uscita mezz'ora fa: dentro la finestra di novanta minuti.
    await cliente.query(
      `INSERT INTO anime_episodi (anime_id, numero, titolo, uscita_italia, piattaforma)
       VALUES ($1, 7, 'La puntata & il titolo', NOW() - interval '30 minutes', 'Crunchyroll [DUB ITA]')`,
      [serie.id]
    );

    // Uscita due ore fa: FUORI dalla finestra, non si annuncia.
    await cliente.query(
      `INSERT INTO anime_episodi (anime_id, numero, titolo, uscita_italia, piattaforma)
       VALUES ($1, 6, 'Quella di prima', NOW() - interval '2 hours', 'Crunchyroll')`,
      [serie.id]
    );

    for (const utente of [tizio.id, caio.id, muto.id]) {
      await cliente.query(
        `INSERT INTO visioni (anime_id, utente_id, stato) VALUES ($1, $2, 'in_visione')`,
        [serie.id, utente]
      );
    }

    // ---- "è appena uscita" ----

    console.log("\n══ L'avviso a puntata uscita\n");

    const vuoto = await avvisi.avvisa(cliente, { tipo: "uscita", prova: true });

    esito(
      "il giro a vuoto trova le due persone collegate",
      vuoto.persone === 2 && vuoto.trovate === 2,
      `${vuoto.trovate} righe, ${vuoto.persone} persone`
    );

    esito("il giro a vuoto non manda niente", mandati.length === 0);

    esito(
      "chi non ha collegato la chat non compare",
      !JSON.stringify(vuoto.dettaglio).includes("ProvaAvvisi3")
    );

    const primo = await avvisi.avvisa(cliente, { tipo: "uscita" });

    esito("parte un messaggio a testa", primo.inviati === 2, `${mandati.length} mandati`);

    const testo = mandati[0]?.testo || "";

    esito("il messaggio dice la piattaforma", testo.includes("Crunchyroll [DUB ITA]"));
    esito("il messaggio dice numero e titolo", testo.includes("7") && testo.includes("La puntata"));

    esito(
      "quello che viene da AnimeClick è disinnescato",
      testo.includes("&amp;") && testo.includes("&lt;b&gt;"),
      "un titolo con dentro < o & non deve rompere il messaggio"
    );

    esito("non annuncia la puntata di due ore fa", !testo.includes("Quella di prima"));

    // ---- la seconda volta ----

    mandati.length = 0;

    const secondo = await avvisi.avvisa(cliente, { tipo: "uscita" });

    esito(
      "il giro successivo non ripete niente",
      secondo.inviati === 0 && mandati.length === 0,
      "è quello che fa `avvisi_uscite`"
    );

    // ---- quando Telegram non risponde ----

    console.log("\n══ Quando l'invio fallisce\n");

    await cliente.query(
      `INSERT INTO anime_episodi (anime_id, numero, titolo, uscita_italia, piattaforma)
       VALUES ($1, 8, 'Quella che non parte', NOW() - interval '5 minutes', 'Netflix')`,
      [serie.id]
    );

    telegramFunziona = false;

    const rotto = await avvisi.avvisa(cliente, { tipo: "uscita" });

    esito("l'errore viene contato", rotto.falliti === 2 && rotto.inviati === 0);

    const { rows: [rimaste] } = await cliente.query(
      `SELECT COUNT(*)::int AS n FROM avvisi_uscite WHERE numero = 8`
    );

    esito(
      "la riga segnata viene tolta",
      rimaste.n === 0,
      "altrimenti quella puntata non verrebbe annunciata mai più"
    );

    telegramFunziona = true;
    mandati.length = 0;

    const ripreso = await avvisi.avvisa(cliente, { tipo: "uscita" });

    esito("mezz'ora dopo riparte", ripreso.inviati === 2 && mandati.length === 2);

    // ---- il promemoria del mattino ----

    console.log("\n══ Il promemoria del mattino\n");

    mandati.length = 0;

    // Fra un'ora, ma solo se oggi c'è ancora un'ora: a mezzanotte meno
    // dieci la puntata "fra un'ora" è di domani, e il promemoria di
    // oggi non deve vederla. La prova si adatta invece di sbagliare
    // una volta al giorno.
    const { rows: [quando] } = await cliente.query(
      `SELECT (NOW() + interval '1 hour') <
              (date_trunc('day', NOW() AT TIME ZONE 'Europe/Rome') + interval '1 day')
                AT TIME ZONE 'Europe/Rome' AS oggi`
    );

    if (quando.oggi) {
      await cliente.query(
        `INSERT INTO anime_episodi (anime_id, numero, titolo, uscita_italia, piattaforma)
         VALUES ($1, 9, 'Stasera', NOW() + interval '1 hour', 'Prime Video')`,
        [serie.id]
      );

      const mattina = await avvisi.avvisa(cliente, { tipo: "mattina" });

      esito("il promemoria parte", mattina.inviati === 2);

      const digest = mandati[0]?.testo || "";

      esito("dice l'ora", /\d{2}:\d{2}/.test(digest));
      esito("dice la piattaforma", digest.includes("Prime Video"));
      esito(
        "non si annulla con l'altro avviso",
        digest.includes("Stasera"),
        "`tipo` sta nella chiave apposta"
      );
    } else {
      console.log("  ⏭  saltata: a quest'ora la puntata «fra un'ora» sarebbe di domani");
    }

    // ---- chi ha mollato la serie ----

    console.log("\n══ Le serie droppate\n");

    await cliente.query(`UPDATE visioni SET stato = 'droppata' WHERE utente_id = $1`, [caio.id]);

    await cliente.query(
      `INSERT INTO anime_episodi (anime_id, numero, titolo, uscita_italia, piattaforma)
       VALUES ($1, 10, 'Dopo il droppo', NOW() - interval '10 minutes', 'Crunchyroll')`,
      [serie.id]
    );

    mandati.length = 0;

    const dopoDroppo = await avvisi.avvisa(cliente, { tipo: "uscita" });

    esito(
      "chi ha mollato la serie non viene avvisato",
      dopoDroppo.inviati === 1,
      `${dopoDroppo.inviati} messaggio invece di 2`
    );

    esito("chi la guarda ancora sì", mandati[0]?.chatId === "999000001" || mandati[0]?.chatId === 999000001);
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
