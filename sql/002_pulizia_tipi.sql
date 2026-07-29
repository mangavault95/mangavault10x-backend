-- ============================================================
-- MangaVault — Migrazione 002: pulizia dati e tipi corretti
--
-- ESEGUIRE DOPO il 001.
--
-- Cosa fa:
--   1. Trasforma la stringa letterale 'NULL' in NULL vero
--   2. Ripulisce i prefissi "x"/"xx" dai titoli
--   3. Cancella le trame che sono messaggi di errore
--   4. Converte le colonne numeriche da testo a numero
--   5. Ricrea la vista senza le funzioni-toppa
--
-- ⚠️  Modifica i dati. Fai un backup prima:
--     Supabase → Database → Backups
-- ============================================================


-- ------------------------------------------------------------
-- 0. VIA LA VISTA
--    Postgres non permette di cambiare il tipo di una colonna
--    finché una vista la usa. La ricreo al punto 6.
-- ------------------------------------------------------------

DROP VIEW IF EXISTS v_collezione_riepilogo;


-- ------------------------------------------------------------
-- 1. LA STRINGA 'NULL' NON È UN VALORE
--    Residuo di un vecchio import: le quattro lettere N-U-L-L
--    salvate come testo. Diventano NULL veri.
-- ------------------------------------------------------------

UPDATE "Manga" SET "VolumiTotali"  = NULL WHERE upper(trim("VolumiTotali"))  IN ('NULL', '');
UPDATE "Manga" SET "Valutazione"   = NULL WHERE upper(trim("Valutazione"))   IN ('NULL', '');
UPDATE "Manga" SET "PrezzoStimato" = NULL WHERE upper(trim("PrezzoStimato")) IN ('NULL', '');
UPDATE "Manga" SET "MarketValue"   = NULL WHERE upper(trim("MarketValue"))   IN ('NULL', '');
UPDATE "Manga" SET "DataAggiunta"  = NULL WHERE upper(trim("DataAggiunta"))  IN ('NULL', '');
UPDATE "Manga" SET "Editore"       = NULL WHERE trim(COALESCE("Editore", '')) = '';
UPDATE "Manga" SET "Genere"        = NULL WHERE upper(trim("Genere"))        IN ('NULL', '');


-- ------------------------------------------------------------
-- 2. PREFISSI "x" / "xx" NEI TITOLI
--    Erano refusi: "xxAkame ga Kill!" → "Akame ga Kill!"
--    Tolgo solo le x minuscole iniziali seguite da maiuscola,
--    così non tocco titoli legittimi tipo "xxxHOLiC".
-- ------------------------------------------------------------

UPDATE "Manga"
SET "Titolo" = regexp_replace("Titolo", '^x{1,2}(?=[A-Z])', '', 'g')
WHERE "Titolo" ~ '^x{1,2}[A-Z]';


-- ------------------------------------------------------------
-- 3. TRAME CHE SONO MESSAGGI DI ERRORE
--    Il vecchio traduttore, finita la quota, salvava il proprio
--    messaggio di errore al posto della trama. Le azzero: verranno
--    rigenerate dal nuovo servizio (Google Books italiano).
-- ------------------------------------------------------------

UPDATE "Manga"
SET "Trama" = NULL
WHERE "Trama" ILIKE '%MYMEMORY WARNING%'
   OR "Trama" ILIKE '%ALL AVAILABLE FREE TRANSLATIONS%'
   OR "Trama" ILIKE '%QUERY LENGTH LIMIT EXCEEDED%'
   OR "Trama" ILIKE '%USAGELIMITS.PHP%';

-- Caso isolato: una trama inizia con "NULL" attaccato al testo
UPDATE "Manga"
SET "Trama" = regexp_replace("Trama", '^NULL', '')
WHERE "Trama" LIKE 'NULL%';


-- ------------------------------------------------------------
-- 4. CONVERSIONE DEI TIPI
--    Da qui in poi i confronti numerici e gli ordinamenti
--    funzionano davvero: prima "10" veniva prima di "9".
--    USING converte i valori esistenti riga per riga.
-- ------------------------------------------------------------

ALTER TABLE "Manga"
  ALTER COLUMN "VolumiTotali" TYPE INTEGER
  USING NULLIF(regexp_replace(COALESCE("VolumiTotali", ''), '[^0-9]', '', 'g'), '')::INTEGER;

ALTER TABLE "Manga"
  ALTER COLUMN "Valutazione" TYPE NUMERIC(3,1)
  USING NULLIF(regexp_replace(replace(COALESCE("Valutazione", ''), ',', '.'), '[^0-9.]', '', 'g'), '')::NUMERIC;

ALTER TABLE "Manga"
  ALTER COLUMN "PrezzoStimato" TYPE NUMERIC(10,2)
  USING NULLIF(regexp_replace(replace(COALESCE("PrezzoStimato", ''), ',', '.'), '[^0-9.]', '', 'g'), '')::NUMERIC;

ALTER TABLE "Manga"
  ALTER COLUMN "MarketValue" TYPE NUMERIC(10,2)
  USING NULLIF(regexp_replace(replace(COALESCE("MarketValue", ''), ',', '.'), '[^0-9.]', '', 'g'), '')::NUMERIC;

ALTER TABLE "Manga"
  ALTER COLUMN "DataAggiunta" TYPE DATE
  USING CASE
          WHEN "DataAggiunta" ~ '^\d{4}-\d{2}-\d{2}' THEN "DataAggiunta"::DATE
          ELSE NULL
        END;

-- "Concluso" è un flag 0/1 salvato come numero: diventa booleano
ALTER TABLE "Manga"
  ALTER COLUMN "Concluso" TYPE BOOLEAN
  USING CASE WHEN "Concluso" = 1 THEN TRUE
             WHEN "Concluso" = 0 THEN FALSE
             ELSE NULL END;


-- ------------------------------------------------------------
-- 5. STATO SERIE
--    Popolo la colonna nuova a partire da "Concluso".
--    NULL = non lo sappiamo ancora, da rivedere a mano.
-- ------------------------------------------------------------

UPDATE "Manga"
SET "StatoSerie" = CASE
                     WHEN "Concluso" IS TRUE  THEN 'conclusa'
                     WHEN "Concluso" IS FALSE THEN 'in_corso'
                     ELSE NULL
                   END
WHERE "StatoSerie" IS NULL;


-- ------------------------------------------------------------
-- 6. VISTA RICREATA
--    Ora le colonne sono numeriche: via le funzioni-toppa.
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
  m."Valutazione",
  m."StatoSerie",
  m."Preferito",
  m."Costo"                                      AS prezzo_volume,

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

  -- Segnala le schede da completare: senza editore, senza prezzo,
  -- senza trama o senza numero di volumi.
  (m."Editore" IS NULL
   OR m."Costo" IS NULL OR m."Costo" = 0
   OR m."Trama" IS NULL
   OR m."VolumiTotali" IS NULL)                  AS scheda_incompleta

FROM "Manga" m
LEFT JOIN acquisti a ON a.manga_id = m."ID"
GROUP BY m."ID";


-- ------------------------------------------------------------
-- 7. FUNZIONI-TOPPA NON PIÙ NECESSARIE
-- ------------------------------------------------------------

DROP FUNCTION IF EXISTS safe_int(TEXT);
DROP FUNCTION IF EXISTS safe_num(TEXT);


-- ============================================================
-- VERIFICA — lancia dopo il Run
-- ============================================================

-- SELECT
--   COUNT(*)                                            AS serie,
--   COUNT(*) FILTER (WHERE trama_mancante)              AS trame_da_rigenerare,
--   COUNT(*) FILTER (WHERE scheda_incompleta)           AS schede_incomplete,
--   SUM("VolumiPosseduti")                              AS volumi,
--   ROUND(SUM(spesa_stimata), 2)                        AS valore_collezione
-- FROM v_collezione_riepilogo;
