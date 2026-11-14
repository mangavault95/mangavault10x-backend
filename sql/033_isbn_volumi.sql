-- ============================================================
-- 033 — Il codice a barre di ogni volume
--
-- COME ESEGUIRLO:
--   Supabase → SQL Editor → New query → incolla → Run
--
-- È SICURO: crea una tabella nuova, vuota. Si può rieseguire.
--
-- PERCHÉ
--
-- Inquadrando il retro di un volume il sito legge il codice (ISBN) e lo
-- chiede a Google Books, che per molte edizioni italiane non risponde o
-- risponde col titolo sbagliato. Quando il codice è già stato collegato
-- una volta a mano («questo è Berserk 12»), qui resta: la volta dopo la
-- risposta è immediata e non dipende da Google.
--
-- Una riga per codice: un codice a barre è di un solo volume di una sola
-- edizione. Se la serie viene cancellata, i suoi codici se ne vanno con lei.
-- ============================================================

CREATE TABLE IF NOT EXISTS isbn_volumi (
  isbn       TEXT PRIMARY KEY CHECK (isbn ~ '^[0-9]{13}$'),
  manga_id   INTEGER NOT NULL REFERENCES "Manga"("ID") ON DELETE CASCADE,
  numero     INTEGER NOT NULL CHECK (numero > 0),
  creato_il  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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
