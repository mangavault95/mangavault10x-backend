-- ============================================================
-- MangaVault — Migrazione 003: voto a 5 stelle intere
--
-- ESEGUIRE DOPO il 002.
--
-- Perché: il voto era 0–10 con un decimale (mezza stella su cinque,
-- ogni stella valeva due punti). Da qui in poi sono 5 stelle intere,
-- un click assegna direttamente 1-5. I voti già dati vanno riscalati
-- una volta sola, altrimenti un vecchio "8.5" resterebbe una stella
-- e mezza fuori scala nella nuova interfaccia.
--
-- Regola di conversione: voto_nuovo = ROUND(voto_vecchio / 2),
-- con il risultato vincolato fra 1 e 5. Zero o NULL restano NULL
-- ("non ancora votato" — vedi 002, punto 1).
--
-- ⚠️  Modifica i dati. Fai un backup prima:
--     Supabase → Database → Backups
-- ============================================================


-- ------------------------------------------------------------
-- 0. VIA LA VISTA
--    Come nel 002: non si cambia il tipo di una colonna che una
--    vista sta usando.
-- ------------------------------------------------------------

DROP VIEW IF EXISTS v_collezione_riepilogo;


-- ------------------------------------------------------------
-- 1. RISCALA I VOTI ESISTENTI
--    Va fatto PRIMA di cambiare il tipo della colonna, sui valori
--    ancora in scala 0-10.
-- ------------------------------------------------------------

UPDATE "Manga"
SET "Valutazione" = LEAST(5, GREATEST(1, ROUND("Valutazione" / 2)))
WHERE "Valutazione" IS NOT NULL AND "Valutazione" > 0;

UPDATE "Manga"
SET "Valutazione" = NULL
WHERE "Valutazione" IS NOT NULL AND "Valutazione" <= 0;


-- ------------------------------------------------------------
-- 2. LA COLONNA DIVENTA UN INTERO
--    Non servono più i decimali: sono stelle intere da 1 a 5.
-- ------------------------------------------------------------

ALTER TABLE "Manga"
  ALTER COLUMN "Valutazione" TYPE INTEGER
  USING ROUND("Valutazione")::INTEGER;

ALTER TABLE "Manga"
  ADD CONSTRAINT valutazione_1_5 CHECK ("Valutazione" IS NULL OR "Valutazione" BETWEEN 1 AND 5);


-- ------------------------------------------------------------
-- 3. VISTA RICREATA (identica al 002, sulla colonna nuova)
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

-- SELECT "Valutazione", COUNT(*)
-- FROM "Manga"
-- GROUP BY "Valutazione"
-- ORDER BY "Valutazione";
