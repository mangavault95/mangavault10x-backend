-- ============================================================
-- 026 — LE SERIE CHE NON SI COMPRANO PIÙ
--
-- COME ESEGUIRLO:
--   Supabase → SQL Editor → New query → incolla tutto → Run
--
-- È SICURO: aggiunge e basta. Nessun dato viene toccato, si può
-- rieseguire più volte senza danni.
--
-- ------------------------------------------------------------
-- PERCHÉ
--
-- «Droppare» esiste già, ma è di chi LEGGE (`letture_droppate`, 011):
-- dice «questa lettura l'ho mollata» e vale per una persona sola.
-- Le uscite invece sono della COLLEZIONE, che è in comune: una serie
-- che in casa non si compra più continuava a comparire fra le uscite,
-- nella ricerca su Fumettologica, nel riepilogo del bot, fra i volumi
-- mancanti della wishlist e fra le serie «in corso» delle statistiche.
--
-- È una cosa diversa anche da "StatoSerie": quello dice se l'EDITORE
-- la pubblica ancora, questa se NOI la seguiamo ancora.
--
-- NULL = la seguiamo; una data = da quel giorno non la compriamo più.
-- Smessa, la serie sparisce da TUTTE le uscite, passate e future: di
-- lei restano solo i volumi in casa. La data dice da quando, e basta.
-- Riprenderla = rimetterla a NULL.
-- ============================================================

ALTER TABLE "Manga"
  ADD COLUMN IF NOT EXISTS "SmessaIl" TIMESTAMPTZ;

COMMENT ON COLUMN "Manga"."SmessaIl" IS
  'Da quando la serie non si compra più (in comune ai due lettori). NULL = la si segue. Diverso da StatoSerie (dell''editore) e da letture_droppate (di chi legge).';
