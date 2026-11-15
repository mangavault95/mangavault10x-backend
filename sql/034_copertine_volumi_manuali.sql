-- ============================================================
-- 034 — Copertine di volume scelte a mano
--
-- COME ESEGUIRLO: `npm run migra -- applica --si` (vedi sql/LEGGIMI.md)
-- È SICURO: aggiunge una colonna con un valore di partenza. Si può rieseguire.
--
-- PERCHÉ
--
-- Le copertine dei volumi le scrive il giro di AnimeClick (030), e una
-- serie che ha cambiato edizione (Yu-Gi-Oh!, Stella cadente in pieno giorno)
-- ne prende a volte una sbagliata o quella dell'edizione vecchia. Non c'era
-- modo di correggerla: al giro dopo, la lettura la riscriveva.
--
-- `manuale` segna le copertine messe da una persona: il giro non le tocca più.
-- ============================================================

ALTER TABLE copertine_volumi
  ADD COLUMN IF NOT EXISTS manuale BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN copertine_volumi.manuale IS
  'Vera se la copertina l''ha scelta una persona dalla Gestione: il giro di AnimeClick non la sovrascrive.';
