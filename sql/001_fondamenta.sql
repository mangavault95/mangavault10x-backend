-- ============================================================
-- MangaVault — Migrazione 001: fondamenta
--
-- COME ESEGUIRLO:
--   Supabase → SQL Editor → New query → incolla tutto → Run
--
-- È SICURO: usa IF NOT EXISTS ovunque, non cancella né modifica
-- dati esistenti. Puoi rieseguirlo più volte senza danni.
-- ============================================================


-- ------------------------------------------------------------
-- 0. PREREQUISITO
--    Le tabelle nuove si agganciano a "Manga"("ID"): serve che
--    quella colonna sia chiave primaria. Se lo è già non succede
--    nulla, altrimenti la imposto qui.
-- ------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_name = 'Manga'
      AND constraint_type = 'PRIMARY KEY'
  ) THEN
    ALTER TABLE "Manga" ADD PRIMARY KEY ("ID");
    RAISE NOTICE 'Chiave primaria aggiunta su "Manga"("ID")';
  ELSE
    RAISE NOTICE 'Chiave primaria già presente, nessuna modifica';
  END IF;
END $$;


-- ------------------------------------------------------------
-- 1. NUOVE COLONNE SULLA TABELLA Manga
--    Servono per: editore italiano, stato serie, prezzo di
--    copertina ufficiale, ISBN per il matching su eBay.
-- ------------------------------------------------------------

ALTER TABLE "Manga" ADD COLUMN IF NOT EXISTS "StatoSerie" TEXT;
      -- 'in_corso' | 'conclusa' | 'interrotta' | 'inedita'

ALTER TABLE "Manga" ADD COLUMN IF NOT EXISTS "PrezzoCopertina" NUMERIC(10,2);
      -- prezzo ufficiale di UN volume (es. 5.20 per Panini)

ALTER TABLE "Manga" ADD COLUMN IF NOT EXISTS "Isbn" TEXT;
ALTER TABLE "Manga" ADD COLUMN IF NOT EXISTS "AnnoInizio" INTEGER;
ALTER TABLE "Manga" ADD COLUMN IF NOT EXISTS "TitoloOriginale" TEXT;
ALTER TABLE "Manga" ADD COLUMN IF NOT EXISTS "Preferito" BOOLEAN DEFAULT FALSE;
      -- nota: la data di inserimento esiste già come "DataAggiunta" (text)


-- ------------------------------------------------------------
-- 1-bis. CONVERSIONI SICURE
--    Alcune colonne numeriche sono salvate come testo
--    ("VolumiTotali", "Valutazione", "PrezzoStimato", "MarketValue").
--    Queste funzioni le leggono senza esplodere se trovano
--    stringhe vuote, virgole decimali o testo sporco.
--    Sono una toppa: la conversione vera dei tipi è in 002.
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION safe_int(txt TEXT)
RETURNS BIGINT AS $$
BEGIN
  RETURN NULLIF(regexp_replace(COALESCE(txt, ''), '[^0-9]', '', 'g'), '')::BIGINT;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION safe_num(txt TEXT)
RETURNS NUMERIC AS $$
BEGIN
  -- accetta sia "5.20" sia "5,20"
  RETURN NULLIF(
    regexp_replace(replace(COALESCE(txt, ''), ',', '.'), '[^0-9.]', '', 'g'),
    ''
  )::NUMERIC;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$ LANGUAGE plpgsql IMMUTABLE;


-- ------------------------------------------------------------
-- 2. TABELLA ACQUISTI
--    Il cuore del "costo totale sempre sott'occhio".
--    Ogni riga = un acquisto reale (uno o più volumi insieme).
--    Permette: totale collezione, spesa per mese/anno,
--    prezzo medio a volume, confronto nuovo vs usato.
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS acquisti (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  manga_id       INTEGER NOT NULL REFERENCES "Manga"("ID") ON DELETE CASCADE,

  volume_da      INTEGER,          -- es. 1  (NULL = serie intera / non specificato)
  volume_a       INTEGER,          -- es. 5  (per acquisti in blocco)

  prezzo         NUMERIC(10,2) NOT NULL,
  data_acquisto  DATE NOT NULL DEFAULT CURRENT_DATE,

  condizione     TEXT DEFAULT 'nuovo',   -- 'nuovo' | 'usato'
  negozio        TEXT,                   -- 'Amazon', 'eBay', 'Fumetteria', ...
  note           TEXT,

  creato_il      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_acquisti_manga ON acquisti(manga_id);
CREATE INDEX IF NOT EXISTS idx_acquisti_data  ON acquisti(data_acquisto DESC);


-- ------------------------------------------------------------
-- 3. CACHE PREZZI DI MERCATO
--    Salva le risposte di eBay così non interroghiamo l'API
--    a ogni caricamento di pagina (e restiamo nei limiti gratuiti).
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS prezzi_mercato (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  manga_id        INTEGER REFERENCES "Manga"("ID") ON DELETE CASCADE,
  query           TEXT NOT NULL,

  fonte           TEXT NOT NULL DEFAULT 'ebay',
  prezzo_mediano  NUMERIC(10,2),
  prezzo_medio    NUMERIC(10,2),
  prezzo_min      NUMERIC(10,2),
  prezzo_max      NUMERIC(10,2),
  campioni        INTEGER DEFAULT 0,

  rilevato_il     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_prezzi_manga ON prezzi_mercato(manga_id);
CREATE INDEX IF NOT EXISTS idx_prezzi_data  ON prezzi_mercato(rilevato_il DESC);


-- ------------------------------------------------------------
-- 4. VISTA RIEPILOGO COLLEZIONE
--    Una query sola che dà tutti i numeri per la dashboard.
-- ------------------------------------------------------------

-- La cancello prima di ricrearla: CREATE OR REPLACE non permette
-- di rinominare le colonne di una vista già esistente.
DROP VIEW IF EXISTS v_collezione_riepilogo;

CREATE VIEW v_collezione_riepilogo AS
SELECT
  m."ID",
  m."Titolo",
  m."Autore",
  m."Editore",
  m."Genere",
  m."CoverURL",
  m."VolumiPosseduti",
  safe_int(m."VolumiTotali")                     AS volumi_totali,
  safe_num(m."Valutazione")                      AS valutazione,
  m."StatoSerie",
  m."Preferito",
  m."Costo"                                      AS prezzo_volume,

  -- "Costo" è il prezzo di UN volume: la spesa della serie
  -- è quindi prezzo unitario per volumi posseduti.
  ROUND((m."Costo" * COALESCE(m."VolumiPosseduti", 0))::numeric, 2)
                                                 AS spesa_stimata,

  COALESCE(SUM(a.prezzo), 0)                     AS spesa_totale,
  COUNT(a.id)                                    AS numero_acquisti,
  ROUND(AVG(a.prezzo), 2)                        AS prezzo_medio_acquisto,
  MAX(a.data_acquisto)                           AS ultimo_acquisto,

  CASE
    WHEN safe_int(m."VolumiTotali") > 0
    THEN ROUND(
           100.0 * COALESCE(m."VolumiPosseduti", 0) / safe_int(m."VolumiTotali"),
           1
         )
    ELSE NULL
  END                                            AS completamento_pct,

  GREATEST(
    COALESCE(safe_int(m."VolumiTotali"), 0) - COALESCE(m."VolumiPosseduti", 0),
    0
  )                                              AS volumi_mancanti

FROM "Manga" m
LEFT JOIN acquisti a ON a.manga_id = m."ID"
GROUP BY m."ID";


-- ============================================================
-- 5. OPZIONALE — MIGRAZIONE DEI COSTI GIÀ INSERITI
--
--    ATTENZIONE: "Costo" è il prezzo di UN volume, non il
--    totale della serie. La spesa storica di una serie è
--    quindi "Costo" * "VolumiPosseduti".
--
--    Registro un acquisto unico che copre i volumi da 1 a
--    "VolumiPosseduti", con la spesa complessiva.
--    La data resta NULL: non sappiamo quando li hai comprati
--    davvero, e inventarla falserebbe le statistiche.
--
--    ⚠️  ESEGUILA UNA VOLTA SOLA (altrimenti duplica).
--    Togli i commenti '--' davanti alle righe per attivarla.
-- ============================================================

-- ALTER TABLE acquisti ALTER COLUMN data_acquisto DROP NOT NULL;
--
-- INSERT INTO acquisti
--   (manga_id, volume_da, volume_a, prezzo, data_acquisto, condizione, note)
-- SELECT
--   "ID",
--   1,
--   "VolumiPosseduti",
--   ROUND(("Costo" * "VolumiPosseduti")::numeric, 2),
--   NULL,
--   'nuovo',
--   'Importato: ' || "VolumiPosseduti" || ' vol. x ' || "Costo" || ' EUR'
-- FROM "Manga"
-- WHERE "Costo" > 0 AND "VolumiPosseduti" > 0;
