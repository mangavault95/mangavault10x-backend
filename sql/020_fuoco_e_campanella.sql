-- ============================================================
-- 020 — DOVE GUARDA LO STRISCIONE, E LA CAMPANELLA
--
-- Due cose piccole e slegate fra loro, in una migrazione sola perché
-- si eseguono a mano dentro Supabase e due Run invece di uno sono
-- un'occasione in più di farne solo metà.
--
--   1. LO STRISCIONE SI SPOSTA. L'immagine della fascia si ritaglia
--      da sé al centro, e su una copertina il centro è la pancia del
--      personaggio: la faccia resta fuori e non c'era modo di dirlo.
--      Adesso ogni immagine si porta dietro il suo punto di fuoco.
--
--   2. LA CAMPANELLA. Chi risponde a un tuo post, chi ci mette un
--      cuore e chi commenta una serie che hai visto: erano tutte cose
--      che si scoprivano scorrendo il feed all'indietro, cioè non si
--      scoprivano. Serve una sola colonna — fin dove hai già letto —
--      perché anche gli avvisi, come il feed, si CALCOLANO dalle
--      tabelle che ci sono già (vedi la 016: nessuna tabella di
--      eventi, nessuna seconda verità da tenere allineata).
-- ============================================================


-- ------------------------------------------------------------
-- 1. IL PUNTO DI FUOCO DI UN'IMMAGINE DI STRISCIONE
--
-- Due percentuali, come `object-position` in CSS: 0 è il bordo
-- sinistro (o alto), 100 quello destro (o basso), 50 il centro — che
-- è il comportamento di prima e quindi il valore predefinito. Le
-- righe che ci sono già restano esattamente dove sono.
--
-- Percentuali e non pixel: la fascia è alta 144 punti sul telefono e
-- 208 sul portatile, e lo stesso scostamento in pixel mostrerebbe due
-- pezzi diversi della stessa foto.
--
-- SMALLINT e non NUMERIC: mezzo punto percentuale su una fascia da
-- duecento pixel è un pixel, e nessuno sposta una foto di un pixel.
-- ------------------------------------------------------------

ALTER TABLE utenti_striscione
  ADD COLUMN IF NOT EXISTS fuoco_x SMALLINT NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS fuoco_y SMALLINT NOT NULL DEFAULT 50;

ALTER TABLE utenti_striscione DROP CONSTRAINT IF EXISTS fuoco_in_percentuale;

ALTER TABLE utenti_striscione ADD CONSTRAINT fuoco_in_percentuale CHECK (
  fuoco_x BETWEEN 0 AND 100 AND fuoco_y BETWEEN 0 AND 100
);


-- ------------------------------------------------------------
-- 2. FIN DOVE HAI GIÀ LETTO GLI AVVISI
--
-- Una colonna sola, e non una tabella «notifiche» con dentro una riga
-- per avviso. Il ragionamento è quello della 016 e vale anche qui:
-- gli avvisi si ricavano tutti da righe che esistono già — una
-- risposta è una riga di `cineforum_risposte`, un cuore una di
-- `cineforum_cuori`, un commento una di `note_anime` — e copiarli
-- altrove vorrebbe dire due verità che possono divergere. Cancellando
-- una risposta l'avviso sparisce da sé, che è il comportamento giusto
-- e che con una tabella a parte sarebbe stato codice da scrivere.
--
-- Quello che dalle righe NON si ricava è una cosa sola: fin dove hai
-- già guardato. Quindi una colonna sola.
--
-- Parte da NULL e non da NOW(): NULL vuol dire «non ha mai aperto la
-- campanella», e allora contano gli ultimi trenta giorni (il tetto lo
-- mette il codice, non il database). Mettendo NOW() qui, chi non ha
-- ancora aperto il sito troverebbe la campanella spenta su cose
-- successe ieri.
-- ------------------------------------------------------------

ALTER TABLE utenti
  ADD COLUMN IF NOT EXISTS avvisi_visti_il TIMESTAMPTZ;


-- Gli avvisi si chiedono «dal più recente» su tre tabelle: senza
-- questi due indici, ogni apertura della campanella legge per intero
-- i cuori e le risposte di tutti. Sono poche righe oggi, ma è la
-- lettura che si fa a ogni caricamento di pagina.
CREATE INDEX IF NOT EXISTS idx_cuori_quando   ON cineforum_cuori    (messo_il DESC);
CREATE INDEX IF NOT EXISTS idx_risposte_quando ON cineforum_risposte (creata_il DESC);


-- ============================================================
-- VERIFICA — lancia dopo il Run
-- ============================================================

-- Le colonne nuove:
-- SELECT column_name, column_default FROM information_schema.columns
--  WHERE table_name = 'utenti_striscione' AND column_name LIKE 'fuoco%';
-- SELECT column_name FROM information_schema.columns
--  WHERE table_name = 'utenti' AND column_name = 'avvisi_visti_il';

-- Tutte le immagini già caricate devono stare al centro:
-- SELECT COUNT(*) AS non_centrate FROM utenti_striscione
--  WHERE fuoco_x <> 50 OR fuoco_y <> 50;
