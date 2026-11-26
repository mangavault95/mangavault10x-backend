-- ============================================================
-- 037 — Le notifiche push dall'app installata
--
-- Gli avvisi delle uscite oggi arrivano solo da Telegram. Da app installata
-- (iPhone dal 16.4, Android, desktop) il browser sa riceverle da solo: «È uscito
-- l'ep. 3 di Frieren», «Domani esce il vol. 12». Servono tre tabelle, e nient'altro:
--
--   push_sottoscrizioni  dove consegnare: l'indirizzo che il browser ha dato a
--                        quella persona su quel dispositivo, più le due chiavi
--                        che servono a cifrare il messaggio. Una persona può
--                        averne più d'una (telefono, portatile).
--   push_inviati         cosa è già partito, per non ripetersi: lo stesso lavoro
--                        degli avvisi Telegram (`avvisi_uscite`), ma in una
--                        tabella a parte, così i due canali non si pestano i
--                        piedi (una puntata già annunciata su Telegram deve
--                        partire comunque come push, e viceversa) e la CHECK di
--                        `avvisi_uscite` non si tocca.
--   push_volumi_inviati  lo stesso, per l'avviso del giorno prima dei volumi
--                        (`services/avvisiVolumi.js`).
--
-- `endpoint` è unico: lo stesso dispositivo che si iscrive due volte è una riga
-- sola. Se cambia persona sullo stesso dispositivo (esce uno, entra l'altro) la
-- riga passa a chi si è iscritto per ultimo: è il comportamento giusto, perché le
-- notifiche vanno a chi tiene il telefono in mano.
--
-- Ripetibile. Va eseguita PRIMA di pubblicare il codice che la usa.
-- ============================================================

CREATE TABLE IF NOT EXISTS push_sottoscrizioni (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  utente_id        BIGINT NOT NULL REFERENCES utenti(id) ON DELETE CASCADE,
  endpoint         TEXT NOT NULL UNIQUE,
  p256dh           TEXT NOT NULL,
  auth             TEXT NOT NULL,
  creata_il        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ultimo_invio_il  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS push_sottoscrizioni_utente
  ON push_sottoscrizioni (utente_id);

COMMENT ON TABLE push_sottoscrizioni IS
  'Dove consegnare una notifica push: un dispositivo di una persona. Una riga che il servizio push rifiuta (410/404) si cancella da sola.';

CREATE TABLE IF NOT EXISTS push_inviati (
  utente_id   BIGINT NOT NULL REFERENCES utenti(id) ON DELETE CASCADE,
  anime_id    BIGINT NOT NULL REFERENCES anime(id)  ON DELETE CASCADE,
  numero      INTEGER NOT NULL,
  tipo        TEXT NOT NULL CHECK (tipo IN ('uscita', 'mattina')),
  inviato_il  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (utente_id, anime_id, numero, tipo)
);

-- «Domani esce il vol. 12»: i volumi annunciati il giorno prima. La DATA sta nella
-- chiave perché un'uscita che si sposta merita un avviso nuovo. Niente chiave
-- esterna su `manga_id`: «Manga» è la tabella più vecchia del sito e una serie
-- cancellata lascia al più una riga morta, che non fa male a nessuno.
CREATE TABLE IF NOT EXISTS push_volumi_inviati (
  utente_id   BIGINT NOT NULL REFERENCES utenti(id) ON DELETE CASCADE,
  manga_id    BIGINT NOT NULL,
  numero      INTEGER NOT NULL,
  data        DATE NOT NULL,
  inviato_il  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (utente_id, manga_id, numero, data)
);

COMMENT ON TABLE push_volumi_inviati IS
  'Un avviso «domani esce il vol. N» già mandato come push. Il giro gira una volta al giorno, ma può essere lanciato due volte: senza questa la stessa persona riceverebbe due notifiche.';

COMMENT ON TABLE push_inviati IS
  'Una notifica push già mandata. Come avvisi_uscite ma per il canale push: il giro gira ogni mezz''ora su una finestra di novanta minuti, e senza questa ogni puntata passerebbe tre volte.';
