-- ============================================================
-- 036 — Con quale versione del lettore è stata letta ogni serie
--
-- COME ESEGUIRLO: `npm run migra -- applica --si` (vedi sql/LEGGIMI.md)
-- È SICURO: aggiunge una colonna con un valore di partenza. Si può rieseguire.
--
-- PERCHÉ
--
-- Una serie conclusa letta una volta non si rilegge più (services/copertineVolumi.js).
-- Ma il lettore delle copertine è cambiato più volte dopo le prime letture: edizione
-- esatta (Soul Eater), editore (Zatch Bell!), edizione base davanti alle variant
-- (Jujutsu Kaisen, Gachiakuta). Le copertine scritte prima di quelle correzioni
-- restavano lì per sempre: la variant al posto del volume (Black Letter 3),
-- l'edizione vecchia al posto della nuova (Guru Guru).
--
-- `versione` dice con quale versione del lettore è stata scritta l'ultima lettura.
-- Il codice ha il suo numero (`VERSIONE_LETTURA`): chi è rimasto indietro torna in
-- coda, venti serie al giorno come le altre. Le righe già presenti partono da 0.
-- ============================================================

ALTER TABLE copertine_giri
  ADD COLUMN IF NOT EXISTS versione INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN copertine_giri.versione IS
  'Versione del lettore delle copertine con cui la serie è stata letta l''ultima volta. Se è più bassa di VERSIONE_LETTURA (services/copertineVolumi.js) la serie si rilegge.';
