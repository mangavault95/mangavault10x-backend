/**
 * I CONSIGLI — «guarda questo», detto a una persona sola.
 *
 * Il Cineforum è la piazza: quello che ci si scrive lo leggono tutti,
 * e va benissimo per un diario. Ma consigliare è un gesto rivolto a
 * qualcuno — si sceglie chi, si scrive perché, e la cosa che si vuole
 * sapere dopo è una sola: l'ha visto?
 *
 * ---------------------------------------------------------------
 * COSA SI PUÒ CONSIGLIARE
 *
 * Qualunque cosa AnimeClick conosca, non solo quello che sta nella
 * propria videoteca. È la parte importante: la serie che l'altro non
 * ha ancora è esattamente quella che vale la pena consigliare, e una
 * chiave esterna verso `anime` avrebbe reso impossibile mandarla.
 *
 * Il titolo e la copertina si copiano dentro la riga (vedi la 021),
 * l'identità vera è `animeclick_id`. Quando la scheda esiste in
 * catalogo — subito, o fra sei mesi perché qualcuno l'ha aggiunta —
 * il LEFT JOIN qui sotto la ritrova e la cartolina diventa
 * cliccabile. Finché non esiste resta una copertina con un titolo,
 * che è già tutto quello che serve per dire «guarda questo».
 *
 * ---------------------------------------------------------------
 * `aperto_il` REGGE TUTTO
 *
 * Una colonna sola con dentro tre risposte:
 *   NULL   → al ricevente va mostrata la cartolina a schermo intero
 *   pieno  → al mittente va detto che è arrivata
 *   quando → l'istante che ordina gli avvisi di tutti e due
 */

/**
 * Quanto può essere lungo il commento che accompagna una copertina.
 *
 * Più corto dei duemila caratteri di un messaggio del Cineforum, e di
 * proposito: sta scritto su una cartolina, sopra a un'immagine, su
 * uno schermo di telefono. Oltre queste righe non è più un consiglio,
 * è un post — e il posto per i post c'è già.
 */
const TESTO_MAX = 600;

/** Le colonne che descrivono chi ha mandato o chi riceve. */
const CHI = (alias, prefisso) => `
  ${alias}.id AS ${prefisso}_id, ${alias}.nickname AS ${prefisso}_nickname,
  ${alias}.colore AS ${prefisso}_colore, ${alias}.faccia_il AS ${prefisso}_faccia
`;

function persona(r, prefisso) {
  return {
    id: Number(r[`${prefisso}_id`]),
    nickname: r[`${prefisso}_nickname`],
    colore: r[`${prefisso}_colore`],
    // Il momento e non i byte, come dappertutto nel sito: va appeso
    // all'indirizzo della faccia, o il browser tiene per un anno
    // quella di prima.
    faccia: r[`${prefisso}_faccia`] ? new Date(r[`${prefisso}_faccia`]).getTime() : null
  };
}

/**
 * Come esce un consiglio.
 *
 * `anime` c'è solo se la scheda è in catalogo: è quello che decide se
 * la copertina sulla cartolina è cliccabile o se resta un'immagine.
 */
function comeConsiglio(r) {
  return {
    id: Number(r.id),
    da: persona(r, "da"),
    a: persona(r, "a"),
    animeclickId: Number(r.animeclick_id),
    titolo: r.titolo,
    cover_url: r.cover_url,
    testo: r.testo,
    mandato_il: r.mandato_il,
    aperto_il: r.aperto_il,
    anime: r.anime_id ? { id: Number(r.anime_id) } : null
  };
}

const DA_CONSIGLIO = `
  SELECT c.id, c.animeclick_id, c.titolo, c.cover_url, c.testo,
         c.mandato_il, c.aperto_il,
         a.id AS anime_id,
         ${CHI("m", "da")},
         ${CHI("d", "a")}
    FROM consigli c
    JOIN utenti m ON m.id = c.da_utente_id
    JOIN utenti d ON d.id = c.a_utente_id
    LEFT JOIN anime a ON a.animeclick_id = c.animeclick_id
`;

/**
 * Manda un consiglio.
 *
 * Il destinatario dev'essere attivo: mandare una cartolina a chi non
 * è ancora stato accettato vorrebbe dire scriverla e non consegnarla
 * mai, senza che il mittente lo sappia.
 */
async function manda(pool, { daId, aId, animeclickId, titolo, coverUrl, testo }) {
  const { rows: destinatario } = await pool.query(
    `SELECT id FROM utenti WHERE id = $1 AND stato = 'attivo'`,
    [Number(aId)]
  );

  if (destinatario.length === 0) {
    const errore = new Error("Non trovo questa persona");
    errore.stato = 404;
    throw errore;
  }

  const { rows } = await pool.query(
    `
    INSERT INTO consigli (da_utente_id, a_utente_id, animeclick_id, titolo, cover_url, testo)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING id
    `,
    [Number(daId), Number(aId), Number(animeclickId), titolo, coverUrl || null, testo || null]
  );

  const { rows: intero } = await pool.query(`${DA_CONSIGLIO} WHERE c.id = $1`, [rows[0].id]);

  return comeConsiglio(intero[0]);
}

/**
 * Le cartoline che aspettano di essere aperte.
 *
 * Dalla PIÙ VECCHIA: se ne sono arrivate tre, si aprono nell'ordine in
 * cui sono state mandate, come si aprirebbe la posta.
 *
 * ⚠️ `c.id` in coda all'ordinamento non è ridondanza. `NOW()` in
 * Postgres è l'istante della TRANSAZIONE, non della riga: due
 * consigli scritti dentro la stessa transazione hanno lo stesso
 * `mandato_il` al microsecondo, e l'ordine fra loro sarebbe quello che
 * capita. Succede negli script di prova e succederebbe il giorno in
 * cui si mandasse più di una cartolina in una richiesta sola. `id` è
 * un BIGSERIAL, quindi è esattamente l'ordine di scrittura.
 *
 * Non c'è una finestra di trenta giorni come per la campanella: un
 * consiglio non aperto non scade, perché nessuno l'ha ancora visto.
 * Sparire da solo vorrebbe dire che qualcuno ha scritto qualcosa a
 * qualcun altro e quel qualcun altro non lo saprà mai.
 */
async function inArrivo(pool, utenteId) {
  const { rows } = await pool.query(
    `${DA_CONSIGLIO}
      WHERE c.a_utente_id = $1 AND c.aperto_il IS NULL
      ORDER BY c.mandato_il ASC, c.id ASC
      LIMIT 10`,
    [Number(utenteId)]
  );

  return rows.map(comeConsiglio);
}

/**
 * «L'ho vista».
 *
 * Si segna quando la cartolina COMPARE, non quando si chiude: se
 * qualcuno spegne il telefono a metà animazione l'ha comunque vista, e
 * rimostrargliela per sempre sarebbe peggio. Vale solo per il proprio
 * destinatario e solo la prima volta — riscrivere `aperto_il` a ogni
 * apertura sposterebbe in avanti l'avviso del mittente, che direbbe
 * «ha aperto adesso» di una cosa letta la settimana scorsa.
 */
async function apri(pool, id, utenteId) {
  const { rows } = await pool.query(
    `
    UPDATE consigli
       SET aperto_il = NOW()
     WHERE id = $1 AND a_utente_id = $2 AND aperto_il IS NULL
     RETURNING aperto_il
    `,
    [Number(id), Number(utenteId)]
  );

  return rows[0]?.aperto_il ?? null;
}

module.exports = { TESTO_MAX, DA_CONSIGLIO, comeConsiglio, manda, inArrivo, apri };
