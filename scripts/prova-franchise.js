// Prova del giro nuovo: una ricerca sola, e in videoteca ci finisce
// la serie intera.
//
//   node scripts/prova-franchise.js
//   node scripts/prova-franchise.js dandadan
//
// Fa il giro che fa una persona dal pannello «Aggiungi una serie»:
// cerca un titolo, chiede di che parti è fatta la serie, la aggiunge
// tutta, controlla che le stagioni siano nello stesso gruppo e in
// ordine di uscita. Poi rimette il database com'era.
//
// ⚠️ LA CAUTELA CHE QUESTO SCRIPT SI PRENDE, E PERCHÉ.
// Cancella SOLO le schede che ha creato lui. Prima di aggiungere
// guarda quali `animeclick_id` sono già in tabella, e alla fine
// risparmia quelli: la videoteca è vera, ci sono dentro spunte e voti
// di anni, e un `DELETE FROM anime` su una serie che c'era già
// porterebbe via quelli insieme alla prova. Per lo stesso motivo la
// serie di prova va scelta fra quelle che NON si guardano.

require("dotenv").config({ quiet: true });

process.env.PORT = process.env.PORT_PROVA || "3998";

const pool = require("../db");
const { firmaToken } = require("../services/auth");
const { idProprietario } = require("../services/utenti");

const BASE = `http://localhost:${process.env.PORT}`;
const TITOLO = process.argv[2] || "dandadan";

let passate = 0;
let fallite = 0;

function esito(descrizione, ok, dettaglio = "") {
  console.log(`  ${ok ? "ok  " : "NO  "} ${descrizione}${dettaglio ? ` — ${dettaglio}` : ""}`);
  ok ? passate++ : fallite++;
}

async function chiama(metodo, percorso, { token, corpo } = {}) {
  const risposta = await fetch(`${BASE}${percorso}`, {
    method: metodo,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: corpo ? JSON.stringify(corpo) : undefined
  });

  const testo = await risposta.text();

  try {
    return { stato: risposta.status, dati: JSON.parse(testo) };
  } catch {
    return { stato: risposta.status, dati: testo };
  }
}

(async () => {
  const server = require("../index");

  await new Promise((r) => setTimeout(r, 700));

  const utenteId = await idProprietario();
  const token = firmaToken({ id: utenteId, username: "prova", ruolo: "admin" });

  let daCancellare = [];
  let gruppoDaCancellare = null;

  try {
    console.log(`\nRicerca «${TITOLO}»`);

    const cerca = await chiama("GET", `/api/anime/cerca?titolo=${encodeURIComponent(TITOLO)}`, {
      token
    });

    esito("risponde 200", cerca.stato === 200, `stato ${cerca.stato}`);
    esito("trova qualcosa", Array.isArray(cerca.dati) && cerca.dati.length > 0);
    esito(
      "ogni candidato porta la radice del titolo",
      cerca.dati.every((c) => typeof c.radice === "string" && c.radice.length > 0),
      cerca.dati[0]?.radice
    );
    esito(
      "il più pertinente sta in cima",
      cerca.dati[0]?.punteggio >= (cerca.dati[cerca.dati.length - 1]?.punteggio ?? 0)
    );

    // La ricerca che prima tornava vuota: AnimeClick trova la serie dal
    // titolo originale, il punteggio dei manga la buttava via.
    const inOriginale = await chiama("GET", "/api/anime/cerca?titolo=shingeki%20no%20kyojin", {
      token
    });

    esito(
      "cercando in originale esce il titolo italiano",
      (inOriginale.dati || []).some((c) => /attacco dei giganti/i.test(c.titolo)),
      (inOriginale.dati || []).map((c) => c.titolo)[0]
    );

    const scelto = cerca.dati[0];

    console.log(`\nDi che parti è fatta «${scelto.titolo}»`);

    const proposta = await chiama("GET", `/api/anime/franchise/${scelto.animeclickId}`, { token });

    esito("risponde 200", proposta.stato === 200, `stato ${proposta.stato}`);
    esito("dà un nome alla serie", Boolean(proposta.dati?.capo?.nome), proposta.dati?.capo?.nome);

    const parti = proposta.dati?.parti || [];

    esito("la scheda cercata è fra le parti", parti.some((p) => p.capo));
    esito("ogni parte ha un ruolo e un motivo", parti.every((p) => p.ruolo && p.motivo));
    esito(
      "le parti sono in ordine di uscita",
      parti.every((p, i) => i === 0 || (parti[i - 1].anno || 9999) <= (p.anno || 9999))
    );

    for (const p of parti) {
      console.log(
        `     ${p.consigliato ? "[x]" : "[ ]"} ${String(p.ruolo).padEnd(8)} ${String(p.anno || "—").padEnd(5)} ${p.titolo}`
      );
    }

    const consigliate = parti.filter((p) => p.consigliato);

    esito("ne consiglia almeno una", consigliate.length > 0, `${consigliate.length} parti`);

    // Cosa c'era già: quello che sopravvive alla pulizia finale.
    const { rows: prima } = await pool.query(
      `SELECT animeclick_id FROM anime WHERE animeclick_id = ANY($1::int[])`,
      [parti.map((p) => p.animeclick_id)]
    );

    const cerano = new Set(prima.map((r) => Number(r.animeclick_id)));

    if (cerano.size > 0) {
      console.log(`\n  (${cerano.size} parti erano già in catalogo: non verranno cancellate)`);
    }

    console.log("\nAggiunta della serie intera");

    let aggiunta = await chiama("POST", "/api/anime", {
      token,
      corpo: {
        animeclick_id: scelto.animeclickId,
        parti: consigliate.map((p) => p.animeclick_id),
        nome: proposta.dati?.capo?.nome
      }
    });

    esito("creata", aggiunta.stato === 201, `stato ${aggiunta.stato}`);

    // Le parti che non erano entrate nel tempo della prima richiesta.
    let giri = 0;

    while (aggiunta.dati?.restanti?.length > 0 && giri < 5) {
      giri++;
      aggiunta = await chiama("POST", "/api/anime", {
        token,
        corpo: {
          animeclick_id: scelto.animeclickId,
          parti: consigliate.map((p) => p.animeclick_id),
          nome: proposta.dati?.capo?.nome
        }
      });
    }

    esito("nessuna parte è rimasta indietro", (aggiunta.dati?.restanti || []).length === 0);
    esito("nessun errore per strada", (aggiunta.dati?.errori || []).length === 0, JSON.stringify(aggiunta.dati?.errori || []));

    const aggiunte = aggiunta.dati?.aggiunte || [];

    daCancellare = aggiunte
      .filter((a) => !cerano.has(Number(a.animeclick_id)))
      .map((a) => Number(a.id));

    esito(
      "sono entrate tutte le parti scelte",
      aggiunte.length === consigliate.length,
      `${aggiunte.length} di ${consigliate.length}`
    );

    if (consigliate.length > 1) {
      gruppoDaCancellare = aggiunta.dati?.gruppo_id ?? null;

      esito("stanno in un gruppo solo", Boolean(gruppoDaCancellare), `gruppo ${gruppoDaCancellare}`);

      const { rows: dentro } = await pool.query(
        `SELECT titolo, ordine, anno_inizio FROM anime WHERE gruppo_id = $1 ORDER BY ordine`,
        [gruppoDaCancellare]
      );

      esito("il gruppo le contiene tutte", dentro.length === consigliate.length, `${dentro.length}`);
      esito(
        "sono in ordine di uscita",
        dentro.every((r, i) => i === 0 || (dentro[i - 1].anno_inizio || 0) <= (r.anno_inizio || 9999)),
        dentro.map((r) => `${r.ordine}·${r.anno_inizio}`).join(" ")
      );

      const { rows: nome } = await pool.query(`SELECT titolo FROM anime_gruppi WHERE id = $1`, [
        gruppoDaCancellare
      ]);

      esito(
        "il gruppo si chiama come la serie, non come la prima stagione",
        nome[0]?.titolo === proposta.dati?.capo?.nome,
        nome[0]?.titolo
      );
    }

    console.log("\nLa scheda");

    const scheda = await chiama("GET", `/api/anime/${aggiunta.dati?.anime?.id}`);

    esito("si apre", scheda.stato === 200, `stato ${scheda.stato}`);
    esito(
      "contiene tutte le stagioni",
      (scheda.dati?.stagioni || []).length === consigliate.length,
      `${(scheda.dati?.stagioni || []).length} stagioni`
    );
    esito(
      "ogni stagione arriva con le sue puntate",
      (scheda.dati?.stagioni || []).every((s) => Array.isArray(s.episodi))
    );

    console.log("\nAggiungere due volte");

    const ripetuta = await chiama("POST", "/api/anime", {
      token,
      corpo: { animeclick_id: scelto.animeclickId, parti: consigliate.map((p) => p.animeclick_id) }
    });

    esito("non duplica", ripetuta.stato === 201);

    const { rows: quante } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM anime WHERE animeclick_id = ANY($1::int[])`,
      [consigliate.map((p) => p.animeclick_id)]
    );

    esito("le schede restano quante erano", quante[0].n === consigliate.length, `${quante[0].n}`);
  } catch (e) {
    console.log("\nERRORE:", e.stack);
    fallite++;
  } finally {
    if (daCancellare.length) {
      await pool.query(`DELETE FROM anime WHERE id = ANY($1::bigint[])`, [daCancellare]);
      console.log(`\n(${daCancellare.length} schede di prova cancellate)`);
    }

    if (gruppoDaCancellare) {
      // Solo se è rimasto vuoto: se dentro c'era una serie vera, il
      // gruppo serve ancora a lei.
      await pool.query(
        `DELETE FROM anime_gruppi g WHERE g.id = $1
           AND NOT EXISTS (SELECT 1 FROM anime a WHERE a.gruppo_id = g.id)`,
        [gruppoDaCancellare]
      );
    }

    console.log(`\n${passate} passate, ${fallite} fallite`);

    await pool.end();
    server?.close?.();
    process.exit(fallite ? 1 : 0);
  }
})();
