-- ============================================================
-- 021 — I CONSIGLI: mandare un anime a qualcuno
--
-- «Guarda questo» detto a una persona sola. Il Cineforum dice tutto a
-- tutti, ed è la cosa giusta per un diario; ma consigliare è
-- un'altra faccenda — si sceglie chi, si scrive perché, e si vuole
-- sapere se è arrivato.
--
-- ------------------------------------------------------------
-- PERCHÉ QUESTA VOLTA UNA TABELLA C'È DAVVERO
--
-- La 016 (il feed) e la 020 (la campanella) hanno fatto la scelta
-- opposta: niente tabella di eventi, perché ogni evento era già una
-- riga da qualche parte e una copia vuol dire due verità che possono
-- divergere.
--
-- Qui non c'è nessuna riga da cui dedurre niente. Un consiglio non è
-- la conseguenza di un gesto registrato altrove — non è una spunta,
-- non è un voto, non è una nota: è una cosa che esiste solo perché
-- qualcuno l'ha mandata a qualcun altro. Quindi si scrive.
--
-- E infatti da questa tabella sola si ricavano ENTRAMBI gli avvisi,
-- senza aggiungere altro:
--   al ricevente   c'è una riga per lui                → «ti ha consigliato X»
--   al mittente    quella riga ha `aperto_il` pieno    → «ha aperto il tuo consiglio»
-- ------------------------------------------------------------


-- ------------------------------------------------------------
-- LA TABELLA
--
-- ⚠️ IL TITOLO E LA COPERTINA SONO COPIATI QUI DENTRO, E NON È UNA
-- DIMENTICANZA. Si consiglia cercando su AnimeClick «come se ne
-- stessi cercando uno nuovo», quindi si può benissimo consigliare
-- una serie che NESSUNO dei due ha in videoteca e che nel nostro
-- catalogo non esiste affatto: una chiave esterna verso `anime`
-- renderebbe impossibile mandarla, che è il caso più interessante di
-- tutti — le cose che l'altro non ha ancora.
--
-- L'identità vera è `animeclick_id`, che su `anime` è UNIQUE: quando
-- (e se) la scheda entra in catalogo, un LEFT JOIN la ritrova e la
-- cartolina diventa cliccabile. Prima di allora resta una cartolina
-- con sopra una copertina e un titolo, che è già tutto quello che
-- serve per dire «guarda questo».
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS consigli (
  id             BIGSERIAL PRIMARY KEY,

  da_utente_id   BIGINT NOT NULL REFERENCES utenti(id) ON DELETE CASCADE,
  a_utente_id    BIGINT NOT NULL REFERENCES utenti(id) ON DELETE CASCADE,

  animeclick_id  INTEGER NOT NULL,
  titolo         TEXT    NOT NULL,
  cover_url      TEXT,

  -- Il commento è facoltativo: c'è chi manda una copertina e basta.
  testo          TEXT,

  mandato_il     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Quando la cartolina si è aperta sullo schermo del ricevente.
  -- NULL = non l'ha ancora vista, ed è la colonna su cui gira tutto:
  -- decide se la cartolina va mostrata a schermo intero al prossimo
  -- accesso, e decide se il mittente ha un avviso da leggere.
  aperto_il      TIMESTAMPTZ,

  CONSTRAINT consiglio_non_a_se_stessi CHECK (da_utente_id <> a_utente_id)
);


-- ------------------------------------------------------------
-- GLI INDICI
--
-- Il primo è quello che conta: «ho una cartolina che mi aspetta?» è
-- una domanda che si fa a OGNI apertura del mondo videoteca, per
-- ognuno. Parziale sulle sole non aperte, perché le altre non
-- rispondono mai a quella domanda e in un anno saranno la
-- maggioranza delle righe.
--
-- Il secondo serve al mittente: «hanno aperto quello che ho
-- mandato?», che è l'altra metà degli avvisi.
-- ------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_consigli_in_arrivo
  ON consigli (a_utente_id, mandato_il DESC)
  WHERE aperto_il IS NULL;

CREATE INDEX IF NOT EXISTS idx_consigli_ricevuti
  ON consigli (a_utente_id, mandato_il DESC);

CREATE INDEX IF NOT EXISTS idx_consigli_aperti
  ON consigli (da_utente_id, aperto_il DESC);


-- ============================================================
-- VERIFICA — lancia dopo il Run
-- ============================================================

-- La tabella c'è e ha le colonne giuste:
-- SELECT column_name, data_type, is_nullable FROM information_schema.columns
--  WHERE table_name = 'consigli' ORDER BY ordinal_position;

-- Nessuno può consigliarsi qualcosa da solo (deve dare errore):
-- INSERT INTO consigli (da_utente_id, a_utente_id, animeclick_id, titolo)
-- VALUES (1, 1, 45427, 'Frieren');

-- Quante cartoline sono in viaggio, per chi:
-- SELECT a_utente_id, COUNT(*) FROM consigli WHERE aperto_il IS NULL
--  GROUP BY a_utente_id;
