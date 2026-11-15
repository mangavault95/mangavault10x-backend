// OPAC SBN — il catalogo delle biblioteche italiane, il terzo a cui chiedere un codice a barre.
//
// Per legge una copia di ogni libro pubblicato in Italia va alle biblioteche nazionali, e SBN
// la cataloga: delle edizioni italiane dei manga ne sa più di Google Books, e soprattutto nel
// titolo scrive di solito IL NUMERO DEL VOLUME, che Google per molte serie non scrive
// («Servamp» e basta, verificato il 15/11/2026). Serve a questo (`services/isbn.js`).
//
// ⚠️ L'indirizzo è quello che usa l'app ufficiale di SBN, non un'API documentata: può cambiare
// o sparire senza avviso. Per questo: una richiesta per codice, mai in ciclo, tempo massimo
// breve, e qualsiasi errore vale «non lo so» (chi chiama va avanti senza). Il formato dei
// titoli NON è stato verificato su risposte vere quando è stato scritto (la rete da cui si
// sviluppava non raggiungeva SBN): le regole qui sotto sono prudenti apposta, e la pagina
// della scansione mostra la risposta com'è («Cosa dice il catalogo») per poterle correggere.

const FIRMA = "MangaVault/1.0";
const INDIRIZZI = ["https://opac.sbn.it/opacmobilegw/search.json", "http://opac.sbn.it/opacmobilegw/search.json"];

async function perIsbn(isbn13) {
  let ultimo = null;

  for (const base of INDIRIZZI) {
    try {
      const res = await fetch(`${base}?isbn=${encodeURIComponent(isbn13)}`, {
        headers: { "User-Agent": FIRMA, Accept: "application/json" },
        signal: AbortSignal.timeout(8000)
      });

      if (!res.ok) throw new Error(`SBN HTTP ${res.status}`);

      return daRisposta(await res.json());
    } catch (err) {
      ultimo = err;
    }
  }

  throw new Error(`SBN: ${ultimo?.message || "non risponde"}`);
}

/**
 * Il numero del volume dentro un titolo di SBN, o null. Solo forme senza ambiguità:
 *
 *   «Servamp / Tanaka Strike. 10»        il numero in fondo, dopo un punto
 *   «Servamp. 10 / Tanaka Strike»        il numero prima della barra dell'autore
 *   «10 / Tanaka Strike», «10»           il titolo È il numero (volume di un'opera in più parti)
 *   «Servamp. Vol. 10», «… n. 10»        scritto per esteso
 *
 * Un numero in mezzo al titolo («20th century boys», «Area 51 / …») non vale.
 */
function numeroNelTitolo(titolo) {
  const testo = String(titolo ?? "").replace(/\s+/g, " ").trim();
  const [prima] = testo.split(" / ");

  const forme = [
    /(?:\bvol(?:ume)?\.?|\bn\.)\s*(\d{1,3})\b/i.exec(testo),
    /^(\d{1,3})\s*(?:$|[:.]\s|\/)/.exec(testo),
    /[.:]\s*(\d{1,3})$/.exec(prima.trim()),
    /\.\s*(\d{1,3})$/.exec(testo)
  ];
  const trovato = forme.find(Boolean);
  const n = trovato ? Number(trovato[1]) : null;

  return n && n > 0 && n < 1000 ? n : null;
}

/** Da una risposta di SBN alla forma che usa la scansione. A parte per poterla provare. */
function daRisposta(risposta) {
  const record = Array.isArray(risposta?.briefRecords) ? risposta.briefRecords[0] : null;

  if (!record?.titolo) return null;

  const titolo = String(record.titolo).replace(/\s+/g, " ").trim();
  const numero = numeroNelTitolo(titolo);
  // La serie: il titolo senza l'autore (dopo « / ») e senza il numero in fondo.
  const serie = titolo
    .split(" / ")[0]
    .replace(/[.:]?\s*(?:vol(?:ume)?\.?|n\.)?\s*\d{1,3}$/i, "")
    .trim();
  // «Milano : Edizioni BD, 2018» → «Edizioni BD»
  const editore = (/:\s*([^,;]+)/.exec(String(record.pubblicazione || "")) || [])[1]?.trim() || null;

  return {
    fonte: "sbn",
    titolo,
    titoloIntero: titolo,
    // Un titolo che è solo il numero non dice la serie: chi chiama lo usa solo per il numero.
    serie: /^\d+$/.test(serie) ? "" : serie,
    numero,
    editore,
    copertina: null,
    prezzoCopertina: null,
    grezzo: {
      quanti: risposta.numFound ?? risposta.briefRecords.length,
      titolo: record.titolo,
      pubblicazione: record.pubblicazione ?? null,
      autore: record.autorePrincipale ?? null,
      livello: record.livello ?? null,
      // I campi che non conosco: se il numero sta altrove, da qui si vede dove.
      campi: Object.keys(record)
    }
  };
}

module.exports = { perIsbn, daRisposta, numeroNelTitolo };
