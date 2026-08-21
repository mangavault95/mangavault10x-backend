-- ============================================================
-- MangaVault — Migrazione 015: le stagioni dentro una scheda sola
--
-- ESEGUIRE DOPO il 014.
--
-- COME ESEGUIRLO:
--   Supabase → SQL Editor → New query → incolla tutto → Run
--
-- Additiva e ripetibile: una colonna in più e niente altro.
--
-- ------------------------------------------------------------
-- L'ALTRA METÀ DEL PROBLEMA DELLE STAGIONI
--
-- La 014 ha risolto il caso di Isekai Farming: due SCHEDE di
-- AnimeClick che sono la stessa serie, rimesse insieme da un gruppo.
--
-- Resta il caso opposto, che è quello di Frieren: UNA scheda sola con
-- dentro 38 puntate che sono due stagioni (28 + 10), numerate di
-- seguito. Nessun gruppo può aiutare — la riga è una — e la scheda
-- mostrava un elenco unico di 38 caselle.
--
-- Serve sapere DOVE finisce una stagione e comincia l'altra, e
-- AnimeClick non lo dice: nella sua tabella degli episodi non c'è
-- nessun separatore, nessuna intestazione, niente. È stato verificato
-- riga per riga sulla pagina di Frieren.
--
-- Lo dice AniList, che al contrario tiene un media per stagione:
-- «Sousou no Frieren» 28 puntate, il suo SEQUEL «2nd Season» 10.
-- Sommando in ordine si sa che la seconda comincia dalla 29. È la
-- stessa asimmetria annotata nella 013 — 38 contro 28 — usata al
-- contrario: non più una discordanza da subire, ma la misura che
-- mancava.
--
-- `tagli` conserva quel risultato: i numeri degli episodi da cui
-- comincia una stagione nuova. Frieren: `{29}`. Una serie di una
-- stagione sola: vuoto.
--
-- Perché conservarlo invece di ricalcolarlo: perché è una risposta che
-- non cambia (una stagione finita ha finito di avere puntate), perché
-- AniList ha un limite di richieste, e soprattutto perché deve poter
-- essere CORRETTO A MANO. L'abbinamento fra le due schede si fa per
-- titolo, e per titolo si sbaglia: la Gestione della videoteca ha un
-- campo per riscriverlo, e quel campo scrive qui.
-- ============================================================

ALTER TABLE anime
  ADD COLUMN IF NOT EXISTS tagli INTEGER[] NOT NULL DEFAULT '{}';

-- L'id di AniList c'era già dalla 013 e non lo usava nessuno: da qui
-- in poi è il media della PRIMA stagione, cioè il capo della catena da
-- cui si contano le puntate.
COMMENT ON COLUMN anime.tagli IS
  'Episodi da cui comincia una stagione nuova dentro questa scheda. Frieren: {29}.';


-- La vista impara i tagli. Le colonne nuove vanno IN FONDO:
-- CREATE OR REPLACE VIEW sa allungare l''elenco, non riordinarlo.
CREATE OR REPLACE VIEW v_videoteca AS
SELECT
  a.id,
  a.titolo,
  a.tipo,
  a.stato,
  a.stato_italia,
  a.anno_inizio,
  a.cover_url,
  a.generi,
  a.distributori,
  a.manga_id,

  a.episodi_totali,
  (SELECT COUNT(*) FROM anime_episodi e WHERE e.anime_id = a.id)           AS episodi_disponibili,

  (SELECT ROUND(AVG(v.voto), 2) FROM voti_anime v WHERE v.anime_id = a.id) AS voto_medio,
  (SELECT COUNT(*) FROM note_anime n WHERE n.anime_id = a.id)              AS note,

  (SELECT MIN(e.uscita_italia)
     FROM anime_episodi e
    WHERE e.anime_id = a.id
      AND e.uscita_italia > NOW())                                         AS prossima_uscita,

  (SELECT e.numero
     FROM anime_episodi e
    WHERE e.anime_id = a.id
      AND e.uscita_italia > NOW()
    ORDER BY e.uscita_italia
    LIMIT 1)                                                               AS prossimo_episodio,

  (a.trama IS NULL OR a.cover_url IS NULL)                                 AS scheda_incompleta,

  -- ---- dal 014: il gruppo ----
  a.gruppo_id,
  a.ordine,
  a.etichetta,
  g.titolo                                                                 AS gruppo_titolo,
  g.cover_url                                                              AS gruppo_cover,

  (SELECT COUNT(*) FROM anime s WHERE s.gruppo_id = a.gruppo_id)           AS stagioni_nel_gruppo,

  -- ---- dal 015: le stagioni dentro la scheda ----
  a.tagli

FROM anime a
LEFT JOIN anime_gruppi g ON g.id = a.gruppo_id;


-- ============================================================
-- VERIFICA — lancia dopo il Run
-- ============================================================

-- La colonna c'è, e i tagli si vedono man mano che le schede si
-- rileggono da AnimeClick:
-- SELECT titolo, episodi_totali, tagli FROM anime ORDER BY lower(titolo);
