// services/annunci.js
//
// Decidere se il titolo di un annuncio eBay sta vendendo la SERIE
// COMPLETA o un volume solo. È la decisione che determina il prezzo
// mostrato sul sito, ed è logica pura senza rete: si verifica da sola
// con `node scripts/verifica-filtro-annunci.js`.
//
// La regola che tiene insieme tutto: i segnali NEGATIVI vengono prima
// dei positivi. Su eBay "serie completa" non descrive quasi mai
// l'oggetto in vendita — è una parola chiave che i venditori
// aggiungono ai singoli volumi per farsi trovare. Chi vende
// "Happiness vol. 3 — serie completa in 10 volumi" sta vendendo IL
// VOLUME 3 a 6 euro. Contarlo come una serie completa è ciò che
// schiacciava la mediana.

const PAROLE_COMPLETEZZA =
  /complet[ao]|integrale|cofanetto|box\s*set|serie\s+inter[ao]|tutt[ai]\s+i\s+volumi/i;

// "vol. 5", "n.5", "numero 5", "tomo 5", "#5".
//
// Il lookahead finale esclude il caso in cui quel numero APRE un
// intervallo: in "vol. 1-10" il "1" non è il volume in vendita, è
// l'inizio della serie, e la valutazione tocca al controllo
// sull'intervallo più sotto.
//
// Attenzione al ramo `n`: il confine di parola iniziale è ciò che
// impedisce di leggere "serie completa IN 10 volumi" come "n. 10".
const VOLUME_SINGOLO = /(?:\b(?:vol|volume|n|numero|tomo)\.?\s*|#\s*)(\d{1,3})(?!\s*[-/–]\s*\d)/i;

// "7 di 10", "3 su 12": il venditore dichiara quale volume è.
// Solo con le parole "di"/"su" — "1/10" con la barra vuol dire
// l'intervallo, ed è tutt'altra cosa.
const VOLUME_SU_TOTALE = /\b(\d{1,3})\s*(?:di|su)\s*(\d{1,3})\b/i;

// Annunci a varianti ("scegli il volume"): eBay ne riporta il prezzo
// della variante più economica, cioè quello di un volume singolo,
// anche quando il titolo nomina tutta la serie.
const A_SCELTA = /a\s*scelta|scegli|seleziona|singol[oi]/i;

/**
 * Tutti gli intervalli "da-a" plausibili come numeri di volume.
 *
 * Il tetto serve a buttare via il rumore: in "Planet Manga 2016-2017"
 * la ricerca di tre cifre pesca (16, 201), che non è un intervallo di
 * volumi di niente. Senza tetto quel numero passava per un lotto
 * parziale e faceva scartare l'annuncio per il motivo sbagliato.
 */
function intervalliPlausibili(titolo, volumiTotali) {
  const tetto = volumiTotali ? volumiTotali + 2 : 100;
  const trovati = [];

  for (const m of titolo.matchAll(/(\d{1,3})\s*[-/–]\s*(\d{1,3})/g)) {
    const da = Number(m[1]);
    const a = Number(m[2]);

    if (a > da && da >= 1 && a <= tetto) trovati.push({ da, a, ampiezza: a - da + 1 });
  }

  return trovati;
}

/** "10 volumi" / "in 10 vol": il numero totale scritto per esteso. */
function menzionaTotaleVolumi(titolo, volumiTotali) {
  if (!volumiTotali) return false;

  return new RegExp(`\\b${volumiTotali}\\s*(volumi|vol\\.?)\\b`, "i").test(titolo);
}

/**
 * Senza `volumiTotali` non esiste un riferimento per dire "quanti
 * volumi sono tutti", e va scelta una soglia a naso: un intervallo
 * che parte dal primo volume e ne copre almeno otto. Non è una bella
 * regola, ed è il motivo per cui `VolumiTotali` andrebbe riempito
 * in tabella per le serie in corso — vedi ROADMAP.
 */
const AMPIEZZA_MINIMA_SENZA_TOTALE = 8;

/**
 * True se l'annuncio sembra vendere la serie completa.
 *
 * Le serie non ancora finite (Hunter x Hunter) rientrano dalla stessa
 * porta: chi ha in mano tutti i volumi usciti scrive l'intervallo
 * "1-38", e con `volumiTotali` allineato all'ultimo uscito la
 * tolleranza di 2 lo accetta.
 */
function sembraSerieCompleta(titoloAnnuncio, volumiTotali) {
  const titolo = titoloAnnuncio || "";

  if (A_SCELTA.test(titolo)) return false;

  const intervalli = intervalliPlausibili(titolo, volumiTotali);

  // Un intervallo che parte dal primo volume (tolleranza: certi
  // annunci partono dal 2 perché il primo è già venduto) e arriva
  // fin quasi in fondo.
  const completo = intervalli.some(
    (i) =>
      i.da <= 2 &&
      (volumiTotali
        ? Math.abs(i.ampiezza - volumiTotali) <= 2
        : i.ampiezza >= AMPIEZZA_MINIMA_SENZA_TOTALE)
  );

  if (completo) return true;

  // C'è un intervallo di volumi, ma non copre la serie: è un lotto
  // parziale ("5-10"), e il suo prezzo non è quello della collezione.
  if (intervalli.length) return false;

  if (VOLUME_SINGOLO.test(titolo)) return false;

  const suTotale = titolo.match(VOLUME_SU_TOTALE);

  if (suTotale && Number(suTotale[1]) < Number(suTotale[2])) return false;

  if (menzionaTotaleVolumi(titolo, volumiTotali)) return true;
  if (PAROLE_COMPLETEZZA.test(titolo)) return true;

  // Restano i titoli che non dicono niente di riconoscibile. Sono
  // esclusi: sul nome di una serie eBay restituisce soprattutto
  // gadget, e includerli "nel dubbio" è ciò che rendeva la stima
  // inaffidabile proprio sui titoli con più merchandise in giro.
  return false;
}

/** True se il titolo dell'annuncio nomina esplicitamente un'altra edizione. */
function nominaEdizione(titoloAnnuncio, etichetta) {
  if (!etichetta) return false;

  return (titoloAnnuncio || "").toLowerCase().includes(etichetta.toLowerCase().trim());
}

module.exports = { sembraSerieCompleta, nominaEdizione };
