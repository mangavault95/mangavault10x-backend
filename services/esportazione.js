// services/esportazione.js
//
// La copia di sicurezza dei dati NOSTRI: tutto quello che hanno scritto i due
// lettori, in un file che si può tenere sul telefono. Il piano gratuito di
// Supabase non ha backup (confermato il 14/11/2026): finché questo file non
// esiste, i dati sono in una copia sola.
//
// Le tabelle si leggono dal catalogo, non da un elenco scritto qui: una tabella
// nuova entra da sola nella copia, e dimenticarla non è possibile. Quello che
// NON entra è invece un elenco corto e scritto, e il file lo dichiara
// (`escluso`), così nessuno crede di avere ciò che non ha.
//
// Fuori restano:
//  - le password (`password_hash`) e gli identificativi Telegram: il file vive
//    sul telefono e in iCloud, e non deve poter aprire un accesso a nessuno;
//  - ogni colonna binaria (le foto del profilo): sono pesanti e si rifanno;
//  - le tabelle che sono solo contabilità dei lavori programmati (cosa è già
//    stato annunciato, a che punto è un giro): si ricostruiscono da sole.

const TABELLE_ESCLUSE = new Set([
  "schema_migrations",
  "telegram_visti",
  "telegram_visti_uscite",
  "avvisi_uscite",
  "riepiloghi_manga",
  "copertine_giri",
  "fonte_stato",
  "utenti_striscione"
]);

const COLONNE_SEGRETE = new Set(["password_hash", "telegram_chat_id"]);

// Un tetto per tabella: con 205 serie e qualche migliaio di letture non si
// avvicina, ma una tabella impazzita non deve poter riempire la memoria di Render.
const RIGHE_MASSIME = 200000;

const ident = (nome) => `"${String(nome).replace(/"/g, '""')}"`;

// Date e orari viaggiano come TESTO. Come `Date` di JavaScript perderebbero due cose, e la
// prova di ripristino del 14/11/2026 le ha trovate entrambe: i microsecondi (Postgres ne ha
// sei, JavaScript tre: `15:31:51.569849` tornava `.569`) e, per le DATE, il giorno, che
// cambia col fuso del server.
const TIPI_COME_TESTO = new Set([
  "timestamp with time zone",
  "timestamp without time zone",
  "time with time zone",
  "time without time zone",
  "interval"
]);

function espressione(colonna, tipo) {
  if (tipo === "date") return `to_char(${ident(colonna)}, 'YYYY-MM-DD') AS ${ident(colonna)}`;
  if (TIPI_COME_TESTO.has(tipo)) return `${ident(colonna)}::text AS ${ident(colonna)}`;

  return ident(colonna);
}

async function struttura(pool) {
  const { rows } = await pool.query(
    `SELECT c.table_name AS tabella, c.column_name AS colonna, c.data_type AS tipo
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = current_schema() AND t.table_type = 'BASE TABLE'
      ORDER BY c.table_name, c.ordinal_position`
  );

  const tabelle = new Map();
  const colonneEscluse = [];

  for (const r of rows) {
    if (TABELLE_ESCLUSE.has(r.tabella)) continue;

    if (r.tipo === "bytea" || COLONNE_SEGRETE.has(r.colonna)) {
      colonneEscluse.push(`${r.tabella}.${r.colonna}`);
      continue;
    }

    if (!tabelle.has(r.tabella)) tabelle.set(r.tabella, []);
    tabelle.get(r.tabella).push({ nome: r.colonna, tipo: r.tipo });
  }

  return { tabelle, colonneEscluse };
}

async function esportaTutto(pool, adesso = new Date()) {
  const { tabelle, colonneEscluse } = await struttura(pool);
  const risultato = {};
  const troncate = [];

  for (const [nome, colonne] of tabelle) {
    const { rows } = await pool.query(
      `SELECT ${colonne.map((c) => espressione(c.nome, c.tipo)).join(", ")}
         FROM ${ident(nome)} ORDER BY 1 LIMIT ${RIGHE_MASSIME + 1}`
    );

    if (rows.length > RIGHE_MASSIME) {
      rows.pop();
      troncate.push(nome);
    }

    risultato[nome] = { colonne: colonne.map((c) => c.nome), righe: rows };
  }

  return {
    app: "MangaVault",
    formato: 1,
    creato_il: adesso.toISOString(),
    conteggi: Object.fromEntries(Object.entries(risultato).map(([n, t]) => [n, t.righe.length])),
    escluso: {
      tabelle: [...TABELLE_ESCLUSE].sort(),
      colonne: colonneEscluse.sort(),
      troncate
    },
    tabelle: risultato
  };
}

/**
 * Una cella di CSV.
 *
 * Il file si apre in un foglio di calcolo, e un titolo che comincia con `=`
 * (o `+`, `-`, `@`) verrebbe eseguito come formula: i titoli arrivano da fuori
 * (AnimeClick, Google Books). Davanti ci va un apice, che il foglio non mostra.
 * Solo per il testo: un numero negativo resta un numero.
 */
function cella(valore) {
  if (valore === null || valore === undefined) return "";

  let testo;

  if (Array.isArray(valore)) testo = valore.join(";");
  else if (valore instanceof Date) testo = valore.toISOString();
  else testo = String(valore);

  if (typeof valore === "string" && /^[=+\-@\t\r]/.test(testo)) testo = `'${testo}`;

  return /[",\n\r]/.test(testo) ? `"${testo.replace(/"/g, '""')}"` : testo;
}

/** Con il segno d'ordine dei byte in testa, perché Excel capisca che è UTF-8. */
function inCsv(colonne, righe) {
  const testa = colonne.map(cella).join(",");
  const corpo = righe.map((r) => colonne.map((c) => cella(r[c])).join(","));

  return `﻿${[testa, ...corpo].join("\r\n")}\r\n`;
}

async function collezioneCsv(pool) {
  const { rows, fields } = await pool.query(`SELECT * FROM "Manga" ORDER BY "Titolo"`);
  // La trama è lunga e in un foglio non serve: sta nella copia completa.
  const colonne = fields.map((f) => f.name).filter((n) => n !== "Trama");

  return inCsv(colonne, rows);
}

async function acquistiCsv(pool) {
  const { rows, fields } = await pool.query(
    `SELECT a.id, m."Titolo" AS serie, a.volume_da, a.volume_a, a.prezzo,
            to_char(a.data_acquisto, 'YYYY-MM-DD') AS data_acquisto,
            a.condizione, a.negozio, a.note
       FROM acquisti a LEFT JOIN "Manga" m ON m."ID" = a.manga_id
      ORDER BY a.data_acquisto DESC, a.id DESC`
  );

  return inCsv(fields.map((f) => f.name), rows);
}

module.exports = { esportaTutto, collezioneCsv, acquistiCsv, inCsv, cella, TABELLE_ESCLUSE, COLONNE_SEGRETE };
