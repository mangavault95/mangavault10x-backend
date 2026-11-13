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
 * (03/11/2026: legge da `uscite_manga`, non più in diretta dal calendario
 * di AnimeClick, che ha messo una verifica anti-bot: la home restava senza
 * volumi. Le uscite le scrive la ricerca di Fumettologica, vedi
 * `services/cercaUscite.js`: quella del 7 e quella settimanale.)
 *
 * Ogni uscita porta il suo `stato` rispetto a quello che avete:
 *   "prossimo"  è il volume dopo l'ultimo in casa
 *   "manca"     prima di questo ve ne mancano altri (`mancanti`)
 *   "gia"       in casa ce ne sono già abbastanza (ristampa, o conto
 *               dei posseduti più avanti del calendario)
 */
async function usciteDellaCollezione(pool, { giorni = 7 } = {}) {
  const dal = oggiInItalia();

  // «dopo» è esclusa: per avere anche oggi si parte da ieri.
  return usciteTra(pool, { dopo: piuGiorni(dal, -1), fino: piuGiorni(dal, giorni), soloMie: true });
}

/**
 * Questa uscita riguarda ancora una serie che forse avete smesso di
 * comprare? (026, 13/11/2026)
 *
 * `serie.SmessaIl` è null se la seguite, altrimenti il momento in cui
 * avete detto «non la compro più» (un Date). `uscita.data` è il giorno
 * dell'uscita come "AAAA-MM-GG". Da qui passano TUTTI: la pagina Uscite,
 * la home, il riepilogo Telegram dell'8 — anche per i mesi passati.
 *
 * Deciso da Carmine il 13/11/2026: una serie smessa sparisce da TUTTE le
 * uscite, passate e future. Restano solo i volumi in casa (nella scheda
 * e in collezione), che qui non passano. La data serve a sapere da quando,
 * non a tracciare un confine.
 */
// eslint-disable-next-line no-unused-vars
function ancoraSeguita(serie, uscita) {
  return serie.SmessaIl == null;
}

/**
 * Tiene delle uscite solo quelle che vi riguardano, nella stessa
 * edizione, e dice per ognuna a che punto siete.
 *
 * Sta a parte perché la usano due: il calendario che si legge adesso
 * (`usciteDellaCollezione`) e quello che abbiamo messo da parte negli
 * ultimi giorni (`uscite_manga`, per il riepilogo del mese e per
 * la pagina delle uscite passate). Due copie della regola
 * sull'edizione sarebbero finite per dire due cose diverse.
 */
async function abbinaAllaCollezione(pool, calendario) {
  const { rows: collezione } = await pool.query(
    `SELECT "ID", "Titolo", "Edizione", "Editore", "NumeriPosseduti", "Costo", "CoverURL", "SmessaIl" FROM "Manga"`
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
    const candidate = perTitolo.get(ossa(uscita.serie)) || [];

    const serie = candidate.find(
      (s) =>
        edizioneDi(s.Edizione) === edizioneDi(uscita.edizione) &&
        stessoEditore(s.Editore, uscita.editore)
    );

    if (!serie) continue;

    // Non la compriamo più (026): l'uscita non vi riguarda. Vedi `ancoraSeguita`.
    if (!ancoraSeguita(serie, uscita)) continue;

    // La pagina corrente e quella del mese dopo possono sovrapporsi.
    const chiave = `${serie.ID}:${uscita.numero}`;

    if (visti.has(chiave)) continue;

    visti.add(chiave);

    // Dalla 022 si sa QUALI volumi ci sono: «già tuo» è avere proprio
    // quel numero, e i mancanti sono i buchi sotto di lui — non più
    // «numero meno quanti ne hai», che per una serie sparsa sbagliava.
    const numeri = new Set((serie.NumeriPosseduti || []).map(Number));
    const posseduti = numeri.size;
    let mancanti = 0;

    for (let n = 1; n < uscita.numero; n += 1) if (!numeri.has(n)) mancanti += 1;

    risultato.push({
      data: uscita.data,
      numero: uscita.numero,
      titolo: uscita.titolo,
      editore: uscita.editore,
      copertina: uscita.copertina,
      stato: numeri.has(uscita.numero) ? "gia" : mancanti > 0 ? "manca" : "prossimo",
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

/**
 * Mette da parte il calendario di AnimeClick.
 *
 * AnimeClick mostra solo da oggi in avanti: una volta passato, un
 * volume sparisce da lì e non c'è modo di sapere che è uscito. Per
 * dire «ecco cosa è uscito dall'8 all'8» bisogna averlo scritto prima,
 * ed è quello che fa questo giro, una volta al giorno: legge la pagina
 * del mese e quella dopo e le copia in `uscite_manga`. Le righe non
 * si cancellano mai, e se una data cambia si aggiorna la stessa riga.
 *
 * Il mese scorso si prova per fortuna: se AnimeClick lo conosce
 * (`paging=prev-month`, da verificare dal server) il giro riempie anche
 * il buco prima del primo giorno; se no, ci si accontenta di quello che
 * c'è e il primo riepilogo sarà parziale.
 */
async function registraCalendario(pool, { scrivi = true } = {}) {
  const pagine = await Promise.all([
    ac.calendarioManga({ quando: null }),
    ac.calendarioManga({ quando: "next-month" }).catch(() => []),
    ac.calendarioManga({ quando: "prev-month" }).catch(() => [])
  ]);

  const [correnti, prossime, scorse] = pagine;

  // Le tre pagine si possono sovrapporre (e un «mese scorso» che
  // AnimeClick non conosce può restituire la pagina corrente): la
  // chiave le fonde, l'ultima scritta vince.
  const perChiave = new Map();

  for (const uscita of [...scorse, ...correnti, ...prossime]) {
    perChiave.set(chiaveUscita(uscita), uscita);
  }

  const righe = [...perChiave.entries()];

  const esito = {
    lette: righe.length,
    meseScorso: scorse.length,
    scritte: 0,
    scrivi
  };

  if (!scrivi || righe.length === 0) return esito;

  esito.scritte = await salvaUscite(pool, righe.map(([, u]) => u), "animeclick");

  return esito;
}

/**
 * Scrive delle uscite in `uscite_manga`, da qualunque fonte vengano.
 *
 * `fonte` si ricorda riga per riga perché le fonti non valgono lo
 * stesso: una data di AnimeClick o scritta a mano ("manuale") non si
 * lascia mai sovrascrivere da una di un'altra fonte (Fumettologica, la
 * ricerca del 7 del mese), mentre il contrario sì. Restituisce quante
 * righe sono nuove o cambiate.
 */
async function salvaUscite(pool, uscite, fonte) {
  if (uscite.length === 0) return 0;

  // Una chiave sola per riga: la stessa uscita trovata due volte conta una volta.
  const perChiave = new Map(uscite.map((u) => [chiaveUscita(u), u]));
  const righe = [...perChiave.entries()];

  const { rowCount } = await pool.query(
    `
    INSERT INTO uscite_manga (chiave, data, serie, numero, titolo, edizione, editore, copertina, fonte)
    SELECT k, d, s, n, t, e, ed, c, $9::text
      FROM UNNEST(
        $1::text[], $2::date[], $3::text[], $4::int[], $5::text[], $6::text[], $7::text[], $8::text[]
      ) AS x(k, d, s, n, t, e, ed, c)
    ON CONFLICT (chiave) DO UPDATE
       SET data = EXCLUDED.data,
           titolo = EXCLUDED.titolo,
           copertina = COALESCE(EXCLUDED.copertina, uscite_manga.copertina),
           fonte = EXCLUDED.fonte,
           aggiornata_il = NOW()
     WHERE (uscite_manga.data IS DISTINCT FROM EXCLUDED.data
            OR uscite_manga.titolo IS DISTINCT FROM EXCLUDED.titolo)
       AND (EXCLUDED.fonte = 'animeclick' OR uscite_manga.fonte NOT IN ('animeclick', 'manuale'))
    `,
    [
      righe.map(([k]) => k),
      righe.map(([, u]) => u.data),
      righe.map(([, u]) => u.serie),
      righe.map(([, u]) => u.numero),
      righe.map(([, u]) => u.titolo || null),
      righe.map(([, u]) => u.edizione || null),
      righe.map(([, u]) => u.editore || null),
      righe.map(([, u]) => u.copertina || null),
      fonte
    ]
  );

  return rowCount;
}

/** Serie, edizione, editore e numero: quello che fa di un'uscita la stessa uscita anche se la data si sposta. */
function chiaveUscita(u) {
  return [ossa(u.serie), edizioneDi(u.edizione), editoreDi(u.editore), u.numero].join("|");
}

/**
 * Le uscite messe da parte fra due date, tutte o solo le vostre.
 *
 * `dopo` esclusa e `fino` inclusa: così due finestre una dietro l'altra
 * (dall'8 all'8, poi dall'8 all'8) non contano mai due volte il giorno
 * di confine.
 *
 * Con `soloMie` restano quelle delle serie in collezione (con lo stato
 * rispetto ai volumi che avete); senza, tutte, e `serie` è null per
 * quelle che non vi riguardano.
 */
async function usciteTra(pool, { dopo, fino, soloMie = true }) {
  const { rows } = await pool.query(
    `SELECT data::text AS data, serie, numero, titolo, edizione, editore, copertina
       FROM uscite_manga
      WHERE data > $1::date AND data <= $2::date
      ORDER BY data, serie, numero`,
    [dopo, fino]
  );

  const mie = await abbinaAllaCollezione(pool, rows);

  if (soloMie) return mie;

  const miePerChiave = new Map(mie.map((m) => [`${m.data}|${ossa(m.serie.titolo)}|${m.numero}`, m]));

  return rows.map(
    (r) =>
      miePerChiave.get(`${r.data}|${ossa(r.serie)}|${r.numero}`) || {
        data: r.data,
        numero: r.numero,
        titolo: r.titolo,
        editore: r.editore,
        copertina: r.copertina,
        stato: null,
        mancanti: 0,
        // Non è in collezione: il nome della serie sta qui, e `serie`
        // (l'oggetto della collezione) manca.
        serie: null,
        serieNome: r.serie,
        edizione: r.edizione
      }
  );
}

module.exports = {
  usciteDellaCollezione,
  registraCalendario,
  salvaUscite,
  usciteTra,
  ossa,
  edizioneDi,
  editoreDi,
  stessoEditore,
  piuGiorni,
  oggiInItalia
};
