-- 007_editore_panini.sql
--
-- Da eseguire nel SQL Editor di Supabase.
--
-- "Panini" (71 righe) e "Panini S.p.A." (2 righe, su Naruto e Psychic
-- Detective Yakumo) sono lo stesso editore scritto in due modi.
-- Verificato: nessun altro editore in tabella ha lo stesso problema
-- (Coconino Press, Dynit, Edizioni BD, GP, Granata Press, J-POP, Play
-- Press, Star Comics, Toshokan compaiono già una sola volta ciascuno).

UPDATE "Manga" SET "Editore" = 'Panini' WHERE "Editore" = 'Panini S.p.A.';
