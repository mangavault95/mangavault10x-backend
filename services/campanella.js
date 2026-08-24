/**
 * LA CAMPANELLA — cosa è successo che riguarda te.
 *
 * Il Cineforum dice cosa hanno fatto tutti; questa dice cosa hanno
 * fatto A TE. Sono cinque cose, e sono quelle che è stato chiesto di
 * sapere:
 *
 *   RISPOSTA  qualcuno ha risposto a un tuo post, o a un filo in cui
 *             hai scritto anche tu
 *   CUORE     qualcuno ha messo un cuore a un tuo post
 *   NOTA      qualcuno ha commentato una serie che hai visto anche tu
 *   CONSIGLIO qualcuno ti ha mandato un anime da guardare
 *   APERTO    qualcuno ha aperto la cartolina che gli hai mandato
 *
 * ---------------------------------------------------------------
 * NESSUNA TABELLA DI AVVISI
 *
 * Vale parola per parola il ragionamento della 016 sul feed: ogni
 * avviso è già una riga da qualche parte — `cineforum_risposte`,
 * `cineforum_cuori`, `note_anime`, `consigli` — e scriverne una copia
 * altrove vorrebbe dire due verità che possono divergere. Con la
 * copia, chi cancella una risposta lascia in giro l'avviso che la
 * annunciava; senza, sparisce da sé.
 *
 * Gli ultimi due avvisi vengono dalla STESSA riga di `consigli`, letta
 * dai due capi: quella riga esiste = te l'hanno mandato, quella riga
 * ha `aperto_il` = l'hanno letta. Una tabella di notifiche avrebbe
 * scritto due righe in più per dire quello che una diceva già.
 *
 * Quello che dalle righe non si ricava è una cosa sola — fin dove hai
 * già guardato — e infatti la 020 aggiunge una colonna sola.
 *
 * ---------------------------------------------------------------
 * PERCHÉ UNA FINESTRA DI TRENTA GIORNI
 *
 * Senza, chi apre la campanella per la prima volta si trova davanti
 * ogni cuore mai messo da quando esiste il sito: un elenco che non è
 * una notizia, è un archivio. Trenta giorni è quanto indietro ha
 * senso tornare per una cosa che si guarda per sapere «mi sono perso
 * qualcosa?».
 */

// Quanto indietro si guarda, e quanti avvisi si consegnano. Il
// secondo numero è generoso apposta: il pallino conta quelli non
// letti, e un pallino che dice «9+» quando i veri sono undici è un
// dettaglio che si nota.
const GIORNI = 30;
const QUANTI = 40;

/**
 * I post di una persona, detti come li scrive la chiave.
 *
 * Una giornata è tua se la chiave porta il tuo numero; un messaggio
 * lo è se la riga lo dice. Due forme diverse per la stessa domanda,
 * perché i post del Cineforum sono di due specie e una sola delle due
 * è una riga vera (vedi `sql/016_cineforum.sql`).
 */
const TUO_POST = (colonna) => `
  (
    ${colonna} LIKE 'giornata:' || $1::bigint::text || ':%'
    OR EXISTS (
      SELECT 1 FROM cineforum_messaggi m
       WHERE 'messaggio:' || m.id = ${colonna} AND m.utente_id = $1::bigint
    )
  )
`;

/** Come si consegna chi ha fatto la cosa. */
const CHI = `
  u.id AS chi_id, u.nickname AS chi_nickname, u.colore AS chi_colore,
  u.faccia_il AS chi_faccia
`;

function persona(r) {
  return {
    id: Number(r.chi_id),
    nickname: r.chi_nickname,
    colore: r.chi_colore,
    // Il momento e non i byte, come dappertutto: va appeso
    // all'indirizzo della faccia.
    faccia: r.chi_faccia ? new Date(r.chi_faccia).getTime() : null
  };
}

/**
 * Una lettura che può non avere ancora la sua tabella.
 *
 * Le migrazioni si eseguono a mano su Supabase e Render può servire il
 * codice nuovo prima (il 22/08/2026 ci ha messo 35 minuti). In mezzo,
 * una query sui `consigli` solleva 42P01 — e dentro un `Promise.all`
 * una sola query caduta porta giù la campanella intera: niente cuori,
 * niente risposte, niente commenti, per una tabella che riguarda una
 * riga su venti. Meglio zero avvisi di UN tipo che zero avvisi.
 */
async function forse(promessa) {
  try {
    return await promessa;
  } catch (err) {
    if (err.code === "42P01" || err.code === "42703") return { rows: [] };

    throw err;
  }
}

/**
 * Gli avvisi di una persona, dal più recente.
 *
 * `visti_il` è NULL per chi non ha mai aperto la campanella: allora
 * niente è «già letto» e conta tutta la finestra.
 */
async function avvisi(pool, utenteId) {
  const id = Number(utenteId);

  const { rows: chiSono } = await pool.query(
    `SELECT avvisi_visti_il FROM utenti WHERE id = $1`,
    [id]
  );

  const visti = chiSono[0]?.avvisi_visti_il ?? null;

  const [risposte, cuori, note, consigli, aperti] = await Promise.all([
    // Anche i fili in cui hai scritto tu e non solo i tuoi post: una
    // risposta alla tua risposta è la cosa più simile a «qualcuno ti
    // ha parlato» che ci sia qui dentro, e non arrivava.
    pool.query(
      `
      SELECT r.id, r.chiave, r.testo, r.creata_il AS quando,
             ${TUO_POST("r.chiave")} AS tuo,
             ${CHI}
        FROM cineforum_risposte r
        JOIN utenti u ON u.id = r.utente_id
       WHERE r.utente_id <> $1::bigint
         AND r.creata_il > NOW() - INTERVAL '${GIORNI} days'
         AND (
           ${TUO_POST("r.chiave")}
           OR EXISTS (
             SELECT 1 FROM cineforum_risposte mie
              WHERE mie.chiave = r.chiave AND mie.utente_id = $1::bigint
           )
         )
       ORDER BY r.creata_il DESC
       LIMIT $2
      `,
      [id, QUANTI]
    ),

    pool.query(
      `
      SELECT k.chiave, k.messo_il AS quando, ${CHI}
        FROM cineforum_cuori k
        JOIN utenti u ON u.id = k.utente_id
       WHERE k.utente_id <> $1::bigint
         AND k.messo_il > NOW() - INTERVAL '${GIORNI} days'
         AND ${TUO_POST("k.chiave")}
       ORDER BY k.messo_il DESC
       LIMIT $2
      `,
      [id, QUANTI]
    ),

    // «Un anime che hai visto» si intende sul GRUPPO e non sulla
    // scheda: chi commenta la seconda stagione di Noragami sta
    // parlando della serie che hai in videoteca, anche se la tua riga
    // è quella della prima.
    pool.query(
      `
      SELECT n.id, n.testo, n.spoiler, n.numero_episodio, n.creata_il AS quando,
             a.id AS anime_id, a.cover_url,
             COALESCE(g.titolo, a.titolo) AS titolo,
             ${CHI}
        FROM note_anime n
        JOIN anime a ON a.id = n.anime_id
        LEFT JOIN anime_gruppi g ON g.id = a.gruppo_id
        JOIN utenti u ON u.id = n.utente_id
       WHERE n.utente_id <> $1::bigint
         AND n.creata_il > NOW() - INTERVAL '${GIORNI} days'
         AND EXISTS (
           SELECT 1
             FROM visioni v
             JOIN anime va ON va.id = v.anime_id
            WHERE v.utente_id = $1::bigint
              AND COALESCE('g' || va.gruppo_id, 'a' || va.id)
                = COALESCE('g' || a.gruppo_id, 'a' || a.id)
         )
       ORDER BY n.creata_il DESC
       LIMIT $2
      `,
      [id, QUANTI]
    ),

    // I consigli che ti hanno mandato. La cartolina si apre da sola al
    // primo accesso, ma l'avviso serve lo stesso: passata quella
    // volta, «chi mi aveva consigliato cosa?» non avrebbe nessun altro
    // posto dove stare. Ci sono anche quelli non ancora aperti — sono
    // arrivati, e il pallino deve dirlo anche a chi non ha ancora
    // riaperto la videoteca.
    forse(
      pool.query(
        `
        SELECT c.id, c.titolo, c.testo, c.mandato_il AS quando,
               an.id AS anime_id, c.cover_url,
               ${CHI}
          FROM consigli c
          JOIN utenti u ON u.id = c.da_utente_id
          LEFT JOIN anime an ON an.animeclick_id = c.animeclick_id
         WHERE c.a_utente_id = $1::bigint
           AND c.mandato_il > NOW() - INTERVAL '${GIORNI} days'
         ORDER BY c.mandato_il DESC
         LIMIT $2
        `,
        [id, QUANTI]
      )
    ),

    // E le cartoline che hai mandato tu, quando sono state aperte:
    // l'unica domanda che ci si fa dopo aver consigliato qualcosa.
    // L'istante è `aperto_il` e non `mandato_il`, perché la notizia è
    // quella — un consiglio mandato tre settimane fa e letto stamattina
    // è una novità di stamattina.
    forse(
      pool.query(
        `
        SELECT c.id, c.titolo, c.aperto_il AS quando,
               an.id AS anime_id, c.cover_url,
               ${CHI}
          FROM consigli c
          JOIN utenti u ON u.id = c.a_utente_id
          LEFT JOIN anime an ON an.animeclick_id = c.animeclick_id
         WHERE c.da_utente_id = $1::bigint
           AND c.aperto_il IS NOT NULL
           AND c.aperto_il > NOW() - INTERVAL '${GIORNI} days'
         ORDER BY c.aperto_il DESC
         LIMIT $2
        `,
        [id, QUANTI]
      )
    )
  ]);

  const elenco = [
    ...risposte.rows.map((r) => ({
      chiave: `risposta-${r.id}`,
      tipo: "risposta",
      quando: r.quando,
      chi: persona(r),
      post: r.chiave,
      // Se il post è tuo o è solo un filo in cui hai scritto anche tu:
      // «ha risposto alla tua giornata» e «ha risposto a un filo in
      // cui hai scritto» sono due notizie diverse, e la prima detta al
      // posto della seconda è falsa.
      tuo: Boolean(r.tuo),
      testo: r.testo
    })),

    ...cuori.rows.map((r) => ({
      // Un cuore non ha un identificativo suo: la sua chiave primaria
      // è la coppia (post, persona), e la stessa cosa vale qui.
      chiave: `cuore-${r.chiave}-${r.chi_id}`,
      tipo: "cuore",
      quando: r.quando,
      chi: persona(r),
      post: r.chiave
    })),

    ...note.rows.map((r) => ({
      chiave: `nota-${r.id}`,
      tipo: "nota",
      quando: r.quando,
      chi: persona(r),
      testo: r.testo,
      spoiler: r.spoiler,
      numeroEpisodio: r.numero_episodio,
      anime: {
        id: Number(r.anime_id),
        titolo: r.titolo,
        cover_url: r.cover_url
      }
    })),

    // `anime.id` può essere NULL: si consiglia anche quello che non è
    // in catalogo, ed è il caso più interessante. Chi disegna la riga
    // deve saperlo — senza id non c'è dove portare, e la riga non è un
    // collegamento.
    ...consigli.rows.map((r) => ({
      chiave: `consiglio-${r.id}`,
      tipo: "consiglio",
      quando: r.quando,
      chi: persona(r),
      testo: r.testo,
      anime: {
        id: r.anime_id ? Number(r.anime_id) : null,
        titolo: r.titolo,
        cover_url: r.cover_url
      }
    })),

    ...aperti.rows.map((r) => ({
      chiave: `consiglio-aperto-${r.id}`,
      tipo: "consiglio-aperto",
      quando: r.quando,
      chi: persona(r),
      anime: {
        id: r.anime_id ? Number(r.anime_id) : null,
        titolo: r.titolo,
        cover_url: r.cover_url
      }
    }))
  ];

  elenco.sort((a, b) => new Date(b.quando) - new Date(a.quando));

  const tagliato = elenco.slice(0, QUANTI);

  return {
    avvisi: tagliato,
    visti_il: visti,
    daLeggere: tagliato.filter((a) => !visti || new Date(a.quando) > new Date(visti)).length
  };
}

/** «Ho visto»: da adesso in poi il pallino riparte da zero. */
async function segnaLetti(pool, utenteId) {
  const { rows } = await pool.query(
    `UPDATE utenti SET avvisi_visti_il = NOW() WHERE id = $1 RETURNING avvisi_visti_il`,
    [Number(utenteId)]
  );

  return rows[0]?.avvisi_visti_il ?? null;
}

module.exports = { GIORNI, avvisi, segnaLetti };
