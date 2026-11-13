-- ============================================================
-- 027 — COSA C'ERA GIÀ IN CASA QUANDO È STATO REGISTRATO UN ACQUISTO
--
-- COME ESEGUIRLO:
--   Supabase → SQL Editor → New query → incolla tutto → Run
--
-- È SICURO: aggiunge una colonna e basta. Nessun dato viene toccato,
-- si può rieseguire più volte senza danni.
--
-- ⚠️ VA ESEGUITA PRIMA di pubblicare il codice nuovo (backend e bot):
-- da questa versione ogni acquisto scrive la colonna, e senza la
-- colonna la registrazione fallisce.
--
-- ------------------------------------------------------------
-- PERCHÉ
--
-- Annullare un acquisto toglieva dai posseduti TUTTI i numeri fra
-- volume_da e volume_a. È giusto finché l'acquisto ha portato in casa
-- volumi nuovi. Ma un doppione registrato apposta («Registralo lo
-- stesso» sul bot, o un volume ricomprato) parla di un numero che in
-- casa c'era già: annullarlo cancellava anche la copia di prima, e il
-- sito si metteva a dire che quel volume manca.
--
-- Qui l'acquisto si segna quali dei suoi numeri erano GIÀ posseduti
-- nel momento in cui è stato scritto. L'annullo toglie solo gli altri.
--
-- NULL = non si sa (tutti gli acquisti scritti prima di oggi): per
-- quelli l'annullo si comporta come ha sempre fatto.
-- ============================================================

ALTER TABLE acquisti
  ADD COLUMN IF NOT EXISTS gia_posseduti INT[];

COMMENT ON COLUMN acquisti.gia_posseduti IS
  'I numeri fra volume_da e volume_a che erano già fra i posseduti quando l''acquisto è stato registrato: l''annullo non li toglie. NULL = acquisto scritto prima della 027, non si sa.';
