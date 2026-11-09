// services/concludeDaAniList.js
//
// La seconda fonte per «questa serie è conclusa anche in Italia», per quando
// AnimeClick non si lascia leggere. Non legge lo stato italiano (nessun sito
// raggiungibile lo pubblica come dato), lo DEDUCE da due numeri affidabili:
//
//   1. AniList dice che l'opera originale è FINITA e di quanti volumi è;
//   2. in Italia è già uscito quel volume o uno oltre.
//
// Se i due numeri COMBACIANO, l'edizione italiana ha pubblicato l'ultimo volume
// che esiste: è conclusa. Se l'opera è finita ma in Italia mancano volumi,
// è ancora in corso da noi e non si tocca.
//
// Dove AniList non indica il totale dei volumi (quasi sempre, anche per le
// serie finite) non si può dire niente, e si lascia com'è.

const { search } = require("./providers/anilist");

const nomi = (testo) =>
  String(testo || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((p) => p.length > 2);

/** Almeno una parola del nome in comune: «Fuse» e «Fuse, Taiki Kawakami», «Urasawa Naoki» e «Naoki Urasawa». */
function stessoAutore(a, b) {
  const x = new Set(nomi(a));

  return nomi(b).some((p) => x.has(p));
}

async function cercaConRiprova(titolo, autore) {
  try {
    return await search(titolo, autore);
  } catch (e) {
    // AniList limita le richieste al minuto: una riprova dopo una pausa basta.
    if (!/429/.test(e.message)) throw e;
    await new Promise((x) => setTimeout(x, 6000));

    return search(titolo, autore);
  }
}

/**
 * @returns {{ conclusa: boolean, motivo: string }}
 */
async function concludeSecondoAniList(riga, ultimoVolume, { cerca = cercaConRiprova } = {}) {
  if (!ultimoVolume) return { conclusa: false, motivo: "non si sa l'ultimo volume uscito in Italia" };

  const trovata = await cerca(String(riga.Titolo).trim(), riga.Autore);

  if (!trovata) return { conclusa: false, motivo: "AniList non la trova" };

  // Senza l'autore a confermare, «Monster» o «Happy!» potrebbero essere un'altra opera.
  if (riga.Autore && !stessoAutore(riga.Autore, `${trovata.autore || ""} ${trovata.disegnatore || ""}`)) {
    return { conclusa: false, motivo: "l'autore su AniList non coincide" };
  }

  if (trovata.statoSerie !== "conclusa") return { conclusa: false, motivo: "su AniList non è finita" };
  if (!trovata.volumitotali) return { conclusa: false, motivo: "AniList non indica il totale dei volumi" };
  if (ultimoVolume < trovata.volumitotali) {
    return { conclusa: false, motivo: `in Italia sono usciti ${ultimoVolume} volumi su ${trovata.volumitotali}` };
  }

  // Più volumi in Italia che nell'originale: o un'edizione diversa o dei
  // volumi extra. Può essere conclusa, ma non lo si decide da due numeri
  // che non combaciano: lo guarda una persona.
  if (ultimoVolume > trovata.volumitotali) {
    return {
      conclusa: false,
      motivo: `da controllare a mano: in Italia ${ultimoVolume} volumi, ma l'originale su AniList ne ha ${trovata.volumitotali}`
    };
  }

  return {
    conclusa: true,
    motivo: `finita su AniList in ${trovata.volumitotali} volumi, in Italia usciti ${ultimoVolume}`
  };
}

module.exports = { concludeSecondoAniList, stessoAutore };
