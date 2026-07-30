-- ============================================================
-- MangaVault — Migrazione 004: serie droppate
--
-- ESEGUIRE DOPO il 003.
--
-- Perché: serve un modo per dire "ho smesso di leggere questa serie"
-- che sia diverso da "StatoSerie" (quello racconta se l'EDITORE ha
-- concluso, sospeso o annullato la pubblicazione, non se il lettore
-- ha mollato). Un booleano semplice basta: non serve una data né un
-- motivo, solo un interruttore che si accende quando droppi e si
-- spegne quando riprendi in mano un volume.
--
-- Non tocca la vista v_collezione_riepilogo: non la usa.
-- ============================================================

ALTER TABLE "Manga"
  ADD COLUMN "Droppato" BOOLEAN NOT NULL DEFAULT false;


-- ============================================================
-- VERIFICA — lancia dopo il Run
-- ============================================================

-- SELECT "Droppato", COUNT(*)
-- FROM "Manga"
-- GROUP BY "Droppato";
