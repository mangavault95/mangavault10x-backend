-- ============================================================
-- MangaVault — Migrazione 010: la categoria e il Kachinuki-sen
--
-- ESEGUIRE DOPO il 009.
--
-- COME ESEGUIRLO:
--   Supabase → SQL Editor → New query → incolla tutto → Run
--
-- Cosa cambia, in breve:
--   1. Ogni serie prende una CATEGORIA (shonen, shojo, seinen,
--      josei, kodomo): il pubblico a cui l'opera è stata scritta.
--      Non è un genere e non va nella colonna "Genere" — "Drama" dice
--      di cosa parla, "seinen" dice per chi è stato scritto, e
--      mescolarli renderebbe impossibile chiedere l'uno senza l'altro.
--      La colonna nasce vuota: la riempie
--      `node scripts/categorie.js --scrivi`, leggendola da AnimeClick.
--   2. Nascono i TORNEI: il Kachinuki-sen (勝ち抜き戦, "torneo a
--      eliminazione"). Si sfidano due serie alla volta, chi vince
--      passa, e alla fine ne resta una. Ogni partita giocata resta
--      scritta per intero — chi ha incontrato chi, e chi è passato.
--
-- Non tocca nessun dato esistente: aggiunge una colonna vuota e tre
-- tabelle nuove.
-- ============================================================


-- ------------------------------------------------------------
-- 1. LA CATEGORIA
--
-- I valori sono un elenco chiuso e in minuscolo, come `StatoSerie`:
-- la scritta che si legge sul sito la decide il browser, qui dentro
-- sta il codice. Senza il vincolo, la stessa cosa finirebbe scritta
-- "Shounen", "shonen" e "Shōnen" a seconda di chi l'ha inserita, e
-- ognuna sparirebbe dai filtri delle altre due.
--
-- `adulto` non è un pubblico come gli altri: è quello che AnimeClick
-- scrive ("Pubblico Adulto") quando non dichiara nient'altro. Si usa
-- solo in quel caso, mai insieme a una categoria vera.
-- ------------------------------------------------------------

ALTER TABLE "Manga" ADD COLUMN IF NOT EXISTS "Categoria" TEXT;

ALTER TABLE "Manga" DROP CONSTRAINT IF EXISTS categoria_nota;

ALTER TABLE "Manga" ADD CONSTRAINT categoria_nota
  CHECK ("Categoria" IS NULL OR "Categoria" IN
    ('kodomo', 'shonen', 'shojo', 'seinen', 'josei', 'adulto'));

CREATE INDEX IF NOT EXISTS idx_manga_categoria ON "Manga" ("Categoria");


-- ------------------------------------------------------------
-- 2. LE PARTITE
--
-- `tema` è il codice del tema sorteggiato ("disegni"), `tema_etichetta`
-- come si leggeva quel giorno ("Disegni migliori"). Sembrano la stessa
-- cosa e non lo sono: i temi vivono nel browser e cambieranno — ne
-- verranno aggiunti, altri saranno riscritti — e una partita del mese
-- scorso deve continuare a dire sotto quale domanda fu giocata, non
-- quella che porta oggi lo stesso codice.
--
-- `utente_id` è chi ha giocato. Le partite si vedono tutte, come i
-- voti: sapere che l'altra persona ha fatto vincere un titolo diverso
-- col medesimo tema è metà del divertimento.
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tornei (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  utente_id       BIGINT NOT NULL REFERENCES utenti(id) ON DELETE CASCADE,

  tema            TEXT NOT NULL,
  tema_etichetta  TEXT NOT NULL,

  taglia          INT NOT NULL CHECK (taglia IN (32, 64, 128)),

  -- Il vincitore è un numero e basta, senza vincolo verso "Manga":
  -- vedi il blocco 3 qui sotto, vale per la stessa ragione.
  vincitore_id    BIGINT NOT NULL,

  giocato_il      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tornei_utente ON tornei(utente_id);
CREATE INDEX IF NOT EXISTS idx_tornei_data   ON tornei(giocato_il DESC);


-- ------------------------------------------------------------
-- 3. CHI È SCESO IN CAMPO
--
-- Titolo e copertina sono copiati qui dentro, non letti da "Manga" al
-- momento di mostrarli. È una duplicazione voluta, e l'unica del
-- progetto: una partita è il verbale di una serata: se domani una
-- scheda viene cancellata, o cambia titolo perché è uscita una nuova
-- edizione, il verbale deve continuare a dire chi giocò davvero.
--
-- Per la stessa ragione `manga_id` NON ha un vincolo verso "Manga":
-- con ON DELETE CASCADE cancellare una scheda cancellerebbe partite
-- intere, con SET NULL le spezzerebbe. Qui una serie cancellata resta
-- nel tabellone col suo nome — semplicemente non si può più cliccare.
--
-- `seme` è la posizione nel tabellone iniziale (0, 1, 2...): le due
-- serie che si incontrano al primo turno sono quelle di posto 0 e 1,
-- poi 2 e 3, e così via.
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS torneo_serie (
  torneo_id   BIGINT NOT NULL REFERENCES tornei(id) ON DELETE CASCADE,
  manga_id    BIGINT NOT NULL,

  titolo      TEXT NOT NULL,
  copertina   TEXT,

  seme        INT  NOT NULL,

  PRIMARY KEY (torneo_id, manga_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS torneo_serie_seme
  ON torneo_serie (torneo_id, seme);


-- ------------------------------------------------------------
-- 4. GLI SCONTRI
--
-- `turno` 1 è il primo, `posizione` è il posto della sfida dentro il
-- turno (da 0 in su). Da queste due coordinate si ricostruisce tutto
-- il tabellone: chi vince la sfida (t, p) va a giocare la sfida
-- (t + 1, p / 2 arrotondato per difetto).
--
-- I tre riferimenti puntano a `torneo_serie` e non a "Manga" per la
-- ragione detta sopra, e il vincolo composto sul torneo impedisce che
-- una sfida schieri una serie che a quel torneo non ha partecipato.
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sfide (
  torneo_id     BIGINT NOT NULL REFERENCES tornei(id) ON DELETE CASCADE,

  turno         INT NOT NULL CHECK (turno >= 1),
  posizione     INT NOT NULL CHECK (posizione >= 0),

  casa_id       BIGINT NOT NULL,
  ospite_id     BIGINT NOT NULL,
  vincitore_id  BIGINT NOT NULL,

  PRIMARY KEY (torneo_id, turno, posizione),

  FOREIGN KEY (torneo_id, casa_id)      REFERENCES torneo_serie(torneo_id, manga_id) ON DELETE CASCADE,
  FOREIGN KEY (torneo_id, ospite_id)    REFERENCES torneo_serie(torneo_id, manga_id) ON DELETE CASCADE,
  FOREIGN KEY (torneo_id, vincitore_id) REFERENCES torneo_serie(torneo_id, manga_id) ON DELETE CASCADE,

  -- Nessuno gioca contro sé stesso, e vince uno dei due che erano in
  -- campo. Il server controlla già l'intero tabellone prima di
  -- scrivere; questo è il controllo che resta anche se un giorno
  -- qualcuno scrive qui dentro da un'altra parte.
  CHECK (casa_id <> ospite_id),
  CHECK (vincitore_id IN (casa_id, ospite_id))
);


-- ============================================================
-- VERIFICA — lancia dopo il Run
-- ============================================================

-- SELECT COUNT(*) FILTER (WHERE "Categoria" IS NOT NULL) AS con_categoria FROM "Manga";
-- SELECT * FROM tornei ORDER BY giocato_il DESC LIMIT 5;
