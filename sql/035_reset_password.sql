-- ============================================================
-- 035 — Reset della password con un link monouso
--
-- COME ESEGUIRLO: `npm run migra -- applica --si` (vedi sql/LEGGIMI.md)
-- È SICURO: solo tabelle e colonne nuove. Si può rieseguire.
--
-- PERCHÉ
--
-- Chi perde la password (Nanaki) non ha modo di rientrare: nel sito non ci
-- sono email, e la password si cambiava solo a mano nel database. Il reset è
-- quindi in due tempi: il PROPRIETARIO genera un link per quella persona, e
-- lei lo apre e sceglie lei stessa la nuova password. Nessuno, nemmeno il
-- proprietario, vede o decide la password di un altro.
--
-- Il link porta un segreto casuale. Nel database c'è SOLO il suo hash
-- SHA-256: chi legge la tabella (un backup, una query sbagliata) non può
-- ricavarne un link valido. Vale una volta sola e scade (30 minuti).
--
-- `password_cambiata_il` serve a buttare fuori le sessioni di prima: un
-- token di accesso dura 30 giorni, e chi ha perso la password potrebbe averla
-- persa perché qualcun altro la ha. Un token emesso prima del cambio non vale più.
-- ============================================================

CREATE TABLE IF NOT EXISTS reset_password (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  utente_id   BIGINT NOT NULL REFERENCES utenti(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  creato_il   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  scade_il    TIMESTAMPTZ NOT NULL,
  usato_il    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS reset_password_utente
  ON reset_password (utente_id) WHERE usato_il IS NULL;

ALTER TABLE utenti
  ADD COLUMN IF NOT EXISTS password_cambiata_il TIMESTAMPTZ;

COMMENT ON COLUMN utenti.password_cambiata_il IS
  'Quando la password è stata cambiata con un reset. I token di accesso emessi prima non valgono più.';
