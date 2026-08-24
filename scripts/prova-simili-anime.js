// Prova dei consigli in fondo alla scheda di un anime.
//
//   node scripts/prova-simili-anime.js
//   node scripts/prova-simili-anime.js 241 12
//   API=http://localhost:3000 node scripts/prova-simili-anime.js 241
//
// Non tocca il database e non ha bisogno di credenziali: il catalogo se
// lo prende dalle rotte pubbliche (`GET /api/anime` e
// `GET /api/anime/:id`), che sono leggibili senza token. È una scelta,
// non una scorciatoia — questo progetto vive su più computer e una
// prova che gira solo dove c'è il `.env` giusto è una prova che non si
// lancia. E la cosa che va guardata qui non è l'SQL: è l'ORDINE in cui
// escono i consigli e in quale dei due mucchi finiscono, che sono
// decisioni prese in `services/similiAnime.js` su dati veri.
//
// Cosa guardare nell'uscita, in ordine di importanza:
//
//   · Nessuna serie che compare DUE VOLTE con nomi di stagioni diverse
//     (era il difetto dei tre Cavalieri dello Zodiaco su Dandadan).
//   · Niente in «da scoprire» che sia in realtà la serie stessa o un
//     suo seguito.
//   · I consigli con molti voti sopra quelli segnalati da una persona.
//   · Nessun titolo in inglese fra i temi: se ne spunta uno, manca una
//     voce in `services/temiItaliani.js`.
//   · Le serie in «riprendile» devono avere davvero puntate rimaste.

const BASE = process.env.API || "https://mangavault10x-api.onrender.com";

const { similiDi } = require("../services/similiAnime");

// Le tre di partenza sono scelte per coprire tre casi diversi, non a
// caso: una serie moderna piena di accostamenti (Dandadan), una che è
// una scheda sola tagliata in due stagioni (Frieren) e una vecchia con
// tanti seguiti, dove il rischio di consigliare sé stessa è massimo.
const PREDEFINITI = [241, 12];

async function json(indirizzo) {
  const risposta = await fetch(`${BASE}${indirizzo}`, {
    signal: AbortSignal.timeout(60000)
  });

  if (!risposta.ok) throw new Error(`HTTP ${risposta.status} su ${indirizzo}`);

  return risposta.json();
}

function riga(carta) {
  const temi = carta.temiInComune.length ? `  ⟨${carta.temiInComune.join(", ")}⟩` : "";

  return `    ${carta.titolo}\n      ${carta.motivo || "—"}${temi}`;
}

(async () => {
  const voluti = process.argv.slice(2).map(Number).filter(Boolean);
  const daProvare = voluti.length ? voluti : PREDEFINITI;

  console.log(`Catalogo da ${BASE} …`);

  const catalogo = await json("/api/anime");

  console.log(`${catalogo.length} schede in catalogo.\n`);

  let problemi = 0;

  for (const id of daProvare) {
    let scheda;

    try {
      scheda = await json(`/api/anime/${id}`);
    } catch (err) {
      console.log(`✗ ${id}: ${err.message}\n`);
      problemi++;
      continue;
    }

    // La scheda torna le stagioni: quella aperta è la prima, ed è
    // quella che porta `animeclick_id` e `anilist_id`.
    const prima = scheda.stagioni?.[0] || scheda;

    const anime = {
      id: Number(scheda.id ?? prima.id),
      titolo: scheda.titolo || prima.titolo,
      titolo_originale: prima.titolo_originale || null,
      titolo_inglese: prima.titolo_inglese || null,
      animeclick_id: prima.animeclick_id || null,
      anilist_id: prima.anilist_id || null,
      gruppo_id: prima.gruppo_id || null
    };

    const inizio = Date.now();
    const esito = await similiDi(anime, { catalogo });
    const durata = ((Date.now() - inizio) / 1000).toFixed(1);

    console.log(`━━ ${anime.titolo} (id ${anime.id}) — ${durata}s`);
    console.log(`   fonti: AniList ${esito.fonti.anilist ? "✓" : "✗"} · AnimeClick ${esito.fonti.animeclick ? "✓" : "✗"}`);
    console.log(`   temi: ${esito.temi.join(" · ") || "—"}`);
    console.log(`   già viste fra i consigli: ${esito.gia_viste}`);

    console.log(`\n   DA SCOPRIRE (${esito.daScoprire.length})`);
    for (const c of esito.daScoprire) console.log(riga(c));

    console.log(`\n   RIPRENDILE (${esito.riprendile.length})`);
    for (const c of esito.riprendile) {
      const v = c.inVideoteca;
      console.log(`${riga(c)}\n      → ${v.stato}, vista fino alla ${v.ultimoVisto ?? 0} di ${v.episodi ?? "?"}`);
    }

    // I controlli che una persona farebbe a occhio, fatti a macchina:
    // sono gli stessi difetti trovati alla prima prova, e non devono
    // poter tornare senza che nessuno se ne accorga.
    const tutte = [...esito.daScoprire, ...esito.riprendile];

    const seStessa = tutte.filter((c) =>
      [anime.titolo, anime.titolo_originale, anime.titolo_inglese]
        .filter(Boolean)
        .some((t) => require("../services/providers/animeclickAnime").parentela([t], c.titolo))
    );

    const senzaMotivo = tutte.filter((c) => !c.motivo);

    const finiteInRiprendile = esito.riprendile.filter(
      (c) => c.inVideoteca.episodi && (c.inVideoteca.ultimoVisto ?? 0) >= c.inVideoteca.episodi
    );

    for (const [guaio, elenco] of [
      ["consiglia sé stessa o un suo seguito", seStessa],
      ["senza motivo scritto", senzaMotivo],
      ["già finita ma messa fra quelle da riprendere", finiteInRiprendile]
    ]) {
      if (!elenco.length) continue;

      console.log(`\n   ✗ ${guaio}: ${elenco.map((c) => c.titolo).join(", ")}`);
      problemi++;
    }

    console.log("");
  }

  console.log(problemi ? `\n${problemi} cose da guardare.` : "\nNessun difetto automatico trovato.");
  process.exit(problemi ? 1 : 0);
})().catch((err) => {
  console.error("Prova fallita:", err.message);
  process.exit(1);
});
