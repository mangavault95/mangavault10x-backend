-- ============================================================
-- MangaVault — Migrazione 013: la Videoteca
--
-- ESEGUIRE DOPO il 012.
--
-- COME ESEGUIRLO:
--   Supabase → SQL Editor → New query → incolla tutto → Run
--
-- Cosa aggiunge: gli anime visti, gli episodi spuntati uno per uno,
-- i voti e i commenti — alla serie intera o alla singola puntata — e
-- le uscite dei prossimi episodi in Italia.
--
-- NON tocca niente di quello che c'è: nessuna colonna eliminata,
-- nessun dato riscritto, "Manga" resta com'è. Si può eseguire a sito
-- acceso e senza backup.
--
-- Le regole di casa restano quelle di sempre (vedi 009 e 011): quello
-- che si POSSIEDE è in comune, quello che si PENSA è di ciascuno. Qui
-- non si possiede niente — un anime non sta su uno scaffale — quindi
-- è di ciascuno praticamente tutto: dove sei arrivato, il voto, le
-- note, l'aver mollato.
--
-- ------------------------------------------------------------
-- LE DUE DECISIONI CHE SPIEGANO QUESTO SCHEMA
--
-- 1. UNA RIGA PER FRANCHISE, NON PER STAGIONE.
--    AnimeClick tiene una scheda sola per serie e numera in continuo:
--    "L'attacco dei giganti" è 89 episodi in un elenco unico, non
--    quattro schede da 25+12+16+... AniList invece apre un media per
--    stagione (Frieren: 28 in una, il resto in un'altra) e i due
--    conteggi non combaciano mai — 38 contro 28 sulla stessa opera.
--    Siccome la videoteca deve mostrare una copertina sola per serie,
--    e siccome i numeri di AnimeClick sono già quelli italiani, il
--    padrone della numerazione è ANIMECLICK. Una scheda = una riga.
--
-- 2. NIENTE INGLESE QUI DENTRO.
--    Ogni testo — titolo, trama, generi, titoli degli episodi, stato,
--    piattaforma — arriva da AnimeClick, che li ha già in italiano.
--    Ad AniList resta un mestiere solo: la copertina ad alta
--    risoluzione, che è un'immagine e non ha lingua. Se un domani un
--    testo italiano mancasse, si traduce (services/translate) invece
--    di scriverlo in inglese.
-- ============================================================


-- ------------------------------------------------------------
-- 1. GLI ANIME
--
-- `animeclick_id` è la chiave vera: è l'unico numero che permette di
-- ritrovare la scheda e di rileggerla fra sei mesi. È UNIQUE perché
-- due righe per la stessa scheda vorrebbero dire due progressi diversi
-- sulla stessa serie.
--
-- `anilist_id` può restare NULL: serve solo ad andare a prendere la
-- copertina grande, e non tutte le schede trovano il loro corrispettivo.
--
-- `episodi_totali` è un numero, `episodi_dichiarati` è quello che dice
-- AnimeClick alla lettera. Non è ridondanza: la scheda di Chainsaw Man
-- scrive «12+2» (serie più special), e buttare via quel «+2» per
-- salvare un intero significa non sapere più da dove veniva il 12.
--
-- `manga_id` è il ponte con la collezione di carta: è quello che
-- permette alla scheda di dire "sei al volume 12, l'anime arriva al 9".
-- ON DELETE SET NULL e non CASCADE: se un giorno il manga esce dalla
-- collezione, l'anime visto resta visto.
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS anime (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  animeclick_id       INTEGER NOT NULL UNIQUE,
  anilist_id          INTEGER,

  titolo              TEXT NOT NULL,          -- come lo elenca AnimeClick, in italiano
  titolo_originale    TEXT,
  titolo_inglese      TEXT,

  -- I tipi sono quelli della voce "Categoria" della scheda, ridotti
  -- alle cinque forme che contano. Un film è un anime con un episodio
  -- solo: cambia la parola sulla scheda, non il modello.
  tipo                TEXT NOT NULL DEFAULT 'serie_tv'
                      CHECK (tipo IN ('serie_tv', 'film', 'ova', 'ona', 'special')),

  anno_inizio         INTEGER,
  anno_fine           INTEGER,
  stagioni            TEXT,                   -- "Autunno (2023) [...] Inverno (2026)"

  episodi_totali      INTEGER CHECK (episodi_totali IS NULL OR episodi_totali >= 0),
  episodi_dichiarati  TEXT,
  durata_media        INTEGER,                -- minuti, dalla colonna Durata degli episodi

  -- Gli stessi valori di "Manga"."StatoSerie", più `in_pausa`: gli
  -- anime la pausa fra una stagione e l'altra ce l'hanno per mestiere,
  -- e chiamarla "interrotta" direbbe un'altra cosa.
  stato               TEXT NOT NULL DEFAULT 'in_corso'
                      CHECK (stato IN ('conclusa', 'in_corso', 'in_pausa', 'inedita', 'interrotta')),

  -- Lo stato italiano non è un fatto solo: doppiaggio e sottotitoli
  -- viaggiano separati ("Doppiaggio in pausa, Sottotitoli completato").
  -- Si conserva la frase intera perché è già la risposta alla domanda
  -- che uno si fa — "posso vederlo in italiano?".
  stato_italia        TEXT,

  generi              TEXT[] NOT NULL DEFAULT '{}',   -- in italiano: Avventura, Combattimento…
  distributori        TEXT[] NOT NULL DEFAULT '{}',   -- Crunchyroll, Netflix, Prime Video…

  trama               TEXT,
  cover_url           TEXT,

  manga_id            BIGINT REFERENCES "Manga"("ID") ON DELETE SET NULL,

  -- Quando abbiamo riletto la scheda. Serve al lavoro di aggiornamento
  -- per sapere chi rileggere e chi lasciare stare: le serie concluse
  -- non cambiano mai più.
  letto_il            TIMESTAMPTZ,
  creato_il           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  aggiornato_il       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- La videoteca si apre in ordine di titolo e si filtra per stato:
-- sono le due domande che fa ogni volta.
CREATE INDEX IF NOT EXISTS idx_anime_titolo ON anime (lower(titolo));
CREATE INDEX IF NOT EXISTS idx_anime_stato  ON anime (stato);
CREATE INDEX IF NOT EXISTS idx_anime_manga  ON anime (manga_id) WHERE manga_id IS NOT NULL;


-- ------------------------------------------------------------
-- 2. GLI EPISODI
--
-- Una riga per puntata, con il titolo italiano che AnimeClick pubblica
-- nella tabella `table-episodi`.
--
-- `uscita_italia` e `piattaforma` NON vengono dalla scheda ma dal
-- calendario (/calendario-anime), che è l'unico posto dove c'è scritto
-- "venerdì 15:30 su Crunchyroll". Per gli episodi già usciti restano
-- spesso vuoti, ed è giusto così: la data serve a sapere cosa esce,
-- non cosa è uscito nel 2013.
--
-- Perché l'unicità è PARZIALE (`WHERE numero > 0`): le serie lunghe
-- elencano in cima gli special senza numero, e AnimeClick li marca
-- tutti "Ep. 0" — One Piece ne ha diversi. Un vincolo secco su
-- (anime, numero) rifiuterebbe il secondo e farebbe fallire l'intera
-- importazione di una serie da 1197 righe per colpa di tre righe
-- fuori scala.
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS anime_episodi (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  anime_id       BIGINT NOT NULL REFERENCES anime(id) ON DELETE CASCADE,

  numero         INTEGER NOT NULL CHECK (numero >= 0),
  titolo         TEXT,
  durata         INTEGER,

  animeclick_id  INTEGER,                    -- id della pagina /episodio/<id>/

  uscita_italia  TIMESTAMPTZ,
  piattaforma    TEXT,

  creato_il      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  aggiornato_il  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS anime_episodi_numerati
  ON anime_episodi (anime_id, numero) WHERE numero > 0;

CREATE INDEX IF NOT EXISTS idx_episodi_anime ON anime_episodi (anime_id, numero);

-- Il calendario chiede sempre "cosa esce da qui a domenica", mai
-- "quando è uscito questo": l'indice sta sulle uscite che esistono.
CREATE INDEX IF NOT EXISTS idx_episodi_uscita
  ON anime_episodi (uscita_italia) WHERE uscita_italia IS NOT NULL;


-- ------------------------------------------------------------
-- 3. CHI GUARDA COSA
--
-- Una riga per (anime, persona), come `voti` e come `letture_droppate`.
-- Lo stato è uno solo e cambia nel tempo: un flag per ogni condizione
-- avrebbe voluto dire poter essere "in visione" e "droppata" insieme.
--
-- `droppata` sta fra gli stati e non in una tabella a parte come per i
-- manga: lì la scelta nacque da una colonna di "Manga" da smontare,
-- qui si parte puliti e mollare una serie è semplicemente uno dei modi
-- in cui una visione può finire.
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS visioni (
  anime_id       BIGINT NOT NULL REFERENCES anime(id)  ON DELETE CASCADE,
  utente_id      BIGINT NOT NULL REFERENCES utenti(id) ON DELETE CASCADE,

  stato          TEXT NOT NULL DEFAULT 'in_visione'
                 CHECK (stato IN ('da_vedere', 'in_visione', 'in_pausa', 'droppata', 'completa')),

  iniziata_il    TIMESTAMPTZ,
  finita_il      TIMESTAMPTZ,
  aggiornata_il  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (anime_id, utente_id)
);

-- "Cosa sto guardando io" è la domanda di ogni apertura della sezione.
CREATE INDEX IF NOT EXISTS idx_visioni_utente ON visioni (utente_id, stato);


-- ------------------------------------------------------------
-- 4. GLI EPISODI SPUNTATI
--
-- È insieme la cronologia e il segnalibro: dove sei arrivato è il
-- numero più alto spuntato, e da queste righe escono gratis "quante
-- ore ho guardato a marzo" e "cosa ho visto ieri".
--
-- La riga punta al NUMERO, non all'id dell'episodio. È una scelta, non
-- una scorciatoia: la lista degli episodi la rileggiamo da AnimeClick
-- ogni tanto, e se un giorno la rigenerassimo gli id cambierebbero
-- portandosi dietro tutte le spunte. Il numero invece è quello che hai
-- visto tu, e resta vero anche se la pagina altrui cambia forma.
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS episodi_visti (
  anime_id   BIGINT  NOT NULL REFERENCES anime(id)  ON DELETE CASCADE,
  numero     INTEGER NOT NULL CHECK (numero >= 0),
  utente_id  BIGINT  NOT NULL REFERENCES utenti(id) ON DELETE CASCADE,

  visto_il   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (anime_id, numero, utente_id)
);

-- La cronologia per data ("cosa ho guardato questa settimana") e il
-- conteggio per persona.
CREATE INDEX IF NOT EXISTS idx_visti_utente_data ON episodi_visti (utente_id, visto_il DESC);


-- ------------------------------------------------------------
-- 5. I VOTI
--
-- Copia esatta di `voti`, mezze stelle comprese: 0,5 … 5 e niente
-- altro. Non votato non è zero, è l'assenza della riga.
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS voti_anime (
  anime_id       BIGINT NOT NULL REFERENCES anime(id)  ON DELETE CASCADE,
  utente_id      BIGINT NOT NULL REFERENCES utenti(id) ON DELETE CASCADE,

  voto           NUMERIC(2,1) NOT NULL
                 CHECK (voto >= 0.5 AND voto <= 5 AND voto * 2 = ROUND(voto * 2)),

  aggiornato_il  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (anime_id, utente_id)
);

CREATE INDEX IF NOT EXISTS idx_voti_anime_utente ON voti_anime (utente_id);


-- ------------------------------------------------------------
-- 6. I COMMENTI
--
-- Una tabella sola per i due tipi di commento chiesti: `numero_episodio`
-- vuoto vuol dire che stai parlando della serie, valorizzato vuol dire
-- che stai parlando di quella puntata. Due tabelle avrebbero
-- significato scrivere due volte lo stesso codice per leggere la
-- stessa cosa.
--
-- Il colore di chi scrive esiste già in `utenti.colore` (migrazione
-- 012): qui non si ripete.
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS note_anime (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  anime_id          BIGINT  NOT NULL REFERENCES anime(id)  ON DELETE CASCADE,
  utente_id         BIGINT  NOT NULL REFERENCES utenti(id) ON DELETE CASCADE,

  numero_episodio   INTEGER CHECK (numero_episodio IS NULL OR numero_episodio >= 0),

  testo             TEXT NOT NULL CHECK (btrim(testo) <> ''),

  -- Un commento che racconta il finale non va letto per sbaglio da chi
  -- è indietro: la scheda lo tiene coperto finché non si tocca.
  spoiler           BOOLEAN NOT NULL DEFAULT FALSE,

  creata_il         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  aggiornata_il     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Le due letture che fa la scheda: tutte le note della serie, e le
-- note di una puntata mentre la si guarda.
CREATE INDEX IF NOT EXISTS idx_note_anime    ON note_anime (anime_id);
CREATE INDEX IF NOT EXISTS idx_note_anime_ep ON note_anime (anime_id, numero_episodio)
  WHERE numero_episodio IS NOT NULL;


-- ------------------------------------------------------------
-- 7. LA VISTA DI RIEPILOGO
--
-- Quello che la griglia della videoteca mostra senza sapere chi sei:
-- il progresso e il voto per persona li chiede la pagina, perché
-- dipendono da chi ha fatto l'accesso.
--
-- `episodi_disponibili` non è `episodi_totali`: il primo è quanti
-- AnimeClick ne ha davvero elencati, il secondo quanti la scheda ne
-- dichiara. Su una serie in corso i due numeri sono diversi, ed è la
-- differenza che dice "ne mancano ancora".
-- ------------------------------------------------------------

CREATE OR REPLACE VIEW v_videoteca AS
SELECT
  a.id,
  a.titolo,
  a.tipo,
  a.stato,
  a.stato_italia,
  a.anno_inizio,
  a.cover_url,
  a.generi,
  a.distributori,
  a.manga_id,

  a.episodi_totali,
  (SELECT COUNT(*) FROM anime_episodi e WHERE e.anime_id = a.id)           AS episodi_disponibili,

  (SELECT ROUND(AVG(v.voto), 2) FROM voti_anime v WHERE v.anime_id = a.id) AS voto_medio,
  (SELECT COUNT(*) FROM note_anime n WHERE n.anime_id = a.id)              AS note,

  (SELECT MIN(e.uscita_italia)
     FROM anime_episodi e
    WHERE e.anime_id = a.id
      AND e.uscita_italia > NOW())                                         AS prossima_uscita,

  (SELECT e.numero
     FROM anime_episodi e
    WHERE e.anime_id = a.id
      AND e.uscita_italia > NOW()
    ORDER BY e.uscita_italia
    LIMIT 1)                                                               AS prossimo_episodio,

  (a.trama IS NULL OR a.cover_url IS NULL)                                 AS scheda_incompleta

FROM anime a;


-- ============================================================
-- VERIFICA — lancia dopo il Run
-- ============================================================

-- Le sei tabelle devono esserci tutte:
-- SELECT table_name FROM information_schema.tables
--  WHERE table_schema = 'public'
--    AND table_name IN ('anime','anime_episodi','visioni','episodi_visti',
--                       'voti_anime','note_anime')
--  ORDER BY table_name;

-- SELECT COUNT(*) AS anime FROM anime;
-- SELECT COUNT(*) AS episodi FROM anime_episodi;

-- Dove sei arrivato, per persona (risponderà quando ci saranno le spunte):
-- SELECT u.nickname, a.titolo, MAX(v.numero) AS episodio
--   FROM episodi_visti v
--   JOIN anime  a ON a.id = v.anime_id
--   JOIN utenti u ON u.id = v.utente_id
--  GROUP BY u.nickname, a.titolo
--  ORDER BY u.nickname, a.titolo;
