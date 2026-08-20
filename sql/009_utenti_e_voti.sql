-- ============================================================
-- MangaVault — Migrazione 009: due lettori, due voti
--
-- ESEGUIRE DOPO il 008.
--
-- COME ESEGUIRLO:
--   Supabase → SQL Editor → New query → incolla tutto → Run
--
-- Cosa cambia, in breve:
--   1. Esistono gli UTENTI. Il proprietario (Carmine) è la riga che
--      c'era già di fatto: le sue credenziali continuano a stare nelle
--      variabili d'ambiente di Render, qui prende solo un identificativo
--      e un soprannome. Chi si registra dal sito nasce "in_attesa" e
--      non entra finché il proprietario non lo approva.
--   2. Il VOTO non è più una colonna della serie ma una riga per
--      (serie, utente): due persone, due giudizi sulla stessa opera.
--      I voti già dati diventano quelli del proprietario.
--   3. I voti ammettono le MEZZE STELLE: 0.5, 1, 1.5 … 5.
--   4. LETTURE per persona: cronologia e segnalibri sanno di chi sono.
--      Tutto quello che c'è oggi è del proprietario.
--
-- Restano in comune, come richiesto: volumi posseduti, wishlist,
-- collezione, spesa. Cambiano solo i voti e le letture.
--
-- ⚠️  Modifica i dati e ELIMINA la colonna "Valutazione" (dopo averla
--     copiata in `voti`). Fai un backup prima:
--     Supabase → Database → Backups
-- ============================================================


-- ------------------------------------------------------------
-- 1. UTENTI
--
-- `username` è il nome con cui si entra, `nickname` quello che si
-- legge accanto al voto ("Voto Nicer"). Sono due cose diverse: il
-- primo si scrive, il secondo si mostra.
--
-- `stato` è il permesso di entrare, `ruolo` cosa si può fare una
-- volta dentro. Un registrato nasce senza né l'uno né l'altro.
-- `proprietario` è uno solo e non si approva da sé: è il padrone di
-- casa, l'unico che può accettare gli altri.
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS utenti (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  username       TEXT NOT NULL,
  nickname       TEXT NOT NULL,
  password_hash  TEXT NOT NULL DEFAULT '',

  ruolo          TEXT NOT NULL DEFAULT 'lettore'
                 CHECK (ruolo IN ('admin', 'lettore')),

  stato          TEXT NOT NULL DEFAULT 'in_attesa'
                 CHECK (stato IN ('in_attesa', 'attivo', 'rifiutato')),

  proprietario   BOOLEAN NOT NULL DEFAULT FALSE,

  creato_il      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deciso_il      TIMESTAMPTZ,
  visto_il       TIMESTAMPTZ
);

-- Il nome per entrare non fa distinzione fra maiuscole e minuscole:
-- "Nicer" e "nicer" sono la stessa persona, e due righe simili
-- sarebbero un modo silenzioso di rubare un accesso.
CREATE UNIQUE INDEX IF NOT EXISTS utenti_username_unico
  ON utenti (lower(username));

CREATE UNIQUE INDEX IF NOT EXISTS utenti_nickname_unico
  ON utenti (lower(nickname));

-- Un solo proprietario, garantito dal database e non dalle buone
-- intenzioni del codice.
CREATE UNIQUE INDEX IF NOT EXISTS utenti_un_solo_proprietario
  ON utenti (proprietario) WHERE proprietario;


-- ------------------------------------------------------------
-- 2. IL PROPRIETARIO
--
-- Nasce qui perché tutto il resto della migrazione ha bisogno del suo
-- identificativo. Username e password restano dove sono sempre stati
-- (le variabili ADMIN_USERNAME / ADMIN_PASSWORD_HASH su Render): il
-- backend le riversa in questa riga a ogni avvio, così cambiare la
-- password resta una cosa che si fa da Render e non da qui.
--
-- Il soprannome invece è di questa riga: si cambia con una UPDATE, o
-- dalla variabile ADMIN_NICKNAME.
-- ------------------------------------------------------------

INSERT INTO utenti (username, nickname, ruolo, stato, proprietario)
SELECT 'proprietario', 'Nicer', 'admin', 'attivo', TRUE
WHERE NOT EXISTS (SELECT 1 FROM utenti WHERE proprietario);


-- ------------------------------------------------------------
-- 3. VOTI — una riga per (serie, persona)
--
-- Mezze stelle: il vincolo accetta 0.5, 1, 1.5 … 5 e niente altro.
-- Non votato non è zero, è l'assenza della riga.
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS voti (
  -- BIGINT come "Manga"."ID" e come le altre tabelle collegate: un
  -- INTEGER qui funzionerebbe lo stesso, ma due tipi diversi ai capi
  -- della stessa relazione sono un inciampo che si paga più avanti.
  manga_id       BIGINT  NOT NULL REFERENCES "Manga"("ID") ON DELETE CASCADE,
  utente_id      BIGINT  NOT NULL REFERENCES utenti(id)    ON DELETE CASCADE,

  voto           NUMERIC(2,1) NOT NULL
                 CHECK (voto >= 0.5 AND voto <= 5 AND voto * 2 = ROUND(voto * 2)),

  aggiornato_il  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (manga_id, utente_id)
);

CREATE INDEX IF NOT EXISTS idx_voti_utente ON voti(utente_id);


-- I voti già dati diventano quelli del proprietario. Girare due volte
-- questo script non li duplica né li sovrascrive.
INSERT INTO voti (manga_id, utente_id, voto)
SELECT
  m."ID",
  (SELECT id FROM utenti WHERE proprietario),
  m."Valutazione"::numeric
FROM "Manga" m
WHERE m."Valutazione" IS NOT NULL
  AND m."Valutazione" > 0
ON CONFLICT (manga_id, utente_id) DO NOTHING;


-- ------------------------------------------------------------
-- 4. VIA LA VECCHIA COLONNA
--
-- Due copie dello stesso numero divergono sempre: se "Valutazione"
-- restasse, prima o poi direbbe una cosa diversa da `voti`. La vista
-- va buttata prima, perché la usa.
-- ------------------------------------------------------------

DROP VIEW IF EXISTS v_collezione_riepilogo;

ALTER TABLE "Manga" DROP CONSTRAINT IF EXISTS valutazione_1_5;
ALTER TABLE "Manga" DROP COLUMN IF EXISTS "Valutazione";


-- ------------------------------------------------------------
-- 5. LETTURE PER PERSONA
--
-- Cronologia e segnalibri prendono un proprietario. Quello che c'è
-- oggi è tutto di chi il sito ce l'ha da sempre.
--
-- Il segnalibro era unico per serie (`ON CONFLICT (manga_id)`): adesso
-- è unico per serie E persona, altrimenti chi legge il volume 3 di una
-- serie cancella il segnalibro dell'altro sullo stesso titolo.
-- ------------------------------------------------------------

ALTER TABLE reading_history
  ADD COLUMN IF NOT EXISTS utente_id BIGINT REFERENCES utenti(id) ON DELETE CASCADE;

ALTER TABLE reading_sessions
  ADD COLUMN IF NOT EXISTS utente_id BIGINT REFERENCES utenti(id) ON DELETE CASCADE;

UPDATE reading_history
SET utente_id = (SELECT id FROM utenti WHERE proprietario)
WHERE utente_id IS NULL;

UPDATE reading_sessions
SET utente_id = (SELECT id FROM utenti WHERE proprietario)
WHERE utente_id IS NULL;

ALTER TABLE reading_history  ALTER COLUMN utente_id SET NOT NULL;
ALTER TABLE reading_sessions ALTER COLUMN utente_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_history_utente  ON reading_history(utente_id);
CREATE INDEX IF NOT EXISTS idx_sessions_utente ON reading_sessions(utente_id);


-- Il vincolo di unicità del segnalibro passa da (manga) a (manga, utente).
-- Il nome del vincolo vecchio dipende da come fu creato, quindi lo cerco
-- invece di indovinarlo.
DO $blocco$
DECLARE
  nome TEXT;
BEGIN
  SELECT con.conname INTO nome
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  WHERE rel.relname = 'reading_sessions'
    AND con.contype IN ('u', 'p')
    AND con.conkey = ARRAY[
      (SELECT attnum FROM pg_attribute
       WHERE attrelid = rel.oid AND attname = 'manga_id')
    ]::smallint[];

  IF nome IS NOT NULL THEN
    EXECUTE format('ALTER TABLE reading_sessions DROP CONSTRAINT %I', nome);
    RAISE NOTICE 'Rimosso il vincolo % (era: un segnalibro per serie)', nome;
  END IF;
END
$blocco$;

CREATE UNIQUE INDEX IF NOT EXISTS reading_sessions_serie_utente
  ON reading_sessions (manga_id, utente_id);


-- ------------------------------------------------------------
-- 6. VISTA RICREATA
--
-- Uguale a prima meno "Valutazione", più la media dei voti dati:
-- con due lettori "il voto" della serie non esiste più come numero
-- singolo, ma la media è ancora una cosa sensata da chiedere.
-- ------------------------------------------------------------

CREATE VIEW v_collezione_riepilogo AS
SELECT
  m."ID",
  m."Titolo",
  m."Autore",
  m."Disegnatore",
  m."Editore",
  m."Genere",
  m."CoverURL",
  m."VolumiPosseduti",
  m."VolumiTotali",
  m."StatoSerie",
  m."Preferito",
  m."Costo"                                      AS prezzo_volume,

  (SELECT ROUND(AVG(v.voto), 2) FROM voti v WHERE v.manga_id = m."ID")
                                                 AS voto_medio,

  ROUND((m."Costo" * COALESCE(m."VolumiPosseduti", 0))::numeric, 2)
                                                 AS spesa_stimata,

  COALESCE(SUM(a.prezzo), 0)                     AS spesa_registrata,
  COUNT(a.id)                                    AS numero_acquisti,
  MAX(a.data_acquisto)                           AS ultimo_acquisto,

  CASE
    WHEN m."VolumiTotali" > 0
    THEN ROUND(100.0 * COALESCE(m."VolumiPosseduti", 0) / m."VolumiTotali", 1)
    ELSE NULL
  END                                            AS completamento_pct,

  GREATEST(COALESCE(m."VolumiTotali", 0) - COALESCE(m."VolumiPosseduti", 0), 0)
                                                 AS volumi_mancanti,

  (m."Trama" IS NULL)                            AS trama_mancante,

  (m."Editore" IS NULL
   OR m."Costo" IS NULL OR m."Costo" = 0
   OR m."Trama" IS NULL
   OR m."VolumiTotali" IS NULL)                  AS scheda_incompleta

FROM "Manga" m
LEFT JOIN acquisti a ON a.manga_id = m."ID"
GROUP BY m."ID";


-- ============================================================
-- VERIFICA — lancia dopo il Run
-- ============================================================

-- SELECT id, username, nickname, ruolo, stato, proprietario FROM utenti;
-- SELECT COUNT(*) AS voti_migrati FROM voti;
-- SELECT utente_id, COUNT(*) FROM reading_history GROUP BY utente_id;
