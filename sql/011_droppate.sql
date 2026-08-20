-- ============================================================
-- MangaVault — Migrazione 011: droppare è di chi legge
--
-- ESEGUIRE DOPO il 010.
--
-- COME ESEGUIRLO:
--   Supabase → SQL Editor → New query → incolla tutto → Run
--
-- Perché.
--   Il 009 ha diviso i voti e le letture fra le due persone, ma
--   "Droppato" è rimasto dov'era: una colonna di "Manga", cioè un
--   fatto della SERIE. Solo che mollare una serie non è una proprietà
--   dell'opera, è un giudizio di chi la stava leggendo — sta dalla
--   parte dei voti, non da quella dei volumi posseduti.
--
--   Il sintomo, trovato dal vivo: Nisekoi è droppata dal proprietario,
--   e siccome le serie droppate restano fuori dall'elenco di quelle da
--   aprire, all'altra lettrice non compariva fra i manga che poteva
--   iniziare. Una decisione presa da uno spariva dallo schermo
--   dell'altra.
--
-- Cosa cambia:
--   1. Nuova tabella `letture_droppate`, una riga per (serie, persona),
--      esattamente come `voti`.
--   2. Le serie droppate oggi diventano droppate DAL PROPRIETARIO.
--   3. La colonna "Manga"."Droppato" sparisce: due copie della stessa
--      informazione divergono sempre.
--
-- Restano in comune, come sempre: volumi posseduti, wishlist,
-- collezione, spesa.
--
-- ⚠️  ELIMINA una colonna. Fai un backup prima:
--     Supabase → Database → Backups
-- ============================================================


-- ------------------------------------------------------------
-- 1. LA TABELLA
--
-- Non c'è un booleano: droppata è la riga che esiste, ripresa è la
-- riga che non c'è più. Un flag avrebbe voluto dire tenere in giro
-- righe `false` che non dicono niente.
--
-- BIGINT ai due capi come in `voti`: gli stessi tipi della relazione
-- che imita.
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS letture_droppate (
  manga_id     BIGINT NOT NULL REFERENCES "Manga"("ID") ON DELETE CASCADE,
  utente_id    BIGINT NOT NULL REFERENCES utenti(id)    ON DELETE CASCADE,

  droppata_il  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (manga_id, utente_id)
);

-- Si interroga sempre "cosa ha droppato questa persona", mai "chi ha
-- droppato questa serie": l'indice va su utente_id, la chiave primaria
-- copre già l'altro verso.
CREATE INDEX IF NOT EXISTS idx_droppate_utente ON letture_droppate(utente_id);


-- ------------------------------------------------------------
-- 2. QUELLE DROPPATE FINORA SONO DEL PROPRIETARIO
--
-- Girare due volte questo script non le duplica.
-- ------------------------------------------------------------

INSERT INTO letture_droppate (manga_id, utente_id)
SELECT
  m."ID",
  (SELECT id FROM utenti WHERE proprietario)
FROM "Manga" m
WHERE m."Droppato" IS TRUE
ON CONFLICT (manga_id, utente_id) DO NOTHING;


-- ------------------------------------------------------------
-- 3. VIA LA VECCHIA COLONNA
--
-- Verificato prima di scriverlo: `v_collezione_riepilogo` non la
-- nomina, quindi la vista non va rifatta come nel 009.
-- ------------------------------------------------------------

ALTER TABLE "Manga" DROP COLUMN IF EXISTS "Droppato";


-- ============================================================
-- VERIFICA — lancia dopo il Run
--
-- Devono uscire le tre serie droppate finora (Beyond the Clouds,
-- Nisekoi, Tokyo Ghoul:re), tutte intestate al proprietario.
-- ============================================================

-- SELECT u.nickname, m."Titolo", d.droppata_il
-- FROM letture_droppate d
-- JOIN "Manga"  m ON m."ID" = d.manga_id
-- JOIN utenti   u ON u.id   = d.utente_id
-- ORDER BY u.nickname, m."Titolo";
