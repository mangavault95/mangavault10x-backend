const express = require("express");
const router = express.Router();
const NodeCache = require("node-cache");

/**
 * Ponte per le copertine.
 *
 * Serve a tre cose che il browser da solo non può fare:
 *
 *   1. Leggere i colori. AniList e AnimeClick non mandano gli header
 *      CORS, quindi disegnare la copertina su una canvas la rende
 *      illeggibile. Passando da qui gli header ci sono.
 *
 *   2. Non aspettare. AnimeClick impiega secondi a rispondere; qui
 *      la prima richiesta paga l'attesa e le successive no.
 *
 *   3. Sopravvivere. Se una fonte sparisce, la copia in cache regge
 *      finché non si sostituisce l'indirizzo.
 */

// Le immagini sono piccole (50-150 KB): mille voci stanno in poche
// decine di MB e coprono l'intera collezione.
const cache = new NodeCache({ stdTTL: 60 * 60 * 24 * 7, maxKeys: 1000 });

// Un proxy aperto verrebbe usato per scaricare qualunque cosa a spese
// tue, e per far sembrare che il traffico parta dal tuo server.
// Qui passano solo i domini da cui prendiamo davvero le copertine.
const DOMINI_AMMESSI = [
  "s4.anilist.co",
  "s1.anilist.co",
  "s2.anilist.co",
  "s3.anilist.co",
  "www.animeclick.it",
  "animeclick.it",
  "cdn.myanimelist.net",
  "myanimelist.net",
  "books.google.com",
  "books.googleusercontent.com",
  // Miniature della ricerca immagini di Google. Sono indirizzi
  // temporanei che prima o poi scadono: passando dal ponte almeno
  // la copia in cache sopravvive alla scadenza dell'originale.
  "encrypted-tbn0.gstatic.com",
  "encrypted-tbn1.gstatic.com",
  "encrypted-tbn2.gstatic.com",
  "encrypted-tbn3.gstatic.com"
];

const TIPI_AMMESSI = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"];

/**
 * Che immagine è, guardandola invece che chiedendolo.
 *
 * I primi byte di un file dicono il formato e non si possono
 * sbagliare; l'intestazione `Content-Type` la scrive il server della
 * fonte, che a volte non la manda affatto.
 *
 * AVIF non c'è: sta dentro un contenitore ISO-BMFF, la firma è più
 * lunga da leggere e nessuna delle fonti ammesse lo serve. Se un
 * giorno arrivasse, arriverebbe col suo `Content-Type` giusto e
 * passerebbe dalla via normale.
 */
function tipoDaiByte(b) {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";

  if (b.length > 8 && b.toString("hex", 0, 8) === "89504e470d0a1a0a") return "image/png";

  if (
    b.length > 12 &&
    b.toString("ascii", 0, 4) === "RIFF" &&
    b.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }

  if (b.length > 6 && b.toString("ascii", 0, 6).match(/^GIF8[79]a$/)) return "image/gif";

  return null;
}

const DIMENSIONE_MASSIMA = 6 * 1024 * 1024; // 6 MB

function indirizzoValido(grezzo) {
  let url;

  try {
    url = new URL(grezzo);
  } catch {
    return null;
  }

  if (url.protocol !== "https:") return null;
  if (!DOMINI_AMMESSI.includes(url.hostname)) return null;

  return url;
}

router.get("/", async (req, res) => {
  const url = indirizzoValido(req.query.url);

  if (!url) {
    return res.status(400).json({ error: "Indirizzo non ammesso" });
  }

  const chiave = url.href;
  const inCache = cache.get(chiave);

  if (inCache) {
    res.set({
      "Content-Type": inCache.tipo,
      "Cache-Control": "public, max-age=604800, immutable",
      "Access-Control-Allow-Origin": "*",
      "X-Cover-Cache": "hit"
    });
    return res.send(inCache.dati);
  }

  try {
    // Alcune fonti rispondono solo a richieste che sembrano venire da
    // un browser: senza User-Agent restituiscono 403 o restano appese.
    const risposta = await fetch(url.href, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; MangaVault/1.0)",
        Accept: "image/avif,image/webp,image/*,*/*;q=0.8"
      },
      signal: AbortSignal.timeout(12000),
      redirect: "follow"
    });

    if (!risposta.ok) {
      return res.status(502).json({ error: `La fonte ha risposto ${risposta.status}` });
    }

    const dichiarato = (risposta.headers.get("content-type") || "").split(";")[0].trim();
    const dati = Buffer.from(await risposta.arrayBuffer());

    // Un proxy che rimanda qualunque cosa diventa un modo per servire
    // file arbitrari dal tuo dominio: qui escono solo immagini.
    //
    // A DECIDERLO SONO I PRIMI BYTE, non l'intestazione. Quella la
    // scrive la fonte, quindi non è una prova — ed è anche
    // inaffidabile in un modo che si è visto: AnimeClick tiene certe
    // copertine con l'estensione `.jpg_large`, che il loro server non
    // riconosce, e le serve SENZA `Content-Type`. Il file c'era e
    // rispondeva 200, ma di qua diventava un 415 e in videoteca un
    // rettangolo col titolo dentro — sembrava una copertina che non
    // esiste, ed era una copertina rifiutata all'ultimo metro (è la
    // storia di Cowboy Bebop).
    //
    // È la stessa regola delle immagini di profilo (`services/immagini`),
    // e sui byte è più severa di prima, non meno: una fonte che
    // dichiarasse `image/jpeg` su un file che jpeg non è, adesso non
    // passa.
    const tipo = TIPI_AMMESSI.includes(dichiarato) ? dichiarato : tipoDaiByte(dati);

    if (!tipo) {
      return res
        .status(415)
        .json({ error: `Tipo non ammesso: ${dichiarato || "non dichiarato"}` });
    }

    if (dati.length > DIMENSIONE_MASSIMA) {
      return res.status(413).json({ error: "Immagine troppo grande" });
    }

    // maxKeys fa scattare un errore quando la cache è piena: meglio
    // servire comunque l'immagine che fallire per un problema di
    // memoria interna.
    try {
      cache.set(chiave, { dati, tipo });
    } catch {
      /* cache piena: si prosegue senza memorizzare */
    }

    res.set({
      "Content-Type": tipo,
      "Cache-Control": "public, max-age=604800, immutable",
      "Access-Control-Allow-Origin": "*",
      "X-Cover-Cache": "miss"
    });

    return res.send(dati);
  } catch (err) {
    const scaduto = err.name === "TimeoutError" || err.name === "AbortError";

    return res
      .status(scaduto ? 504 : 502)
      .json({ error: scaduto ? "La fonte non ha risposto in tempo" : "Fonte irraggiungibile" });
  }
});

module.exports = router;
