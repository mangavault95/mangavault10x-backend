// Prova delle uscite lette da Fumettologica e abbinate alla collezione.
//
//   node scripts/prova-uscite-fumettologica.js
//
// Gira ovunque: il sito di Fumettologica e il database sono finti (un `fetch` e un `pool`
// che rispondono con righe scritte qui sotto). L'articolo è fatto a mano con la stessa forma
// che il lettore cerca («<p><strong>TITOLO</strong><br />»): NON è un articolo vero.
//
// Il caso: «SERIE 17 – ALTRO 1» (edizione abbinata) finiva in archivio come volume 1 della
// serie. E «SERIE – ALTRA OPERA 1» (uno spin-off, come «I diari della speziale – La storia di
// Xiaolan 1») compariva nella pagina Uscite come «I diari della speziale 1», già in casa.

const { titoloRegolare, sottotitoloDi, usciteTra, copertinaDelVolume, copertineDalleUscite } = require("../services/usciteManga");
const { conUsciteSenzaCopertina } = require("../services/copertineVolumi");
const { ultimoVolumeUscito } = require("../services/volumiDaUscite");
const { usciteDellaRivista, numeroDi } = require("../services/usciteFumettologica");

let falliti = 0;

function prova(nome, atteso, ottenuto) {
  const a = JSON.stringify(atteso);
  const o = JSON.stringify(ottenuto);

  if (a === o) console.log(`  ok   ${nome}`);
  else {
    falliti += 1;
    console.log(`  NO   ${nome}\n       atteso   ${a}\n       ottenuto ${o}`);
  }
}

const SPEZIALE = { ID: 1, Titolo: "I diari della speziale", Edizione: null, Editore: "J-POP", NumeriPosseduti: [1], Costo: 6.5, CoverURL: "https://x/spez-1.jpg", SmessaIl: null };
const RENT = { ID: 2, Titolo: "Rent a Girlfriend", Edizione: null, Editore: "J-POP", NumeriPosseduti: Array.from({ length: 34 }, (_, i) => i + 1), Costo: 5.9, CoverURL: "https://x/rent-1.jpg", SmessaIl: null };

(async () => {
  console.log("\nIl titolo è «la serie + il suo numero»?");
  prova("volume normale", true, titoloRegolare("I diari della speziale 17", "I diari della speziale"));
  prova("sottotitolo senza cifre", true, titoloRegolare("Frieren – Oltre la fine del viaggio 12", "Frieren"));
  prova("edizione abbinata con un altro numero in mezzo", false, titoloRegolare("I diari della speziale 17 – Chronicle 1", "I diari della speziale"));
  prova("serie con una cifra nel nome", true, titoloRegolare("20th Century Boys 5", "20th Century Boys"));
  prova("senza titolo non si scarta", true, titoloRegolare(null, "Qualunque"));
  prova("il numero in fondo di un titolo abbinato è quello sbagliato", 1, numeroDi("I diari della speziale 17 – Chronicle 1"));

  console.log("\nLa lettura dell'articolo settimanale");
  const articolo = {
    title: { rendered: "J-Pop: i fumetti in uscita questa settimana (9 &#8211; 15 novembre 2026)" },
    link: "https://esempio.invalid/j-pop-9-15-novembre",
    content: {
      rendered: [
        "<p><strong>I DIARI DELLA SPEZIALE 17</strong><br />",
        "Prezzo: 6,50 euro</p>",
        "<p><strong>I DIARI DELLA SPEZIALE 17 – CHRONICLE 1</strong><br />",
        "Prezzo: 12,00 euro</p>",
        "<p><strong>RENT A GIRLFRIEND 35</strong><br />",
        "Prezzo: 5,90 euro</p>"
      ].join("\n")
    }
  };

  const fetchOriginale = global.fetch;

  global.fetch = async () => ({ ok: true, status: 200, json: async () => [articolo] });

  let esito;

  try {
    esito = await usciteDellaRivista("J-Pop", [SPEZIALE, RENT], { dopo: "2026-11-01", fino: "2026-11-30" });
  } finally {
    global.fetch = fetchOriginale;
  }

  prova("un articolo letto", 1, esito.lette);
  prova(
    "il volume abbinato non diventa il volume 1; gli altri restano",
    [["I diari della speziale", 17, "2026-11-12"], ["Rent a Girlfriend", 35, "2026-11-12"]],
    esito.uscite.map((u) => [u.serie, u.numero, u.data])
  );

  console.log("\nL'abbinamento alla collezione (righe già scritte in archivio)");
  const righe = [
    { data: "2026-11-12", serie: "I diari della speziale", numero: 1, titolo: "I DIARI DELLA SPEZIALE 17 – CHRONICLE 1", edizione: null, editore: "J-POP", copertina: null },
    { data: "2026-11-12", serie: "I diari della speziale", numero: 17, titolo: "I DIARI DELLA SPEZIALE 17", edizione: null, editore: "J-POP", copertina: null },
    { data: "2026-11-12", serie: "Rent a Girlfriend", numero: 35, titolo: null, edizione: null, editore: "J-POP", copertina: null }
  ];

  const pool = {
    query: async (sql) => ({ rows: /FROM uscite_manga/.test(sql) ? righe : [SPEZIALE, RENT] })
  };

  const mie = await usciteTra(pool, { dopo: "2026-11-01", fino: "2026-11-30", soloMie: true });

  prova(
    "la riga «1» scritta in precedenza non compare, il 17 sì",
    [["I diari della speziale", 17, "manca"], ["Rent a Girlfriend", 35, "prossimo"]],
    mie.map((u) => [u.serie.titolo, u.numero, u.stato])
  );

  console.log("\nUno spin-off con lo stesso prefisso non è un volume della serie");
  // Caso reale (22/11/2026): il 17 dei «Diari della speziale» uscì il 28 ottobre; il 12 novembre
  // Fumettologica elencò «I diari della speziale – La storia di Xiaolan 1», un'altra opera. Il
  // sottotitolo si accettava (serve a Frieren), il numero 1 coincideva con il volume in casa e la
  // pagina Uscite diceva «ce l'hai».
  const FRIEREN = { ID: 3, Titolo: "Frieren", Edizione: null, Editore: "Star Comics", NumeriPosseduti: Array.from({ length: 11 }, (_, i) => i + 1), Costo: 5.9, CoverURL: null, SmessaIl: null };

  const archivio = [
    { data: "2026-10-28", serie: "I diari della speziale", numero: 17, titolo: "I diari della speziale 17", edizione: null, editore: "J-POP", copertina: null },
    { data: "2026-11-12", serie: "I diari della speziale", numero: 1, titolo: "I diari della speziale – La storia di Xiaolan 1", edizione: null, editore: "J-POP", copertina: null },
    { data: "2026-11-12", serie: "Frieren", numero: 12, titolo: "Frieren – Oltre la fine del viaggio 12", edizione: null, editore: "Star Comics", copertina: null }
  ];

  const poolArchivio = {
    query: async (sql, parametri) => {
      if (!/FROM uscite_manga/.test(sql)) return { rows: [SPEZIALE, FRIEREN] };

      // `usciteTra` chiede le righe di un periodo, l'abbinamento chiede tutto l'archivio.
      return { rows: parametri ? archivio.filter((r) => r.data > parametri[0] && r.data <= parametri[1]) : archivio };
    }
  };

  const novembre = await usciteTra(poolArchivio, { dopo: "2026-10-31", fino: "2026-11-30", soloMie: true });

  prova(
    "lo spin-off sparisce; Frieren, che ha solo il sottotitolo, resta",
    [["Frieren", 12]],
    novembre.map((u) => [u.serie.titolo, u.numero])
  );

  const ottobre = await usciteTra(poolArchivio, { dopo: "2026-09-30", fino: "2026-10-31", soloMie: true });

  prova("il 17 di ottobre resta", [["I diari della speziale", 17]], ottobre.map((u) => [u.serie.titolo, u.numero]));

  prova("sottotitolo del volume normale", "", sottotitoloDi("I diari della speziale 17", "I diari della speziale"));
  prova("sottotitolo di uno spin-off", "lastoriadixiaolan", sottotitoloDi("I diari della speziale – La storia di Xiaolan 1", "I diari della speziale"));
  prova("il nome dell'edizione non è un sottotitolo", "", sottotitoloDi("ONE PIECE NEW EDITION 8", "One Piece", "New Edition"));
  prova("titolo di un'altra serie: non si può dire", null, sottotitoloDi("Altra cosa 3", "I diari della speziale"));

  console.log("\nL'ultimo volume uscito non lo alza uno spin-off");
  const poolUltimo = { query: async () => ({ rows: [
    { serie: "I diari della speziale", titolo: "I diari della speziale 17", edizione: null, editore: "J-POP", numero: 17, data: "2026-10-28" },
    { serie: "I diari della speziale", titolo: "I diari della speziale – La storia di Xiaolan 24", edizione: null, editore: "J-POP", numero: 24, data: "2026-11-12" },
    { serie: "Frieren", titolo: "Frieren – Oltre la fine del viaggio 12", edizione: null, editore: "Star Comics", numero: 12, data: "2026-11-12" }
  ] }) };

  prova("la speziale resta a 17", 17, await ultimoVolumeUscito(poolUltimo, SPEZIALE, { oggi: "2026-11-22" }));
  prova("Frieren, solo sottotitoli, resta a 12", 12, await ultimoVolumeUscito(poolUltimo, FRIEREN, { oggi: "2026-11-22" }));

  console.log("\nLa copertina della riga vale solo se è quella del volume");
  // Caso reale (22/11/2026): il calendario di AnimeClick dava a Black Letter 6 e Rent a
  // Girlfriend 35 la copertina generica della serie, e la pagina Uscite mostrava il volume 1.
  const COVER_SERIE = "https://www.animeclick.it/immagini/manga/Kanojo_Okarishimasu/cover/Kanojo_Okarishimasu-cover.jpg";
  const MINIATURA = "https://www.animeclick.it/immagini/manga/Zatchbell/edizioni/Zatch%20Bell-edizione-3112746-thumb.jpg";

  prova("la copertina della serie non è del volume", null, copertinaDelVolume(COVER_SERIE));
  prova("la miniatura dell'edizione sì", MINIATURA, copertinaDelVolume(MINIATURA));
  prova("niente copertina, niente", null, copertinaDelVolume(null));

  const ZATCH = { ID: 4, Titolo: "Zatch Bell!", Edizione: null, Editore: "Star Comics", NumeriPosseduti: [1, 2, 3, 4, 5, 6], Costo: 6.9, CoverURL: null, SmessaIl: null };
  const conCopertine = [
    { data: "2026-11-25", serie: "Rent a Girlfriend", numero: 35, titolo: null, edizione: null, editore: "J-POP", copertina: COVER_SERIE },
    { data: "2026-11-25", serie: "Zatch Bell!", numero: 7, titolo: null, edizione: null, editore: "Star Comics", copertina: MINIATURA }
  ];
  const scritte = [];
  const poolCopertine = {
    query: async (sql, parametri) => {
      if (/INSERT INTO copertine_volumi/.test(sql)) {
        scritte.push(parametri);

        return { rowCount: parametri[0].length, rows: [] };
      }

      if (/FROM uscite_manga/.test(sql)) return { rows: conCopertine };
      if (/FROM copertine_volumi/.test(sql)) return { rows: [{ manga_id: 2, numero: 34 }, { manga_id: 4, numero: 6 }] };
      if (/LEFT JOIN copertine_giri/.test(sql)) return { rows: parametri[0].map((id) => ({ manga_id: id, animeclick_id: 1000 + id })) };

      return { rows: [RENT, ZATCH] };
    }
  };

  const viste = await usciteTra(poolCopertine, { dopo: "2026-11-01", fino: "2026-11-30", soloMie: true });

  prova(
    "nell'elenco delle uscite la copertina della serie sparisce, la miniatura resta",
    [["Rent a Girlfriend", null], ["Zatch Bell!", MINIATURA]],
    viste.map((u) => [u.serie.titolo, u.copertina])
  );

  prova("dal calendario si scrive in copertine_volumi solo la miniatura del volume", 1, await copertineDalleUscite(poolCopertine));
  prova("ed è quella di Zatch Bell! 7", [[4], [7], [MINIATURA]], scritte[0]);

  prova(
    "in testa al giro: le serie con un volume in uscita senza copertina",
    [2, 4],
    (await conUsciteSenzaCopertina(poolCopertine, 20)).map((r) => r.manga_id)
  );

  const senzaArchivio = { query: async () => { const e = new Error("relation \"uscite_manga\" does not exist"); e.code = "42P01"; throw e; } };

  prova("senza archivio delle uscite la coda resta quella di sempre", [], await conUsciteSenzaCopertina(senzaArchivio, 20));

  if (falliti) {
    console.log(`\n${falliti} prove fallite.\n`);
    process.exit(1);
  }

  console.log("\nTutte le prove passano.\n");
})();
