/**
 * Collega una persona al bot delle uscite (@Videoteca10xBot).
 *
 * PERCHÉ SERVE UNA COSA A MANO. Un bot di Telegram non può scrivere
 * per primo a nessuno: finché una persona non gli ha parlato, mandarle
 * un messaggio risponde «bot can't initiate conversation with a user».
 * Quindi il giro è: la persona apre il bot e preme Start, noi leggiamo
 * il suo identificativo di chat e lo scriviamo sulla sua riga.
 *
 * Si fa una volta per persona e mai più. Con tre lettori, un pannello
 * apposta nella Gestione sarebbe più codice da mantenere che tempo
 * risparmiato.
 *
 * USO
 *   node scripts/uscite-chatid.js
 *       chi ha scritto al bot di recente, con il suo identificativo
 *
 *   node scripts/uscite-chatid.js --collega Nanaki 123456789
 *       scrive quell'identificativo sulla riga di Nanaki
 *
 *   node scripts/uscite-chatid.js --elenco
 *       chi è collegato e chi no
 *
 *   node scripts/uscite-chatid.js --prova Nanaki
 *       manda un messaggio di prova, per vedere che arrivi davvero
 *
 *   node scripts/uscite-chatid.js --scollega Nanaki
 *       smette di mandarle avvisi
 *
 * ⚠️ Telegram tiene gli aggiornamenti 24 ORE. Chi ha premuto Start
 * l'altro ieri non compare più nell'elenco: basta che riscriva
 * qualcosa al bot.
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const pool = require("../db");
const telegram = require("../services/telegram");

const argomenti = process.argv.slice(2);
const comando = argomenti.find((a) => a.startsWith("--")) || "--chi";
const resto = argomenti.filter((a) => !a.startsWith("--"));

/** La persona, cercata per soprannome o per nome utente, senza badare alle maiuscole. */
async function trova(chi) {
  const { rows } = await pool.query(
    `SELECT id, username, nickname, telegram_chat_id
       FROM utenti
      WHERE lower(nickname) = lower($1) OR lower(username) = lower($1)`,
    [chi]
  );

  if (rows.length === 0) throw new Error(`nessun utente si chiama "${chi}"`);

  return rows[0];
}

async function chiHaScritto() {
  const risposta = await telegram.aggiornamenti();

  if (!risposta.ok) throw new Error(risposta.descrizione);

  const chat = new Map();

  for (const agg of risposta.risultato || []) {
    const m = agg.message;
    if (!m?.chat) continue;

    // L'ultimo messaggio di ogni chat: se uno ha scritto tre volte,
    // interessa che abbia scritto, non quante.
    chat.set(m.chat.id, {
      chatId: m.chat.id,
      nome: [m.chat.first_name, m.chat.last_name].filter(Boolean).join(" ") || m.chat.title || "",
      utente: m.chat.username ? `@${m.chat.username}` : "",
      testo: m.text || ""
    });
  }

  if (chat.size === 0) {
    console.log("Nessuno ha scritto al bot nelle ultime 24 ore.");
    console.log("Apri @Videoteca10xBot su Telegram, premi Start, e rilancia questo comando.");
    return;
  }

  const { rows: collegati } = await pool.query(
    `SELECT nickname, telegram_chat_id FROM utenti WHERE telegram_chat_id IS NOT NULL`
  );

  const giaDi = new Map(collegati.map((r) => [String(r.telegram_chat_id), r.nickname]));

  console.log("\nChi ha scritto al bot:\n");

  for (const c of chat.values()) {
    const suo = giaDi.get(String(c.chatId));

    console.log(
      `  ${String(c.chatId).padEnd(14)} ${c.nome} ${c.utente}`.trimEnd() +
        (suo ? `   → già collegato a ${suo}` : "")
    );

    if (c.testo) console.log(`  ${" ".repeat(14)} «${c.testo}»`);
  }

  console.log("\nPer collegarlo:  node scripts/uscite-chatid.js --collega <soprannome> <id>\n");
}

async function elenco() {
  const { rows } = await pool.query(
    `SELECT nickname, stato, telegram_chat_id FROM utenti ORDER BY proprietario DESC, id`
  );

  console.log("\nAvvisi delle uscite:\n");

  for (const r of rows) {
    const dove = r.telegram_chat_id ? String(r.telegram_chat_id) : "— non collegato";
    const nota = r.stato !== "attivo" ? `  (${r.stato}: non riceve comunque)` : "";

    console.log(`  ${r.nickname.padEnd(12)} ${dove}${nota}`);
  }

  console.log();
}

async function collega(chi, chatId) {
  if (!/^-?\d+$/.test(String(chatId))) {
    throw new Error(`"${chatId}" non è un identificativo di chat`);
  }

  const persona = await trova(chi);

  // L'indice unico direbbe la stessa cosa, ma con un messaggio che
  // parla di vincoli invece che di persone.
  const { rows: altri } = await pool.query(
    `SELECT nickname FROM utenti WHERE telegram_chat_id = $1 AND id <> $2`,
    [chatId, persona.id]
  );

  if (altri.length > 0) {
    throw new Error(`quella chat è già di ${altri[0].nickname}`);
  }

  await pool.query(`UPDATE utenti SET telegram_chat_id = $1 WHERE id = $2`, [chatId, persona.id]);

  console.log(`✅ ${persona.nickname} riceverà gli avvisi su ${chatId}.`);
  console.log(`   Provalo: node scripts/uscite-chatid.js --prova ${persona.nickname}`);
}

async function scollega(chi) {
  const persona = await trova(chi);

  await pool.query(`UPDATE utenti SET telegram_chat_id = NULL WHERE id = $1`, [persona.id]);

  console.log(`✅ ${persona.nickname} non riceve più avvisi.`);
}

async function prova(chi) {
  const persona = await trova(chi);

  if (!persona.telegram_chat_id) throw new Error(`${persona.nickname} non è collegata`);

  const risposta = await telegram.invia(
    persona.telegram_chat_id,
    [
      "📺 <b>Videoteca</b>",
      "",
      `Ciao ${telegram.esc(persona.nickname)}, gli avvisi funzionano.`,
      "Da adesso ti scrivo quando esce una puntata delle serie che segui, e la mattina ti dico cosa esce in giornata."
    ].join("\n")
  );

  if (!risposta.ok) throw new Error(risposta.descrizione);

  console.log(`✅ Messaggio consegnato a ${persona.nickname}.`);
}

(async () => {
  try {
    const io = await telegram.chiSono();

    if (!io.ok) throw new Error(`il token non va: ${io.descrizione}`);

    if (comando !== "--elenco") console.log(`Bot: @${io.risultato.username}`);

    switch (comando) {
      case "--collega":
        await collega(resto[0], resto[1]);
        break;
      case "--scollega":
        await scollega(resto[0]);
        break;
      case "--prova":
        await prova(resto[0]);
        break;
      case "--elenco":
        await elenco();
        break;
      default:
        await chiHaScritto();
    }
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
