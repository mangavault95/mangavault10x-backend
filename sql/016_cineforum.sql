-- ============================================================
-- 016 — IL CINEFORUM
--
-- La videoteca smette di essere una stanza chiusa a chiave.
--
-- Fino a qui ogni account aveva la sua videoteca e non c'era nessun
-- posto in cui vedere quella degli altri: le serie di Nanaki e quelle
-- di Nicer esistevano nello stesso database senza incontrarsi mai.
-- Il Cineforum è quel posto — una pagina sola dove si legge cosa
-- hanno fatto tutti, senza doversi seguire a vicenda.
--
-- ------------------------------------------------------------
-- LA DECISIONE CHE SPIEGA TUTTO IL RESTO: NIENTE TABELLA DEGLI EVENTI
--
-- Un feed si costruisce quasi sempre scrivendo una riga "è successa
-- questa cosa" ogni volta che succede. Qui no, e per tre ragioni:
--
--   1. Gli eventi ci sono GIÀ. `visioni`, `episodi_visti`,
--      `voti_anime` e `note_anime` hanno tutte una data. Copiarle in
--      una sesta tabella vorrebbe dire tenere d'accordo due verità
--      che possono divergere — e quando divergono, quella sbagliata
--      è sempre quella che si vede.
--   2. Il feed nasce PIENO. Le 81 serie in videoteca e ogni spunta
--      già data compaiono il giorno stesso in cui questa migrazione
--      gira. Con una tabella di eventi il Cineforum si sarebbe aperto
--      su una pagina vuota, che è il modo più sicuro di non tornarci.
--   3. Cancellare resta vero. Se tolgo una serie dalla videoteca, il
--      post che diceva che l'avevo aggiunta sparisce da sé: non c'è
--      niente da ripulire.
--
-- Quello che questa migrazione aggiunge è quindi solo ciò che dagli
-- eventi NON si ricava: i messaggi scritti a mano, i cuori, le
-- risposte, i preferiti — e una data che mancava.
--
-- ------------------------------------------------------------
-- LA CHIAVE DI UN POST
--
-- Cuori e risposte devono attaccarsi a qualcosa. Un messaggio scritto
-- ha una riga e quindi un id; un post automatico no — è il risultato
-- di un raggruppamento. Gli si dà allora una CHIAVE calcolata, che
-- resta la stessa a ogni lettura:
--
--     messaggio:<id>
--     giornata:<utente_id>:<AAAA-MM-GG>
--
-- Una sola giornata per persona, non una per tipo di evento: chi
-- aggiunge due serie, spunta quattro puntate e ne vota una, il
-- martedì, produce UN post. È quello che è stato chiesto ("se ne
-- aggiungessi più di una in un giorno saranno tutte in un unico
-- post"), ed è anche l'unico modo perché una giornata attiva non
-- occupi da sola tutta la pagina degli altri.
--
-- Il giorno si taglia sull'ORA ITALIANA e non su UTC: una puntata
-- vista alle 23:30 di martedì appartiene a martedì. In UTC sarebbe
-- ancora martedì d'inverno e già mercoledì d'estate, cioè un post che
-- cambia giorno a seconda della stagione.
-- ============================================================


-- ------------------------------------------------------------
-- 1. QUANDO UNA SERIE È ENTRATA IN VIDEOTECA
--
-- `visioni` sapeva dire quando una serie era stata cominciata
-- (`iniziata_il`), quando era finita (`finita_il`) e quando la riga
-- era stata toccata l'ultima volta (`aggiornata_il`) — ma non quando
-- era stata MESSA in videoteca, che è precisamente l'evento da
-- raccontare. `aggiornata_il` non basta: cambia a ogni spunta, e un
-- post "ha aggiunto Frieren" si sposterebbe in cima ogni volta che
-- guardo una puntata di Frieren.
--
-- Il riempimento delle righe già esistenti usa la data più antica che
-- si conosce di quella riga. Non è la verità storica — quella non
-- l'ha mai registrata nessuno — ma è l'unica stima che non collochi
-- un'aggiunta *dopo* la prima puntata vista.
-- ------------------------------------------------------------

ALTER TABLE visioni
  ADD COLUMN IF NOT EXISTS creata_il TIMESTAMPTZ NOT NULL DEFAULT NOW();

UPDATE visioni v
SET creata_il = LEAST(
      COALESCE(v.iniziata_il, v.aggiornata_il),
      v.aggiornata_il,
      COALESCE((SELECT MIN(ev.visto_il)
                  FROM episodi_visti ev
                 WHERE ev.anime_id = v.anime_id
                   AND ev.utente_id = v.utente_id), v.aggiornata_il)
    )
WHERE v.creata_il > v.aggiornata_il;

-- Il feed chiede sempre "cosa è successo di recente", mai "cosa è
-- successo a questa serie": l'indice sta sul tempo.
CREATE INDEX IF NOT EXISTS idx_visioni_creata ON visioni (creata_il DESC);
CREATE INDEX IF NOT EXISTS idx_visioni_finita ON visioni (finita_il DESC)
  WHERE finita_il IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_voti_anime_quando ON voti_anime (aggiornato_il DESC);
CREATE INDEX IF NOT EXISTS idx_note_anime_quando ON note_anime (creata_il DESC);


-- ------------------------------------------------------------
-- 2. I MESSAGGI
--
-- Quello che si scrive apposta, e che nessun evento potrebbe
-- dedurre: "stasera comincio Monster, qualcuno l'ha visto?".
--
-- `anime_id` è facoltativo e serve a una cosa sola: agganciare il
-- messaggio a una serie, così sotto compare la copertina e da lì si
-- entra nella scheda. ON DELETE SET NULL perché il messaggio resta
-- vero anche se quella serie esce dal catalogo.
--
-- `modificato_il` è NULL finché non si corregge: la differenza fra
-- "scritto" e "riscritto" va vista, o un messaggio cambiato dopo che
-- gli hanno risposto sembra la versione originale.
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS cineforum_messaggi (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  utente_id      BIGINT NOT NULL REFERENCES utenti(id) ON DELETE CASCADE,

  testo          TEXT NOT NULL CHECK (btrim(testo) <> ''),

  anime_id       BIGINT REFERENCES anime(id) ON DELETE SET NULL,

  creato_il      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modificato_il  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_messaggi_quando ON cineforum_messaggi (creato_il DESC);


-- ------------------------------------------------------------
-- 3. I CUORI
--
-- Una riga per (post, persona): mettere il cuore due volte è la
-- stessa cosa che metterlo una volta, e la chiave primaria lo dice
-- meglio di qualunque controllo nel codice.
--
-- `chiave` è testo e non una coppia di colonne perché i post sono di
-- due specie diverse — una riga vera e un raggruppamento calcolato —
-- e nessuna chiave esterna può puntare a entrambe. Il formato è
-- controllato dal vincolo qui sotto: senza, un errore di battitura
-- nel codice produrrebbe cuori appesi a un post che non esiste, e
-- nessuno se ne accorgerebbe mai.
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS cineforum_cuori (
  chiave     TEXT   NOT NULL
             CHECK (chiave ~ '^(messaggio:[0-9]+|giornata:[0-9]+:[0-9]{4}-[0-9]{2}-[0-9]{2})$'),

  utente_id  BIGINT NOT NULL REFERENCES utenti(id) ON DELETE CASCADE,

  messo_il   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (chiave, utente_id)
);


-- ------------------------------------------------------------
-- 4. LE RISPOSTE
--
-- Un filo piatto sotto il post, non un albero: siete in tre, e una
-- risposta a una risposta a una risposta è una struttura che serve a
-- moderare le folle.
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS cineforum_risposte (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  chiave         TEXT   NOT NULL
                 CHECK (chiave ~ '^(messaggio:[0-9]+|giornata:[0-9]+:[0-9]{4}-[0-9]{2}-[0-9]{2})$'),

  utente_id      BIGINT NOT NULL REFERENCES utenti(id) ON DELETE CASCADE,

  testo          TEXT   NOT NULL CHECK (btrim(testo) <> ''),

  creata_il      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modificata_il  TIMESTAMPTZ
);

-- Le risposte si leggono sempre insieme, per post e in ordine.
CREATE INDEX IF NOT EXISTS idx_risposte_chiave
  ON cineforum_risposte (chiave, creata_il);


-- ------------------------------------------------------------
-- 5. I PREFERITI
--
-- Il ripiano in fondo alla pagina personale: non "le serie che ho
-- votato 5" — quella è la classifica, e si ricava dai voti — ma le
-- poche che uno mette in vetrina, nell'ordine che decide lui.
--
-- Sono di ciascuno, come tutto il resto della videoteca: la vetrina
-- è il ritratto di chi la mette insieme.
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS anime_preferiti (
  anime_id     BIGINT NOT NULL REFERENCES anime(id)  ON DELETE CASCADE,
  utente_id    BIGINT NOT NULL REFERENCES utenti(id) ON DELETE CASCADE,

  -- Deciso a mano trascinando; NULL vuol dire "in fondo, in ordine di
  -- quando l'ho messo".
  ordine       INTEGER,

  aggiunto_il  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (anime_id, utente_id)
);

CREATE INDEX IF NOT EXISTS idx_preferiti_utente
  ON anime_preferiti (utente_id, ordine NULLS LAST, aggiunto_il);


-- ============================================================
-- VERIFICA — lancia dopo il Run
-- ============================================================

-- Le quattro tabelle nuove:
-- SELECT table_name FROM information_schema.tables
--  WHERE table_schema = 'public'
--    AND table_name IN ('cineforum_messaggi','cineforum_cuori',
--                       'cineforum_risposte','anime_preferiti')
--  ORDER BY table_name;

-- Nessuna riga deve avere l'aggiunta dopo l'ultimo aggiornamento:
-- SELECT COUNT(*) AS incoerenti FROM visioni WHERE creata_il > aggiornata_il;

-- Com'è fatto il feed che si aprirà, giorno per giorno:
-- WITH eventi AS (
--   SELECT utente_id, (creata_il  AT TIME ZONE 'Europe/Rome')::date AS g FROM visioni
--   UNION ALL
--   SELECT utente_id, (visto_il   AT TIME ZONE 'Europe/Rome')::date FROM episodi_visti
--   UNION ALL
--   SELECT utente_id, (finita_il  AT TIME ZONE 'Europe/Rome')::date FROM visioni WHERE finita_il IS NOT NULL
--   UNION ALL
--   SELECT utente_id, (aggiornato_il AT TIME ZONE 'Europe/Rome')::date FROM voti_anime
--   UNION ALL
--   SELECT utente_id, (creata_il  AT TIME ZONE 'Europe/Rome')::date FROM note_anime
-- )
-- SELECT u.nickname, e.g AS giorno, COUNT(*) AS eventi
--   FROM eventi e JOIN utenti u ON u.id = e.utente_id
--  GROUP BY u.nickname, e.g
--  ORDER BY e.g DESC
--  LIMIT 20;
