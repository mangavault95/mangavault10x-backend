-- ============================================================
-- 018 — LA BIBLIOTECA È RISERVATA
--
-- Fino a qui "essere accettati" era una cosa sola: chi si registrava e
-- veniva approvato entrava dappertutto, con i suoi voti e le sue
-- letture in biblioteca e la sua videoteca di là.
--
-- Non è più quello che serve. Le REGISTRAZIONI valgono per la
-- VIDEOTECA: chi bussa vuole il Cineforum, le serie viste, i commenti
-- agli episodi. La BIBLIOTECA invece è la collezione di carta di casa
-- — i volumi comprati, quelli letti, i voti sui manga — ed è di due
-- persone: il proprietario e Nanaki. Chiunque altro, di qua, può
-- soltanto GUARDARE, e quello che guarda è la biblioteca del
-- proprietario, come chiunque passi dal sito senza entrare.
--
-- ------------------------------------------------------------
-- PERCHÉ UNA COLONNA E NON UN RUOLO
--
-- `ruolo` c'è già ('admin' / 'lettore') e la tentazione era usarlo.
-- Ma un ruolo è una scala — chi ne ha di più può fare tutto quello
-- che può chi ne ha di meno — e qui non c'è nessuna scala: la
-- videoteca ce l'hanno tutti, la biblioteca è un posto in cui si è
-- ammessi o no. Sono due permessi affiancati, non due gradini, e
-- scriverli come gradini vorrebbe dire che il giorno in cui uno dei
-- due cambia bisogna reinventare l'ordine.
--
-- Di suo la colonna nasce FALSE: chi si registra da domani ha la
-- videoteca e basta, ed è il proprietario ad aprirgli la biblioteca a
-- mano dalla Gestione, se e quando vorrà.
--
-- ------------------------------------------------------------
-- COSA SUCCEDE A QUELLO CHE HANNO GIÀ SCRITTO
--
-- Niente: voti, letture, note e droppate di chi resta fuori NON si
-- cancellano. Smettono solo di comparire — le schede in
-- `GET /api/manga` elencano ormai solo chi è di casa — e tornerebbero
-- da sole il giorno in cui il proprietario aprisse la porta a quella
-- persona. Cancellarle sarebbe una decisione irreversibile presa da
-- una migrazione, che è il posto peggiore per prenderla.
--
-- Sotto, in fondo, c'è una NOTICE che dice chi sono le persone che
-- restano fuori pur avendo lasciato qualcosa in biblioteca: è
-- un'informazione da leggere prima di considerare finito il lavoro,
-- non un errore.
-- ============================================================

ALTER TABLE utenti
  ADD COLUMN IF NOT EXISTS biblioteca BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN utenti.biblioteca IS
  'Ha una biblioteca sua: voti, letture, note e droppate dei manga. Senza, la biblioteca si vede soltanto, ed è quella del proprietario. La videoteca non c''entra: quella ce l''hanno tutti.';

-- Il padrone di casa, sempre. Lo riscrive anche il backend a ogni
-- avvio (`preparaUtenti`), ma un permesso che dipende da un processo
-- acceso non è un permesso.
UPDATE utenti SET biblioteca = TRUE WHERE proprietario;

-- L'altra lettrice. Il soprannome è l'unica cosa stabile che la
-- identifica: l'identificativo cambia da un database all'altro e il
-- nome utente non si scrive da nessuna parte.
UPDATE utenti SET biblioteca = TRUE WHERE lower(nickname) = 'nanaki';

-- ------------------------------------------------------------
-- CHI RESTA FUORI PUR AVENDO LASCIATO QUALCOSA
-- ------------------------------------------------------------
DO $$
DECLARE
  riga RECORD;
  trovati INT := 0;
BEGIN
  FOR riga IN
    SELECT u.nickname,
           (SELECT COUNT(*) FROM voti             v WHERE v.utente_id = u.id) AS voti,
           (SELECT COUNT(*) FROM reading_history  h WHERE h.utente_id = u.id) AS letture,
           (SELECT COUNT(*) FROM note_serie       n WHERE n.utente_id = u.id) AS note,
           (SELECT COUNT(*) FROM letture_droppate d WHERE d.utente_id = u.id) AS droppate
      FROM utenti u
     WHERE NOT u.biblioteca
     ORDER BY u.creato_il
  LOOP
    IF riga.voti + riga.letture + riga.note + riga.droppate > 0 THEN
      trovati := trovati + 1;

      RAISE NOTICE
        'Fuori dalla biblioteca ma ha già scritto: % — % voti, % letture, % note, % droppate (restano, nascoste)',
        riga.nickname, riga.voti, riga.letture, riga.note, riga.droppate;
    END IF;
  END LOOP;

  IF trovati = 0 THEN
    RAISE NOTICE 'Nessuno resta fuori con qualcosa di scritto in biblioteca.';
  END IF;

  RAISE NOTICE 'Dentro la biblioteca: %',
    (SELECT string_agg(nickname, ', ' ORDER BY proprietario DESC, creato_il)
       FROM utenti WHERE biblioteca);
END $$;


-- ============================================================
-- VERIFICA — lancia dopo il Run
-- ============================================================

-- Chi è di casa e chi no:
-- SELECT nickname, proprietario, biblioteca, stato FROM utenti
--  ORDER BY proprietario DESC, creato_il;

-- Aprire la biblioteca a qualcuno si fa dalla Gestione, non di qui.
-- Ma se servisse a mano:
-- UPDATE utenti SET biblioteca = TRUE WHERE lower(nickname) = 'gla';
