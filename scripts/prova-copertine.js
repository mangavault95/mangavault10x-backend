// Prova delle copertine dei volumi (services/copertineVolumi.js, sql/030).
//
//   PROVA_DATABASE_URL=postgres://… node scripts/prova-copertine.js
//
// Il lettore gira ovunque; la parte che scrive gira su un Postgres di prova, in uno
// schema suo creato e buttato via, con il file vero sql/030.
//
// ⚠️ La riga d'esempio ricalca la PRIMA riga di una pagina vera (Hunter x Hunter, letta da
// GitHub il 14/11/2026: cella nascosta con l'id, `<img class="anteprima-img" data-img=…>`,
// link a /edizione/…). Le altre righe sono costruite a mano sulla stessa forma: la colonna
// della data e quella del prezzo non le ho viste, sono come le legge `volumiUsciti`.

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const { copertineVolumi, indirizzoImmagine } = require("../services/providers/animeclick");
const { riparato } = require("../services/copertineVolumi");

let falliti = 0;

function prova(nome, atteso, ottenuto) {
  const a = JSON.stringify(atteso);
  const o = JSON.stringify(ottenuto);

  if (a === o) console.log(`  ok   ${nome}`);
  else {
    falliti += 1;
    console.log(`  NO   ${nome}\n       atteso   ${a}\n       ottenuto ${o}`);
  }
}

const riga = (titolo, immagine, { data = "01/02/2020", extra = "" } = {}) => `
<tr> <td style="display:none;">3588</td> <td>
  ${immagine === null ? "" : `<img width="32" class="anteprima-img" data-edition-cover-preview="1" data-img="${immagine}" src="${immagine}" />`}
  </td> <td class="col-lg-4"><a rel="nofollow" href="/edizione/29401/x">${titolo}</a>
  <span style='white-space: nowrap;'><a href="https://mangayo.it/r/animeclick/1" target='_blank'><img src='/bundles/accommon/images/MangaYo2.svg' height='20'></a></span></td>
  <td>${extra}</td><td>${data}</td><td>5,20</td></tr>`;

const pagina = (...righe) => `<html><table><thead><tr><th>x</th></tr></thead><tbody>${righe.join("")}</tbody></table></html>`;

const AC = "https://www.animeclick.it";

console.log("\nIl lettore");
{
  const html = pagina(
    riga("Hunter x Hunter&nbsp;1", "/images/Manga_Cover/HunterxHunter1.jpg"),
    riga("Hunter x Hunter 2", "/images/Manga_Cover/HunterxHunter2.jpg"),
    riga("Hunter x Hunter 2", "/images/Manga_Cover/HunterxHunter2-doppione.jpg"),
    riga("Hunter x Hunter 2", "/images/Manga_Cover/HunterxHunter2-ristampa.jpg", { extra: "Ristampa" }),
    riga("Hunter x Hunter 3", "/images/Manga_Cover/HxH3-ristampa.jpg", { extra: "Ristampa" }),
    riga("Hunter x Hunter Deluxe 1", "/images/Manga_Cover/HxHDeluxe1.jpg"),
    riga("Hunter x Hunter 4", null),
    riga("Hunter x Hunter 5", "https://altrove.example/img.jpg"),
    riga("Hunter x Hunter 38", "/images/Manga_Cover/Hunter x Hunter38.jpg", { data: "01/02/2099" })
  );

  prova(
    "un volume una volta: l'edizione normale, la ristampa solo se non c'è altro, il futuro sì, niente immagini di altri siti",
    [
      [1, `${AC}/images/Manga_Cover/HunterxHunter1.jpg`],
      [2, `${AC}/images/Manga_Cover/HunterxHunter2.jpg`],
      [3, `${AC}/images/Manga_Cover/HxH3-ristampa.jpg`],
      [38, `${AC}/images/Manga_Cover/Hunter%20x%20Hunter38.jpg`]
    ],
    copertineVolumi(html).map((v) => [v.numero, v.copertina])
  );

  prova("con l'etichetta dell'edizione si tiene solo quella", [[1, `${AC}/images/Manga_Cover/HxHDeluxe1.jpg`]], copertineVolumi(html, { edizione: "Deluxe" }).map((v) => [v.numero, v.copertina]));

  let errore = null;

  try {
    copertineVolumi("<html>Verifica che sei un essere umano</html>");
  } catch (e) {
    errore = e.message;
  }

  prova("una pagina senza la tabella lancia (non «zero copertine»)", true, /tabella delle edizioni/.test(errore || ""));
}

console.log("\nL'editore decide fra edizioni con lo stesso nome (Zatch Bell!)");
{
  // La vecchia di Star Comics (interrotta a 3) e la nuova di J-POP hanno lo stesso titolo.
  const html = pagina(
    riga("Zatch Bell! 1", "/images/Manga_Cover/ZB-vecchia1.jpg", { extra: "Star Comics" }),
    riga("Zatch Bell! 2", "/images/Manga_Cover/ZB-vecchia2.jpg", { extra: "Star Comics" }),
    riga("Zatch Bell! 3", "/images/Manga_Cover/ZB-vecchia3.jpg", { extra: "Star Comics" }),
    riga("Zatch Bell! 1", "/images/Manga_Cover/ZB-nuova1.jpg", { extra: "J-Pop" }),
    riga("Zatch Bell! 2", "/images/Manga_Cover/ZB-nuova2.jpg", { extra: "J-Pop" })
  );
  const numeri = (o) => copertineVolumi(html, o).map((v) => v.copertina.split("/").pop());

  prova("senza editore resta quello che c'era: la prima che capita", ["ZB-vecchia1.jpg", "ZB-vecchia2.jpg", "ZB-vecchia3.jpg"], numeri({}));
  prova("con l'editore si tiene solo la sua (maiuscole e trattino non contano)", ["ZB-nuova1.jpg", "ZB-nuova2.jpg"], numeri({ editore: "J-POP" }));
  prova("se nessuna riga nomina l'editore non si scarta niente", ["ZB-vecchia1.jpg", "ZB-vecchia2.jpg", "ZB-vecchia3.jpg"], numeri({ editore: "Panini" }));
}

console.log("\nGli artbook numerati come i volumi (Soul Eater - Soul Art 1): l'edizione è quella esatta");
{
  // L'artbook sta nella stessa tabella, con gli stessi numeri 1 e 2, e viene prima dei volumi veri.
  const html = pagina(
    riga("Soul Eater - Soul Art 1", "/images/Manga_Cover/SoulEaterArtbook.jpg", { extra: "Panini" }),
    riga("Soul Eater - Soul Art 2", "/images/Manga_Cover/SoulArt2.jpg", { extra: "Panini" }),
    riga("Soul Eater 1", "/images/Manga_Cover/SoulEater01.jpg", { extra: "Panini" }),
    riga("Soul Eater 2", "/images/Manga_Cover/SoulEater02.jpg", { extra: "Panini" }),
    riga("Soul Eater 3", "/images/Manga_Cover/SoulEater03.jpg", { extra: "Panini" })
  );
  const file = (o, h = html) => copertineVolumi(h, o).map((v) => v.copertina.split("/").pop());
  const veri = ["SoulEater01.jpg", "SoulEater02.jpg", "SoulEater03.jpg"];

  prova("senza titolo vince comunque la base: «Soul Eater - Soul Art» allunga «Soul Eater»", veri, file({ editore: "Panini" }));
  prova("con il titolo, Edizione vuota: solo i nomi che coincidono", veri, file({ editore: "Panini", titolo: "Soul Eater" }));
  prova("maiuscole e punteggiatura del titolo non contano", veri, file({ titolo: "SOUL-EATER" }));
  prova("un titolo che non coincide con nessuna riga: resta la base, il nome più corto", veri, file({ titolo: "Anima Mangiatrice" }));

  // Edizione valorizzata: titolo + etichetta, non basta che la contenga.
  const deluxe = pagina(
    riga("Hunter x Hunter Deluxe - Variant 1", "/images/Manga_Cover/HxHDeluxeVariant1.jpg"),
    riga("Hunter x Hunter Deluxe 1", "/images/Manga_Cover/HxHDeluxe1.jpg"),
    riga("Hunter x Hunter 1", "/images/Manga_Cover/HxH1.jpg")
  );

  prova("con l'etichetta: titolo + etichetta esatti, non ogni nome che la contiene", ["HxHDeluxe1.jpg"], file({ edizione: "Deluxe", titolo: "Hunter x Hunter" }, deluxe));
  prova("con l'etichetta e senza titolo: fra le righe che la contengono vince la base", ["HxHDeluxe1.jpg"], file({ edizione: "Deluxe" }, deluxe));
  prova("l'etichetta può stare prima del titolo", ["Deluxe1.jpg"], file({ edizione: "Deluxe", titolo: "Hunter x Hunter" }, pagina(riga("Deluxe Hunter x Hunter 1", "/images/Manga_Cover/Deluxe1.jpg"), riga("Hunter x Hunter Deluxe - Variant 1", "/images/Manga_Cover/V1.jpg"))));
  prova("senza etichetta le edizioni speciali restano fuori", ["HxH1.jpg"], file({ titolo: "Hunter x Hunter" }, deluxe));

  // Fra due ristampe del solo numero 4 vale lo stesso: il nome esatto.
  const conRistampe = pagina(
    riga("Soul Eater - Soul Art 4", "/images/Manga_Cover/SoulArt4-ristampa.jpg", { extra: "Ristampa" }),
    riga("Soul Eater 4", "/images/Manga_Cover/SoulEater04-ristampa.jpg", { extra: "Ristampa" })
  );

  prova("anche fra le ristampe vale il nome esatto", ["SoulEater04-ristampa.jpg"], file({ titolo: "Soul Eater" }, conRistampe));
}

console.log("\nUn variant col nome dell'edizione davanti al volume 1 (Atelier of Witch Hat - Grimoire Edition)");
{
  // Dai dati veri della serie 191 (Edizione «Grimoire Edition», Panini): il volume 1 usciva con la copertina
  // «… Grimoire Edition Instant Variant Crunchyroll», che contiene l'etichetta. I nomi delle righe sono
  // ricostruiti dai nomi dei file: la pagina non è stata letta.
  const html = pagina(
    riga("Atelier of Witch Hat Grimoire Edition Instant Variant Crunchyroll 1", "/images/Manga_Cover/AtelierVariantCrunchyroll1.jpg", { extra: "Panini" }),
    riga("Atelier of Witch Hat Grimoire Edition 1", "/images/Manga_Cover/AtelierGrimoire1.jpg", { extra: "Panini" }),
    riga("Atelier of Witch Hat Grimoire Edition 2", "/images/Manga_Cover/AtelierGrimoire2.jpg", { extra: "Panini" }),
    riga("Atelier of Witch Hat Grimoire Edition 3", "/images/Manga_Cover/AtelierGrimoire3.jpg", { extra: "Panini" }),
    riga("Atelier of Witch Hat 1", "/images/Manga_Cover/AtelierNormale1.jpg", { extra: "Panini" })
  );
  const file = (o) => copertineVolumi(html, o).map((v) => v.copertina.split("/").pop());
  const o = { edizione: "Grimoire Edition", editore: "Panini" };

  prova("senza titolo vince comunque la base: il variant allunga «Grimoire Edition»", ["AtelierGrimoire1.jpg", "AtelierGrimoire2.jpg", "AtelierGrimoire3.jpg"], file(o));
  prova("etichetta scritta a metà («Grimoire»): il confronto esatto non coincide, ma la base vince lo stesso", ["AtelierGrimoire1.jpg", "AtelierGrimoire2.jpg", "AtelierGrimoire3.jpg"], file({ edizione: "Grimoire", editore: "Panini", titolo: "Atelier of Witch Hat" }));
  prova("con il titolo: la Grimoire Edition, non il variant né l'edizione normale", ["AtelierGrimoire1.jpg", "AtelierGrimoire2.jpg", "AtelierGrimoire3.jpg"], file({ ...o, titolo: "Atelier of Witch Hat" }));
}

console.log("\nL'edizione base senza etichetta (Jujutsu Kaisen, Gachiakuta)");
{
  // Jujutsu Kaisen: l'edizione normale si chiama «Jujutsu Kaisen - Sorcery Fight», non come il titolo in
  // collezione, e `Edizione` resta vuota. L'Early Access sta davanti. I nomi sono ricostruiti dai nomi dei
  // file delle copertine salvate: la pagina non è stata letta.
  const jjk = pagina(
    riga("Jujutsu Kaisen - Sorcery Fight - Edizione Early Access 1", "/images/Manga_Cover/JJKEarly1.jpg", { extra: "Panini" }),
    riga("Jujutsu Kaisen - Sorcery Fight 1", "/images/Manga_Cover/JJK1.jpg", { extra: "Panini" }),
    riga("Jujutsu Kaisen - Sorcery Fight 2", "/images/Manga_Cover/JJK2.jpg", { extra: "Panini" })
  );
  const file = (h, o) => copertineVolumi(h, o).map((v) => v.copertina.split("/").pop());

  prova("Edizione vuota, titolo «Jujutsu Kaisen»: la base «… Sorcery Fight», non l'Early Access", ["JJK1.jpg", "JJK2.jpg"], file(jjk, { titolo: "Jujutsu Kaisen", editore: "Panini" }));
  prova("lo stesso senza titolo", ["JJK1.jpg", "JJK2.jpg"], file(jjk, {}));
  prova("in qualunque ordine arrivino le righe", ["JJK1.jpg", "JJK2.jpg"], file(
    pagina(
      riga("Jujutsu Kaisen - Sorcery Fight 1", "/images/Manga_Cover/JJK1.jpg"),
      riga("Jujutsu Kaisen - Sorcery Fight - Edizione Early Access 1", "/images/Manga_Cover/JJKEarly1.jpg"),
      riga("Jujutsu Kaisen - Sorcery Fight 2", "/images/Manga_Cover/JJK2.jpg")
    ),
    { titolo: "Jujutsu Kaisen" }
  ));

  const gachi = pagina(
    riga("Gachiakuta Limited Edition Exclusive Trash Box 1", "/images/Manga_Cover/GachiaTrashBox.jpg", { extra: "Star Comics" }),
    riga("Gachiakuta 1", "/images/Manga_Cover/Gachia1.jpg", { extra: "Star Comics" }),
    riga("Gachiakuta 2", "/images/Manga_Cover/Gachia2.jpg", { extra: "Star Comics" })
  );

  prova("Gachiakuta: l'edizione speciale non toglie il posto al volume 1", ["Gachia1.jpg", "Gachia2.jpg"], file(gachi, { titolo: "Gachiakuta", editore: "Star Comics" }));

  // Un numero che esiste solo come variant si prende lo stesso: meglio una copertina che nessuna.
  prova(
    "un numero che esiste solo nella variante si prende",
    ["JJK1.jpg", "JJKEarly5.jpg"],
    file(pagina(riga("Jujutsu Kaisen - Sorcery Fight 1", "/images/Manga_Cover/JJK1.jpg"), riga("Jujutsu Kaisen - Sorcery Fight - Edizione Early Access 5", "/images/Manga_Cover/JJKEarly5.jpg")), {})
  );

  // Nomi che non si contengono restano alla prima riga (due edizioni diverse), e decide l'editore.
  const diverse = pagina(
    riga("Devilman 1", "/images/Manga_Cover/DevilmanA1.jpg", { extra: "Dynamic" }),
    riga("Devilman Complete Collection 1", "/images/Manga_Cover/DevilmanB1.jpg", { extra: "J-Pop" }),
    riga("Mazinger 1", "/images/Manga_Cover/Mazinger1.jpg", { extra: "J-Pop" })
  );

  prova("nomi senza relazione: la prima riga trovata", ["DevilmanA1.jpg"], file(diverse, { titolo: "Devilman" }).slice(0, 1));

  // Un titolo senza lettere né cifre latine non si confronta: resta la prima riga.
  prova(
    "titolo tutto in giapponese: la prima riga, niente confronto",
    ["Prima1.jpg"],
    file(pagina(riga("呪術廻戦 1", "/images/Manga_Cover/Prima1.jpg"), riga("呪術廻戦 特装版 1", "/images/Manga_Cover/Seconda1.jpg")), {})
  );
}

console.log("\nLa diagnosi: cosa ha visto il lettore");
{
  const html = pagina(
    riga("Soul Eater - Soul Art 1", "/images/Manga_Cover/SoulEaterArtbook.jpg", { extra: "Panini" }),
    riga("Soul Eater 1", "/images/Manga_Cover/SoulEater01.jpg", { extra: "Panini" }),
    riga("Soul Eater 2", null, { extra: "Panini" }),
    riga("Soul Eater 3", "/images/Manga_Cover/SoulEater03.jpg", { extra: "Star Comics" }),
    riga("Soul Eater Deluxe 1", "/images/Manga_Cover/SoulEaterDeluxe1.jpg", { extra: "Panini" })
  );
  const diagnosi = {};
  const volumi = copertineVolumi(html, { titolo: "Soul Eater", editore: "Panini", diagnosi });

  prova("la diagnosi non cambia il risultato", copertineVolumi(html, { titolo: "Soul Eater", editore: "Panini" }), volumi);
  prova("righe con un titolo", 5, diagnosi.righe);
  prova("fuori edizione: quella speciale", ["Soul Eater Deluxe 1"], diagnosi.altraEdizione);
  prova("nome diverso dal titolo: l'artbook", ["Soul Eater - Soul Art 1"], diagnosi.altroNome);
  prova("altro editore", ["Soul Eater 3"], diagnosi.altroEditore);
  prova("il volume senza immagine", ["Soul Eater 2"], diagnosi.senzaImmagine);
  prova("la riga scelta per ogni numero", ["1: SoulEater01.jpg"], diagnosi.scelte);
}

console.log("\nI titoli con caratteri speciali (Yu-Gi-Oh!, È una stella cadente…)");
{
  // Dentro un attributo dell'HTML i caratteri speciali arrivano come entità. Prima del 15/11/2026
  // restavano lì: `&#33;` dentro un indirizzo è un'àncora (`#`), e il browser chiedeva un file
  // che non esiste. Le serie con un «!» o un accento nel titolo restavano senza copertine.
  const html = pagina(
    riga("Yu-Gi-Oh&#33; 1", "/images/Manga_Cover/Yu-Gi-Oh&#33;1.jpg"),
    riga("Yu-Gi-Oh&#x21; 2", "/images/Manga_Cover/Yu-Gi-Oh&#x21;2.jpg"),
    riga("&Egrave; una stella cadente in pieno cielo 3", "/images/Manga_Cover/&Egrave;unastellacadente3.jpg"),
    riga("Rock &amp; Roll 4", "/images/Manga_Cover/Rock&amp;Roll4.jpg")
  );

  prova(
    "le entità si sciolgono e l'indirizzo si scrive per bene",
    [
      [1, `${AC}/images/Manga_Cover/Yu-Gi-Oh!1.jpg`],
      [2, `${AC}/images/Manga_Cover/Yu-Gi-Oh!2.jpg`],
      [3, `${AC}/images/Manga_Cover/%C3%88unastellacadente3.jpg`],
      [4, `${AC}/images/Manga_Cover/Rock&Roll4.jpg`]
    ],
    copertineVolumi(html).map((v) => [v.numero, v.copertina])
  );

  prova("nessuna àncora negli indirizzi", true, copertineVolumi(html).every((v) => !new URL(v.copertina).hash));
  prova("un'entità che non si conosce resta com'è", `${AC}/images/x&foo;y.jpg`, indirizzoImmagine("/images/x&foo;y.jpg"));
  prova("un valore vuoto non è un indirizzo", null, indirizzoImmagine(""));
  prova(
    "gli indirizzi già salvati con le entità si riparano leggendoli",
    [`${AC}/images/Manga_Cover/Yu-Gi-Oh!1.jpg`, `${AC}/images/Manga_Cover/%C3%88unastella1.jpg`, `${AC}/images/Manga_Cover/Berserk1.jpg`],
    [
      riparato(new URL("/images/Manga_Cover/Yu-Gi-Oh&#33;1.jpg", AC).href),
      riparato(`${AC}/images/Manga_Cover/&Egrave;unastella1.jpg`),
      riparato(`${AC}/images/Manga_Cover/Berserk1.jpg`)
    ]
  );
}

(async () => {
  const url = process.env.PROVA_DATABASE_URL;

  if (!url) {
    console.log("\n(PROVA_DATABASE_URL non c'è: salto la parte che usa il database.)");
  } else {
    const schema = `prova_cop_${Math.random().toString(36).slice(2, 10)}`;
    const locale = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
    const ssl = locale ? false : { rejectUnauthorized: false };
    const admin = new Pool({ connectionString: url, ssl, max: 1 });

    await admin.query(`CREATE SCHEMA ${schema}`);

    process.env.DATABASE_URL = `${url}${url.includes("?") ? "&" : "?"}options=-c%20search_path%3D${schema}`;
    process.env.CRON_SECRET = "segreto-di-prova";
    process.env.JWT_SECRET = "una-chiave-finta-lunga-almeno-trentadue-caratteri";
    process.env.ADMIN_USERNAME = "prova";
    process.env.ADMIN_PASSWORD_HASH = "00:00";

    const scratch = new Pool({ connectionString: process.env.DATABASE_URL, ssl, max: 2 });
    let server;

    try {
      await scratch.query(`
        CREATE TABLE "Manga" ("ID" int PRIMARY KEY, "Titolo" text, "Edizione" text, "Editore" text, "StatoSerie" text, "AnimeClickID" int, "CoverURL" text);
        INSERT INTO "Manga" ("ID","Titolo","Edizione","StatoSerie","AnimeClickID","CoverURL") VALUES
          (1, 'Hunter x Hunter', NULL, 'in_corso', 9553, 'https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx-hxh-jp.jpg'),
          (2, 'Berserk', 'Deluxe', 'conclusa', 9607, NULL),
          (3, 'Senza scheda', NULL, 'in_corso', NULL, NULL),
          (4, 'Frieren', NULL, 'in_corso', 7000, NULL);`);
      await scratch.query(fs.readFileSync(path.join(__dirname, "..", "sql", "030_copertine_volumi.sql"), "utf8"));
      await scratch.query(fs.readFileSync(path.join(__dirname, "..", "sql", "034_copertine_volumi_manuali.sql"), "utf8"));
      await scratch.query(fs.readFileSync(path.join(__dirname, "..", "sql", "036_copertine_versione_lettura.sql"), "utf8"));

      const express = require("express");
      const app = express();

      app.use("/api/manga/copertine/pagina", express.json({ limit: "4mb" }));
      app.use(express.json());
      app.use("/api/manga", require("../routes/manga"));
      app.use((err, req, res, next) => res.status(500).json({ error: String(err?.message || err) }));
      server = app.listen(0);

      const base = `http://127.0.0.1:${server.address().port}/api/manga`;
      const intest = { "content-type": "application/json", "x-cron-secret": "segreto-di-prova" };
      const elenco = async (q = "") => (await fetch(`${base}/copertine/da-leggere${q}`, { headers: intest })).json();
      const manda = async (corpo) => {
        const r = await fetch(`${base}/copertine/pagina`, { method: "POST", headers: intest, body: JSON.stringify(corpo) });

        return { stato: r.status, ...(await r.json()) };
      };

      console.log("\nQuali serie leggere");

      prova("mai lette e con la scheda di AnimeClick, in ordine; quella senza scheda no", [[1, 9553], [2, 9607], [4, 7000]], (await elenco()).serie.map((s) => [s.manga_id, s.animeclick_id]));
      prova("«quanti» taglia l'elenco", [1], (await elenco("?quanti=1")).serie.map((s) => s.manga_id));

      console.log("\nRicevere una pagina");

      const hxh = pagina(riga("Hunter x Hunter 1", "/images/Manga_Cover/HunterxHunter1.jpg"), riga("Hunter x Hunter 2", "/images/Manga_Cover/HunterxHunter2.jpg"));

      const aVuoto = await manda({ manga_id: 1, html: hxh, prova: true });
      const nulla = await scratch.query(`SELECT (SELECT count(*)::int FROM copertine_volumi) AS c, (SELECT count(*)::int FROM copertine_giri) AS g`);

      prova("con prova:true conta e non scrive niente", [true, 2, 0, 0, 0], [aVuoto.letta, aVuoto.trovate, aVuoto.scritte, nulla.rows[0].c, nulla.rows[0].g]);

      const r1 = await manda({ manga_id: 1, html: hxh });

      prova("la pagina buona: due trovate, due scritte", [200, true, 2, 2], [r1.stato, r1.letta, r1.trovate, r1.scritte]);
      prova("rimandata uguale non riscrive", [2, 0], [(await manda({ manga_id: 1, html: hxh })).trovate, (await manda({ manga_id: 1, html: hxh })).scritte]);

      const cambiata = pagina(riga("Hunter x Hunter 1", "/images/Manga_Cover/HunterxHunter1-nuova.jpg"), riga("Hunter x Hunter 3", "/images/Manga_Cover/HunterxHunter3.jpg"));
      const r2 = await manda({ manga_id: 1, html: cambiata });
      const { rows } = await scratch.query(`SELECT numero, copertina FROM copertine_volumi WHERE manga_id = 1 ORDER BY numero`);

      prova(
        "una copertina cambiata si aggiorna, una nuova si aggiunge, quella sparita dalla pagina resta",
        [2, [1, "HunterxHunter1-nuova.jpg"], [2, "HunterxHunter2.jpg"], [3, "HunterxHunter3.jpg"]],
        [r2.scritte, ...rows.map((r) => [r.numero, r.copertina.split("/").pop()])]
      );

      // Una copertina scelta a mano (034): il giro non la riscrive, e «togli» la restituisce ad AnimeClick.
      const copertineSrv = require("../services/copertineVolumi");
      const scelta = await copertineSrv.scegli(scratch, 1, 1, "https://example.org/mia.jpg");
      const dopoGiro = await manda({ manga_id: 1, html: hxh });
      const dopoScelta = (await scratch.query(`SELECT copertina, manuale FROM copertine_volumi WHERE manga_id = 1 AND numero = 1`)).rows[0];

      prova(
        "la copertina scelta a mano resta, anche se il giro la legge diversa",
        [true, "https://example.org/mia.jpg", true, 0],
        [scelta.ok, dopoScelta.copertina, dopoScelta.manuale, dopoGiro.scritte]
      );

      prova("un indirizzo non https si rifiuta", true, Boolean((await copertineSrv.scegli(scratch, 1, 1, "http://example.org/a.jpg")).errore));

      const tolta = await copertineSrv.scegli(scratch, 1, 1, null);
      const resta = (await scratch.query(`SELECT count(*)::int AS n FROM copertine_volumi WHERE manga_id = 1 AND numero = 1`)).rows[0].n;

      prova("togliere la scelta a mano cancella la riga, e la serie si rilegge", [true, 0], [tolta.tolta, resta]);

      await manda({ manga_id: 1, html: cambiata });

      const bloccata = await manda({ manga_id: 2, html: "<html>Verifica che sei un essere umano</html>" });

      prova("la pagina della verifica anti-bot: non letta, e lo dice", [200, false, true], [bloccata.stato, bloccata.letta, /tabella/.test(bloccata.motivo)]);

      const dichiarato = await manda({ manga_id: 4, fallito: true, motivo: "HTTP 404" });

      prova("il giro che dichiara il fallimento", [200, false, "HTTP 404"], [dichiarato.stato, dichiarato.letta, dichiarato.motivo]);
      prova("una serie che non esiste: 404, niente scritto", 404, (await manda({ manga_id: 99, html: hxh })).stato);
      prova("senza manga_id: 400", 400, (await manda({ html: hxh })).stato);

      console.log("\nLa copertina della serie segue il volume 1");

      const copertinaSerie = async (id) => (await scratch.query(`SELECT "CoverURL" FROM "Manga" WHERE "ID" = $1`, [id])).rows[0]["CoverURL"];

      prova(
        "dopo la lettura la serie ha la copertina del volume 1 (non più quella di AniList)",
        `${AC}/images/Manga_Cover/HunterxHunter1-nuova.jpg`,
        await copertinaSerie(1)
      );

      // Il volume 1 sparisce dalla pagina e la riga resta (come sopra): se manca il numero 1 si usa il più basso.
      await scratch.query(`DELETE FROM copertine_volumi WHERE manga_id = 1 AND numero = 1`);
      await scratch.query(`UPDATE "Manga" SET "CoverURL" = 'https://cdn.myanimelist.net/images/manga/vecchia.jpg' WHERE "ID" = 1`);

      const senzaUno = await copertineSrv.allineaSerie(scratch, { scrivi: false });

      prova("la simulazione conta e non scrive", [1, 1, "https://cdn.myanimelist.net/images/manga/vecchia.jpg"], [senzaUno.esaminate, senzaUno.cambiate, await copertinaSerie(1)]);

      const tutteLeSerie = await copertineSrv.allineaSerie(scratch);

      prova(
        "senza volume 1 si usa il più basso; l'allineamento di tutte le serie scrive",
        [1, `${AC}/images/Manga_Cover/HunterxHunter2.jpg`],
        [tutteLeSerie.cambiate, await copertinaSerie(1)]
      );
      prova("rifatto subito, non c'è più niente da cambiare", 0, (await copertineSrv.allineaSerie(scratch)).cambiate);
      prova("una serie senza copertine di volume non si tocca", null, await copertinaSerie(4));

      await scratch.query(`UPDATE "Manga" SET "CoverURL" = 'https://s4.anilist.co/vecchia.jpg' WHERE "ID" = 1`);
      await copertineSrv.scegli(scratch, 1, 1, "https://example.org/mio-volume-uno.jpg");

      prova("scegliendo a mano il volume 1, la serie lo segue", "https://example.org/mio-volume-uno.jpg", await copertinaSerie(1));

      // La rotta che lancia il lavoro di GitHub (copertine-volumi.yml, «allinea»).
      await scratch.query(`UPDATE "Manga" SET "CoverURL" = 'https://s4.anilist.co/estera.jpg' WHERE "ID" = 1`);

      const allinea = async (corpo, headers = intest) => {
        const r = await fetch(`${base}/copertine/allinea`, { method: "POST", headers, body: JSON.stringify(corpo) });

        return { stato: r.status, ...(await r.json()) };
      };
      const aProva = await allinea({ prova: true });

      prova(
        "la rotta con prova:true elenca e non scrive",
        [200, false, 1, "https://s4.anilist.co/estera.jpg", "https://example.org/mio-volume-uno.jpg", "https://s4.anilist.co/estera.jpg"],
        [aProva.stato, aProva.scritto, aProva.cambiate, aProva.elenco[0]?.da, aProva.elenco[0]?.a, await copertinaSerie(1)]
      );

      const davvero = await allinea({});

      prova("la rotta senza prova scrive (qui il volume 1 è quello scelto a mano)", [200, true, 1, "https://example.org/mio-volume-uno.jpg"], [davvero.stato, davvero.scritto, davvero.cambiate, await copertinaSerie(1)]);
      prova("la rotta, rifatta, non ha più niente da cambiare", [0, []], [(await allinea({})).cambiate, (await allinea({})).elenco]);
      prova(
        "la rotta senza il segreto: 403",
        [403, 403],
        [(await allinea({}, { "content-type": "application/json" })).stato, (await allinea({}, { "content-type": "application/json", "x-cron-secret": "no" })).stato]
      );

      await scratch.query(`DELETE FROM copertine_volumi WHERE manga_id = 1 AND numero = 1`);
      await manda({ manga_id: 1, html: cambiata });

      prova("la lettura successiva rimette il volume 1 di AnimeClick", `${AC}/images/Manga_Cover/HunterxHunter1-nuova.jpg`, await copertinaSerie(1));

      console.log("\nIl giro va avanti");

      prova("le serie appena provate (anche quelle fallite) non tornano subito", [], (await elenco()).serie.map((s) => s.manga_id));

      await scratch.query(`UPDATE copertine_giri SET letta_il = NOW() - interval '31 days'`);

      prova("dopo un mese tornano quelle in corso (la conclusa rimasta a zero no)", [1, 4], (await elenco()).serie.map((s) => s.manga_id).sort());

      await scratch.query(`UPDATE copertine_giri SET letta_il = NOW() - interval '61 days'`);

      prova("dopo due mesi si riprovano anche quelle rimaste a zero", [1, 2, 4], (await elenco()).serie.map((s) => s.manga_id).sort());

      console.log("\nUna serie letta con un lettore più vecchio si rilegge");

      // Tutte lette adesso: niente deve tornare per le regole dei giorni.
      await scratch.query(`UPDATE copertine_giri SET letta_il = NOW(), versione = $1`, [copertineSrv.VERSIONE_LETTURA]);
      await scratch.query(`UPDATE "Manga" SET "StatoSerie" = 'conclusa' WHERE "ID" = 1`);

      const daRileggere = async (o) => (await copertineSrv.daLeggere(scratch, o)).map((x) => x.manga_id).sort();

      prova("lette col lettore di oggi: niente da rileggere", [], await daRileggere());

      await scratch.query(`UPDATE copertine_giri SET versione = 0 WHERE manga_id = 1`);

      prova("una conclusa letta con una versione più vecchia torna in coda", [1], await daRileggere());

      await manda({ manga_id: 1, html: cambiata });

      prova("riletta, ha la versione di oggi e non torna più", [copertineSrv.VERSIONE_LETTURA, []], [
        (await scratch.query(`SELECT versione FROM copertine_giri WHERE manga_id = 1`)).rows[0].versione,
        await daRileggere()
      ]);

      console.log("\nRileggere una serie a mano, per titolo");

      prova("un pezzo del titolo, senza badare alle maiuscole né a quando è stata letta", [1], await daRileggere({ titolo: "HUNTER x" }));
      prova("anche una serie letta da poco e conclusa", [2], await daRileggere({ titolo: "bers" }));
      prova("«%» è una lettera, non un jolly", [], await daRileggere({ titolo: "%" }));
      prova("un titolo che non c'è", [], await daRileggere({ titolo: "Nessuna serie così" }));
      prova("la rotta lo accetta", [1], ((await (await fetch(`${base}/copertine/da-leggere?titolo=hunter`, { headers: intest })).json()).serie || []).map((x) => x.manga_id));

      const conDiagnosi = await manda({ manga_id: 1, html: hxh, prova: true, diagnosi: true });

      prova("con diagnosi:true la rotta risponde anche cosa ha visto il lettore", [true, 2, ["1: HunterxHunter1.jpg", "2: HunterxHunter2.jpg"]], [conDiagnosi.letta, conDiagnosi.diagnosi?.righe, conDiagnosi.diagnosi?.scelte]);
      prova("senza diagnosi:true non c'è", false, "diagnosi" in (await manda({ manga_id: 1, html: hxh, prova: true })));

      // La 036 non è ancora passata: valgono le regole di prima e la lettura si segna lo stesso.
      await scratch.query(`ALTER TABLE copertine_giri DROP COLUMN versione`);

      prova("senza la colonna `versione` l'elenco risponde ancora", [], await daRileggere());

      await copertineSrv.segnaGiro(scratch, 1, "ok", 3);

      prova("senza la colonna `versione` la lettura si segna ancora", 3, (await scratch.query(`SELECT trovate FROM copertine_giri WHERE manga_id = 1`)).rows[0].trovate);

      await scratch.query(fs.readFileSync(path.join(__dirname, "..", "sql", "036_copertine_versione_lettura.sql"), "utf8"));
      await scratch.query(`UPDATE copertine_giri SET versione = $1`, [copertineSrv.VERSIONE_LETTURA]);
      await scratch.query(`UPDATE "Manga" SET "StatoSerie" = 'in_corso' WHERE "ID" = 1`);

      await scratch.query(`CREATE TABLE IF NOT EXISTS fonte_stato (fonte text PRIMARY KEY, fallimenti_di_fila int, ultimo_tentativo timestamptz, ultimo_esito text, ultimo_ok timestamptz, in_pausa_fino timestamptz);
        INSERT INTO fonte_stato (fonte, fallimenti_di_fila, in_pausa_fino) VALUES ('animeclick', 7, NOW() + interval '3 days')`);

      const pausa = await elenco();

      prova("con AnimeClick in pausa l'elenco è vuoto", [[], true], [pausa.serie, pausa.in_pausa]);

      console.log("\nQuello che legge il sito");

      const pubblico = await fetch(`${base}/copertine-volumi`);
      const corpo = await pubblico.json();

      prova("pubblica, con la cache di un'ora", [200, "public, max-age=3600"], [pubblico.status, pubblico.headers.get("cache-control")]);
      prova(
        "per serie e numero, col percorso accorciato",
        ["https://www.animeclick.it", { 1: { 1: "/images/Manga_Cover/HunterxHunter1-nuova.jpg", 2: "/images/Manga_Cover/HunterxHunter2.jpg", 3: "/images/Manga_Cover/HunterxHunter3.jpg" } }],
        [corpo.base, corpo.copertine]
      );

      console.log("\nSenza il segreto non entra nessuno");

      const senza = [
        (await fetch(`${base}/copertine/da-leggere`)).status,
        (await fetch(`${base}/copertine/pagina`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ manga_id: 1, html: hxh }) })).status,
        (await fetch(`${base}/copertine/pagina`, { method: "POST", headers: { "content-type": "application/json", "x-cron-secret": "no" }, body: "{}" })).status
      ];

      prova("elenco e ricezione: 403", [403, 403, 403], senza);

      await scratch.query(`DELETE FROM "Manga" WHERE "ID" = 1`);

      prova("cancellata la serie, spariscono le sue copertine", 0, (await scratch.query(`SELECT count(*)::int AS n FROM copertine_volumi`)).rows[0].n);
    } finally {
      if (server) server.close();
      await scratch.end().catch(() => {});
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  }

  console.log(falliti ? `\n${falliti} prove fallite.\n` : "\nTutto a posto.\n");
  process.exit(falliti ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
