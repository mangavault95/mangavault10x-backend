-- ============================================================
-- 017 — LA FACCIA E LO STRISCIONE
--
-- Fino a qui una persona era una lettera dentro una forma colorata.
-- Funzionava — il colore basta a riconoscere chi ha scritto una nota
-- — ma una pagina personale con in cima un'iniziale non è la pagina
-- di qualcuno: è un segnaposto in attesa che qualcuno la riempia.
--
-- Adesso ciascuno può mettere una FACCIA (un'immagine tonda, presa dal
-- telefono o ritagliata da una copertina della propria videoteca) e
-- uno STRISCIONE, cioè la fascia dietro: una o più immagini che si
-- alternano piano.
--
-- ------------------------------------------------------------
-- PERCHÉ LE IMMAGINI STANNO NEL DATABASE
--
-- La strada normale sarebbe un servizio di archiviazione (Supabase
-- Storage, un bucket S3). Qui no, per due ragioni che valgono più
-- della purezza architetturale:
--
--   1. DEVE RESTARE TUTTO GRATIS. Un bucket vuol dire un'altra chiave
--      da tenere in vita, un altro servizio che può cambiare piano, e
--      un secondo posto dove i dati di casa vivono.
--   2. SONO QUATTRO PERSONE. Una faccia ridotta a 512 pixel pesa una
--      trentina di kilobyte, uno striscione un paio di etti: anche
--      riempiendo tutti e sei i posti dello striscione, una persona
--      occupa poco più di un megabyte. Il piano gratuito di Supabase
--      ne dà cinquecento.
--
-- Le immagini si conservano come BYTEA e NON come data URI dentro una
-- colonna di testo. La differenza conta: un data URI è base64, cioè un
-- terzo di peso in più, e soprattutto finirebbe dentro le risposte
-- JSON — ripetuto in ogni post del Cineforum, dove la stessa faccia
-- compare quindici volte per pagina. Come BYTEA invece esce da un
-- indirizzo suo (`/api/utenti/<id>/faccia`), il browser la scarica una
-- volta e se la tiene.
-- ============================================================


-- ------------------------------------------------------------
-- 1. LA FACCIA
--
-- Una sola per persona, quindi tre colonne sulla riga che c'è già e
-- non una tabella a parte.
--
-- `faccia_il` non è un dettaglio di cronaca: è il numero che va
-- appeso all'indirizzo dell'immagine (`?v=…`). Senza, il browser che
-- ha già in cache la faccia vecchia continuerebbe a mostrarla per un
-- anno dopo che l'hai cambiata — e cambiare foto profilo senza vederla
-- cambiare è il modo più sicuro di farlo tre volte.
-- ------------------------------------------------------------

ALTER TABLE utenti
  ADD COLUMN IF NOT EXISTS faccia       BYTEA,
  ADD COLUMN IF NOT EXISTS faccia_tipo  TEXT,
  ADD COLUMN IF NOT EXISTS faccia_il    TIMESTAMPTZ;

-- Il tipo esiste solo se l'immagine esiste, e viceversa: una riga con
-- i byte e senza tipo si servirebbe con l'intestazione sbagliata.
ALTER TABLE utenti DROP CONSTRAINT IF EXISTS faccia_intera;

ALTER TABLE utenti ADD CONSTRAINT faccia_intera CHECK (
  (faccia IS NULL AND faccia_tipo IS NULL AND faccia_il IS NULL)
  OR (faccia IS NOT NULL AND faccia_tipo IS NOT NULL AND faccia_il IS NOT NULL)
);


-- ------------------------------------------------------------
-- 2. LO STRISCIONE
--
-- Una tabella e non un array di colonne, perché le immagini sono
-- «una o più» e il numero cambia: chi ne mette tre oggi ne toglie una
-- domani, e l'ordine con cui si alternano è una decisione sua.
--
-- Il tetto di quante ne stanno dentro non è nel database ma nel
-- codice: è una regola di prodotto («sei bastano») e non un vincolo di
-- integrità, e messa qui costringerebbe a una migrazione per cambiare
-- idea.
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS utenti_striscione (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  utente_id  BIGINT  NOT NULL REFERENCES utenti(id) ON DELETE CASCADE,

  -- Il posto nella successione. Si riscrive per intero a ogni
  -- modifica: riordinare tre immagini è un gesto solo, non tre.
  ordine     INTEGER NOT NULL DEFAULT 0,

  immagine   BYTEA   NOT NULL,
  tipo       TEXT    NOT NULL,

  messa_il   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- L'unica lettura che si fa: lo striscione di una persona, in ordine.
CREATE INDEX IF NOT EXISTS idx_striscione_utente
  ON utenti_striscione (utente_id, ordine, id);


-- ============================================================
-- VERIFICA — lancia dopo il Run
-- ============================================================

-- Le colonne nuove e la tabella nuova:
-- SELECT column_name FROM information_schema.columns
--  WHERE table_name = 'utenti' AND column_name LIKE 'faccia%';
-- SELECT COUNT(*) FROM utenti_striscione;

-- Quanto pesano davvero, quando ce ne saranno:
-- SELECT u.nickname,
--        pg_size_pretty(COALESCE(length(u.faccia), 0)::bigint)          AS faccia,
--        (SELECT COUNT(*) FROM utenti_striscione s WHERE s.utente_id = u.id) AS immagini,
--        pg_size_pretty(COALESCE(
--          (SELECT SUM(length(s.immagine)) FROM utenti_striscione s
--            WHERE s.utente_id = u.id), 0)::bigint)                     AS striscione
--   FROM utenti u ORDER BY u.creato_il;
