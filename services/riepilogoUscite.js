/**
 * Il riepilogo dell'8 — «cosa è uscito e ti manca».
 *
 * Una volta al mese il bot della spesa manga (@Spesamanga10xbot) scrive i volumi usciti dall'8
 * del mese scorso a oggi per le serie in collezione, e dice quali non
 * ci sono ancora. Serve a recuperarli in una volta sola invece di
 * accorgersene a caso in fumetteria.
 *
 * Il giro parte da GitHub Actions (`riepilogo-manga.yml`), che chiama
 * `POST /api/manga/uscite/riepilogo`. Come per gli avvisi anime, qui
 * c'è solo cosa mandare e a chi; i dati li ha già messi da parte il giro
 * quotidiano del calendario (`registraCalendario`).
 *
 * La finestra è (8 del mese scorso, 8 di questo mese]: il giorno di
 * partenza è escluso e quello di arrivo incluso, così il riepilogo
 * seguente comincia dove questo finisce e un volume uscito proprio il
 * 8 non si conta due volte né si perde.
 *
 * (03/11/2026: il giorno era il 10, Carmine l'ha portato all'8. Sta in
 * `GIORNO_RIEPILOGO`: cambiarlo qui sposta la finestra; i due cron dei
 * workflow — la ricerca il giorno prima, il riepilogo quel giorno — si
 * cambiano a mano.)
 *
 * Come per gli avvisi si SEGNA prima e si MANDA dopo, e se la mandata
 * fallisce si toglie il segno: vedi `services/avvisi.js` per il perché.
 */

const telegram = require("./telegram").manga;
const { usciteTra, piuGiorni, oggiInItalia } = require("./usciteManga");
const { haBiblioteca } = require("./utenti");

const SITO = (process.env.SITO_URL || "https://mangavault10x-frontend.vercel.app").replace(/\/$/, "");

// Telegram rifiuta oltre 4096 caratteri: si spezza prima, con margine.
const MAX_MESSAGGIO = 3500;

const MESI = [
  "gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno",
  "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"
];

/** Il giorno in cui chiude la finestra, e a cui arriva il riepilogo. */
const GIORNO_RIEPILOGO = 8;

const dueCifre = (n) => String(n).padStart(2, "0");

/** Il giorno del riepilogo del mese prima di `giorno` ("AAAA-MM-GG"). */
function giornoDelMesePrima(giorno) {
  const [anno, mese] = giorno.split("-").map(Number);
  const a = mese === 1 ? anno - 1 : anno;
  const m = mese === 1 ? 12 : mese - 1;

  return `${a}-${dueCifre(m)}-${dueCifre(GIORNO_RIEPILOGO)}`;
}

/** "8 ottobre", "3 nov": la data come si dice a voce. */
function giornoMese(data, breve = false) {
  const [, m, g] = data.split("-").map(Number);
  const mese = MESI[m - 1];

  return `${g} ${breve ? mese.slice(0, 3) : mese}`;
}

function euro(n) {
  return `${n.toFixed(2).replace(".", ",")} €`;
}

/**
 * I messaggi del riepilogo (uno o più, se è lungo).
 *
 * Del «già in casa» si dice solo il numero: l'elenco è quello che non
 * serve, ed è la parte che renderebbe il messaggio illeggibile.
 */
function messaggi({ dopo, fino, uscite }) {
  const intestazione = `📚 <b>Uscite dal ${giornoMese(dopo)} al ${giornoMese(fino)}</b>`;

  const daRecuperare = uscite.filter((u) => u.stato !== "gia");
  const giaTuoi = uscite.length - daRecuperare.length;

  if (uscite.length === 0) {
    return [`${intestazione}\n\nNessuna uscita delle tue serie in questo periodo.`];
  }

  if (daRecuperare.length === 0) {
    return [`${intestazione}\n\nSei in pari: ${giaTuoi === 1 ? "l'unico volume uscito è già tuo" : `tutti i ${giaTuoi} volumi usciti sono già tuoi`}.`];
  }

  const perSerie = new Map();

  for (const u of daRecuperare) {
    if (!perSerie.has(u.serie.id)) perSerie.set(u.serie.id, { serie: u.serie, volumi: [] });

    perSerie.get(u.serie.id).volumi.push(u);
  }

  const stima = daRecuperare.reduce((somma, u) => somma + (u.serie.prezzo_stimato || 0), 0);

  const righe = [...perSerie.values()].map(({ serie, volumi }) => {
    const nome = serie.edizione ? `${serie.titolo} · ${serie.edizione}` : serie.titolo;
    const elenco = volumi.map((v) => `${v.numero} (${giornoMese(v.data, true)})`).join(", ");
    // Prima di questi volumi ce ne sono altri che non hai: si dice, perché
    // comprare il 12 senza l'11 è proprio l'errore da evitare.
    const buchi = volumi.some((v) => v.stato === "manca") ? " ⚠️ con dei buchi prima" : "";

    return `• <b>${telegram.esc(nome)}</b> — vol. ${elenco}${buchi}`;
  });

  const testa = [
    intestazione,
    "",
    `Da recuperare: <b>${daRecuperare.length}</b> ${daRecuperare.length === 1 ? "volume" : "volumi"}` +
      (stima > 0 ? ` · circa ${euro(stima)}` : ""),
    ""
  ].join("\n");

  const coda = [
    "",
    giaTuoi > 0 ? `Già in casa: ${giaTuoi}.` : null,
    `${SITO}/wishlist`
  ]
    .filter((r) => r !== null)
    .join("\n");

  // Spezza solo se serve, sempre fra una serie e l'altra.
  const pezzi = [];
  let corrente = testa;

  for (const riga of righe) {
    if (corrente.length + riga.length + 1 > MAX_MESSAGGIO && corrente !== testa) {
      pezzi.push(corrente);
      corrente = "";
    }

    corrente += (corrente && !corrente.endsWith("\n") ? "\n" : "") + riga;
  }

  pezzi.push(corrente + "\n" + coda);

  return pezzi;
}

/** Chi riceve: persone attive con la chat collegata e accesso alla biblioteca (o il proprietario). */
async function destinatari(pool) {
  const { rows } = await pool.query(
    `SELECT id, nickname, telegram_chat_id, proprietario
       FROM utenti
      WHERE stato = 'attivo' AND telegram_chat_id IS NOT NULL`
  );

  const risultato = [];

  for (const r of rows) {
    if (r.proprietario || (await haBiblioteca(r.id))) risultato.push(r);
  }

  return risultato;
}

/**
 * Il lavoro intero.
 *
 * `prova: true` dice cosa manderebbe, e a chi, senza segnare né mandare.
 * `oggi` (AAAA-MM-GG) serve alle prove: in produzione è sempre il
 * giorno di Roma.
 */
async function riepilogaMese(pool, { prova = false, oggi = null } = {}) {
  if (!telegram.configurato()) {
    throw new Error("TELEGRAM_MANGA_TOKEN non configurato: il riepilogo è spento");
  }

  const fino = oggi || oggiInItalia();
  const dopo = giornoDelMesePrima(fino);

  const uscite = await usciteTra(pool, { dopo, fino, soloMie: true });
  const persone = await destinatari(pool);
  const testi = messaggi({ dopo, fino, uscite });

  const esito = {
    periodo: { dopo, fino },
    uscite: uscite.length,
    daRecuperare: uscite.filter((u) => u.stato !== "gia").length,
    persone: persone.length,
    inviati: 0,
    falliti: 0,
    dettaglio: []
  };

  for (const persona of persone) {
    if (prova) {
      esito.dettaglio.push({ a: persona.nickname, testi });
      continue;
    }

    const { rowCount } = await pool.query(
      `INSERT INTO riepiloghi_manga (utente_id, periodo) VALUES ($1, $2::date)
       ON CONFLICT DO NOTHING`,
      [persona.id, fino]
    );

    // Già mandato (il giro è partito due volte): sta zitto.
    if (rowCount === 0) continue;

    let errore = null;

    for (const testo of testi) {
      const risposta = await telegram.invia(persona.telegram_chat_id, testo);

      if (!risposta.ok) {
        errore = risposta.descrizione;
        break;
      }
    }

    if (!errore) {
      esito.inviati++;
      esito.dettaglio.push({ a: persona.nickname, messaggi: testi.length });
      continue;
    }

    await pool.query(`DELETE FROM riepiloghi_manga WHERE utente_id = $1 AND periodo = $2::date`, [
      persona.id,
      fino
    ]);

    esito.falliti++;
    esito.dettaglio.push({ a: persona.nickname, errore });

    console.error(`📚 Riepilogo a ${persona.nickname} non partito:`, errore);
  }

  return esito;
}

module.exports = { riepilogaMese, messaggi, giornoDelMesePrima, GIORNO_RIEPILOGO, dueCifre };
