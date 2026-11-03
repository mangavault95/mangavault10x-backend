/**
 * Le uscite lette da Fumettologica, editore per editore, settimana per settimana.
 *
 * Idea di Carmine (03/11/2026): AnimeClick non si può più leggere in
 * automatico, Google Books sbaglia troppo, e i siti degli editori sono
 * tre siti con tre strutture diverse (e Panini non si lascia leggere).
 * Fumettologica pubblica ogni settimana, per Planet Manga (Panini),
 * J-Pop e Star Comics, l'elenco di tutti i volumi in uscita, sempre con
 * lo stesso formato. Il suo robots.txt lo consente e il sito offre il
 * WordPress REST API proprio ai programmi: una richiesta elenca gli
 * articoli, e nella risposta c'è già il testo, senza visitare ogni pagina.
 *
 * ⚠️ La data è quella della SETTIMANA («12 – 18 ottobre»), non del
 * giorno. Si salva il giovedi della settimana, che è il giorno in cui
 * di norma escono i manga: per il riepilogo dell'8 serve il mese, non
 * il giorno, e dire «giovedi» è più onesto che inventare una precisione.
 *
 * Niente dipendenze del database: le funzioni ricevono le serie come
 * righe di "Manga" e restituiscono uscite, così si possono provare da sole.
 */

const { ossa } = require("./usciteManga");

const API = "https://fumettologica.it/wp-json/wp/v2/posts";

const USER_AGENT =
  "MangaVault/1.0 (collezione personale; +https://mangavault10x-frontend.vercel.app)";

// Gli editori che Fumettologica copre con un articolo settimanale, e come
// si chiamano nel titolo dell'articolo. L'ordine conta: il primo che combacia.
const FONTI = [
  { rivista: "Planet Manga", editore: /panini|planet/i },
  { rivista: "J-Pop", editore: /j-?\s?pop/i },
  { rivista: "Star Comics", editore: /star\s*comics/i }
];

/** Su quale rivista cercare le uscite di questo editore, o null se non è coperto. */
function fonteDi(editore) {
  const fonte = FONTI.find((f) => f.editore.test(String(editore || "")));

  return fonte ? fonte.rivista : null;
}

const MESI = {
  gennaio: 1, febbraio: 2, marzo: 3, aprile: 4, maggio: 5, giugno: 6,
  luglio: 7, agosto: 8, settembre: 9, ottobre: 10, novembre: 11, dicembre: 12,
  gen: 1, feb: 2, mar: 3, apr: 4, mag: 5, giu: 6, lug: 7, ago: 8, set: 9, ott: 10, nov: 11, dic: 12
};

/** «&#8211;», «&#8217;», «&amp;»: come WordPress scrive trattini, apostrofi ed &. */
function decodifica(testo) {
  return String(testo || "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ");
}

const dueCifre = (n) => String(n).padStart(2, "0");

/**
 * Il giovedi della settimana di un articolo, da un titolo come
 * «Planet Manga: i fumetti in uscita questa settimana (12 – 18 ottobre 2026)»
 * o «(28 settembre-4 ottobre 2026)» o «(28 set – 4 ott 2026)». null se il
 * titolo non ha un intervallo che si capisce.
 */
function giovediDellaSettimana(titolo) {
  const t = decodifica(titolo).toLowerCase();
  const m = t.match(/\((\d{1,2})\s*([a-zà-ù]+)?\s*[–—-]\s*(\d{1,2})\s+([a-zà-ù]+)\s+(\d{4})\)/);

  if (!m) return null;

  const giornoInizio = Number(m[1]);
  const meseFine = MESI[m[4]];
  const anno = Number(m[5]);

  // «12 – 18 ottobre»: l'inizio non ha il mese e prende quello della fine.
  const meseInizio = m[2] ? MESI[m[2]] : meseFine;

  if (!meseInizio || !meseFine) return null;

  // Un intervallo a cavallo d'anno («28 dicembre – 3 gennaio 2027») inizia l'anno prima.
  const annoInizio = meseInizio > meseFine ? anno - 1 : anno;

  const lunedi = new Date(Date.UTC(annoInizio, meseInizio - 1, giornoInizio));

  lunedi.setUTCDate(lunedi.getUTCDate() + 3);

  return `${lunedi.getUTCFullYear()}-${dueCifre(lunedi.getUTCMonth() + 1)}-${dueCifre(lunedi.getUTCDate())}`;
}

/** Quanto sta in fondo al titolo di un volume: «BLUE LOCK 35» → 35. */
function numeroDi(titolo) {
  const m = String(titolo || "").match(/(?:\b(?:vol(?:ume)?|n)\b\.?|#)?\s*(\d{1,3})\s*$/i);

  return m ? Number(m[1]) : null;
}

const NUMERO_IN_FONDO = /[\s.:\-–—,]*(?:\b(?:vol(?:ume)?|n)\b\.?|#)?\s*\d{1,3}\s*$/i;

function senzaNumero(titolo) {
  return String(titolo || "").replace(NUMERO_IN_FONDO, "").trim();
}

/** Parole che fanno di un volume un'altra edizione di quella in collezione. */
const ALTRE_EDIZIONI =
  /\b(deluxe|variant|limited|box|cofanetto|collector|complete|ultimate|nuova edizione|new edition|perfect|artbook|fanbook|special edition|wide edition|colossal|omnibus|lucca)\b/i;

const SENZA_EDIZIONE = /\b(edition|edizione)\b/gi;

/**
 * Questo titolo (di un volume in uscita) è un volume DI QUESTA serie?
 * La serie in collezione ha `Titolo` e, a volte, `Edizione`.
 */
function titoloDellaSerie(titoloVolume, serie) {
  const base = ossa(serie.Titolo);
  const titolo = ossa(senzaNumero(titoloVolume));

  if (!base || !titolo.startsWith(base)) return false;

  const resto = titolo.slice(base.length);

  if (serie.Edizione) {
    const ed = ossa(String(serie.Edizione).replace(SENZA_EDIZIONE, ""));

    return !ed || titolo.includes(ed);
  }

  // Senza edizione: il volume dev'essere quello normale. Un sottotitolo
  // («Frieren - Oltre la fine del viaggio») va bene, un'altra edizione no.
  return !ALTRE_EDIZIONI.test(titoloVolume) && resto.length < 40;
}

/** I titoli dei volumi di un articolo: ogni voce comincia con il titolo in grassetto. */
function vociDellArticolo(html) {
  return [...String(html || "").matchAll(/<p[^>]*><strong>([^<]+)<\/strong><br\s*\/?>/g)].map((m) =>
    decodifica(m[1]).trim()
  );
}

async function articoli(rivista, { dopo, fino }) {
  // Un articolo copre una settimana: si parte una settimana prima della finestra.
  const inizio = new Date(`${dopo}T00:00:00Z`);

  inizio.setUTCDate(inizio.getUTCDate() - 8);

  const url =
    `${API}?search=${encodeURIComponent(`${rivista} in uscita questa settimana`)}` +
    `&per_page=40&after=${inizio.toISOString().slice(0, 10)}T00:00:00&_fields=date,link,title,content`;

  const risposta = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal: AbortSignal.timeout(30000)
  });

  if (!risposta.ok) throw new Error(`Fumettologica HTTP ${risposta.status}`);

  const posts = await risposta.json();

  return posts
    .map((p) => ({
      titolo: decodifica(p.title?.rendered),
      link: p.link,
      giovedi: giovediDellaSettimana(p.title?.rendered),
      voci: vociDellArticolo(p.content?.rendered)
    }))
    // Solo quelli della rivista giusta («Planet Manga:», non «22 fumetti da non perdere…»).
    .filter((a) => a.titolo.toLowerCase().startsWith(`${rivista.toLowerCase()}:`) && a.giovedi)
    .filter((a) => a.giovedi > dopo && a.giovedi <= fino)
    .sort((a, b) => a.giovedi.localeCompare(b.giovedi));
}

/**
 * Le uscite di una rivista nella finestra, confrontate con le serie date.
 * Restituisce `{ uscite, lette, settimane }`: `lette` è quanti articoli
 * (settimane) si sono letti, così chi chiama può dire «non ho trovato
 * nessun articolo» invece di «non è uscito niente».
 */
async function usciteDellaRivista(rivista, serie, finestra) {
  const lista = await articoli(rivista, finestra);
  const uscite = [];

  for (const a of lista) {
    for (const voce of a.voci) {
      const numero = numeroDi(voce);

      if (numero === null || numero <= 0) continue;

      for (const s of serie) {
        if (!titoloDellaSerie(voce, s)) continue;

        uscite.push({
          data: a.giovedi,
          serie: s.Titolo,
          edizione: s.Edizione || "",
          editore: s.Editore || null,
          numero,
          titolo: voce,
          copertina: null,
          settimana: a.titolo.replace(/^.*\(/, "(")
        });
      }
    }
  }

  return { uscite, lette: lista.length };
}

module.exports = {
  fonteDi,
  usciteDellaRivista,
  giovediDellaSettimana,
  titoloDellaSerie,
  vociDellArticolo,
  numeroDi,
  senzaNumero,
  decodifica
};
