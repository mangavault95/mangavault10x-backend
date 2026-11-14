# Pagine d'esempio di AnimeClick

Pagine **costruite a mano** dai casi che i commenti del codice dicono essere già
successi (ristampe, Gazzetta, apostrofi come entità, doppio sceneggiatore, slug
col punto). **Non sono pagine salvate dal sito**: chi le ha scritte non poteva
raggiungere animeclick.it. Proteggono il nostro codice dai cambiamenti nostri e
tengono allineati i due parser; non possono accorgersi che AnimeClick ha cambiato
l'HTML.

Quando AnimeClick rompe qualcosa, la prova giusta è salvare la pagina vera:

    curl -A "MangaVault/1.0 (collezione personale)" -o fixtures/animeclick/NOME.html \
      "https://www.animeclick.it/manga/9607/-/edizioni"

aggiungere il caso al test, e vederlo fallire prima di correggere il parser.

**Questa cartella esiste uguale in `mangavault10x-backend` e in `mangavault10x-bot`.**
Le prove controllano che il contenuto sia lo stesso (impronta in
`scripts/prova-parser.js`): cambiata qui, va copiata là.
