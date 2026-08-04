// services/volumiItaliani.js
//
// Le regole con cui si aggiorna "VolumiItalia" per le serie in corso.
// Chi va a leggere il numero è services/providers/animeclick.js: qui
// c'è solo la decisione, che è la parte da non sbagliare.
//
// Perché una colonna a parte da "VolumiTotali": quella è (o dovrebbe
// essere) il totale in Giappone, da AniList — e AniList non lo
// pubblica finché la serie è in corso (`volumes: null`,
// `status: RELEASING`), quindi 28 serie su 34 in corso ce l'hanno
// vuoto. "VolumiItalia" risponde a una domanda diversa: quanti ne ha
// pubblicati l'editore italiano finora, l'unico numero sensato per
// dire se manca qualcosa da comprare. Google Books è stato provato e
// scartato come fonte: rispondeva numeri diversi a pochi minuti di
// distanza sulle stesse serie.

const { volumiUsciti } = require("./providers/animeclick");

/**
 * Cosa fare del numero trovato. Le tre regole sono di Carmine, e
 * ognuna nasce da un modo concreto di rovinare i dati:
 *
 * 1. **Non scende mai.** Se un giorno la fonte perde gli ultimi
 *    volumi, il job non deve disfare un dato buono. Il pavimento
 *    tiene conto anche dei volumi posseduti: quelli sono una prova
 *    concreta che esistono, li hai in mano.
 * 2. **Solo le serie in corso.** Le concluse il totale ce l'hanno già
 *    da AniList ed è quello definitivo: non si tocca.
 * 3. **Solo l'edizione giusta** — se ne occupa il provider, che
 *    scarta ristampe ed edizioni sorelle prima di contare.
 */
function decidiAggiornamento({ attuale, posseduti, trovato, statoSerie }) {
  if (statoSerie !== "in_corso") return { azione: "saltata", motivo: "non è in corso" };
  if (trovato == null) return { azione: "niente", motivo: "nessun volume trovato" };

  // I volumi posseduti NON sono il pavimento del "non scende mai":
  // sono un controllo di sanità. Se la fonte ne conta meno di quanti
  // ne ho in mano, è lei a essere indietro — o è la scheda sbagliata.
  if (posseduti && trovato < posseduti) {
    return {
      azione: "niente",
      motivo: `la fonte ne conta ${trovato} ma ne possiedi ${posseduti}: non mi fido`
    };
  }

  // Il pavimento vero è il totale già scritto. Tenerlo separato dai
  // posseduti è ciò che permette di riempire una casella VUOTA quando
  // la fonte conferma esattamente i volumi posseduti — il caso di
  // Hunter x Hunter (38 e 38), cioè proprio quello da cui siamo
  // partiti. Confondere le due cose lasciava il campo a NULL.
  if (attuale != null && trovato <= attuale) {
    return {
      azione: "niente",
      motivo:
        trovato === attuale
          ? `già a ${trovato}`
          : `trovato ${trovato} ≤ ${attuale} già scritto (il numero non scende mai)`
    };
  }

  // Nessun tetto al salto: un divario grande vuol dire quasi sempre
  // che Carmine è rimasto indietro con gli acquisti, non che l'aggancio
  // è sbagliato — su Vita da slime sono 14 volumi di scarto ed è
  // corretto. A guardia dell'identità della serie c'è l'AnimeClickID,
  // verificato una volta a mano, e la sequenza dei volumi: se i numeri
  // non partono da 1 senza buchi, `controllaSerie` ferma comunque la
  // scrittura.
  return { azione: "scrivi", valore: trovato, motivo: `da ${attuale ?? "vuoto"} a ${trovato}` };
}

/**
 * Controlla una riga della tabella e dice cosa andrebbe fatto, senza
 * fare niente. Chi scrive davvero è chi chiama.
 */
async function controllaSerie(riga, opzioni = {}) {
  const animeClickId = riga.AnimeClickID;

  if (!animeClickId) {
    return { esito: null, decisione: { azione: "non_mappata", motivo: "manca AnimeClickID" } };
  }

  let esito;

  try {
    esito = await volumiUsciti(animeClickId, { edizione: riga.Edizione || null, ...opzioni });
  } catch (e) {
    return { esito: null, decisione: { azione: "errore", motivo: e.message } };
  }

  const decisione = decidiAggiornamento({
    attuale: riga.VolumiItalia ?? null,
    posseduti: Number(riga.VolumiPosseduti) || 0,
    trovato: esito.massimo,
    statoSerie: riga.StatoSerie
  });

  // Una sequenza con dei buchi non invalida il massimo, ma vale la
  // pena dirlo: se mancano metà dei numeri, quella scheda è da
  // guardare prima di fidarsene.
  if (decisione.azione === "scrivi" && !esito.completo && esito.mancanti.length > 2) {
    return {
      esito,
      decisione: {
        azione: "da_controllare",
        valore: esito.massimo,
        motivo: `${decisione.motivo}, ma mancano i volumi ${esito.mancanti.slice(0, 8).join(",")}`
      }
    };
  }

  return { esito, decisione };
}

module.exports = { decidiAggiornamento, controllaSerie };
