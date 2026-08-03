-- ============================================================
-- MangaVault — Migrazione 005: edizioni collegate
--
-- ESEGUIRE DOPO il 004.
--
-- Perché: alcune serie esistono in più edizioni (es. "Maison
-- Ikkoku" classica e "Maison Ikkoku Perfect Edition") e finora non
-- c'era modo di dire "questa riga è un'edizione diversa di quella
-- riga là" — servono soprattutto alla ricerca eBay, per non
-- mischiare i prezzi di edizioni diverse.
--
-- Niente tabella nuova: una riga di "Manga" è già "una cosa che
-- possiedi" con propri volumi/prezzo/copertina, la stessa misura
-- giusta per un'edizione. "OperaId" collega le righe gemelle fra
-- loro; il GRUPPO EFFETTIVO di una riga è COALESCE("OperaId","ID"),
-- quindi senza collegamenti ogni riga resta gruppo di se stessa e
-- niente cambia per le righe esistenti.
-- ============================================================

ALTER TABLE "Manga" ADD COLUMN IF NOT EXISTS "Edizione" TEXT;
      -- etichetta libera, es. 'Perfect Edition'. NULL = edizione
      -- standard/unica (comportamento identico a prima).

ALTER TABLE "Manga" ADD COLUMN IF NOT EXISTS "OperaId" INTEGER
      REFERENCES "Manga"("ID") ON DELETE SET NULL;
      -- ON DELETE SET NULL: cancellare un'edizione non deve
      -- trascinare via le sue sorelle, solo scioglierle dal gruppo.

CREATE INDEX IF NOT EXISTS idx_manga_opera ON "Manga"("OperaId");


-- ============================================================
-- VERIFICA — lancia dopo il Run
-- ============================================================

-- SELECT "ID", "Titolo", "Edizione", "OperaId"
-- FROM "Manga"
-- ORDER BY COALESCE("OperaId", "ID"), "ID";
