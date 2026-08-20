-- ============================================================
-- MangaVault — Migrazione 012: le note, e il colore di chi le scrive
--
-- ESEGUIRE DOPO il 011.
--
-- COME ESEGUIRLO:
--   Supabase → SQL Editor → New query → incolla tutto → Run
--
-- Cosa cambia:
--   1. Ogni lettore ha un COLORE. Serve a capire a colpo d'occhio chi
--      ha scritto una nota, senza leggere un nome accanto a ogni riga.
--      Nicer l'ottone (il giallo di sempre), Nanaki il lilla; chi si
--      registrerà dopo se lo prende da solo fra quelli liberi.
--   2. Esistono le NOTE: testo libero attaccato a una serie, una riga
--      per nota, con dentro chi l'ha scritta e quando.
--
-- Le note si SCRIVONO dal libro aperto in "in lettura" e si LEGGONO
-- anche dalla scheda della serie in collezione — che è dove restano
-- quando la lettura è finita o mollata.
--
-- Le note sono di chi le scrive ma si vedono in due: è tutto il senso
-- del colore. La riga che divide il sito non cambia — quello che si
-- possiede è in comune, quello che si pensa è di ciascuno — cambia
-- solo che qui i pensieri si leggono a vicenda.
--
-- Non elimina niente e non tocca "Manga": si può eseguire a sito
-- acceso.
-- ============================================================


-- ------------------------------------------------------------
-- 1. IL COLORE DEL LETTORE
--
-- Non è un colore vero ma il NOME di un colore ('ottone', 'lilla'…):
-- il sito disegna solo con i token del suo design system, e un `#rrggbb`
-- scritto qui dentro sarebbe l'unico colore del sito deciso altrove.
-- I nomi validi stanno in `services/utenti.js` (COLORI_LETTORE), che è
-- anche chi ne assegna uno libero a chi si registra.
-- ------------------------------------------------------------

ALTER TABLE utenti
  ADD COLUMN IF NOT EXISTS colore TEXT;

-- Il proprietario tiene il giallo che il sito ha sempre usato.
UPDATE utenti SET colore = 'ottone' WHERE proprietario AND colore IS NULL;

-- Il primo lettore dopo di lui è Nanaki, e vuole il lilla.
UPDATE utenti
   SET colore = 'lilla'
 WHERE colore IS NULL
   AND id = (
     SELECT id FROM utenti
      WHERE NOT proprietario
      ORDER BY creato_il ASC
      LIMIT 1
   );


-- ------------------------------------------------------------
-- 2. LE NOTE
--
-- Attaccate alla serie e non al volume: è quello che è stato chiesto,
-- e una nota che parla di un'opera non ha bisogno di un numero per
-- essere ritrovata.
--
-- Nessun vincolo di unicità: le note sono tante per serie, ed è il
-- punto — si annota mentre si legge, non una volta sola.
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS note_serie (
  id             BIGSERIAL PRIMARY KEY,

  manga_id       BIGINT NOT NULL REFERENCES "Manga"("ID") ON DELETE CASCADE,
  utente_id      BIGINT NOT NULL REFERENCES utenti(id)    ON DELETE CASCADE,

  -- Il testo non può essere vuoto: una nota senza niente dentro è una
  -- riga che occupa spazio sulla scheda e non dice nulla.
  testo          TEXT NOT NULL CHECK (btrim(testo) <> ''),

  creata_il      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  aggiornata_il  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Si leggono sempre "tutte le note di questa serie": è la lettura che
-- fa ogni scheda, e senza indice sarebbe una scansione per riga.
CREATE INDEX IF NOT EXISTS idx_note_manga ON note_serie(manga_id);


-- ------------------------------------------------------------
-- 3. CHI HA LETTO COSA, in fretta
--
-- Il filtro "lette da" in collezione e la classifica chiedono, per
-- ogni serie, se una persona ne ha letto almeno un volume. È una
-- domanda su (manga_id, utente_id) e la cronologia ha già qualche
-- migliaio di righe.
-- ------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_storico_manga_utente
  ON reading_history(manga_id, utente_id);


-- ============================================================
-- VERIFICA — lancia dopo il Run
-- ============================================================

-- SELECT nickname, colore, proprietario FROM utenti ORDER BY creato_il;
-- SELECT COUNT(*) AS note FROM note_serie;
