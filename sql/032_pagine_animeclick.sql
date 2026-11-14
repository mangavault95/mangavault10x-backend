-- ============================================================
-- 032 — Le pagine di AnimeClick scaricate da GitHub, in attesa di essere lette
--
-- COME ESEGUIRLO:
--   npm run migra -- applica --si
--   (oppure Supabase → SQL Editor → incolla → Run)
--
-- È SICURO: crea una tabella nuova e vuota. Si può rieseguire.
--
-- ------------------------------------------------------------
-- PERCHÉ
--
-- Da Render AnimeClick risponde 403 (verifica anti-bot) e da GitHub Actions, con la firma
-- dichiarata del progetto, risponde 200. Il giro delle uscite manga già lavora così: scarica
-- GitHub e manda le pagine al backend. Il calendario degli anime, le schede degli anime e il
-- rapporto dei volumi invece partivano da Render e venivano rifiutati ogni giorno.
--
-- Sono lavori lunghi (il rapporto legge fino a 68 pagine) e le pagine pesano 200-300 kB l'una:
-- non stanno in una richiesta sola (il tetto è 4 MB). Allora GitHub le manda una alla volta
-- e le tiene qui; poi chiama il lavoro di sempre, che invece di chiedere la pagina ad
-- AnimeClick la legge da questa tabella. Il lavoro non cambia, cambia da dove arriva la pagina.
-- Dopo l'uso le righe si cancellano; quelle dimenticate più vecchie di due giorni pure.
--
-- Come le altre tabelle: protezione delle righe attiva, e nessun permesso ai ruoli pubblici di
-- Supabase (vedi 031). Ci parla solo il backend, che si collega come `postgres`.
-- ============================================================

CREATE TABLE IF NOT EXISTS animeclick_pagine (
  url          TEXT PRIMARY KEY,
  html         TEXT NOT NULL,
  scaricata_il TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_animeclick_pagine_scaricata ON animeclick_pagine (scaricata_il);

COMMENT ON TABLE animeclick_pagine IS
  'Pagine di AnimeClick scaricate da GitHub Actions e in attesa che un lavoro le legga (poi si cancellano). Vedi services/pagineAnimeClick.js.';

ALTER TABLE animeclick_pagine ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  ruolo text;
BEGIN
  FOREACH ruolo IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ruolo) THEN
      EXECUTE format('REVOKE ALL ON TABLE animeclick_pagine FROM %I', ruolo);
    END IF;
  END LOOP;
END
$$;
