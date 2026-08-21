-- ============================================================
-- MangaVault — Migrazione 014: le stagioni, e la videoteca di ciascuno
--
-- ESEGUIRE DOPO il 013.
--
-- COME ESEGUIRLO:
--   Supabase → SQL Editor → New query → incolla tutto → Run
--
-- Additiva e ripetibile: nessuna colonna eliminata, nessun dato
-- riscritto. Si può eseguire a sito acceso.
--
-- ------------------------------------------------------------
-- 1. QUELLO CHE IL 013 AVEVA DATO PER SCONTATO
--
-- La migrazione 013 dava per buona una regola: «una scheda AnimeClick
-- = una serie», perché AnimeClick numera in continuo su tutto il
-- franchise. È vero per Frieren (38 puntate, due stagioni, una scheda
-- sola) e per L'attacco dei giganti (89 in un elenco unico).
--
-- Non è vero sempre. «Isekai Farming» ha due schede — 42643 per la
-- prima stagione e 67685 per la seconda, che riparte da 1 — e in
-- videoteca diventavano due copertine della stessa serie, ognuna col
-- suo progresso. AnimeClick non è coerente con sé stessa, e la
-- videoteca non può fingere che lo sia.
--
-- Quindi si aggiunge un livello sopra la scheda: il GRUPPO. Un gruppo
-- è la serie come la chiama una persona («Isekai Farming»), le schede
-- che ci stanno dentro sono le sue stagioni. Una copertina sola in
-- videoteca, tutte le stagioni dentro la scheda.
--
-- Il gruppo NON sostituisce la riga `anime`: le puntate, le spunte e
-- le date restano attaccate alla scheda che le ha davvero, perché è
-- lì che i numeri di AnimeClick tornano. Il gruppo è solo il modo di
-- guardarle insieme.
--
-- ------------------------------------------------------------
-- 2. LA VIDEOTECA DIVENTA DI CIASCUNO
--
-- Finora `anime` era insieme il catalogo e la videoteca: qualunque
-- riga esistesse compariva a chiunque aprisse la sezione. Con due
-- persone che guardano cose diverse è sbagliato — e non c'era modo di
-- togliersi di torno una serie senza cancellarla anche all'altro.
--
-- Da qui in poi le due cose sono separate:
--   `anime`    il CATALOGO: cosa sappiamo di una serie. In comune,
--              perché i titoli delle puntate sono gli stessi per tutti
--              e rileggerli due volte sarebbe solo scortesia verso
--              AnimeClick.
--   `visioni`  la VIDEOTECA: quali serie sono TUE. Una riga per
--              (serie, persona), che già esisteva per tenere lo stato.
--              Adesso è anche la tessera d'ingresso.
--
-- «Togliere una serie dalla videoteca» diventa quindi: si cancella la
-- tua riga in `visioni` (con le tue spunte, il tuo voto, le tue note).
-- La scheda resta finché serve a qualcun altro, e sparisce quando non
-- la guarda più nessuno.
-- ============================================================


-- ------------------------------------------------------------
-- 1. I GRUPPI
--
-- Una tabella e non una colonna `franchise` scritta sulla riga:
-- il titolo del gruppo è una cosa sola condivisa da più schede, e
-- ripeterlo su ognuna vorrebbe dire poterlo scrivere in due modi
-- diversi sulla stessa serie.
--
-- `cover_url` può restare NULL: di norma la copertina del gruppo è
-- quella della prima stagione, e vale la pena scriverla solo quando si
-- vuole che sia un'altra.
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS anime_gruppi (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  titolo     TEXT NOT NULL CHECK (btrim(titolo) <> ''),
  cover_url  TEXT,

  creato_il  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ------------------------------------------------------------
-- 2. LA SCHEDA SA A QUALE GRUPPO APPARTIENE
--
-- `ordine` è la posizione fra le stagioni. Di solito la si deduce
-- dall'anno, ma non sempre l'anno basta (un film uscito fra due
-- stagioni, un prequel arrivato dopo), quindi si può scrivere.
--
-- `etichetta` è come si chiama quella stagione sulla scheda —
-- «Stagione 2», «Il film», «OAV». Vuota vuol dire «calcolala», e il
-- sito scrive «Stagione N» dalla posizione: così le serie normali non
-- chiedono nessun lavoro a mano.
--
-- ON DELETE SET NULL sul gruppo: sciogliere un gruppo non deve
-- portarsi dietro le serie che conteneva.
-- ------------------------------------------------------------

ALTER TABLE anime
  ADD COLUMN IF NOT EXISTS gruppo_id  BIGINT REFERENCES anime_gruppi(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ordine     INTEGER,
  ADD COLUMN IF NOT EXISTS etichetta  TEXT;

CREATE INDEX IF NOT EXISTS idx_anime_gruppo
  ON anime (gruppo_id, ordine) WHERE gruppo_id IS NOT NULL;


-- ------------------------------------------------------------
-- 3. CHI HA GIÀ UNA VIDEOTECA SE LA TIENE
--
-- Se la videoteca diventa «le serie che hai in `visioni`» senza
-- scrivere niente, chi apriva la sezione ieri e ci trovava quattro
-- serie oggi ne trova due: quelle a cui aveva dato uno stato. Le
-- altre sembrerebbero cancellate.
--
-- Quindi si consegnano al proprietario tutte le schede esistenti, e a
-- chiunque altro le schede su cui ha lasciato qualcosa di suo — una
-- spunta, un voto, una nota. `da_vedere` è lo stato giusto per una
-- serie che sta in videoteca senza che si sia detto altro.
-- ------------------------------------------------------------

INSERT INTO visioni (anime_id, utente_id, stato)
SELECT a.id, u.id, 'da_vedere'
  FROM anime a
 CROSS JOIN utenti u
 WHERE u.proprietario
ON CONFLICT (anime_id, utente_id) DO NOTHING;

INSERT INTO visioni (anime_id, utente_id, stato)
SELECT anime_id, utente_id, 'da_vedere' FROM episodi_visti
UNION
SELECT anime_id, utente_id, 'da_vedere' FROM voti_anime
UNION
SELECT anime_id, utente_id, 'da_vedere' FROM note_anime
ON CONFLICT (anime_id, utente_id) DO NOTHING;


-- ------------------------------------------------------------
-- 4. LA VISTA IMPARA I GRUPPI
--
-- Le colonne nuove si aggiungono IN FONDO: `CREATE OR REPLACE VIEW`
-- sa allungare l'elenco, non riordinarlo, e infilarne una in mezzo
-- costringerebbe a un DROP — che con una vista usata dal sito acceso
-- vuol dire qualche secondo di errori.
--
-- `stagioni_nel_gruppo` serve alla griglia: è il numero che permette
-- di scrivere «3 stagioni» sotto una copertina sola senza chiedere
-- una seconda volta al database.
-- ------------------------------------------------------------

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

  (SELECT COUNT(*) FROM anime s WHERE s.gruppo_id = a.gruppo_id)           AS stagioni_nel_gruppo

FROM anime a
LEFT JOIN anime_gruppi g ON g.id = a.gruppo_id;


-- ============================================================
-- VERIFICA — lancia dopo il Run
-- ============================================================

-- Le colonne nuove ci sono:
-- SELECT column_name FROM information_schema.columns
--  WHERE table_name = 'anime' AND column_name IN ('gruppo_id','ordine','etichetta');

-- Nessuno ha perso la sua videoteca (una riga per persona, col conto):
-- SELECT u.nickname, COUNT(*) AS serie
--   FROM visioni v JOIN utenti u ON u.id = v.utente_id
--  GROUP BY u.nickname ORDER BY u.nickname;

-- I gruppi, con dentro le loro stagioni:
-- SELECT g.titolo AS gruppo, a.ordine, a.etichetta, a.titolo
--   FROM anime_gruppi g JOIN anime a ON a.gruppo_id = g.id
--  ORDER BY g.titolo, a.ordine;
