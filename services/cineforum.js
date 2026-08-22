/**
 * IL CINEFORUM — cosa hanno fatto tutti, in una pagina sola.
 *
 * Non c'è nessuno da seguire e nessuno da accettare: siete quattro,
 * vi conoscete, e un bottone «segui» fra persone che vivono nella
 * stessa casa sarebbe cerimonia inutile. Chi entra vede tutto.
 *
 * ---------------------------------------------------------------
 * IL FEED NON È UNA TABELLA
 *
 * Nessun evento viene scritto da nessuna parte: il feed si CALCOLA
 * ogni volta dalle date che le tabelle della videoteca hanno già —
 * `visioni.creata_il`, `episodi_visti.visto_il`, `visioni.finita_il`,
 * `voti_anime.aggiornato_il`, `note_anime.creata_il`. Il perché sta
 * per esteso in `sql/016_cineforum.sql`; in due righe: una tabella di
 * eventi sarebbe una seconda verità da tenere allineata alla prima, e
 * il Cineforum si sarebbe aperto vuoto invece che pieno di tutto
 * quello che è già successo.
 *
 * Quello che il database conserva davvero è solo ciò che non si
 * ricava: i messaggi scritti a mano, i cuori e le risposte.
 *
 * ---------------------------------------------------------------
 * DUE SPECIE DI POST, UNA SOLA CHIAVE
 *
 *   messaggio:<id>                 quello che qualcuno ha scritto
 *   giornata:<utente>:<AAAA-MM-GG> tutto quello che ha fatto in un giorno
 *
 * Una giornata sola per persona, non una per tipo di evento: due
 * serie aggiunte, quattro puntate e un voto nello stesso martedì sono
 * UN post con dentro tre paragrafi, non tre post. La pagina resta
 * leggibile anche quando qualcuno passa una domenica intera davanti
 * allo schermo.
 *
 * ---------------------------------------------------------------
 * IL GIORNO È QUELLO ITALIANO
 *
 * Ogni taglio passa da `AT TIME ZONE 'Europe/Rome'`. Una puntata
 * spuntata alle 23:30 appartiene alla sera in cui l'hai vista, non al
 * giorno dopo — e tagliare su UTC farebbe cadere il confine in un
 * punto diverso fra inverno ed estate, cioè post che cambiano giorno
 * quando cambia l'ora legale.
 */

// Il fuso in cui si vive, scritto una volta sola: comparirebbe in
// undici punti diversi, e undici stringhe uguali sono dieci occasioni
// di scriverne una sbagliata.
const FUSO = "Europe/Rome";
const GIORNO_DI = (colonna) => `(${colonna} AT TIME ZONE '${FUSO}')::date`;

// Quanti post per pagina. Quindici è circa due schermate di telefono:
// abbastanza da non premere «ancora» subito, poco da non far
// aspettare Render mentre si sveglia.
const QUANTI = 15;
const QUANTI_MAX = 50;

// Il giorno esce da Postgres già scritto, non come data.
//
// ⚠️  Questa riga costa un'ora di caccia se la si toglie. Un `date`
// consegnato dal driver diventa un oggetto Date a MEZZANOTTE LOCALE:
// per chi sta a Roma d'estate, quella mezzanotte in UTC è le 22 del
// giorno prima. Leggendola con `getUTCDate()` — la lettura che sembra
// più sicura, perché "non dipende dal fuso" — ogni giornata scalava
// indietro di uno. Effetto visto sui dati veri: il post di oggi si
// chiamava «ieri» e usciva VUOTO, perché il dettaglio veniva poi
// chiesto per un giorno in cui non era successo niente, mentre gli
// eventi di ieri finivano appesi al post dell'altro ieri.
//
// Si può risolvere in tre modi: leggere con i getter locali (giusto
// finché il server non viene spostato di fuso), registrare un parser
// di tipo in pg (agisce su tutto il sito per una cosa che riguarda
// una query), oppure non far mai diventare quella data un oggetto
// Date. Il terzo non ha casi limite.
const GIORNO_SCRITTO = (espressione) => `to_char(${espressione}, 'YYYY-MM-DD')`;

/**
 * La data come chiave: `2026-08-22`.
 *
 * Arriva già come testo da tutte le query di qui (vedi
 * `GIORNO_SCRITTO`). Il ramo con la Date resta come rete per chi
 * riuserà questa funzione altrove, e usa i getter LOCALI proprio per
 * la ragione scritta qui sopra.
 */
function comeGiorno(valore) {
  if (typeof valore === "string") return valore.slice(0, 10);

  const d = new Date(valore);

  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0")
  ].join("-");
}

const chiaveGiornata = (utenteId, giorno) => `giornata:${Number(utenteId)}:${comeGiorno(giorno)}`;

/**
 * Una chiave scritta da un browser è testo che arriva da fuori.
 *
 * Vale il vincolo che sta anche nel database (016): due controlli
 * sulla stessa cosa non sono uno di troppo — quello di qui dà un
 * messaggio comprensibile, quello di là impedisce che una strada che
 * non ho previsto scriva righe appese al nulla.
 */
const FORMA_CHIAVE = /^(messaggio:[0-9]+|giornata:[0-9]+:\d{4}-\d{2}-\d{2})$/;

function chiaveValida(grezza) {
  const chiave = String(grezza || "");

  return FORMA_CHIAVE.test(chiave) ? chiave : null;
}

/* ==================================================
   IL FEED
   ================================================== */

/**
 * Le giornate e i messaggi, mescolati e ordinati nel tempo.
 *
 * `prima` è la paginazione: si chiede "quello che viene prima di
 * questo istante" invece di "la pagina numero 3", perché fra una
 * pagina e l'altra qualcuno può spuntare una puntata — e con le
 * pagine numerate quel post farebbe scalare tutti gli altri di uno,
 * facendo comparire due volte lo stesso contenuto.
 */
async function pagina(pool, { prima = null, quanti = QUANTI, utenteId = null } = {}) {
  const limite = Math.min(Math.max(Number(quanti) || QUANTI, 1), QUANTI_MAX);

  // Una riga per evento, ridotta all'osso: chi, che giorno, quando.
  // Il dettaglio (quale serie, quale puntata) si chiede dopo e solo
  // per le giornate che entrano davvero in pagina — su una videoteca
  // di ottantuno serie e migliaia di spunte, tirarsi dietro i titoli
  // qui dentro vorrebbe dire ordinare tutto per buttarne via il 95%.
  const { rows } = await pool.query(
    `
    WITH eventi AS (
      SELECT utente_id, ${GIORNO_DI("creata_il")}    AS giorno, creata_il     AS quando FROM visioni
      UNION ALL
      SELECT utente_id, ${GIORNO_DI("visto_il")},              visto_il               FROM episodi_visti
      UNION ALL
      SELECT utente_id, ${GIORNO_DI("finita_il")},             finita_il
        FROM visioni WHERE finita_il IS NOT NULL
      UNION ALL
      SELECT utente_id, ${GIORNO_DI("aggiornato_il")},         aggiornato_il          FROM voti_anime
      UNION ALL
      SELECT utente_id, ${GIORNO_DI("creata_il")},             creata_il              FROM note_anime
    ),
    giornate AS (
      SELECT utente_id, giorno, MAX(quando) AS quando
        FROM eventi
       GROUP BY utente_id, giorno
    ),
    tutto AS (
      SELECT 'giornata'::text AS tipo, utente_id, giorno, quando, NULL::bigint AS id
        FROM giornate
      UNION ALL
      SELECT 'messaggio', utente_id, ${GIORNO_DI("creato_il")}, creato_il, id
        FROM cineforum_messaggi
    )
    SELECT t.tipo, t.utente_id, ${GIORNO_SCRITTO("t.giorno")} AS giorno, t.quando, t.id,
           u.nickname, u.colore, u.proprietario
      FROM tutto t
      JOIN utenti u ON u.id = t.utente_id
     WHERE ($1::timestamptz IS NULL OR t.quando < $1)
       AND ($2::bigint IS NULL OR t.utente_id = $2)
     ORDER BY t.quando DESC
     LIMIT $3
    `,
    [prima, utenteId, limite + 1]
  );

  // Una riga in più del dovuto: è il modo più corto di sapere se
  // esiste una pagina successiva senza contare l'intero feed.
  const ancora = rows.length > limite;
  const righe = ancora ? rows.slice(0, limite) : rows;

  return { righe, ancora };
}

/**
 * Il dettaglio delle giornate in pagina.
 *
 * Cinque letture, una per tipo di evento, tutte agganciate alle
 * stesse coppie (persona, giorno) tramite `unnest` di due array
 * paralleli. È il modo di dire a Postgres "solo queste quindici
 * giornate" senza costruire una condizione lunga quanto la pagina.
 */
async function dettaglioGiornate(pool, giornate) {
  const vuoto = { aggiunte: [], episodi: [], finite: [], voti: [], commenti: [] };

  if (giornate.length === 0) return vuoto;

  const utenti = giornate.map((g) => g.utente_id);
  const giorni = giornate.map((g) => comeGiorno(g.giorno));
  const param = [utenti, giorni];

  // Il gruppo viaggia con ogni riga: Frieren stagione 1 e stagione 2
  // sono due schede, e un post che dice "ha aggiunto Frieren e
  // Frieren" sembra un errore. Chi mostra il post le accorpa.
  const ANAGRAFICA = `
    a.id, a.titolo, a.cover_url, a.tipo, a.anno_inizio,
    a.gruppo_id, g.titolo AS gruppo_titolo
  `;

  const AGGANCIO = (colonna, tabella) => `
    JOIN unnest($1::bigint[], $2::date[]) AS q(utente_id, giorno)
      ON q.utente_id = ${tabella}.utente_id
     AND q.giorno = ${GIORNO_DI(colonna)}
  `;

  const [aggiunte, episodi, finite, voti, commenti] = await Promise.all([
    pool.query(
      `
      SELECT vis.utente_id, ${GIORNO_SCRITTO(GIORNO_DI("vis.creata_il"))} AS giorno, vis.creata_il AS quando,
             vis.stato, ${ANAGRAFICA}
        FROM visioni vis
        JOIN anime a ON a.id = vis.anime_id
        LEFT JOIN anime_gruppi g ON g.id = a.gruppo_id
        ${AGGANCIO("vis.creata_il", "vis")}
       ORDER BY vis.creata_il
      `,
      param
    ),

    // Le puntate della stessa serie nello stesso giorno stanno su una
    // riga: «4 episodi di Frieren», non quattro righe uguali.
    pool.query(
      `
      SELECT ev.utente_id, ${GIORNO_SCRITTO(GIORNO_DI("ev.visto_il"))} AS giorno,
             MAX(ev.visto_il) AS quando,
             array_agg(ev.numero ORDER BY ev.numero) AS numeri,
             ${ANAGRAFICA}
        FROM episodi_visti ev
        JOIN anime a ON a.id = ev.anime_id
        LEFT JOIN anime_gruppi g ON g.id = a.gruppo_id
        ${AGGANCIO("ev.visto_il", "ev")}
       GROUP BY ev.utente_id, ${GIORNO_DI("ev.visto_il")},
                a.id, a.titolo, a.cover_url, a.tipo, a.anno_inizio, a.gruppo_id, g.titolo
       ORDER BY MAX(ev.visto_il)
      `,
      param
    ),

    // Finire una serie è l'evento che merita più spazio di tutti: è
    // il momento in cui uno ha qualcosa da dire.
    pool.query(
      `
      SELECT vis.utente_id, ${GIORNO_SCRITTO(GIORNO_DI("vis.finita_il"))} AS giorno, vis.finita_il AS quando,
             (SELECT vo.voto FROM voti_anime vo
               WHERE vo.anime_id = a.id AND vo.utente_id = vis.utente_id) AS voto,
             ${ANAGRAFICA}
        FROM visioni vis
        JOIN anime a ON a.id = vis.anime_id
        LEFT JOIN anime_gruppi g ON g.id = a.gruppo_id
        ${AGGANCIO("vis.finita_il", "vis")}
       WHERE vis.finita_il IS NOT NULL
       ORDER BY vis.finita_il
      `,
      param
    ),

    pool.query(
      `
      SELECT vo.utente_id, ${GIORNO_SCRITTO(GIORNO_DI("vo.aggiornato_il"))} AS giorno,
             vo.aggiornato_il AS quando, vo.voto, ${ANAGRAFICA}
        FROM voti_anime vo
        JOIN anime a ON a.id = vo.anime_id
        LEFT JOIN anime_gruppi g ON g.id = a.gruppo_id
        ${AGGANCIO("vo.aggiornato_il", "vo")}
       ORDER BY vo.aggiornato_il
      `,
      param
    ),

    // Il commento va nel feed in chiaro: è l'unico evento che ha
    // qualcosa da leggere dentro, e nasconderlo dietro «ha commentato
    // Frieren» costringerebbe ad aprire una scheda per sapere cosa.
    // Lo spoiler resta coperto — la copertura la mette chi mostra.
    pool.query(
      `
      SELECT n.utente_id, ${GIORNO_SCRITTO(GIORNO_DI("n.creata_il"))} AS giorno, n.creata_il AS quando,
             n.id AS nota_id, n.testo, n.spoiler, n.numero_episodio,
             (SELECT e.titolo FROM anime_episodi e
               WHERE e.anime_id = a.id AND e.numero = n.numero_episodio) AS titolo_episodio,
             ${ANAGRAFICA}
        FROM note_anime n
        JOIN anime a ON a.id = n.anime_id
        LEFT JOIN anime_gruppi g ON g.id = a.gruppo_id
        ${AGGANCIO("n.creata_il", "n")}
       ORDER BY n.creata_il
      `,
      param
    )
  ]);

  return {
    aggiunte: aggiunte.rows,
    episodi: episodi.rows,
    finite: finite.rows,
    voti: voti.rows,
    commenti: commenti.rows
  };
}

/** Cuori e risposte di tutti i post in pagina, in due letture sole. */
async function reazioni(pool, chiavi, chiGuarda) {
  if (chiavi.length === 0) return { cuori: new Map(), risposte: new Map() };

  const [c, r] = await Promise.all([
    pool.query(
      `
      SELECT k.chiave, u.id, u.nickname, u.colore
        FROM cineforum_cuori k
        JOIN utenti u ON u.id = k.utente_id
       WHERE k.chiave = ANY($1::text[])
       ORDER BY k.messo_il
      `,
      [chiavi]
    ),
    pool.query(
      `
      SELECT r.id, r.chiave, r.testo, r.creata_il, r.modificata_il,
             u.id AS utente_id, u.nickname, u.colore
        FROM cineforum_risposte r
        JOIN utenti u ON u.id = r.utente_id
       WHERE r.chiave = ANY($1::text[])
       ORDER BY r.creata_il
      `,
      [chiavi]
    )
  ]);

  const cuori = new Map();

  for (const riga of c.rows) {
    if (!cuori.has(riga.chiave)) cuori.set(riga.chiave, { chi: [], mio: false });

    const voce = cuori.get(riga.chiave);

    voce.chi.push({ id: Number(riga.id), nickname: riga.nickname, colore: riga.colore });

    if (chiGuarda && Number(riga.id) === Number(chiGuarda)) voce.mio = true;
  }

  const risposte = new Map();

  for (const riga of r.rows) {
    if (!risposte.has(riga.chiave)) risposte.set(riga.chiave, []);

    risposte.get(riga.chiave).push({
      id: Number(riga.id),
      testo: riga.testo,
      creata_il: riga.creata_il,
      modificata_il: riga.modificata_il,
      utente: {
        id: Number(riga.utente_id),
        nickname: riga.nickname,
        colore: riga.colore
      }
    });
  }

  return { cuori, risposte };
}

/**
 * Il feed, pronto da mostrare.
 *
 * `chiGuarda` serve a una cosa sola: sapere se il cuore è già tuo.
 * Non filtra niente — qui si vede tutto di tutti, che è il punto.
 */
async function feed(pool, { prima = null, quanti = QUANTI, utenteId = null, chiGuarda = null } = {}) {
  const { righe, ancora } = await pagina(pool, { prima, quanti, utenteId });

  const giornate = righe.filter((r) => r.tipo === "giornata");
  const messaggi = righe.filter((r) => r.tipo === "messaggio");

  const [dettaglio, animeDeiMessaggi] = await Promise.all([
    dettaglioGiornate(pool, giornate),
    schedeDeiMessaggi(pool, messaggi.map((m) => Number(m.id)))
  ]);

  // Ogni evento va nella sua giornata. La mappa si costruisce una
  // volta: cercare l'evento giusto scorrendo cinque array per ognuno
  // dei quindici post sarebbe lo stesso lavoro fatto quindici volte.
  const per = new Map();

  for (const g of giornate) {
    per.set(chiaveGiornata(g.utente_id, g.giorno), {
      aggiunte: [],
      episodi: [],
      finite: [],
      voti: [],
      commenti: []
    });
  }

  for (const [nome, righeEvento] of Object.entries(dettaglio)) {
    for (const riga of righeEvento) {
      const voce = per.get(chiaveGiornata(riga.utente_id, riga.giorno));

      if (voce) voce[nome].push(riga);
    }
  }

  const chiavi = righe.map((r) =>
    r.tipo === "messaggio" ? `messaggio:${r.id}` : chiaveGiornata(r.utente_id, r.giorno)
  );

  const { cuori, risposte } = await reazioni(pool, chiavi, chiGuarda);

  const post = righe.map((r, indice) => {
    const chiave = chiavi[indice];

    const comune = {
      chiave,
      tipo: r.tipo,
      quando: r.quando,
      giorno: comeGiorno(r.giorno),
      utente: {
        id: Number(r.utente_id),
        nickname: r.nickname,
        colore: r.colore,
        proprietario: Boolean(r.proprietario)
      },
      cuori: cuori.get(chiave)?.chi ?? [],
      cuorMio: cuori.get(chiave)?.mio ?? false,
      risposte: risposte.get(chiave) ?? []
    };

    if (r.tipo === "messaggio") {
      const scheda = animeDeiMessaggi.get(Number(r.id));

      return { ...comune, id: Number(r.id), testo: scheda?.testo ?? "", anime: scheda?.anime ?? null,
               modificato_il: scheda?.modificato_il ?? null };
    }

    return { ...comune, eventi: per.get(chiave) };
  });

  return {
    post,
    ancora,
    // L'istante da cui riprendere. Va restituito e non ricalcolato dal
    // browser: due post possono avere lo stesso millisecondo, e
    // riprendere da «l'ultimo che ho visto» li salterebbe.
    prossimo: ancora ? righe[righe.length - 1].quando : null
  };
}

/** Il testo dei messaggi in pagina e la serie a cui sono agganciati. */
async function schedeDeiMessaggi(pool, ids) {
  const mappa = new Map();

  if (ids.length === 0) return mappa;

  const { rows } = await pool.query(
    `
    SELECT m.id, m.testo, m.modificato_il,
           a.id AS anime_id, a.titolo, a.cover_url, a.tipo,
           a.gruppo_id, g.titolo AS gruppo_titolo
      FROM cineforum_messaggi m
      LEFT JOIN anime a ON a.id = m.anime_id
      LEFT JOIN anime_gruppi g ON g.id = a.gruppo_id
     WHERE m.id = ANY($1::bigint[])
    `,
    [ids]
  );

  for (const r of rows) {
    mappa.set(Number(r.id), {
      testo: r.testo,
      modificato_il: r.modificato_il,
      anime: r.anime_id
        ? {
            id: Number(r.anime_id),
            titolo: r.gruppo_titolo || r.titolo,
            cover_url: r.cover_url,
            tipo: r.tipo
          }
        : null
    });
  }

  return mappa;
}

/* ==================================================
   I NUMERI DI UNA PERSONA
   ================================================== */

/**
 * Le statistiche di chi si sta guardando.
 *
 * Le stesse che compaiono in cima alla pagina personale e le stesse
 * che il confronto mette una accanto all'altra: un conto solo, o i
 * due schermi direbbero due numeri diversi per la stessa cosa.
 *
 * SULLE SERIE: si contano i GRUPPI, non le schede. Frieren è una
 * scheda con due stagioni e Isekai Farming due schede con una serie
 * sola: contare le righe darebbe a due persone con la stessa
 * videoteca due numeri diversi a seconda di come AnimeClick ha
 * catalogato le loro serie.
 *
 * SULLE ORE: la durata vera dell'episodio quando c'è, altrimenti la
 * media della serie, altrimenti ventiquattro minuti — che è la durata
 * di un episodio televisivo standard senza sigle. Un'ora sbagliata di
 * poco è meglio di un buco.
 */
async function statistiche(pool, utenteId) {
  const id = Number(utenteId);

  const [base, minuti, generi, tempo] = await Promise.all([
    pool.query(
      `
      SELECT
        COUNT(DISTINCT COALESCE('g' || a.gruppo_id, 'a' || a.id))                   AS serie,
        COUNT(*) FILTER (WHERE a.tipo = 'film')                                     AS film,
        COUNT(*) FILTER (WHERE vis.stato = 'in_visione')                            AS in_visione,
        COUNT(*) FILTER (WHERE vis.stato = 'completa')                              AS finite,
        COUNT(*) FILTER (WHERE vis.stato = 'da_vedere')                             AS da_vedere,
        COUNT(*) FILTER (WHERE vis.stato = 'in_pausa')                              AS in_pausa,
        COUNT(*) FILTER (WHERE vis.stato = 'droppata')                              AS droppate,
        (SELECT COUNT(*)         FROM episodi_visti ev WHERE ev.utente_id = $1)     AS episodi,
        (SELECT COUNT(*)         FROM voti_anime vo    WHERE vo.utente_id = $1)     AS votate,
        (SELECT ROUND(AVG(vo.voto), 2) FROM voti_anime vo WHERE vo.utente_id = $1)  AS voto_medio,
        (SELECT COUNT(*)         FROM note_anime n     WHERE n.utente_id = $1)      AS commenti,
        (SELECT COUNT(*)         FROM anime_preferiti p WHERE p.utente_id = $1)     AS preferiti
      FROM visioni vis
      JOIN anime a ON a.id = vis.anime_id
      WHERE vis.utente_id = $1
      `,
      [id]
    ),

    pool.query(
      `
      SELECT COALESCE(SUM(COALESCE(e.durata, a.durata_media, 24)), 0) AS minuti
        FROM episodi_visti ev
        JOIN anime a ON a.id = ev.anime_id
        LEFT JOIN anime_episodi e ON e.anime_id = ev.anime_id AND e.numero = ev.numero
       WHERE ev.utente_id = $1
      `,
      [id]
    ),

    // I generi si contano sulle serie in videoteca e non sulle
    // puntate: chi ha visto novecento episodi di One Piece non è
    // «uno che guarda solo avventura».
    pool.query(
      `
      SELECT genere, COUNT(*)::int AS quante
        FROM visioni vis
        JOIN anime a ON a.id = vis.anime_id
        CROSS JOIN LATERAL unnest(a.generi) AS genere
       WHERE vis.utente_id = $1
       GROUP BY genere
       ORDER BY quante DESC, genere
       LIMIT 8
      `,
      [id]
    ),

    pool.query(
      `
      SELECT MIN(quando) AS primo, MAX(quando) AS ultimo,
             COUNT(DISTINCT ${GIORNO_DI("quando")})::int AS giorni
        FROM (
          SELECT visto_il AS quando FROM episodi_visti WHERE utente_id = $1
          UNION ALL
          SELECT creata_il          FROM visioni       WHERE utente_id = $1
        ) t
      `,
      [id]
    )
  ]);

  const b = base.rows[0] || {};
  const t = tempo.rows[0] || {};

  return {
    utenteId: id,
    serie: Number(b.serie || 0),
    film: Number(b.film || 0),
    in_visione: Number(b.in_visione || 0),
    finite: Number(b.finite || 0),
    da_vedere: Number(b.da_vedere || 0),
    in_pausa: Number(b.in_pausa || 0),
    droppate: Number(b.droppate || 0),
    episodi: Number(b.episodi || 0),
    votate: Number(b.votate || 0),
    voto_medio: b.voto_medio === null || b.voto_medio === undefined ? null : Number(b.voto_medio),
    commenti: Number(b.commenti || 0),
    preferiti: Number(b.preferiti || 0),
    minuti: Number(minuti.rows[0]?.minuti || 0),
    generi: generi.rows.map((r) => ({ genere: r.genere, quante: r.quante })),
    primo: t.primo ?? null,
    ultimo: t.ultimo ?? null,
    giorni: Number(t.giorni || 0)
  };
}

/**
 * Due persone, una accanto all'altra.
 *
 * La parte che vale davvero non sono i due totali — quelli si
 * leggerebbero anche aprendo due pagine — ma le serie CHE AVETE IN
 * COMUNE, con i due voti accanto. È la domanda che uno si fa
 * guardando la videoteca di qualcun altro: «l'hai visto anche tu, e
 * cosa ne pensi?».
 *
 * Il confronto sta sui gruppi, non sulle schede: se una l'ha aggiunta
 * come due stagioni separate e l'altro come una sola, è comunque la
 * stessa serie e deve comparire una volta.
 */
async function confronto(pool, aId, bId) {
  const a = Number(aId);
  const b = Number(bId);

  const [statoA, statoB, comuni] = await Promise.all([
    statistiche(pool, a),
    statistiche(pool, b),
    pool.query(
      `
      SELECT
        COALESCE('g' || an.gruppo_id, 'a' || an.id) AS chiave,
        MIN(COALESCE(g.titolo, an.titolo))          AS titolo,
        MIN(an.id)                                  AS anime_id,
        (array_agg(an.cover_url ORDER BY an.ordine NULLS FIRST, an.anno_inizio))[1] AS cover_url,
        MIN(an.tipo)                                AS tipo,

        MAX(va.voto) AS voto_a,
        MAX(vb.voto) AS voto_b,

        SUM((SELECT COUNT(*) FROM episodi_visti ev
              WHERE ev.anime_id = an.id AND ev.utente_id = $1))::int AS episodi_a,
        SUM((SELECT COUNT(*) FROM episodi_visti ev
              WHERE ev.anime_id = an.id AND ev.utente_id = $2))::int AS episodi_b

      FROM anime an
      JOIN visioni visa ON visa.anime_id = an.id AND visa.utente_id = $1
      JOIN visioni visb ON visb.anime_id = an.id AND visb.utente_id = $2
      LEFT JOIN anime_gruppi g ON g.id = an.gruppo_id
      LEFT JOIN voti_anime va ON va.anime_id = an.id AND va.utente_id = $1
      LEFT JOIN voti_anime vb ON vb.anime_id = an.id AND vb.utente_id = $2
      GROUP BY COALESCE('g' || an.gruppo_id, 'a' || an.id)
      ORDER BY MIN(lower(COALESCE(g.titolo, an.titolo)))
      `,
      [a, b]
    )
  ]);

  const inComune = comuni.rows.map((r) => ({
    chiave: r.chiave,
    animeId: Number(r.anime_id),
    titolo: r.titolo,
    cover_url: r.cover_url,
    tipo: r.tipo,
    votoA: r.voto_a === null ? null : Number(r.voto_a),
    votoB: r.voto_b === null ? null : Number(r.voto_b),
    episodiA: Number(r.episodi_a || 0),
    episodiB: Number(r.episodi_b || 0)
  }));

  // Quanti dei due sono d'accordo: sulle serie che hanno votato
  // entrambi, quanto distano in media. Serve a dare una frase alla
  // pagina («andate d'accordo su quasi tutto») invece di un elenco.
  const votateInDue = inComune.filter((s) => s.votoA !== null && s.votoB !== null);

  const distanza = votateInDue.length
    ? votateInDue.reduce((somma, s) => somma + Math.abs(s.votoA - s.votoB), 0) / votateInDue.length
    : null;

  return {
    a: statoA,
    b: statoB,
    inComune,
    quanteInComune: inComune.length,
    votateInDue: votateInDue.length,
    distanzaMedia: distanza === null ? null : Math.round(distanza * 100) / 100
  };
}

module.exports = {
  FUSO,
  QUANTI,
  chiaveValida,
  chiaveGiornata,
  comeGiorno,
  feed,
  statistiche,
  confronto
};
