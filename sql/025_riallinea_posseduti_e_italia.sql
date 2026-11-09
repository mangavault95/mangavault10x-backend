-- 025_riallinea_posseduti_e_italia.sql
--
-- Da eseguire nel SQL Editor di Supabase. Si può rilanciare: non
-- duplica niente.
--
-- Due correzioni ai dati che «Da comprare» ha portato a galla (09/11/2026).
--
-- 1. VITA DA SLIME 29. Il volume era stato comprato il 10/09 e c'è fra
--    gli `acquisti`, ma non nell'elenco "NumeriPosseduti": la 022 (02/11)
--    ha costruito l'elenco dal solo conteggio, 1..28, e il 29 non c'era
--    ancora nel conteggio. Risultato: la serie risultava a 28 e il 29
--    tornava fra i volumi da comprare. Qui ogni numero registrato in
--    `acquisti` ma assente dall'elenco ci viene aggiunto; ordine,
--    doppioni e conteggio li rifà il trigger della 022.
--
--    Non si tolgono mai numeri: gli acquisti non sono l'unica fonte
--    (la 022 ha dato 1..N a serie mai passate dal bot), quindi un numero
--    che c'è in elenco e non fra gli acquisti va lasciato dov'è.
--
-- 2. CHAINSAW MAN. Conclusa in Giappone con 24 volumi, in Italia ferma
--    al 23. Il controllo di AnimeClick tocca solo le serie in corso (o,
--    dal 09/11, quelle concluse con volumi mancanti) e per questa il
--    dato italiano è ancora vuoto, quindi il 24 sembrava già uscito.
--    Il controllo settimanale lo riscriverà da solo; qui lo si mette
--    subito. Il guard su "VolumiItalia" IS NULL evita di sovrascrivere un
--    dato più recente.

UPDATE "Manga" m
   SET "NumeriPosseduti" = COALESCE(m."NumeriPosseduti", '{}') || ARRAY(
         SELECT DISTINCT g
           FROM acquisti a, generate_series(a.volume_da, a.volume_a) AS g
          WHERE a.manga_id = m."ID"
            AND g <> ALL (COALESCE(m."NumeriPosseduti", '{}'))
          ORDER BY g)
 WHERE EXISTS (
         SELECT 1
           FROM acquisti a, generate_series(a.volume_da, a.volume_a) AS g
          WHERE a.manga_id = m."ID"
            AND g <> ALL (COALESCE(m."NumeriPosseduti", '{}')));

UPDATE "Manga"
   SET "VolumiItalia" = 23
 WHERE "Titolo" = 'Chainsaw Man'
   AND "VolumiItalia" IS NULL;

-- Controllo: dovrebbe restituire Vita da slime a 29 e Chainsaw Man a 23.
SELECT "Titolo", "VolumiPosseduti", "VolumiItalia"
  FROM "Manga"
 WHERE "Titolo" IN ('Vita da slime', 'Chainsaw Man');
