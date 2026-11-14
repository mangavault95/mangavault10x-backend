-- ============================================================
-- 029 — Lo stato delle fonti esterne (AnimeClick)
--
-- COME ESEGUIRLO:
--   Supabase → SQL Editor → New query → incolla → Run
--   (da telefono: la pagina «Pulizia dei dati» ha il testo già pronto,
--   con la riga del registro delle migrazioni)
--
-- È SICURO: crea una tabella nuova, vuota. Si può rieseguire.
--
-- ------------------------------------------------------------
-- PERCHÉ
--
-- AnimeClick è la fonte principale delle uscite, ma da ottobre 2026 ha
-- messo una verifica anti-bot e certi giorni risponde 403. Il giro
-- quotidiano ci prova ogni volta; se non riesce, quel giorno si ripiega
-- su Fumettologica. Se non riesce per sette giorni di fila, si smette di
-- insistere per due settimane (non ha senso bussare a una porta chiusa
-- ogni giorno) e poi si riprova.
--
-- Questa tabella ricorda, per ogni fonte, quanti tentativi sono falliti
-- di fila e fino a quando è in pausa. Una riga per fonte.
-- ============================================================

CREATE TABLE IF NOT EXISTS fonte_stato (
  fonte               TEXT PRIMARY KEY,
  fallimenti_di_fila  INTEGER NOT NULL DEFAULT 0,
  ultimo_tentativo    TIMESTAMPTZ,
  ultimo_esito        TEXT,
  ultimo_ok           TIMESTAMPTZ,
  in_pausa_fino       TIMESTAMPTZ
);

COMMENT ON TABLE fonte_stato IS
  'Stato delle fonti esterne: fallimenti di fila e pausa. Vedi services/fontiStato.js.';
