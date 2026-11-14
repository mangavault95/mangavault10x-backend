-- ============================================================
-- 030 — Una copertina per ogni volume
--
-- COME ESEGUIRLO:
--   Supabase → SQL Editor → New query → incolla → Run
--   (da telefono: la pagina «Migrazione 030» ha il testo già pronto,
--   con la riga del registro delle migrazioni)
--
-- È SICURO: crea due tabelle nuove, vuote. Si può rieseguire.
--
-- ------------------------------------------------------------
-- PERCHÉ
--
-- Di ogni serie c'era una copertina sola ("CoverURL", di solito il
-- volume 1). Nelle letture si vuole vedere il volume a cui si è
-- arrivati, in «Da comprare» quello che manca. AnimeClick, nella pagina
-- delle edizioni di una serie, ha la miniatura di ogni volume.
--
-- `copertine_volumi` le tiene: una riga per serie e numero.
-- `copertine_giri` ricorda quando la pagina di una serie è stata letta
-- l'ultima volta, così il giro quotidiano (poche serie al giorno, per
-- non pesare su AnimeClick) sa da quale ripartire.
-- ============================================================

CREATE TABLE IF NOT EXISTS copertine_volumi (
  manga_id       INTEGER NOT NULL REFERENCES "Manga"("ID") ON DELETE CASCADE,
  numero         INTEGER NOT NULL CHECK (numero > 0),
  copertina      TEXT NOT NULL,
  aggiornata_il  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (manga_id, numero)
);

COMMENT ON TABLE copertine_volumi IS
  'La copertina di ogni volume, da AnimeClick. Vedi services/copertineVolumi.js.';

CREATE TABLE IF NOT EXISTS copertine_giri (
  manga_id  INTEGER PRIMARY KEY REFERENCES "Manga"("ID") ON DELETE CASCADE,
  letta_il  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  esito     TEXT,
  trovate   INTEGER NOT NULL DEFAULT 0
);

COMMENT ON TABLE copertine_giri IS
  'Quando la pagina delle edizioni di una serie è stata letta per le copertine dei volumi.';
