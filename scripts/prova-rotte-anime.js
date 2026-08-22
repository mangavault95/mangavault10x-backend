// Prova delle rotte della Videoteca, sul database vero.
//
// Fa il giro che farebbe una persona: cerca una serie su AnimeClick,
// la aggancia, spunta gli episodi, vota, scrive una nota, chiede il
// calendario. Poi CANCELLA la serie di prova, e con lei — per
// cascata — le spunte, il voto e le note.
//
//   node scripts/prova-rotte-anime.js
//   node scripts/prova-rotte-anime.js 24529 "demon slayer"
//
// ⚠️ Si rifiuta di girare su una serie che è già in videoteca: la
// userebbe come cavia e alla fine la cancellerebbe con dentro le
// spunte, il voto e i commenti di chi la guarda. Se la serie
// predefinita è entrata davvero, si passa l'id di una che non si
// guarda (e, volendo, il titolo con cui cercarla).
//
// Serve un server acceso? No: lo accende da sé su una porta sua, così
// non litiga con `npm run dev` se è già in piedi.

process.env.PORT = process.env.PORT_PROVA || "3999";

require("dotenv").config();

const pool = require("../db");
const { firmaToken } = require("../services/auth");
const { idProprietario } = require("../services/utenti");

const BASE = `http://localhost:${process.env.PORT}`;

// Frieren: 38 episodi, titoli italiani, una scheda che ha già tutto.
const ANIMECLICK_ID = Number(process.argv[2]) || 45427;

// Cosa si scrive nella casella di ricerca. Con un id passato a mano non
// si sa che titolo abbia: si cerca l'id stesso, che AnimeClick non
// trova, e l'unica cosa che quella prova continua a dire è che la rotta
// risponde e che senza token è chiusa. Va bene: il resto del giro non
// dipende dalla ricerca.
const TITOLO_CERCATO = process.argv[3] || (ANIMECLICK_ID === 45427 ? "Frieren" : String(ANIMECLICK_ID));

let passate = 0;
let fallite = 0;

function esito(descrizione, ok, dettaglio = "") {
  console.log(`  ${ok ? "ok  " : "NO  "} ${descrizione}${dettaglio ? ` — ${dettaglio}` : ""}`);
  ok ? passate++ : fallite++;
}

async function chiama(metodo, percorso, { token, corpo, segreto } = {}) {
  const risposta = await fetch(`${BASE}${percorso}`, {
    method: metodo,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(segreto ? { "X-Cron-Secret": segreto } : {})
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

  // Il tempo che il server si leghi alla porta.
  await new Promise((r) => setTimeout(r, 700));

  const utenteId = await idProprietario();
  const token = firmaToken({ id: utenteId, username: "prova", ruolo: "admin" });

  let animeId = null;

  // ⚠️ LA MINA CHE QUESTO SCRIPT SI PORTAVA DIETRO.
  //
  // Frieren è la serie di prova, e in fondo lo script cancella quello
  // che ha agganciato. Andava bene finché la videoteca era vuota. Dal
  // momento in cui Frieren è entrata DAVVERO — trentotto spunte, un
  // voto, dei commenti — lanciare la prova voleva dire scrivere sulla
  // stessa riga (l'aggancio è un upsert su `animeclick_id`), spuntare
  // e despuntare le sue puntate, sovrascrivere il voto, e alla fine
  // cancellare tutto quanto con la cascata.
  //
  // Quindi la prova si rifiuta di girare su una serie che si guarda
  // davvero. Non è prudenza di maniera: qui l'unica cosa che non si
  // può riprendere da AnimeClick è proprio quella che si perdeva.
  const { rows: gia } = await pool.query(`SELECT id, titolo FROM anime WHERE animeclick_id = $1`, [
    ANIMECLICK_ID
  ]);

  if (gia.length > 0) {
    console.log(
      [
        "",
        `«${gia[0].titolo}» è già in videoteca, e questa prova la userebbe come cavia:`,
        "spunta episodi, cambia il voto, e alla fine cancella la serie con tutto",
        "quello che c'è attaccato. Non gira.",
        "",
        "Per provare le rotte, usa una serie che non guardi:",
        "  node scripts/prova-rotte-anime.js <animeclick_id>",
        "",
        "Per il giro nuovo — una ricerca sola, tutta la serie — c'è invece",
        "`scripts/prova-franchise.js`, che cancella solo quello che ha creato lui."
      ].join("\n")
    );

    await pool.end();
    server?.close?.();
    process.exit(0);
  }

  try {
    console.log("\nRicerca su AnimeClick");
    const cerca = await chiama(
      "GET",
      `/api/anime/cerca?titolo=${encodeURIComponent(TITOLO_CERCATO)}`,
      { token }
    );
    esito("risponde 200", cerca.stato === 200, `stato ${cerca.stato}`);
    esito(
      "propone la scheda giusta fra i candidati",
      Array.isArray(cerca.dati) && cerca.dati.some((c) => c.animeclickId === ANIMECLICK_ID),
      Array.isArray(cerca.dati) ? `${cerca.dati.length} candidati` : ""
    );
    esito("senza token è chiusa", (await chiama("GET", "/api/anime/cerca?titolo=x")).stato === 401);

    console.log("\nAggancio");
    const aggancio = await chiama("POST", "/api/anime", {
      token,
      corpo: { animeclick_id: ANIMECLICK_ID }
    });

    esito("creata", aggancio.stato === 201, `stato ${aggancio.stato}`);
    animeId = aggancio.dati?.anime?.id;

    esito(
      "titolo scritto come lo scrive AnimeClick",
      Boolean(aggancio.dati?.anime?.titolo),
      aggancio.dati?.anime?.titolo
    );
    esito(
      "generi presenti, e in italiano",
      (aggancio.dati?.anime?.generi || []).length > 0,
      (aggancio.dati?.anime?.generi || []).join(", ")
    );
    esito("trama presente", Boolean(aggancio.dati?.anime?.trama));
    esito(
      "la scheda è entrata in videoteca",
      (aggancio.dati?.aggiunte || []).length > 0,
      `${(aggancio.dati?.aggiunte || []).length} parti`
    );

    const ripetuto = await chiama("POST", "/api/anime", {
      token,
      corpo: { animeclick_id: ANIMECLICK_ID }
    });
    esito(
      "agganciarla due volte aggiorna, non duplica",
      ripetuto.stato === 201 && Number(ripetuto.dati?.anime?.id) === Number(animeId)
    );

    console.log("\nGuardare");
    const spunta = await chiama("POST", `/api/anime/${animeId}/episodi/5`, {
      token,
      corpo: { fino: true }
    });
    esito("«ho visto fino al 5» spunta cinque puntate", spunta.dati?.visti === 5, `visti ${spunta.dati?.visti}`);
    esito("la serie non risulta finita", spunta.dati?.completa === false);

    const doppia = await chiama("POST", `/api/anime/${animeId}/episodi/5`, { token });
    esito("spuntare due volte non è un errore", doppia.stato === 200 && doppia.dati?.visti === 5);

    const scheda = await chiama("GET", `/api/anime/${animeId}`);
    esito("la scheda dice a che punto sono", Number(scheda.dati?.ultimo_visto) === 5, `ultimo ${scheda.dati?.ultimo_visto}`);
    esito("la visione si è accesa da sola", scheda.dati?.stato_visione === "in_visione", scheda.dati?.stato_visione);
    esito(
      "gli episodi arrivano con la spunta attaccata",
      scheda.dati?.episodi?.filter((e) => e.visto).length === 5
    );
    esito(
      "gli episodi hanno il titolo italiano di AnimeClick",
      Boolean(scheda.dati?.episodi?.[0]?.titolo),
      scheda.dati?.episodi?.[0]?.titolo
    );

    const tolta = await chiama("DELETE", `/api/anime/${animeId}/episodi/5`, { token });
    esito("togliere una spunta funziona", tolta.stato === 200);

    console.log("\nVoto e note");
    esito(
      "il voto a mezze stelle passa",
      (await chiama("PUT", `/api/anime/${animeId}/voto`, { token, corpo: { voto: 4.5 } })).stato === 200
    );
    esito(
      "un voto da 3,7 viene rifiutato",
      (await chiama("PUT", `/api/anime/${animeId}/voto`, { token, corpo: { voto: 3.7 } })).stato === 400
    );

    const notaSerie = await chiama("POST", `/api/anime/${animeId}/note`, {
      token,
      corpo: { testo: "Da rivedere con calma." }
    });
    esito("nota sulla serie", notaSerie.stato === 201);

    const notaEp = await chiama("POST", `/api/anime/${animeId}/note`, {
      token,
      corpo: { testo: "Che apertura.", numero_episodio: 1, spoiler: true }
    });
    esito("nota su una puntata", notaEp.stato === 201 && notaEp.dati?.nota?.numero_episodio === 1);

    const conNote = await chiama("GET", `/api/anime/${animeId}`);
    esito("la scheda le riporta tutte e due", conNote.dati?.note?.length === 2);
    esito("il voto medio è calcolato", Number(conNote.dati?.voto_medio) === 4.5, `${conNote.dati?.voto_medio}`);

    esito(
      "cancellare una nota altrui non si può (id inesistente)",
      (await chiama("DELETE", "/api/anime/note/999999999", { token })).stato === 404
    );

    console.log("\nVideoteca e calendario");
    const elenco = await chiama("GET", "/api/anime");
    esito("l'elenco contiene la serie", Array.isArray(elenco.dati) && elenco.dati.some((a) => Number(a.id) === Number(animeId)));

    const cal = await chiama("POST", "/api/anime/calendario/aggiorna", {
      segreto: process.env.CRON_SECRET,
      corpo: { scrivi: false }
    });
    esito("il giro del calendario gira", cal.stato === 200, `${cal.dati?.lette} uscite lette`);

    esito(
      "senza segreto il giro è chiuso",
      (await chiama("POST", "/api/anime/calendario/aggiorna", { corpo: {} })).stato === 403
    );

    const calendario = await chiama("GET", "/api/anime/calendario");
    esito("il calendario risponde", calendario.stato === 200, `${calendario.dati?.length ?? 0} uscite in tabella`);
  } catch (e) {
    console.log("\nERRORE:", e.message);
    fallite++;
  } finally {
    if (animeId) {
      // Via la serie di prova: la cascata porta con sé spunte, voto e
      // note. Si arriva qui solo se la serie NON c'era prima — il
      // controllo in cima non lascia passare altro.
      await pool.query(`DELETE FROM anime WHERE id = $1`, [animeId]);
      console.log(`\n(serie di prova ${animeId} cancellata)`);
    }

    console.log(`\n${passate} passate, ${fallite} fallite`);

    await pool.end();
    server?.close?.();
    process.exit(fallite ? 1 : 0);
  }
})();
