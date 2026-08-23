-- ============================================================
-- 019 — GLI AVVISI DELLE USCITE
--
-- COME ESEGUIRLO:
--   Supabase → SQL Editor → New query → incolla tutto → Run
--
-- È SICURO: aggiunge e basta. Nessun dato viene toccato, si può
-- rieseguire più volte senza danni.
--
-- ------------------------------------------------------------
-- COSA SERVE AL BOT
--
-- Il bot delle uscite (@Videoteca10xBot) è l'opposto di quello degli
-- acquisti: quello RICEVE messaggi, questo li MANDA e basta. Non ha
-- un webhook, non ha un indirizzo, non ascolta niente — è il giro
-- schedulato che lo fa parlare, come già fa col calendario.
--
-- Due cose gli mancano, e sono queste due qui sotto: A CHI scrivere,
-- e COSA HA GIÀ DETTO.
-- ============================================================


-- ------------------------------------------------------------
-- 1. A CHI SCRIVERE
--
-- Una colonna su `utenti` e non una tabella a parte: la chat di
-- Telegram è un attributo della persona come il soprannome o la
-- faccia, ce n'è al massimo una, e una tabella con una riga per
-- utente sarebbe `utenti` scritta due volte.
--
-- Nasce vuota, e vuota vuol dire "questa persona non riceve avvisi":
-- è la scelta giusta di partenza, perché un bot non può nemmeno
-- scrivere per primo a chi non l'ha mai aperto. Si riempie con
-- `node scripts/uscite-chatid.js --collega <soprannome> <chat_id>`,
-- dopo che la persona ha premuto Start.
--
-- BIGINT e non INTEGER: gli identificativi di chat di Telegram hanno
-- già superato i due miliardi, e i gruppi li scrivono in negativo.
-- ------------------------------------------------------------

ALTER TABLE utenti
  ADD COLUMN IF NOT EXISTS telegram_chat_id BIGINT;

COMMENT ON COLUMN utenti.telegram_chat_id IS
  'La chat di @Videoteca10xBot dove arrivano gli avvisi delle uscite. Vuota = questa persona non ne riceve. Si riempie a mano dopo che ha premuto Start: un bot non può scrivere per primo.';

-- Due persone non possono avere la stessa chat: sarebbe un modo
-- silenzioso di leggere gli avvisi di un altro. Parziale, perché il
-- vuoto ce l'hanno tutti quelli che non l'hanno collegato.
CREATE UNIQUE INDEX IF NOT EXISTS utenti_telegram_unico
  ON utenti (telegram_chat_id) WHERE telegram_chat_id IS NOT NULL;


-- ------------------------------------------------------------
-- 2. COSA HA GIÀ DETTO
--
-- È il pezzo che regge tutto il resto, ed è lo stesso meccanismo di
-- `telegram_visti` nel bot degli acquisti: la chiave primaria è
-- l'unica cosa che serve, chi scrive per primo vince, il secondo
-- trova il posto occupato e sta zitto.
--
-- PERCHÉ SERVE. Il cron di GitHub Actions non è puntuale: parte con
-- cinque, dieci, venti minuti di ritardo, e sotto carico un giro
-- salta del tutto. Perciò il lavoro non guarda "cosa è uscito in
-- questo istante" ma "cosa è uscito nell'ultima ora e mezza" — e una
-- finestra che si sovrappone ai giri vicini rimanderebbe lo stesso
-- avviso tre volte di fila. Le due cose insieme, mai una sola: la
-- finestra larga perché un giro saltato non perda la puntata, questa
-- tabella perché due giri non la mandino due volte.
--
-- `tipo` sta nella chiave apposta: il promemoria del mattino e
-- l'avviso a puntata uscita parlano della STESSA puntata e devono
-- partire tutti e due. Senza, il primo dei due zittirebbe l'altro.
--
-- Si punta al NUMERO dell'episodio e non al suo `id`, come fanno già
-- `episodi_visti`: le righe di `anime_episodi` si riscrivono quando
-- si rilegge una scheda, e un avviso legato a un id sparito sarebbe
-- un avviso mandato due volte.
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS avvisi_uscite (
  utente_id   BIGINT NOT NULL REFERENCES utenti(id) ON DELETE CASCADE,
  anime_id    BIGINT NOT NULL REFERENCES anime(id)  ON DELETE CASCADE,
  numero      INTEGER NOT NULL,

  tipo        TEXT NOT NULL CHECK (tipo IN ('uscita', 'mattina')),

  inviato_il  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (utente_id, anime_id, numero, tipo)
);

COMMENT ON TABLE avvisi_uscite IS
  'Un avviso già mandato. Serve a non ripetersi: il giro gira ogni mezz''ora su una finestra di novanta minuti, quindi ogni puntata passa sotto gli occhi del lavoro tre volte.';

-- La ripulitura: gli avvisi vecchi non servono a niente, ma non si
-- cancellano da soli. L'indice è per quello e per niente altro — la
-- domanda "l'ho già mandato?" la risponde la chiave primaria.
CREATE INDEX IF NOT EXISTS idx_avvisi_uscite_quando
  ON avvisi_uscite (inviato_il);


-- ------------------------------------------------------------
-- 3. CHI RICEVERÀ, OGGI
--
-- Non è un errore: è la riga da leggere prima di considerare finito
-- il lavoro. Appena eseguita la migrazione sono zero, ed è giusto —
-- nessuno ha ancora premuto Start.
-- ------------------------------------------------------------

DO $$
DECLARE
  collegati INTEGER;
  totale    INTEGER;
BEGIN
  SELECT COUNT(*) FILTER (WHERE telegram_chat_id IS NOT NULL), COUNT(*)
    INTO collegati, totale
    FROM utenti WHERE stato = 'attivo';

  RAISE NOTICE 'Avvisi delle uscite: % persone collegate su % attive.', collegati, totale;

  IF collegati = 0 THEN
    RAISE NOTICE 'Nessuna, per ora. Ognuno apre @Videoteca10xBot e preme Start, poi: node scripts/uscite-chatid.js';
  END IF;
END $$;
