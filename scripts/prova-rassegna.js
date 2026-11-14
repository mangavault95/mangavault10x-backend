// Prove dell'anno in rassegna.
//
//   PROVA_DATABASE_URL=postgres://… node scripts/prova-rassegna.js
//
// Senza PROVA_DATABASE_URL girano solo le prove pure (giorni di fila, mesi). Con il database
// crea uno schema a parte con dati finti (anche a cavallo del 1° gennaio, in ora italiana) e lo butta.

const { rassegna, giorniDiFila, perMese, meseTop } = require("../services/rassegna");

let falliti = 0;
function prova(nome, atteso, ottenuto) {
  const bene = JSON.stringify(atteso) === JSON.stringify(ottenuto);
  console.log(`  ${bene ? "ok  " : "NO  "} ${nome}`);
  if (!bene) { falliti += 1; console.log(`       atteso:   ${JSON.stringify(atteso)}\n       ottenuto: ${JSON.stringify(ottenuto)}`); }
}

console.log("\nConti senza database");
prova("giorni di fila: niente", 0, giorniDiFila([]));
prova("giorni di fila: ripetuti e disordinati", 3, giorniDiFila(["2026-08-12", "2026-08-10", "2026-08-11", "2026-08-11", "2026-09-01"]));
prova("giorni di fila: a cavallo di fine mese", 3, giorniDiFila(["2026-10-30", "2026-10-31", "2026-11-01"]));
prova("giorni di fila: a cavallo dell'anno", 2, giorniDiFila(["2025-12-31", "2026-01-01"]));
prova("per mese: gennaio è l'indice 0", [0, 0, 5, ...Array(9).fill(0)], perMese([{ mese: 3, n: 5 }]));
prova("mese più intenso", 3, meseTop([0, 0, 5, 1, ...Array(8).fill(0)]));
prova("mese più intenso: tutto a zero", null, meseTop(Array(12).fill(0)));

(async () => {
  const url = process.env.PROVA_DATABASE_URL;
  if (!url) { console.log("\n(PROVA_DATABASE_URL non c'è: salto la parte che usa il database.)"); process.exit(falliti ? 1 : 0); }
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: url, ssl: /@(localhost|127\.0\.0\.1)[:/]/.test(url) ? false : { rejectUnauthorized: false } });
  await pool.query(`DROP SCHEMA IF EXISTS pr CASCADE; CREATE SCHEMA pr; SET search_path=pr;`);
  const c = await pool.connect(); await c.query("SET search_path=pr");
  await c.query(`
   CREATE TABLE utenti(id bigint primary key, nickname text, colore text);
   CREATE TABLE "Manga"("ID" int primary key,"Titolo" text,"CoverURL" text);
   CREATE TABLE reading_history(id serial, utente_id bigint, manga_id int, titolo text, coverurl text, volume int, read_at timestamptz);
   CREATE TABLE voti(manga_id bigint, utente_id bigint, voto numeric(2,1), aggiornato_il timestamptz);
   CREATE TABLE anime(id bigint primary key, titolo text, cover_url text, generi text[], durata_media int);
   CREATE TABLE anime_episodi(anime_id bigint, numero int, durata int);
   CREATE TABLE episodi_visti(anime_id bigint, numero int, utente_id bigint, visto_il timestamptz);
   CREATE TABLE visioni(anime_id bigint, utente_id bigint, stato text, finita_il timestamptz);
   CREATE TABLE voti_anime(anime_id bigint, utente_id bigint, voto numeric(2,1), aggiornato_il timestamptz);
   CREATE TABLE acquisti(id serial, manga_id int, volume_da int, volume_a int, prezzo numeric(10,2), data_acquisto date);
   INSERT INTO utenti VALUES (1,'Nicer','#fff'),(2,'Sara','#f0f');
   INSERT INTO "Manga" VALUES (10,'Berserk','c1'),(11,'Spy x Family','c2');
   INSERT INTO reading_history(utente_id,manga_id,titolo,volume,read_at) VALUES
     (1,10,'Berserk',1,'2026-08-10 10:00+02'),(1,10,'Berserk',2,'2026-08-11 22:00+02'),(1,10,'Berserk',3,'2026-08-12 09:00+02'),
     (1,11,'Spy x Family',1,'2026-09-01 12:00+02'),(2,11,'Spy x Family',1,'2026-09-02 12:00+02'),
     (1,10,'Berserk',4,'2025-12-31 23:30+01'),(1,10,'Berserk',5,'2026-01-01 00:30+01');
   INSERT INTO anime VALUES (1,'Frieren','a1',ARRAY['Fantasy','Avventura'],24),(2,'Dandadan','a2',ARRAY['Azione'],NULL);
   INSERT INTO anime_episodi VALUES (1,1,30);
   INSERT INTO episodi_visti VALUES (1,1,1,'2026-10-01 20:00+02'),(1,2,1,'2026-10-02 20:00+02'),(2,1,1,'2026-10-02 21:00+02'),(2,1,2,'2026-10-03 21:00+02');
   INSERT INTO visioni VALUES (1,1,'completa','2026-10-05 10:00+02');
   INSERT INTO voti VALUES (10,1,5,'2026-08-20 10:00+02'),(11,1,4.5,'2026-09-05 10:00+02');
   INSERT INTO voti_anime VALUES (1,1,4.5,'2026-10-06 10:00+02');
   INSERT INTO acquisti(manga_id,volume_da,volume_a,prezzo,data_acquisto) VALUES (10,1,3,19.5,'2026-08-09'),(11,NULL,NULL,5,'2026-09-30'),(10,4,NULL,6.5,'2025-12-30');`);
  const p = { query: (t, v) => c.query(t, v) };
  const a = await rassegna(p, { anno: 2026, utenteId: 1 });
  console.log("\nCon un database di prova (persona 1, anno 2026)");
  prova("volumi letti: conta anche l'1 gennaio a mezzanotte e mezza, in ora italiana", 5, a.manga.volumiLetti);
  prova("non conta il 31 dicembre", 2, a.manga.serieLette);
  prova("la serie più letta", ["Berserk", 4], [a.manga.topSerie[0].titolo, a.manga.topSerie[0].volumi]);
  prova("il mese più intenso delle letture", 8, a.manga.meseTop);
  prova("puntate viste e serie", [3, 2, 1], [a.anime.puntate, a.anime.serieViste, a.anime.serieFinite]);
  prova("ore: durata vera, media o 24 minuti", 1.3, a.anime.ore);
  prova("il giorno più intenso delle puntate", ["2026-10-02", 2], [a.anime.giornoTop.giorno, a.anime.giornoTop.n]);
  prova("acquisti: volumi e spesa dell'anno, senza il 2025", [4, 24.5, 2], [a.casa.volumi, a.casa.spesa, a.casa.serie]);
  prova("gli acquisti dicono di essere della casa", true, a.casa.casa);
  prova("giorni di fila e giorni attivi", [3, 7], [a.giorniDiFila, a.giorniAttivi]);
  prova("l'anno è intero (si parte dal 1 gennaio)", [false, "2026-01-01"], [a.parziale, a.primoGiorno]);
  const s = await rassegna(p, { anno: 2026, utenteId: 2 });
  prova("l'altra persona ha solo le sue letture e puntate", [1, 1], [s.manga.volumiLetti, s.anime.puntate]);
  prova("gli acquisti sono gli stessi per tutti e due", a.casa.volumi, s.casa.volumi);
  prova("una persona che non c'è: niente", null, await rassegna(p, { anno: 2026, utenteId: 99 }));
  c.release(); await pool.query("DROP SCHEMA pr CASCADE"); await pool.end();
  if (falliti) { console.log(`\n${falliti} prove fallite`); process.exit(1); }
  console.log("\nTutto a posto.");
})().catch(e => { console.error(e); process.exit(1); });
