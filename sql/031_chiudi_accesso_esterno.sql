-- ============================================================
-- 031 — Chiudere l'accesso diretto dall'esterno alle tabelle
--
-- COME ESEGUIRLO:
--   npm run migra -- applica --si
--   (oppure Supabase → SQL Editor → incolla → Run)
--
-- È SICURO: non tocca nessun dato, solo permessi. Si può rieseguire.
-- Il backend e il bot si collegano come `postgres`, che scavalca la
-- protezione delle righe: per loro non cambia niente.
--
-- ------------------------------------------------------------
-- PERCHÉ
--
-- Supabase espone le tabelle di `public` anche senza passare dal nostro
-- backend (la «Data API»), con i ruoli `anon` e `authenticated`. Il
-- 14/11/2026 una query sul database vero ha mostrato che 7 tabelle e 2
-- viste, le più vecchie, avevano la protezione delle righe spenta e tutti
-- i permessi aperti a quei ruoli: chi conosceva l'indirizzo del progetto
-- e la chiave pubblica poteva leggerle, svuotarle, cancellarle. Le altre
-- tabelle (utenti, acquisti, note, voti…) erano già protette.
--
-- Qui si attiva la protezione (senza regole: nessuno da fuori passa) e si
-- tolgono i permessi ai due ruoli. Le viste girano coi diritti di chi le
-- ha create e scavalcherebbero la protezione: per loro vale solo la revoca.
--
-- Ogni oggetto è controllato prima (`to_regclass`) e i ruoli pure: su un
-- database senza `anon`/`authenticated` (la prova locale, la CI) non fa
-- niente di sbagliato e non dà errore.
--
-- Già eseguito a mano sul database di produzione il 14/11/2026: da lì va
-- solo segnato nel registro (`npm run migra -- baseline --fino 031`).
-- ============================================================

DO $$
DECLARE
  tabella text;
  vista   text;
  ruolo   text;
BEGIN
  FOREACH tabella IN ARRAY ARRAY[
    'Manga', 'anime_gruppi', 'avvisi_uscite', 'reading_history',
    'reading_sessions', 'telegram_visti_uscite', 'wishlist_custom'
  ] LOOP
    IF to_regclass(format('public.%I', tabella)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tabella);
    END IF;
  END LOOP;

  FOREACH ruolo IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ruolo) THEN
      FOREACH tabella IN ARRAY ARRAY[
        'Manga', 'anime_gruppi', 'avvisi_uscite', 'reading_history',
        'reading_sessions', 'telegram_visti_uscite', 'wishlist_custom'
      ] LOOP
        IF to_regclass(format('public.%I', tabella)) IS NOT NULL THEN
          EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', tabella, ruolo);
        END IF;
      END LOOP;

      FOREACH vista IN ARRAY ARRAY['v_collezione_riepilogo', 'v_videoteca'] LOOP
        IF to_regclass(format('public.%I', vista)) IS NOT NULL THEN
          EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', vista, ruolo);
        END IF;
      END LOOP;
    END IF;
  END LOOP;
END
$$;
