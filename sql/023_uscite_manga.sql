-- ============================================================
-- 023 — LE USCITE DEI MANGA, MESSE DA PARTE
--
-- COME ESEGUIRLO:
--   Supabase → SQL Editor → New query → incolla tutto → Run
--
-- È SICURO: aggiunge e basta. Nessun dato viene toccato, si può
-- rieseguire più volte senza danni.
--
-- ------------------------------------------------------------
-- PERCHÉ
--
-- Il calendario manga di AnimeClick mostra solo da OGGI in avanti: un
-- volume uscito ieri sparisce dalla pagina e da lì non si può più
-- sapere che è uscito. Per il riepilogo del 10 («cosa è uscito dal 10
-- del mese scorso a oggi, e cosa ti manca») e per una pagina con le
-- uscite passate bisogna averlo scritto PRIMA. Un giro al giorno copia
-- il calendario qui; le righe restano per sempre.
--
-- Non è una tabella dei vostri volumi: ci sono TUTTE le uscite che
-- AnimeClick elenca, anche delle serie che non avete. Cosa vi riguarda
-- si decide dopo, abbinando titolo ed edizione alla collezione (vedi
-- `services/usciteManga.js`), come per le uscite della settimana.
-- ============================================================


-- ------------------------------------------------------------
-- 1. LE USCITE
--
-- La chiave è serie + edizione + editore + numero, ridotti a lettere e
-- cifre (la calcola il codice, `chiaveUscita`): così se AnimeClick
-- sposta la data di un volume si aggiorna LA STESSA riga invece di
-- scriverne una seconda, e un volume non può risultare uscito due volte.
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS uscite_manga (
  chiave        TEXT PRIMARY KEY,

  data          DATE NOT NULL,
  serie         TEXT NOT NULL,
  numero        INTEGER NOT NULL,
  titolo        TEXT,
  edizione      TEXT,
  editore       TEXT,
  copertina     TEXT,

  vista_il      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  aggiornata_il TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE uscite_manga IS
  'Il calendario manga di AnimeClick messo da parte, un giro al giorno. AnimeClick mostra solo da oggi in avanti: senza questa copia le uscite passate si perdono.';

-- Le domande sono sempre "fra due date".
CREATE INDEX IF NOT EXISTS idx_uscite_manga_data ON uscite_manga (data);


-- ------------------------------------------------------------
-- 2. I RIEPILOGHI GIÀ MANDATI
--
-- Una riga per persona e per periodo: la chiave primaria è tutto il
-- meccanismo, come per `avvisi_uscite`. Se il giro del 10 parte due
-- volte (GitHub Actions ogni tanto ripete) il secondo trova il posto
-- occupato e sta zitto. `periodo` è il giorno in cui chiude la finestra,
-- AAAA-MM-GG.
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS riepiloghi_manga (
  utente_id   BIGINT NOT NULL REFERENCES utenti(id) ON DELETE CASCADE,
  periodo     DATE   NOT NULL,
  inviato_il  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (utente_id, periodo)
);

COMMENT ON TABLE riepiloghi_manga IS
  'Il riepilogo mensile delle uscite già mandato a una persona. Serve a non ripeterlo se il giro del 10 parte due volte.';
