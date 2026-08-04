-- 006_animeclick.sql
--
-- Da eseguire nel SQL Editor di Supabase.
--
-- A cosa serve: sapere quanti volumi di una serie sono usciti in
-- Italia. AniList non lo dice finché la serie è in corso (risponde
-- `volumes: null`), quindi 28 serie su 34 in corso hanno
-- "VolumiTotali" vuoto, e senza quel numero la stima del prezzo su
-- eBay non sa distinguere un lotto completo da uno parziale.
--
-- La fonte è la pagina delle edizioni di AnimeClick, che va
-- indirizzata per identificativo: nella scheda di Hunter x Hunter
-- l'indirizzo è /manga/9553/hunter-x-hunter, quindi l'ID è 9553.
-- Si salva una volta sola e poi il controllo mensile lo riusa: la
-- loro ricerca non è interrogabile da programma, e cercare il titolo
-- a ogni giro sarebbe la parte fragile di tutto il meccanismo — oltre
-- che il modo per agganciare l'opera sbagliata.

ALTER TABLE "Manga"
  ADD COLUMN IF NOT EXISTS "AnimeClickID" integer;

COMMENT ON COLUMN "Manga"."AnimeClickID" IS
  'Identificativo della scheda su AnimeClick (il numero in /manga/<id>/<slug>). Serve al controllo periodico dei volumi usciti in Italia. Vuoto = la serie non viene controllata.';

CREATE INDEX IF NOT EXISTS "Manga_animeclick_in_corso_idx"
  ON "Manga" ("AnimeClickID")
  WHERE "AnimeClickID" IS NOT NULL;

-- ==========================================================
-- MAPPATURA
--
-- Ogni ID è stato verificato scaricando la sua scheda e
-- confrontando i volumi elencati con quelli posseduti
-- (scripts/rapporto-volumi.js fa lo stesso controllo).
-- Fra parentesi: volumi posseduti → volumi usciti secondo AnimeClick.
-- ==========================================================

UPDATE "Manga" SET "AnimeClickID" = 18871 WHERE "Titolo" = 'Atelier of Witch Hat';                        --  2 →  2
UPDATE "Manga" SET "AnimeClickID" = 50294 WHERE "Titolo" = 'Blood-Crawling Princess of a Ruined Country'; --  3 →  5
UPDATE "Manga" SET "AnimeClickID" = 28155 WHERE "Titolo" = 'Blue Lock';                                   -- 31 → 33
UPDATE "Manga" SET "AnimeClickID" = 53982 WHERE "Titolo" = 'Boruto - Two Blue Vortex';                    --  4 →  6
UPDATE "Manga" SET "AnimeClickID" = 38190 WHERE "Titolo" = 'DanDaDan';                                    -- 22 → 22
UPDATE "Manga" SET "AnimeClickID" = 32313 WHERE "Titolo" = 'Frieren';                                     -- 14 → 15
UPDATE "Manga" SET "AnimeClickID" = 43155 WHERE "Titolo" = 'Gachiakuta';                                  -- 13 → 16
UPDATE "Manga" SET "AnimeClickID" = 38876 WHERE "Titolo" = 'Hirayasumi';                                  --  9 →  9
UPDATE "Manga" SET "AnimeClickID" =  9553 WHERE "Titolo" = 'HUNTER x HUNTER';                             -- 38 → 38
UPDATE "Manga" SET "AnimeClickID" = 23236 WHERE "Titolo" = 'I diari della speziale';                      -- 16 → 16
UPDATE "Manga" SET "AnimeClickID" = 10553 WHERE "Titolo" = 'La storia di Genji';                          --  4 →  6
UPDATE "Manga" SET "AnimeClickID" = 19539 WHERE "Titolo" = 'Made in Abyss';                               -- 14 → 14
UPDATE "Manga" SET "AnimeClickID" = 51937 WHERE "Titolo" = 'Mujina into the Deep';                        --  4 →  5
UPDATE "Manga" SET "AnimeClickID" =  9556 WHERE "Titolo" = 'One Piece';                                   -- 109 → 110 (New Edition riconosciuta)
UPDATE "Manga" SET "AnimeClickID" = 15202 WHERE "Titolo" = 'Servamp';                                     -- 22 → 24
UPDATE "Manga" SET "AnimeClickID" = 28184 WHERE "Titolo" = 'SPY x FAMILY';                                -- 16 → 16
UPDATE "Manga" SET "AnimeClickID" = 12731 WHERE "Titolo" = 'Sword Art Online';                            --  2 →  2 (Aincrad: la serie madre è 2 volumi)
UPDATE "Manga" SET "AnimeClickID" = 42158 WHERE "Titolo" = 'The Flagrant Flower Blooms with Dignity';     --  7 → 10
UPDATE "Manga" SET "AnimeClickID" = 15637 WHERE "Titolo" = 'The Rising of the Shield Hero';               -- 26 → 28
UPDATE "Manga" SET "AnimeClickID" = 14606 WHERE "Titolo" = 'Twin Star Exorcists';                         -- 30 → 35
UPDATE "Manga" SET "AnimeClickID" = 13235 WHERE "Titolo" = 'Welcome to the Ballroom';                     -- 12 → 12

UPDATE "Manga" SET "AnimeClickID" = 22544 WHERE "Titolo" = 'Rent a Girlfriend';                           -- 31 → 33

-- ----------------------------------------------------------
-- Su queste sei AnimeClick elenca parecchi volumi più di quanti ne
-- possiedi: non è un aggancio sbagliato, sei rimasto indietro con gli
-- acquisti. Vengono scritte come le altre (nessun tetto al salto).
-- ----------------------------------------------------------
UPDATE "Manga" SET "AnimeClickID" = 28710 WHERE "Titolo" = 'Dororo e Hyakkimaru';                         --  5 → 12
UPDATE "Manga" SET "AnimeClickID" = 15603 WHERE "Titolo" = 'Kakegurui';                                   -- 14 → 20
UPDATE "Manga" SET "AnimeClickID" = 11566 WHERE "Titolo" = 'Toradora';                                    --  2 → 11
UPDATE "Manga" SET "AnimeClickID" = 16648 WHERE "Titolo" = 'Vita da slime';                               -- 14 → 28

-- ----------------------------------------------------------
-- I due casi di edizione, risolti.
--
--   Nana     — la scheda elenca quattro edizioni: "Nana" (42 volumi,
--              la prima uscita a mezzi volumi), "Nana Collection" (21)
--              e "Nana Reloaded Edition" (21), che è quella posseduta.
--              Basta dichiararla in "Edizione" e il provider filtra da
--              sé: verificato, restituisce 21.
--
--   Pokémon  — la scheda tiene insieme "Pokémon - La grande avventura"
--              (26 volumi, fumetteria) e la stessa in edicola con La
--              Gazzetta dello Sport (55). Qui non serve etichetta:
--              "gazzetta" è entrato fra i marchi che il provider
--              scarta, e senza etichetta restituisce i 26 giusti.
--              (TRIM perché il titolo in tabella ha uno spazio in fondo.)
-- ----------------------------------------------------------
UPDATE "Manga" SET "AnimeClickID" =  9567, "Edizione" = 'Reloaded Edition'
 WHERE "Titolo" = 'Nana';                                                                                 -- 21 → 21
UPDATE "Manga" SET "AnimeClickID" = 10662 WHERE TRIM("Titolo") = 'Pokémon';                               --  9 → 26

-- ----------------------------------------------------------
-- Le ultime sei, quelle che il primo rapporto-volumi.js aveva
-- lasciato fuori perché AniList aveva già dato un totale (vero o
-- presunto). Restano da mappare comunque: sono ancora in corso in
-- Italia, quindi quel numero invecchierà.
--
--   Zatch Bell!  — ATTENZIONE, due schede possibili: l'originale
--     (9553... no, 10108) e un sequel appena annunciato,
--     "Konjiki no Gash!! 2" (id 44946). Il sequel non ha nemmeno la
--     pagina delle edizioni — non è ancora in vendita in Italia —
--     mentre l'originale combacia esatto con i 5 posseduti. Preso
--     quello.
--
--   Black Clover — "VolumiTotali" è già 38: è il finale GIAPPONESE
--     vero, non una stima (la serie si è appena conclusa in Giappone).
--     AnimeClick oggi conta 37 usciti in Italia; la regola "non scende
--     mai" lo protegge finché l'Italia non arriva all'ultimo volume,
--     com'è giusto.
-- ----------------------------------------------------------
UPDATE "Manga" SET "AnimeClickID" = 41370 WHERE "Titolo" = '#DRCL Midnight Children!'; --  6 →  6
UPDATE "Manga" SET "AnimeClickID" = 26974 WHERE "Titolo" = 'Asadora';                  --  8 →  9
UPDATE "Manga" SET "AnimeClickID" = 15666 WHERE "Titolo" = 'Black Clover';             -- 30 → 37 (VolumiTotali resta 38, vedi sopra)
UPDATE "Manga" SET "AnimeClickID" = 55512 WHERE "Titolo" = 'Black Letter';             --  5 →  5
UPDATE "Manga" SET "AnimeClickID" = 38162 WHERE "Titolo" = 'Blue Box';                 -- 14 → 16
UPDATE "Manga" SET "AnimeClickID" = 10108 WHERE "Titolo" = 'Zatch Bell!';              --  5 →  5
