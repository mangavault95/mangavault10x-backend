// Prova dei parser di AnimeClick sulle pagine d'esempio di
// `fixtures/animeclick/`. Niente rete e niente database: la rete è
// sostituita da `fetchImpl`, che risponde con quei file.
//
//   node scripts/prova-parser.js
//
// ⚠️ Le pagine sono costruite a mano (vedi fixtures/animeclick/LEGGIMI.md),
// quindi questa prova protegge il NOSTRO codice e la concordanza col bot,
// non dice se AnimeClick ha cambiato l'HTML. Quella si scopre salvando la
// pagina vera e aggiungendo un caso.
//
// La stessa cartella e lo stesso controllo stanno in
// `mangavault10x-bot/scripts/prova-parser.js`: due copie dello stesso
// scraper, e questa è la cosa che le tiene d'accordo.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const {
  volumiUsciti,
  leggiStatoItaliano,
  categoriaDi,
  autoriDi,
  consigli,
  cerca,
  testoDi
} = require("../services/providers/animeclick");

const CARTELLA = path.join(__dirname, "..", "fixtures", "animeclick");

// L'impronta delle pagine d'esempio. Se cambiano qui devono cambiare
// anche nel bot: l'impronta dell'altra copia dice se si sono separate.
const IMPRONTA = "4e52444db8d84dec";

const leggi = (nome) => fs.readFileSync(path.join(CARTELLA, nome), "utf8");

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

/** Una risposta finta, con quel che serve a chi legge. */
function risposta(corpo, { status = 200, cookie = null } = {}) {
  const testo = typeof corpo === "string" ? corpo : JSON.stringify(corpo);

  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n) => (n.toLowerCase() === "set-cookie" ? cookie : null) },
    text: async () => testo,
    json: async () => (typeof corpo === "string" ? JSON.parse(corpo) : corpo)
  };
}

/** Un `fetch` che risponde dalle pagine d'esempio e si ricorda le richieste. */
function finto(rotte) {
  const richieste = [];

  const fetchImpl = async (url, opzioni = {}) => {
    richieste.push({ url: String(url), metodo: opzioni.method || "GET", intestazioni: opzioni.headers || {}, corpo: opzioni.body });

    for (const [forma, dai] of rotte) {
      if (forma.test(String(url)) && (!dai.metodo || dai.metodo === (opzioni.method || "GET"))) return dai.risposta(richieste.length);
    }

    return risposta("non trovato", { status: 404 });
  };

  return { fetchImpl, richieste };
}

(async () => {
  console.log("\nLe pagine d'esempio");
  {
    const hash = crypto.createHash("sha256");

    for (const f of fs.readdirSync(CARTELLA).filter((x) => x !== "LEGGIMI.md").sort()) hash.update(f).update(leggi(f));

    const impronta = hash.digest("hex").slice(0, 16);

    prova("sono le stesse del bot (impronta)", IMPRONTA, impronta);
  }

  const OGGI = new Date("2026-11-14T00:00:00Z");
  const edizioni = (nome) => finto([[/\/edizioni$/, { risposta: () => risposta(leggi(nome)) }]]);

  console.log("\nVolumi usciti (pagina delle edizioni)");
  {
    const r = await volumiUsciti(9607, { oggi: OGGI, fetchImpl: edizioni("edizioni-berserk.html").fetchImpl });

    prova("tiene i tre usciti della serie normale", [3, 3, 3, true, []], [r.massimo, r.quanti, r.quanti, r.completo, r.mancanti]);
    prova("l'ultima uscita è l'ultima già uscita, non l'annunciata", "12/05/1999", r.ultimaUscita);
    prova("dice perché ha scartato il resto", { ristampa: 1, altraEdizione: 2, futuri: 1, illeggibili: 1 }, r.scartati);
    prova("conta tutte le righe della tabella", 8, r.righeTotali);

    const d = await volumiUsciti(9607, { edizione: "Deluxe", oggi: OGGI, fetchImpl: edizioni("edizioni-berserk.html").fetchImpl });

    prova("con un'etichetta tiene solo quella edizione", [1, "20/09/2019"], [d.massimo, d.ultimaUscita]);

    const t = await volumiUsciti(1, { oggi: OGGI, fetchImpl: edizioni("edizioni-takopi.html").fetchImpl });

    // «Blue Box» è un titolo vero: la parola `box` da sola non deve far scartare la riga.
    prova("«Blue Box» non è un cofanetto, con un buco lo dice", [7, 3, false, [3, 4, 5, 6]], [t.massimo, t.quanti, t.completo, t.mancanti]);

    const senza = finto([[/\/edizioni$/, { risposta: () => risposta("<html><body>niente tabella</body></html>") }]]);
    let errore = null;

    try {
      await volumiUsciti(1, { oggi: OGGI, fetchImpl: senza.fetchImpl });
    } catch (e) {
      errore = e.message;
    }

    prova("senza tabella dice che non la trova", true, /tabella delle edizioni non trovata/.test(errore || ""));
  }

  console.log("\nTesto ed entità");
  {
    prova("apostrofo decimale", "Takopi's Original Sin", testoDi("Takopi&#039;s Original Sin"));
    prova("apostrofo esadecimale", "Takopi's Original Sin", testoDi("Takopi&#x27;s Original Sin"));
    prova("accenti e tag", "è un tè", testoDi("<b>&egrave;</b> un t&egrave;"));
  }

  console.log("\nScheda: stato in Italia, categoria, autori");
  {
    const scheda = finto([[/\/manga\/9607\/-\/$/, { risposta: () => risposta(leggi("scheda-berserk.html")) }]]);

    const stato = leggiStatoItaliano(leggi("scheda-berserk.html"));

    prova("conta lo stato ITALIANO, non quello dell'opera", ["in_corso", "In corso"], [stato.stato, stato.testo]);
    prova("riporta tutte le voci di stato", ["Stato in patria: Concluso", "Stato in Italia: In corso"], stato.etichette);

    const conStato = (valore) => leggiStatoItaliano(`<dl class="dl-horizontal"><dt>Stato in Italia</dt><dd>${valore}</dd></dl>`).stato;

    prova("«Concluso»", "conclusa", conStato("Concluso"));
    prova("«Completo»", "conclusa", conStato("Completo"));
    prova("«Non concluso» è in corso", "in_corso", conStato("Non concluso"));
    prova("«In corso»", "in_corso", conStato("In corso"));
    prova("«Sospeso»: non si decide", null, conStato("Sospeso"));
    prova("senza il <dl>: non si decide", null, leggiStatoItaliano("<html></html>").stato);

    prova("categoria: il pubblico, non l'avvertimento", "seinen", await categoriaDi(9607, { fetchImpl: scheda.fetchImpl }));

    const soloAdulto = finto([[/\/manga\//, { risposta: () => risposta('<dl class="dl-horizontal"><dt>Categoria</dt><dd><a>Pubblico Adulto</a></dd></dl>') }]]);

    prova("categoria: l'avvertimento da solo vale «adulto»", "adulto", await categoriaDi(1, { fetchImpl: soloAdulto.fetchImpl }));
    prova("autori: storia e disegni, senza doppioni", ["Kentaro Miura", "Kouji Mori"], await autoriDi(9607, { fetchImpl: scheda.fetchImpl }));
  }

  console.log("\nRicerca");
  {
    const modulo = leggi("ricerca-modulo.html");
    const json = JSON.parse(leggi("ricerca-risposta.json"));

    const sito = finto([
      [/\/ricerca\/manga$/, { metodo: "GET", risposta: () => risposta(modulo, { cookie: "PHPSESSID=abc; path=/; HttpOnly" }) }],
      [/\/ricerca\/manga$/, { metodo: "POST", risposta: () => risposta(json) }]
    ]);

    const trovate = await cerca("Berserk", { fetchImpl: sito.fetchImpl });

    prova("ordina per somiglianza e scarta chi non c'entra", [9607, 12345, 777], trovate.map((s) => s.id));
    prova("l'anno viene dal riquadro o dal calendario", [1989, 2019, 2005], trovate.map((s) => s.anno));
    prova("le copertine diventano indirizzi interi", ["https://www.animeclick.it/immagini/manga/9607-thumb.jpg", "https://cdn.example/thumb2.jpg"], trovate.slice(0, 2).map((s) => s.copertina));
    prova("il punteggio del titolo identico è 100", 100, trovate[0].punteggio);

    const post = sito.richieste.find((r) => r.metodo === "POST");

    prova("rimanda token e cookie del modulo", ["tok3n-di-prova_123", "PHPSESSID=abc"], [new URLSearchParams(post.corpo).get("search_manga[_token]"), post.intestazioni.Cookie]);
    prova("chiede «contiene» e «anno qualunque»", ["0", "-1", "Berserk"], ["search_manga[titleOption]", "search_manga[anno]", "search_manga[title]"].map((k) => new URLSearchParams(post.corpo).get(k)));
    prova("si presenta con uno User-Agent", true, sito.richieste.every((r) => /MangaVault/.test(r.intestazioni["User-Agent"] || "")));

    await cerca("Berserk", { fetchImpl: sito.fetchImpl, modo: "esatto" });

    const ultima = sito.richieste.filter((r) => r.metodo === "POST").pop();

    prova("la sessione si riusa (un solo modulo) e «esatto» è l'opzione 3", [1, "3"], [sito.richieste.filter((r) => r.metodo === "GET").length, new URLSearchParams(ultima.corpo).get("search_manga[titleOption]")]);

    const senzaToken = finto([[/\/ricerca\/anime$/, { risposta: () => risposta("<html>modulo cambiato</html>") }]]);
    let errore = null;

    try {
      await cerca("x", { fetchImpl: senzaToken.fetchImpl, tipo: "anime" });
    } catch (e) {
      errore = e.message;
    }

    prova("se il token sparisce dice che non lo trova", true, /token della ricerca anime non trovato/.test(errore || ""));
  }

  console.log("\nConsigli");
  {
    const sito = finto([[/\/consigli$/, { risposta: () => risposta(leggi("consigli-berserk.html")) }]]);
    const c = await consigli(9607, { fetchImpl: sito.fetchImpl });

    prova(
      "legge titolo, copertina e segnalazioni, anche con lo slug col punto",
      [
        { id: 2001, titolo: "Vagabond", url: "https://www.animeclick.it/manga/2001/vagabond", copertina: "https://www.animeclick.it/immagini/manga/2001.jpg", segnalazioni: 42 },
        { id: 2002, titolo: "Kaiju No. 8", url: "https://www.animeclick.it/manga/2002/kaiju-no.8", copertina: "https://cdn.example/k8.jpg", segnalazioni: 17 }
      ],
      c
    );

    prova("senza il pannello dei consigli, nessun consiglio", [], await consigli(1, { fetchImpl: finto([[/./, { risposta: () => risposta("<html></html>") }]]).fetchImpl }));
  }

  console.log("\nQuando il sito sbaglia");
  {
    const e404 = finto([[/./, { risposta: () => risposta("no", { status: 404 }) }]]);
    let errore = null;

    try {
      await volumiUsciti(1, { fetchImpl: e404.fetchImpl });
    } catch (e) {
      errore = e.message;
    }

    prova("un 404 non si ritenta e lo dice", [1, true], [e404.richieste.length, /HTTP 404/.test(errore || "")]);

    let giri = 0;
    const instabile = finto([[/\/edizioni$/, { risposta: () => (++giri === 1 ? risposta("giù", { status: 503 }) : risposta(leggi("edizioni-takopi.html"))) }]]);
    const r = await volumiUsciti(1, { oggi: OGGI, fetchImpl: instabile.fetchImpl });

    prova("un 503 si ritenta una volta e poi passa", [2, 7], [instabile.richieste.length, r.massimo]);
  }

  console.log(falliti ? `\n${falliti} prove fallite.\n` : "\nTutto a posto.\n");
  process.exitCode = falliti ? 1 : 0;
})();
