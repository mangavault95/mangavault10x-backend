-- ============================================================
-- 033 — Il codice a barre di ogni volume
--
-- COME ESEGUIRLO:
--   npm run migra -- applica --si
--   (oppure Supabase → SQL Editor → New query → incolla → Run)
--
-- È SICURO: crea una tabella nuova, vuota. Si può rieseguire: chi ha già
-- eseguito la prima stesura (codice di sole 13 cifre, numero obbligatorio)
-- la ritrova aggiornata, senza perdere niente.
--
-- ------------------------------------------------------------
-- PERCHÉ
--
-- Inquadrando il retro di un volume il sito legge il codice e lo chiede a
-- Google Books, che per molte edizioni italiane non risponde o risponde
-- col titolo sbagliato. Quando il codice è già stato collegato una volta
-- («questo è Berserk 12»), qui resta: la volta dopo la risposta è
-- immediata e non dipende da nessuno.
--
-- La colonna si chiama `isbn` ma tiene tre forme di chiave
-- (`services/isbn.js`):
--
--   9788891234568         un ISBN: è quel volume              (numero pieno)
--   9771234567003-00042   un codice da edicola con le cinque
--                         cifre piccole accanto: quel volume  (numero pieno)
--   9771234567003         un codice da edicola da solo: è
--                         uguale per tutti i numeri, quindi
--                         dice la SERIE e basta               (numero vuoto)
--
-- Una riga per chiave. Se la serie viene cancellata, i suoi codici se ne
-- vanno con lei.
-- ============================================================

CREATE TABLE IF NOT EXISTS isbn_volumi (
  isbn       TEXT PRIMARY KEY,
  manga_id   INTEGER NOT NULL REFERENCES "Manga"("ID") ON DELETE CASCADE,
  numero     INTEGER CHECK (numero > 0),
  creato_il  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Per chi aveva la prima stesura: il numero può mancare, e la chiave può
-- portare le cifre piccole. (Su una tabella appena creata non cambia niente.)
ALTER TABLE isbn_volumi ALTER COLUMN numero DROP NOT NULL;
ALTER TABLE isbn_volumi DROP CONSTRAINT IF EXISTS isbn_volumi_isbn_check;
ALTER TABLE isbn_volumi ADD CONSTRAINT isbn_volumi_isbn_check
  CHECK (isbn ~ '^[0-9]{13}(-[0-9]{5})?$');

CREATE INDEX IF NOT EXISTS idx_isbn_volumi_manga ON isbn_volumi (manga_id);

-- Come le altre tabelle (031): chiusa ai ruoli pubblici di Supabase. Il backend si collega
-- come `postgres` e non ne risente. I ruoli si controllano prima: su un database che non li
-- ha (la prova locale, la CI) non si fa niente e non dà errore.
ALTER TABLE isbn_volumi ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  ruolo text;
BEGIN
  FOREACH ruolo IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ruolo) THEN
      EXECUTE format('REVOKE ALL ON isbn_volumi FROM %I', ruolo);
    END IF;
  END LOOP;
END $$;
