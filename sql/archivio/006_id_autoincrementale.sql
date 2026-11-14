-- ============================================================
-- ARCHIVIATA il 14/11/2026 — NON ESEGUIRE, e non è nel registro.
--
-- Questa migrazione non è mai stata eseguita sul database di
-- produzione: il controllo prima della baseline (npm run migra)
-- ha trovato che la sequenza `manga_id_seq` non esiste. Il sito ha
-- sempre funzionato senza, perché il codice calcola l'ID da solo
-- (services/idManga.js, con un lucchetto di transazione che mette
-- in fila le creazioni contemporanee).
--
-- Resta qui perché l'idea è giusta: se un giorno il codice smette di
-- calcolare l'ID a mano e lascia fare al database, questo è il
-- file da riportare in `sql/` con un numero nuovo. Attenzione:
-- una sequenza non avanza quando si inseriscono ID espliciti, quindi
-- la sostituzione va fatta in una volta sola, in tutti e tre i posti
-- (creazione dal sito, wishlist, bot).
-- ============================================================

-- ============================================================
-- MangaVault — Migrazione 006: ID autoincrementale
--
-- ESEGUIRE DOPO il 005.
--
-- Perché: la colonna "Manga"."ID" è sempre stata NOT NULL senza
-- nessuna sequenza collegata — chi ha creato la tabella l'ha
-- popolata con ID forniti a mano, e non è mai stato aggiunto un
-- autoincremento vero. Finché tutte le righe arrivavano da import
-- manuali nessuno se n'è accorto; il codice ha sempre dovuto
-- calcolare il prossimo ID da solo (vedi wishlistActions.js, che lo
-- fa con COALESCE(MAX("ID"),0)+1 dentro una transazione).
--
-- La rotta "Nuova serie" (routes/manga.js, creaManga) non replicava
-- quel calcolo e ogni INSERT falliva con "null value in column ID
-- violates not-null constraint" — l'errore che compariva aggiungendo
-- una serie dal sito. Il codice è già stato corretto allo stesso modo
-- (calcolo manuale) per sbloccare subito senza aspettare questa
-- migrazione.
--
-- Questa migrazione è il fix definitivo: attacca una sequenza vera
-- alla colonna, così il calcolo manuale nel codice non serve più da
-- nessuna parte. La sequenza parte da MAX("ID")+1 per non collidere
-- con le righe esistenti.
-- ============================================================

CREATE SEQUENCE IF NOT EXISTS manga_id_seq OWNED BY "Manga"."ID";

SELECT setval('manga_id_seq', COALESCE((SELECT MAX("ID") FROM "Manga"), 0) + 1, false);

ALTER TABLE "Manga" ALTER COLUMN "ID" SET DEFAULT nextval('manga_id_seq');


-- ============================================================
-- VERIFICA — lancia dopo il Run
-- ============================================================

-- SELECT nextval('manga_id_seq');  -- deve dare un numero mai usato, poi si può ignorare/scartare
-- SELECT column_default FROM information_schema.columns WHERE table_name = 'Manga' AND column_name = 'ID';
