/**
 * La tua settimana — il passo corto del «vostro mese».
 *
 * Puntate viste, volumi letti e quanto speso negli ULTIMI SETTE GIORNI: oggi
 * e i sei prima, giorni di calendario italiano. Non «da lunedì»: la domenica
 * sera e il lunedì mattina — quando la Home lo mostra — la finestra scorre con
 * te e non si svuota a mezzanotte.
 *
 * Di chi sono i numeri:
 *   puntate e letture  di UNA persona (`utenteId`): sono esperienze, e per
 *                      questo sito appartengono a chi le ha avute;
 *   acquisti           della CASA: la tabella non dice chi è andato in
 *                      fumetteria (vedi `routes/mese.js`, che ha la stessa regola).
 *
 * Tutto in una funzione che prende il database e il giorno: così si prova su un
 * Postgres vuoto, con i bordi della finestra, senza passare dalla rotta.
 */

const { oggiInItalia, piuGiorni } = require("./usciteManga");

/** Quanti giorni dura la finestra, oggi compreso. */
const GIORNI = 7;

async function settimana(pool, { utenteId, oggi = null }) {
  const al = oggi || oggiInItalia();
  const dal = piuGiorni(al, -(GIORNI - 1));
  // Il giorno dopo `al`: la finestra è [dal, domani), mezzanotte italiana a mezzanotte italiana.
  const domani = piuGiorni(al, 1);

  const romani = `($1::date::timestamp AT TIME ZONE 'Europe/Rome')`;
  const fino = `($2::date::timestamp AT TIME ZONE 'Europe/Rome')`;

  const [puntate, letti, acquisti] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS puntate, COUNT(DISTINCT anime_id)::int AS serie
         FROM episodi_visti
        WHERE utente_id = $3 AND visto_il >= ${romani} AND visto_il < ${fino}`,
      [dal, domani, utenteId]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS volumi
         FROM reading_history
        WHERE utente_id = $3 AND read_at >= ${romani} AND read_at < ${fino}`,
      [dal, domani, utenteId]
    ),
    pool.query(
      `SELECT COALESCE(SUM(prezzo), 0)::float AS spesa,
              COALESCE(SUM(volume_a - volume_da + 1), 0)::int AS volumi
         FROM acquisti
        WHERE data_acquisto >= $1::date AND data_acquisto < $2::date`,
      [dal, domani]
    )
  ]);

  return {
    dal,
    al,
    puntate: puntate.rows[0].puntate,
    serie: puntate.rows[0].serie,
    letti: letti.rows[0].volumi,
    spesa: acquisti.rows[0].spesa,
    volumiComprati: acquisti.rows[0].volumi
  };
}

module.exports = { settimana, GIORNI };
