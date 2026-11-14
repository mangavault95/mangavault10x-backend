// routes/montaggio.js
//
// Quali rotte stanno a quale indirizzo. Lo legge `index.js` per montarle e lo legge
// `scripts/prova-protezione.js` per controllare che ogni rotta che SCRIVE abbia una
// guardia: la stessa lista nei due posti, così una rotta nuova non può restare fuori
// da quel controllo senza che qualcuno se ne accorga.
//
// L'ORDINE conta (Express prova le rotte in sequenza): non va cambiato senza motivo.

module.exports = [
  ["/api/utenti", require("./utenti")],
  ["/api/manga", require("./manga")],
  ["/api/wishlist", require("./wishlist")],
  ["/api/wishlist-actions", require("./wishlistActions")],
  ["/api/reading-history", require("./readingHistory")],
  ["/api/reading-sessions", require("./readingSessions")],
  ["/api/letture-droppate", require("./droppate")],
  ["/api/note", require("./note")],
  ["/api/marketplace", require("./marketplace")],
  ["/api/cover", require("./cover")],
  ["/api/simili", require("./simili")],
  ["/api/tornei", require("./tornei")],
  ["/api/autore", require("./autore")],
  ["/api/anime", require("./anime")],
  ["/api/mese", require("./mese")],
  ["/api/esporta", require("./esporta")],
  // La piazza della videoteca: quello che hanno fatto tutti, i messaggi
  // scritti a mano, e le pagine personali che si cercano per soprannome.
  ["/api/cineforum", require("./cineforum")]
];
