/**
 * Il Cineforum sui dati veri, senza toccarli.
 *
 * Applica la migrazione 016 dentro una transazione, ci dirotta dentro
 * `pool.query` e fa girare il servizio del feed sopra lo schema
 * migrato: si vedono i post che si vedrebbero davvero — le serie che
 * ci sono, le spunte che ci sono — e alla fine ROLLBACK, quindi il
 * database resta com'era.
 *
 * È lo stesso trucco di `prova-migrazione.js`, con un pezzo in più:
 * là si guarda se lo SQL gira, qui se il feed che ne esce ha senso.
 * Serve perché il difetto tipico di un feed calcolato non è un errore
 * SQL ma una frase sbagliata — un giorno tagliato nel fuso storto, una
 * serie che compare due volte perché sono due stagioni.
 *
 * Uso:
 *   node scripts/prova-cineforum.js
 */

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const pool = require("../db");
const cineforum = require("../services/cineforum");

const MIGRAZIONE = path.join(__dirname, "..", "sql", "016_cineforum.sql");

function titolo(testo) {
  console.log(`\n${"═".repeat(64)}\n${testo}\n${"═".repeat(64)}`);
}

(async () => {
  const cliente = await pool.connect();

  try {
    await cliente.query("SET lock_timeout = '5s'");
    await cliente.query("SET statement_timeout = '120s'");
    await cliente.query("BEGIN");

    titolo("1 · la migrazione 016");

    await cliente.query(fs.readFileSync(MIGRAZIONE, "utf8"));

    console.log("✅ nessun errore SQL");

    const { rows: incoerenti } = await cliente.query(
      `SELECT COUNT(*)::int AS quante FROM visioni WHERE creata_il > aggiornata_il`
    );

    console.log(`   visioni con l'aggiunta dopo l'ultimo aggiornamento: ${incoerenti[0].quante}`);

    // Da qui in poi il servizio parla col client dentro la
    // transazione, non col pool: è l'unico modo di provarlo sopra uno
    // schema che non esiste ancora davvero.
    const finto = { query: (...a) => cliente.query(...a), connect: async () => cliente };

    titolo("2 · il feed, prima pagina");

    const prima = await cineforum.feed(finto, { quanti: 8 });

    console.log(`post: ${prima.post.length}${prima.ancora ? " (ce ne sono altri)" : ""}\n`);

    for (const p of prima.post) {
      const quando = new Date(p.quando).toLocaleString("it-IT", { timeZone: cineforum.FUSO });

      console.log(`── ${p.utente.nickname} · ${p.giorno} · ${quando}`);
      console.log(`   ${p.chiave}`);

      if (p.tipo === "messaggio") {
        console.log(`   «${p.testo.slice(0, 70)}»`);
      } else {
        const e = p.eventi;

        const dice = [
          e.aggiunte.length && `${e.aggiunte.length} aggiunte`,
          e.episodi.length &&
            `${e.episodi.reduce((s, r) => s + r.numeri.length, 0)} episodi su ${e.episodi.length} serie`,
          e.finite.length && `${e.finite.length} finite`,
          e.voti.length && `${e.voti.length} voti`,
          e.commenti.length && `${e.commenti.length} commenti`
        ].filter(Boolean);

        console.log(`   ${dice.join(" · ") || "(giornata vuota — non dovrebbe capitare)"}`);

        for (const r of e.episodi.slice(0, 3)) {
          const n = r.numeri;
          const elenco =
            n.length > 3 ? `${n[0]}–${n[n.length - 1]} (${n.length})` : n.join(", ");

          console.log(`     · ${r.gruppo_titolo || r.titolo}: ep ${elenco}`);
        }

        for (const r of e.aggiunte.slice(0, 3)) {
          console.log(`     + ${r.gruppo_titolo || r.titolo}`);
        }
      }
    }

    titolo("3 · la seconda pagina riprende dove finisce la prima");

    if (prima.prossimo) {
      const dopo = await cineforum.feed(finto, { quanti: 5, prima: prima.prossimo });

      const ripetuti = dopo.post.filter((p) => prima.post.some((q) => q.chiave === p.chiave));

      console.log(`post: ${dopo.post.length}, ripetuti dalla prima pagina: ${ripetuti.length}`);

      if (ripetuti.length) console.log("   ⚠️  un post compare in due pagine:", ripetuti.map((p) => p.chiave));
    } else {
      console.log("(il feed sta tutto in una pagina)");
    }

    titolo("4 · i numeri di ciascuno");

    const { rows: gente } = await cliente.query(
      `SELECT id, nickname FROM utenti WHERE stato = 'attivo' ORDER BY proprietario DESC, creato_il`
    );

    const numeri = [];

    for (const persona of gente) {
      const s = await cineforum.statistiche(finto, persona.id);

      numeri.push({ persona, s });

      console.log(
        `${persona.nickname.padEnd(12)} ${String(s.serie).padStart(4)} serie · ` +
          `${String(s.film).padStart(3)} film · ${String(s.episodi).padStart(5)} episodi · ` +
          `${String(Math.round(s.minuti / 60)).padStart(4)} ore · ` +
          `voto medio ${s.voto_medio ?? "—"} · ${s.giorni} giorni attivi`
      );

      if (s.generi.length) {
        console.log(`             generi: ${s.generi.slice(0, 4).map((g) => `${g.genere} (${g.quante})`).join(", ")}`);
      }
    }

    titolo("5 · il confronto fra i primi due");

    if (numeri.length >= 2) {
      const c = await cineforum.confronto(finto, numeri[0].persona.id, numeri[1].persona.id);

      console.log(
        `${numeri[0].persona.nickname} vs ${numeri[1].persona.nickname}: ` +
          `${c.quanteInComune} serie in comune, ${c.votateInDue} votate da entrambi, ` +
          `distanza media dei voti ${c.distanzaMedia ?? "—"}`
      );

      for (const s of c.inComune.slice(0, 8)) {
        console.log(
          `   ${s.titolo.slice(0, 40).padEnd(40)} ` +
            `${String(s.votoA ?? "—").padStart(4)} / ${String(s.votoB ?? "—").padEnd(4)} ` +
            `· ep ${s.episodiA}/${s.episodiB}`
        );
      }
    } else {
      console.log("(serve più di una persona attiva)");
    }

    titolo("6 · un messaggio, un cuore e una risposta");

    if (gente.length) {
      const io = gente[0].id;

      const { rows: m } = await cliente.query(
        `INSERT INTO cineforum_messaggi (utente_id, testo) VALUES ($1, $2) RETURNING id`,
        [io, "Prova: stasera comincio qualcosa di nuovo."]
      );

      const chiave = `messaggio:${m[0].id}`;

      await cliente.query(`INSERT INTO cineforum_cuori (chiave, utente_id) VALUES ($1, $2)`, [
        chiave,
        io
      ]);

      await cliente.query(
        `INSERT INTO cineforum_risposte (chiave, utente_id, testo) VALUES ($1, $2, $3)`,
        [chiave, io, "Prova di risposta."]
      );

      const conMessaggio = await cineforum.feed(finto, { quanti: 3, chiGuarda: io });
      const trovato = conMessaggio.post.find((p) => p.chiave === chiave);

      console.log(
        trovato
          ? `✅ in cima: «${trovato.testo}» — cuori ${trovato.cuori.length} (mio: ${trovato.cuorMio}), risposte ${trovato.risposte.length}`
          : "❌ il messaggio appena scritto non è in cima al feed"
      );

      // Una chiave storta non deve poter entrare: il vincolo del
      // database è l'ultima rete, e va vista funzionare almeno una volta.
      try {
        await cliente.query(`SAVEPOINT storta`);
        await cliente.query(`INSERT INTO cineforum_cuori (chiave, utente_id) VALUES ($1, $2)`, [
          "qualcosa:di-inventato",
          io
        ]);
        console.log("❌ il vincolo sulla chiave non ha fermato una chiave inventata");
      } catch {
        console.log("✅ una chiave inventata viene rifiutata dal database");
      } finally {
        await cliente.query(`ROLLBACK TO SAVEPOINT storta`);
      }
    }

    titolo("annullo tutto");

    await cliente.query("ROLLBACK");

    console.log("✅ ROLLBACK: il database è com'era.");
  } catch (err) {
    await cliente.query("ROLLBACK").catch(() => {});
    console.error("\n❌", err.message);
    if (err.position) console.error("   posizione nello script:", err.position);
    process.exitCode = 1;
  } finally {
    cliente.release();
    await pool.end();
  }
})();
