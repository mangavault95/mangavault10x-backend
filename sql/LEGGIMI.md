# Le migrazioni

I file `NNN_nome.sql` si eseguono **in ordine, una volta sola**. Quali sono già
passate lo dice la tabella `schema_migrations`, che si legge e si aggiorna con
`scripts/migra.js`. Il codice è in `services/migrazioni.js`.

## Aggiungere una migrazione

1. Scrivi `sql/028_nome.sql` col numero successivo. Ripetibile (`IF NOT EXISTS`)
   quando si può, e con in testa il **perché**, come le altre.
2. `npm run migra` — stato, in sola lettura.
3. `npm run migra -- applica` — **simulazione**: elenca cosa applicherebbe.
4. `npm run migra -- applica --si` — la applica, in una transazione sua insieme
   alla riga del registro: o passa tutta o non cambia niente.

Va fatto **prima** di pubblicare il codice che ne dipende, come sempre.
Serve `DATABASE_URL` (di solito nel file `.env`). Non c'è niente di automatico:
né all'avvio del server né al deploy.

Un numero ripetuto è un errore,
e un file con un numero più basso dell'ultimo applicato viene rifiutato.

## La prima volta: la baseline

Il registro non esiste finché non lo si crea, e le prime 27 migrazioni sono già
passate (a mano, da Supabase). **Non vanno rieseguite**: alcune modificano dati
e non sono ripetibili — la `006_animeclick` riscrive gli `AnimeClickID` corretti
nel frattempo, la `003` ragiona su una colonna che la `009` ha tolto.

1. `npm run migra` — per ogni file dice quanti degli oggetti che crea (tabelle,
   colonne, indici, sequenze) sono già sul database. Quelli che mancano
   sono la prova che quella migrazione NON è passata.
2. `npm run migra -- baseline --fino 027` — simulazione.
3. `npm run migra -- baseline --fino 027 --si` — le segna come già eseguite,
   **senza eseguire niente**.

La baseline rifiuta se un oggetto atteso manca (esegui prima a mano quella
migrazione, oppure `--forza` se sai cosa stai facendo). Le migrazioni di soli
dati (002, 003, 025…) non hanno oggetti da controllare: lì ci si fida della
propria parola.

## Cosa NON è ancora cambiato

Il codice ha una quarantina di rami che sul codice di errore `42P01` (tabella
assente) o `42703` (colonna assente) ripiegano su un comportamento vecchio:
servivano quando non si sapeva quali migrazioni fossero passate. **Sono ancora
lì**, e vanno tolti solo dopo che la baseline è stata fatta sul database vero e
`npm run migra` mostra tutto in ordine: tolti prima, un database in ritardo
darebbe errori al posto di dati degradati.

## `sql/archivio/`

Migrazioni **mai eseguite** in produzione e non più da eseguire. Il registro non
le legge. Oggi c'è la `006_id_autoincrementale` (una sequenza per gli ID delle
serie): il codice sceglie l'ID da sé con un lucchetto (`services/idManga.js`) e
il sito funziona così, quindi non serviva. Il motivo per cui è lì e cosa servirebbe
per riprenderla sono scritti in testa al file.
