-- 007_volumi_italia.sql
--
-- Da eseguire nel SQL Editor di Supabase.
--
-- A cosa serve: separare due domande diverse che finora condividevano
-- la stessa colonna. "VolumiTotali" è (o dovrebbe essere) il totale
-- della serie in Giappone, da AniList. Ma per le serie in corso senza
-- quel numero, il controllo mensile di AnimeClick lo sovrascriveva
-- con l'ultimo volume uscito IN ITALIA — utile, ma da lì in poi la
-- stessa colonna significava una cosa per una riga e un'altra per la
-- riga accanto, e ogni statistica di completamento leggeva l'una o
-- l'altra senza saperlo.
--
-- Da qui in poi "VolumiTotali" torna a significare solo Giappone (o
-- resta vuoto per le serie in corso che AniList non dice). I volumi
-- usciti in Italia vanno nella colonna nuova, e sono quelli su cui si
-- calcola quanto manca da comprare: non ha senso segnare come "da
-- completare" una serie di cui possiedi già tutto quello che l'editore
-- italiano ha pubblicato finora.

ALTER TABLE "Manga"
  ADD COLUMN IF NOT EXISTS "VolumiItalia" integer;

COMMENT ON COLUMN "Manga"."VolumiItalia" IS
  'Ultimo volume uscito in Italia secondo AnimeClick (services/volumiItaliani.js). Vuoto = non ancora controllata, o non in corso. Diverso da "VolumiTotali", che è il totale in Giappone.';

-- ==========================================================
-- MIGRAZIONE DEI DATI GIA' SCRITTI
--
-- Le serie in corso il cui "VolumiTotali" oggi è già il numero letto
-- da AnimeClick (non da AniList) vanno spostate nella colonna giusta,
-- altrimenti il primo giro del rapporto le tratterebbe come mai
-- controllate. Non c'è modo di distinguerle con certezza col solo
-- SQL — la mappatura verificata a mano il 04/08/2026 (34 serie, vedi
-- ROADMAP) è la fonte più affidabile: qualunque riga con
-- "AnimeClickID" e "StatoSerie" = 'in_corso' ha avuto il suo
-- "VolumiTotali" scritto da quel meccanismo, non da AniList (AniList
-- non pubblica quel numero per le serie in corso).
UPDATE "Manga"
SET "VolumiItalia" = "VolumiTotali"
WHERE "StatoSerie" = 'in_corso'
  AND "AnimeClickID" IS NOT NULL
  AND "VolumiTotali" IS NOT NULL
  AND "VolumiItalia" IS NULL;
