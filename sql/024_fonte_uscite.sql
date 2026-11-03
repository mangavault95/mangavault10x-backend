-- ============================================================
-- 024 — DA DOVE VIENE UN'USCITA
--
-- COME ESEGUIRLO:
--   Supabase → SQL Editor → New query → incolla tutto → Run
--
-- È SICURO: aggiunge e basta. Si può rieseguire più volte.
--
-- AnimeClick ha messo una verifica anti-bot sul calendario, e le uscite
-- non arrivano più da lì in automatico. Ora una ricerca mensile (il 9)
-- le cerca per le serie in corso su altre fonti. Le fonti non valgono
-- lo stesso, quindi ogni riga ricorda la sua: una data di AnimeClick
-- non viene mai sovrascritta da una data di un'altra fonte.
-- ============================================================

ALTER TABLE uscite_manga
  ADD COLUMN IF NOT EXISTS fonte TEXT NOT NULL DEFAULT 'animeclick';

COMMENT ON COLUMN uscite_manga.fonte IS
  'Chi ha detto che è uscito: animeclick (il calendario) o fumettologica (la ricerca del 9) o manuale. Una data di animeclick non si sovrascrive con quella di un''altra fonte.';
