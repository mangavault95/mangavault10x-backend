// I temi di AniList, detti in italiano.
//
// AniList marca ogni opera con dei `tags` votati dagli utenti — «Urban
// Fantasy», «Coming of Age», «Surreal Comedy» — ognuno con un rango che
// dice quanto pesa su quell'opera. Sono la cosa più vicina a «di che
// pasta è fatta questa serie» che esista in un database, e sono il
// motivo per cui i consigli della Videoteca possono spiegarsi invece di
// comparire e basta.
//
// Sono però scritti in inglese, e la Videoteca è italiana da cima a
// fondo. Da qui questo vocabolario, scritto a mano.
//
// ⚠️ QUESTO FILE FA DUE MESTIERI, ed è voluto: traduce e FILTRA.
// Un tema che non sta qui dentro non viene mostrato — mai in inglese,
// mai tradotto al volo da una macchina. E l'assenza è spesso una
// scelta, non una dimenticanza: dei 361 temi non adulti di AniList
// molti non sono un motivo per cui guardare qualcosa.
//
//   · Le voci tecniche («CGI», «Rotoscoping», «4-koma», «Achromatic»)
//     dicono come l'opera è fatta, non di cosa parla. «Guardala perché
//     anche questa è in CGI» non è un consiglio.
//   · Le voci quasi universali («Male Protagonist», «Heterosexual»,
//     «Primarily Teen Cast») le condividono centinaia di serie che non
//     c'entrano niente l'una con l'altra: sono rumore che scaccia il
//     segnale, esattamente come i generi che questa sezione è nata per
//     non usare.
//
// Il risultato è che una carta può restare senza temi da mostrare, e va
// benissimo: in quel caso il motivo scritto accanto diventa quello dei
// voti («l'hanno accostata in 539»), che è comunque il segnale più
// forte che abbiamo.
//
// Se un giorno AniList aggiunge un tema nuovo e importante, si nota da
// solo: comincia a sparire dai motivi. Aggiungerlo qui è una riga.

const TEMI = {
  // --------------------------------------------------
  // Ambientazione: dove e quando
  // --------------------------------------------------
  "Urban Fantasy": "fantastico urbano",
  "Post-Apocalyptic": "post-apocalittico",
  Dystopian: "distopico",
  Afterlife: "aldilà",
  Space: "spazio",
  "Space Opera": "space opera",
  "Virtual World": "mondo virtuale",
  "Augmented Reality": "realtà aumentata",
  "Alternate Universe": "universo alternativo",
  Historical: "storico",
  Medieval: "medievale",
  "Ancient China": "Cina antica",
  Anachronism: "anacronismo",
  "Time Skip": "salto temporale",
  "Achronological Order": "racconto fuori ordine",
  Cyberpunk: "cyberpunk",
  Steampunk: "steampunk",
  "Lost Civilization": "civiltà perduta",
  Isekai: "isekai",
  "Reverse Isekai": "isekai al contrario",
  School: "scuola",
  "Boarding School": "collegio",
  College: "università",
  Prison: "prigione",
  Dungeon: "sotterranei",
  Rural: "provincia",
  Urban: "città",
  Wilderness: "natura selvaggia",
  Desert: "deserto",
  Snowscape: "paesaggi innevati",
  Coastal: "mare",
  Office: "ufficio",
  Work: "lavoro",
  Camping: "campeggio",
  Circus: "circo",
  Foreign: "all'estero",
  "Natural Disaster": "catastrofe naturale",

  // --------------------------------------------------
  // Il registro: l'atmosfera, che è quello che si cerca davvero
  // --------------------------------------------------
  "Surreal Comedy": "comicità surreale",
  Parody: "parodia",
  Satire: "satira",
  Slapstick: "comicità fisica",
  Iyashikei: "iyashikei",
  Noir: "noir",
  "Cosmic Horror": "orrore cosmico",
  "Body Horror": "body horror",
  "Eco-Horror": "orrore ecologico",
  "Ero Guro": "ero guro",
  Gore: "splatter",
  Tragedy: "tragedia",
  Philosophy: "filosofia",
  Meta: "metanarrazione",
  Denpa: "denpa",
  Psychosexual: "psicosessuale",
  "Non-fiction": "non finzione",
  Autobiographical: "autobiografico",
  Biographical: "biografico",
  Educational: "divulgativo",

  // --------------------------------------------------
  // Le dinamiche: cosa succede fra i personaggi
  // --------------------------------------------------
  "Coming of Age": "romanzo di formazione",
  "Found Family": "famiglia scelta",
  "Estranged Family": "famiglia spezzata",
  "Family Life": "vita di famiglia",
  Parenthood: "essere genitori",
  Adoption: "adozione",
  Bullying: "bullismo",
  Revenge: "vendetta",
  "Class Struggle": "lotta di classe",
  Conspiracy: "cospirazione",
  Rehabilitation: "riscatto",
  Suicide: "suicidio",
  Survival: "sopravvivenza",
  "Death Game": "gioco mortale",
  "Battle Royale": "battle royale",
  "Proxy Battle": "lotta per interposta persona",
  Politics: "politica",
  War: "guerra",
  Terrorism: "terrorismo",
  Crime: "crimine",
  Gambling: "gioco d'azzardo",
  Blackmail: "ricatto",
  Slavery: "schiavitù",
  Torture: "tortura",
  Cannibalism: "cannibalismo",
  "Human Experimentation": "esperimenti sull'uomo",
  Brainwashing: "lavaggio del cervello",
  "Memory Manipulation": "memoria manipolata",
  Amnesia: "amnesia",
  "Dissociative Identities": "identità multiple",
  Reincarnation: "reincarnazione",
  Prophecy: "profezia",
  Curses: "maledizioni",
  Religion: "religione",
  Mythology: "mitologia",
  Economics: "economia",
  Medicine: "medicina",
  Environmental: "ambiente",
  Pandemic: "pandemia",
  Drugs: "droghe",
  Homeless: "senzatetto",
  "Body Image": "rapporto col proprio corpo",
  Disability: "disabilità",
  "Language Barrier": "barriera linguistica",
  Travel: "viaggio",
  Rescue: "salvataggio",
  Exiled: "esilio",
  "Royal Affairs": "intrighi di corte",
  "Kingdom Management": "governare un regno",
  Marriage: "matrimonio",
  "Arranged Marriage": "matrimonio combinato",
  Pregnancy: "gravidanza",
  "Gender Bending": "scambio di genere",
  "Body Swapping": "scambio di corpi",
  "LGBTQ+ Themes": "temi LGBTQ+",
  "Otaku Culture": "cultura otaku",
  Chuunibyou: "chuunibyou",
  Crossover: "incrocio fra opere",
  "Indigenous Cultures": "culture indigene",

  // --------------------------------------------------
  // Sentimenti
  // --------------------------------------------------
  "Love Triangle": "triangolo amoroso",
  "Unrequited Love": "amore non corrisposto",
  "Fake Relationship": "finta relazione",
  Cohabitation: "convivenza",
  Matchmaking: "combinare coppie",
  Cheating: "tradimento",
  "Age Gap": "differenza d'età",
  Interspecies: "amore fra specie diverse",
  "Boys' Love": "boys' love",
  Yuri: "yuri",
  "Female Harem": "harem femminile",
  "Male Harem": "harem maschile",
  Polyamorous: "poliamore",

  // --------------------------------------------------
  // Poteri, creature, mestieri: le cose che popolano la storia
  // --------------------------------------------------
  "Super Power": "superpoteri",
  Superhero: "supereroi",
  Henshin: "trasformazioni",
  Magic: "magia",
  Alchemy: "alchimia",
  Necromancy: "negromanzia",
  Shapeshifting: "mutaforma",
  Exorcism: "esorcismi",
  Cultivation: "coltivazione spirituale",
  Wuxia: "wuxia",
  Youkai: "youkai",
  Kaiju: "kaiju",
  Tokusatsu: "tokusatsu",
  "Time Loop": "anello temporale",
  "Time Manipulation": "manipolazione del tempo",
  "Artificial Intelligence": "intelligenza artificiale",
  Robots: "robot",
  Cyborg: "cyborg",
  "Real Robot": "real robot",
  "Super Robot": "super robot",
  Clone: "cloni",
  Aliens: "alieni",
  Ghost: "fantasmi",
  Demons: "demoni",
  Angels: "angeli",
  Gods: "divinità",
  Vampire: "vampiri",
  Werewolf: "licantropi",
  Zombie: "zombie",
  Witch: "streghe",
  Dragons: "draghi",
  Elf: "elfi",
  Fairy: "fate",
  Mermaid: "sirene",
  "Monster Girl": "ragazze mostro",
  "Monster Boy": "ragazzi mostro",
  Skeleton: "scheletri",
  Succubus: "succubi",
  Dinosaurs: "dinosauri",
  Animals: "animali",
  "Creature Taming": "addestrare creature",
  Anthropomorphism: "animali antropomorfi",
  Samurai: "samurai",
  Ninja: "ninja",
  Pirates: "pirati",
  Vikings: "vichinghi",
  Cowboys: "cowboy",
  Detective: "investigazione",
  Assassins: "assassini",
  Military: "militari",
  Police: "polizia",
  Firefighters: "vigili del fuoco",
  Yakuza: "yakuza",
  Mafia: "mafia",
  Triads: "triadi",
  Gangs: "bande",
  "Criminal Organization": "organizzazione criminale",
  Cult: "sette",
  Espionage: "spionaggio",
  Fugitive: "latitanza",
  Delinquents: "teppisti",
  Idol: "idol",
  VTuber: "vtuber",
  Teacher: "insegnanti",
  Butler: "maggiordomi",
  Maids: "domestiche",
  Nun: "suore",
  "Shrine Maiden": "miko",
  Veterinarian: "veterinari",
  "Office Lady": "impiegate",
  "Ojou-sama": "signorine di buona famiglia",
  Villainess: "villainess",
  Orphan: "orfani",
  Hikikomori: "hikikomori",
  Twins: "gemelli",

  // --------------------------------------------------
  // Chi porta la storia: solo i tratti che dicono qualcosa
  // («Male Protagonist» e simili stanno fuori apposta — vedi sopra)
  // --------------------------------------------------
  "Ensemble Cast": "storia corale",
  "Anti-Hero": "antieroe",
  "Elderly Protagonist": "protagonista anziano",
  "Primarily Adult Cast": "personaggi adulti",
  "Primarily Child Cast": "personaggi bambini",
  "Primarily Animal Cast": "personaggi animali",
  Tsundere: "tsundere",
  Yandere: "yandere",
  Kuudere: "kuudere",
  Tomboy: "maschiaccio",
  Gyaru: "gyaru",

  // --------------------------------------------------
  // Azione
  // --------------------------------------------------
  "Martial Arts": "arti marziali",
  Swordplay: "scherma",
  Spearplay: "lancia",
  Archery: "tiro con l'arco",
  Guns: "armi da fuoco",
  Parkour: "parkour",
  Acrobatics: "acrobazie",

  // --------------------------------------------------
  // Arti, musica, mestieri creativi
  // --------------------------------------------------
  Band: "gruppo musicale",
  "Rock Music": "rock",
  "Metal Music": "metal",
  "Jazz Music": "jazz",
  "Classical Music": "musica classica",
  "Hip-hop Music": "hip-hop",
  "Musical Theater": "teatro musicale",
  "Vocal Synth": "voci sintetiche",
  Dancing: "danza",
  Ballet: "danza classica",
  Acting: "recitazione",
  Kabuki: "kabuki",
  Rakugo: "rakugo",
  Manzai: "manzai",
  Filmmaking: "fare cinema",
  Writing: "scrittura",
  "Classic Literature": "letteratura classica",
  Drawing: "disegno",
  Calligraphy: "calligrafia",
  Photography: "fotografia",
  Fashion: "moda",
  Modeling: "moda e passerelle",
  Makeup: "trucco",
  Food: "cucina",
  Agriculture: "agricoltura",
  Horticulture: "giardinaggio",
  Astronomy: "astronomia",
  Mountaineering: "alpinismo",
  "Software Development": "programmazione",

  // --------------------------------------------------
  // Sport e giochi
  // --------------------------------------------------
  Athletics: "atletica",
  Football: "calcio",
  "American Football": "football americano",
  Baseball: "baseball",
  Basketball: "pallacanestro",
  Volleyball: "pallavolo",
  Handball: "pallamano",
  Rugby: "rugby",
  Tennis: "tennis",
  "Table Tennis": "ping pong",
  Badminton: "badminton",
  Boxing: "pugilato",
  Wrestling: "wrestling",
  Judo: "judo",
  Sumo: "sumo",
  Fencing: "scherma sportiva",
  Swimming: "nuoto",
  "Scuba Diving": "immersioni",
  Surfing: "surf",
  Skateboarding: "skateboard",
  Cycling: "ciclismo",
  "Ice Sports": "sport sul ghiaccio",
  Golf: "golf",
  Bowling: "bowling",
  Lacrosse: "lacrosse",
  Cheerleading: "cheerleading",
  Fishing: "pesca",
  Fitness: "palestra",
  "Outdoor Activities": "vita all'aperto",
  "E-Sports": "e-sport",
  "Video Games": "videogiochi",
  "Board Game": "giochi da tavolo",
  "Card Battle": "giochi di carte",
  Mahjong: "mahjong",
  Shogi: "shogi",
  Go: "go",
  Karuta: "karuta",
  Poker: "poker",

  // --------------------------------------------------
  // Mezzi
  // --------------------------------------------------
  Cars: "automobili",
  Motorcycles: "motociclette",
  Mopeds: "motorini",
  Aviation: "aviazione",
  Ships: "navi",
  Trains: "treni",
  Tanks: "carri armati",

  // --------------------------------------------------
  // Pubblico
  // --------------------------------------------------
  Shounen: "shonen",
  Shoujo: "shojo",
  Seinen: "seinen",
  Josei: "josei",
  Kids: "per bambini",

  // --------------------------------------------------
  // Forma del racconto: poche, e solo quelle che si notano guardando
  // --------------------------------------------------
  Episodic: "a episodi autoconclusivi",
  Anthology: "antologia",
  "No Dialogue": "senza dialoghi",
  Chibi: "chibi"
};

// Il confronto si fa su una forma ridotta — solo lettere e cifre, tutto
// minuscolo — così «Ojou-sama», «Ojou sama» e «ojousama» sono la stessa
// chiave. AniList non è sempre coerente con i trattini e con gli
// apostrofi («Boys' Love»), e questa è la differenza fra un tema
// tradotto e un tema che sparisce senza che nessuno se ne accorga.
function chiave(testo) {
  return String(testo || "")
    .toLowerCase()
    .replace(/[^a-z0-9+]+/g, "");
}

const PER_CHIAVE = new Map(
  Object.entries(TEMI).map(([inglese, italiano]) => [chiave(inglese), italiano])
);

/**
 * Il nome italiano di un tema, o `null` se non lo sappiamo dire.
 *
 * `null` non è un errore ed è il caso normale per un buon terzo dei
 * temi: chi chiama lo scarta e mostra un motivo diverso. Vedi in cima
 * al file perché è meglio così che tradurre a macchina.
 */
function inItaliano(tema) {
  return PER_CHIAVE.get(chiave(tema)) || null;
}

/**
 * Traduce una lista di temi, buttando quelli che non sappiamo dire.
 *
 * Conserva l'ordine in cui arrivano — che è quello del rango, cioè
 * dal più caratterizzante in giù — perché chi mostra ne prende solo i
 * primi due o tre e devono essere i più significativi.
 */
function traduci(temi) {
  const visti = new Set();
  const fuori = [];

  for (const t of temi || []) {
    const nome = inItaliano(typeof t === "string" ? t : t?.nome);

    if (!nome || visti.has(nome)) continue;

    visti.add(nome);
    fuori.push(nome);
  }

  return fuori;
}

module.exports = { inItaliano, traduci, TEMI };
