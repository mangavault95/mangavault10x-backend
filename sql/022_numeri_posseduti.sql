-- ============================================================
-- 022 — QUALI VOLUMI, NON QUANTI
--
-- Fino a qui di ogni serie si sapeva QUANTI volumi ci sono in casa
-- ("VolumiPosseduti"), mai QUALI. Andava bene finché si comprava in
-- ordine; non va bene per Yu-gi-oh, dove si possono avere l'1, il 2,
-- il 3, il 4, il 5 e l'11: il database diceva «6 su 13» e nessuno
-- poteva sapere che i buchi sono 6-10, 12 e 13.
--
-- Deciso da Carmine il 02/11/2026: ogni serie tiene l'ELENCO dei numeri.
--
-- ------------------------------------------------------------
-- PERCHÉ IL CONTEGGIO RESTA
--
-- "VolumiPosseduti" lo leggono le tre viste di riepilogo, le
-- statistiche, il rapporto mensile dei volumi, le uscite in
-- calendario, `/mancanti` del bot. Toglierlo vorrebbe dire
-- riscriverli tutti nello stesso giorno, e qualcosa resterebbe
-- indietro — il bot, per esempio, va ridistribuito a mano.
--
-- Quindi il conteggio resta, ma smette di essere una verità a parte:
-- è la LUNGHEZZA dell'elenco, e la tiene allineata un trigger. Chi
-- legge il conteggio continua a leggere un numero giusto; chi scrive
-- l'elenco non deve ricordarsi di aggiornare anche l'altro.
--
-- ------------------------------------------------------------
-- CHI SCRIVE ANCORA SOLO IL CONTEGGIO
--
-- Il bot com'è oggi in produzione fa «+1» e «−1» sul conteggio, e la
-- Gestione può scriverlo a mano. Il trigger li traduce nel gesto che
-- farebbe una persona: se il numero sale, entrano i primi volumi che
-- mancano; se scende, escono i più alti. È esattamente quanto ne
-- sapeva il vecchio sistema, quindi non si perde niente — e non c'è
-- una finestra in cui il bot vecchio scrive dati sbagliati, in
-- qualunque ordine si pubblichino migrazione, backend e bot.
-- ============================================================


-- ------------------------------------------------------------
-- 1. L'ELENCO
--
-- Un array e non una tabella a parte: i numeri di una serie si
-- leggono e si scrivono sempre tutti insieme, la scheda li vuole
-- tutti, e `SELECT *` di /api/manga li porta con sé senza un JOIN.
-- 2.604 volumi su 205 serie: niente che un array non regga.
-- ------------------------------------------------------------

ALTER TABLE "Manga"
  ADD COLUMN IF NOT EXISTS "NumeriPosseduti" INTEGER[] NOT NULL DEFAULT '{}';

-- Volumi dall'1 in su: lo zero e i negativi non esistono.
-- `0 < ALL('{}')` è vero, quindi l'elenco vuoto passa.
ALTER TABLE "Manga" DROP CONSTRAINT IF EXISTS numeri_posseduti_positivi;
ALTER TABLE "Manga"
  ADD CONSTRAINT numeri_posseduti_positivi CHECK (0 < ALL ("NumeriPosseduti"));


-- ------------------------------------------------------------
-- 2. IL RIEMPIMENTO
--
-- Chi ne ha N li ha dall'1 all'N. È vero per quasi tutta la
-- collezione; le poche serie sparse si correggono a mano dalla scheda.
-- Solo le righe ancora vuote: rilanciare la migrazione non deve
-- cancellare le correzioni già fatte.
-- ------------------------------------------------------------

UPDATE "Manga"
   SET "NumeriPosseduti" = ARRAY(SELECT generate_series(1, "VolumiPosseduti"::int))
 WHERE cardinality("NumeriPosseduti") = 0
   AND COALESCE("VolumiPosseduti", 0) > 0;


-- ------------------------------------------------------------
-- 3. IL TRIGGER CHE LI TIENE D'ACCORDO
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION allinea_numeri_posseduti() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  voluti  INTEGER;
  attuali INTEGER[];
BEGIN
  attuali := COALESCE(NEW."NumeriPosseduti", '{}');

  IF TG_OP = 'UPDATE'
     AND NEW."NumeriPosseduti" IS NOT DISTINCT FROM OLD."NumeriPosseduti"
     AND NEW."VolumiPosseduti" IS DISTINCT FROM OLD."VolumiPosseduti" THEN

    -- È cambiato solo il conteggio: chi scrive non conosce l'elenco.
    voluti := GREATEST(COALESCE(NEW."VolumiPosseduti", 0), 0)::int;

    IF voluti > cardinality(attuali) THEN
      -- Entrano i primi numeri che mancano. Fino a voluti + quanti ce
      -- ne sono già basta sempre: al massimo quelli sono esclusi.
      attuali := attuali || ARRAY(
        SELECT n FROM generate_series(1, voluti + cardinality(attuali)) AS n
         WHERE n <> ALL (attuali)
         ORDER BY n
         LIMIT voluti - cardinality(attuali)
      );
    ELSIF voluti < cardinality(attuali) THEN
      -- Escono i più alti: è l'ultimo comprato che si annulla.
      attuali := ARRAY(SELECT n FROM unnest(attuali) AS n ORDER BY n LIMIT voluti);
    END IF;

  ELSIF TG_OP = 'INSERT'
     AND cardinality(attuali) = 0
     AND COALESCE(NEW."VolumiPosseduti", 0) > 0 THEN

    -- Una serie nuova scritta col solo conteggio (la wishlist, il bot).
    attuali := ARRAY(SELECT generate_series(1, NEW."VolumiPosseduti"::int));
  END IF;

  -- Sempre: in ordine, senza doppioni, e il conteggio è la lunghezza.
  NEW."NumeriPosseduti" := ARRAY(SELECT DISTINCT n FROM unnest(attuali) AS n ORDER BY n);
  NEW."VolumiPosseduti" := cardinality(NEW."NumeriPosseduti");

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS manga_allinea_numeri ON "Manga";

-- `UPDATE OF` le due colonne: cambiare la trama non deve passare di qui.
CREATE TRIGGER manga_allinea_numeri
  BEFORE INSERT OR UPDATE OF "VolumiPosseduti", "NumeriPosseduti" ON "Manga"
  FOR EACH ROW EXECUTE FUNCTION allinea_numeri_posseduti();


-- ------------------------------------------------------------
-- 4. IL CONTROLLO
-- ------------------------------------------------------------

DO $$
DECLARE
  storte INTEGER;
  volumi INTEGER;
BEGIN
  SELECT COUNT(*) FILTER (WHERE cardinality("NumeriPosseduti") <> COALESCE("VolumiPosseduti", 0)),
         COALESCE(SUM(cardinality("NumeriPosseduti")), 0)
    INTO storte, volumi
    FROM "Manga";

  RAISE NOTICE '022: % volumi in elenco, % serie col conteggio diverso dall''elenco (deve essere 0)', volumi, storte;
END;
$$;


-- ------------------------------------------------------------
-- PER TORNARE INDIETRO (non serve eseguirlo)
--
-- DROP TRIGGER IF EXISTS manga_allinea_numeri ON "Manga";
-- DROP FUNCTION IF EXISTS allinea_numeri_posseduti();
-- ALTER TABLE "Manga" DROP CONSTRAINT IF EXISTS numeri_posseduti_positivi;
-- ALTER TABLE "Manga" DROP COLUMN IF EXISTS "NumeriPosseduti";
--
-- Il conteggio resta giusto: il trigger l'ha sempre tenuto allineato.
-- ------------------------------------------------------------
