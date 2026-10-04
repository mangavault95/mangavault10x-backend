/**
 * I volumi che escono e che vi riguardano.
 *
 * Legge il calendario manga di AnimeClick (`calendarioManga`) e tiene
 * solo le uscite delle serie che sono in collezione, NELLA STESSA
 * EDIZIONE. È la regola che conta: di One Piece in casa c'è la New
 * Edition, e il 114 normale o la Limited non sono affari vostri.
 * Verificato sul calendario del 04/10/2026, dove One Piece usciva in
 * due edizioni lo stesso giorno e nessuna delle due era quella giusta.
 *
 * Il calendario si legge al massimo ogni sei ore: cambia di rado, e la
 * home lo chiede a ogni apertura.
 */

const NodeCache = require("node-cache");
const ac = require("./providers/animeclickAnime");

const cache = new NodeCache({ stdTTL: 60 * 60 * 6, maxKeys: 10 });

/** Solo lettere e cifre: «DanDaDan» e «Dandadan», «J-POP» e «JPOP» si equivalgono. */
function ossa(testo) {
  return String(testo || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, "");
}

/**
 * L'edizione ridotta al suo nome. «Deluxe» e «Deluxe Edition» sono la
 * stessa cosa scritta da due persone diverse; il vuoto e `null` sono
 * entrambi l'edizione normale.
 */
function edizioneDi(testo) {
  return ossa(String(testo || "").replace(/\b(edition|edizione)\b/gi, ""));
}

/** «Panini Comics» e «Panini», «Flashbook Edizioni» e «Flashbook». */
function editoreDi(testo) {
  return ossa(String(testo || "").replace(/\b(comics|edizioni|edizione|editore|srl)\b/gi, ""));
}

function stessoEditore(a, b) {
  const x = editoreDi(a);
  const y = editoreDi(b);

  // Uno dei due non lo sa: l'editore non è una prova contro.
  if (!x || !y) return true;

  return x === y || x.includes(y) || y.includes(x);
}

/** Il giorno di oggi a Roma, come "AAAA-MM-GG". */
function oggiInItalia() {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Rome" }).format(new Date());
}

function piuGiorni(giorno, n) {
  const d = new Date(`${giorno}T12:00:00Z`);

  d.setUTCDate(d.getUTCDate() + n);

  return d.toISOString().slice(0, 10);
}

async function paginaCalendario(quando) {
  const chiave = quando || "corrente";
  const inCache = cache.get(chiave);

  if (inCache) return inCache;

  const uscite = await ac.calendarioManga({ quando });

  cache.set(chiave, uscite);

  return uscite;
}

/**
 * Le uscite dei prossimi `giorni` per le serie della collezione.
 *
 * Ogni uscita porta il suo `stato` rispetto a quello che avete:
 *   "prossimo"  è il volume dopo l'ultimo in casa
 *   "manca"     prima di questo ve ne mancano altri (`mancanti`)
 *   "gia"       in casa ce ne sono già abbastanza (ristampa, o conto
 *               dei posseduti più avanti del calendario)
 */
async function usciteDellaCollezione(pool, { giorni = 7 } = {}) {
  const dal = oggiInItalia();
  const al = piuGiorni(dal, giorni);

  // La pagina corrente va da oggi a fine mese; se la finestra scavalca
  // il mese, serve anche quella dopo. Un intoppo sulla seconda non deve
  // costare la prima.
  const pagine = [paginaCalendario(null)];

  if (al.slice(0, 7) !== dal.slice(0, 7)) {
    pagine.push(paginaCalendario("next-month").catch(() => []));
  }

  const calendario = (await Promise.all(pagine)).flat();

  const { rows: collezione } = await pool.query(
    `SELECT "ID", "Titolo", "Edizione", "Editore", "VolumiPosseduti", "Costo", "CoverURL" FROM "Manga"`
  );

  const perTitolo = new Map();

  for (const serie of collezione) {
    const chiave = ossa(serie.Titolo);

    if (!perTitolo.has(chiave)) perTitolo.set(chiave, []);

    perTitolo.get(chiave).push(serie);
  }

  const visti = new Set();
  const risultato = [];

  for (const uscita of calendario) {
    if (uscita.data < dal || uscita.data > al) continue;

    const candidate = perTitolo.get(ossa(uscita.serie)) || [];

    const serie = candidate.find(
      (s) =>
        edizioneDi(s.Edizione) === edizioneDi(uscita.edizione) &&
        stessoEditore(s.Editore, uscita.editore)
    );

    if (!serie) continue;

    // La pagina corrente e quella del mese dopo possono sovrapporsi.
    const chiave = `${serie.ID}:${uscita.numero}`;

    if (visti.has(chiave)) continue;

    visti.add(chiave);

    const posseduti = Number(serie.VolumiPosseduti) || 0;
    const mancanti = Math.max(0, uscita.numero - posseduti - 1);

    risultato.push({
      data: uscita.data,
      numero: uscita.numero,
      titolo: uscita.titolo,
      editore: uscita.editore,
      copertina: uscita.copertina,
      stato: posseduti >= uscita.numero ? "gia" : mancanti > 0 ? "manca" : "prossimo",
      mancanti,
      serie: {
        id: Number(serie.ID),
        titolo: serie.Titolo,
        edizione: serie.Edizione || null,
        posseduti,
        // Il calendario non scrive il prezzo: quello della scheda è la
        // stima migliore che abbiamo, e si dice che è una stima.
        prezzo_stimato: serie.Costo == null ? null : Number(serie.Costo),
        copertina: serie.CoverURL || null
      }
    });
  }

  return risultato.sort((a, b) => a.data.localeCompare(b.data));
}

module.exports = { usciteDellaCollezione, edizioneDi, editoreDi, stessoEditore };
