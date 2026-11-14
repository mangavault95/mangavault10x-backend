// Prova di `.github/scripts/scarica-pagine.sh`, lo script con cui GitHub Actions scarica da AnimeClick le
// pagine per il calendario degli anime, le schede e il rapporto dei volumi.
//
//   node scripts/prova-scarica-pagine.mjs        (vuole bash, curl e jq, che GitHub ha)
//
// Un finto AnimeClick e un finto backend sullo stesso server locale: si CONTANO le richieste, si guarda la
// firma e la distanza fra una pagina e l'altra, e si controlla che il primo 403 o 429, una pagina che non è
// AnimeClick (la verifica anti-bot risponde 200 con altro dentro) e tre errori di fila fermino il giro.
// Nessuna richiesta esce: gli indirizzi sono quelli del server locale.

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".github", "scripts", "scarica-pagine.sh");
let falliti = 0;
const prova = (nome, atteso, ottenuto) => {
  const bene = JSON.stringify(atteso) === JSON.stringify(ottenuto);
  console.log(`  ${bene ? "ok  " : "NO  "} ${nome}`);
  if (!bene) { falliti++; console.log(`       atteso:   ${JSON.stringify(atteso)}\n       ottenuto: ${JSON.stringify(ottenuto)}`); }
};

let scenario;
let eventi;

const server = http.createServer((req, res) => {
  let corpo = "";
  req.on("data", (c) => (corpo += c));
  req.on("end", () => {
    const quando = Date.now();
    if (req.url.startsWith("/ac/")) {
      eventi.push({ tipo: "ac", url: req.url, ua: req.headers["user-agent"], lingua: req.headers["accept-language"], quando });
      const n = eventi.filter((e) => e.tipo === "ac").length;
      const r = scenario.ac(n, req.url);
      res.writeHead(r.status, r.intestazioni || { "content-type": "text/html" });
      return res.end(r.corpo ?? "<html><body>AnimeClick pagina</body></html>");
    }
    // il finto backend
    const segreto = req.headers["x-cron-secret"];
    if (segreto !== "x") { res.writeHead(403); return res.end("{}"); }
    let json = null; try { json = JSON.parse(corpo); } catch {}
    eventi.push({ tipo: "api", metodo: req.method, url: req.url, json, quando });
    res.setHeader("content-type", "application/json");
    if (req.url.startsWith("/api/animeclick/da-scaricare")) return res.end(JSON.stringify(scenario.elenco(PORT)));
    if (scenario.paginaStato && req.url === "/api/animeclick/pagina") { res.statusCode = scenario.paginaStato; return res.end('{"error":"Errore server"}'); }
    return res.end(JSON.stringify({ success: true }));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;

async function esegui(nome, sc, { pausa = "0", api = null } = {}) {
  scenario = sc; eventi = [];
  const cartella = fs.mkdtempSync(path.join(os.tmpdir(), "scarica-"));
  const uscita = path.join(cartella, "output");
  const t0 = Date.now();
  const codice = await new Promise((ok) => {
    const p = spawn("bash", [SCRIPT, "calendario"], {
      cwd: cartella,
      env: { ...process.env, CRON_SECRET: "x", PROVA: "false", PAUSA_SECONDI: pausa, ATTESA_RITENTATIVO: "0", GITHUB_OUTPUT: uscita,
             API_URL: api || `http://127.0.0.1:${PORT}/api/animeclick`, ANIMECLICK_PREFISSO: `http://127.0.0.1:${PORT}/ac/` },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let out = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d));
    p.on("close", (c) => { fs.writeFileSync(path.join(cartella, "log"), out); ok(c); });
  });
  const output = Object.fromEntries((fs.existsSync(uscita) ? fs.readFileSync(uscita, "utf8") : "").split("\n").filter(Boolean).map((r) => r.split("=")));
  return { codice, output, eventi, ms: Date.now() - t0, log: fs.readFileSync(path.join(cartella, "log"), "utf8") };
}
const elenco3 = (p) => ({ tentare: true, in_pausa_fino: null, urls: [1, 2, 3].map((i) => `http://127.0.0.1:${p}/ac/pagina${i}`) });
const ac = (r) => r.eventi.filter((e) => e.tipo === "ac");
const api = (r, metodo, inizio) => r.eventi.filter((e) => e.tipo === "api" && e.metodo === metodo && e.url.startsWith(inizio));

console.log("\nTutto va bene");
let r = await esegui("ok", { elenco: elenco3, ac: () => ({ status: 200 }) });
prova("tre pagine scaricate e mandate", [0, "3", "0", "0", 3], [r.codice, r.output.scaricate, r.output.rifiutato, r.output.non_accettate, api(r, "POST", "/api/animeclick/pagina").length]);
prova("ogni pagina arriva con il suo indirizzo e l'HTML", true, api(r, "POST", "/api/animeclick/pagina").every((e, i) => e.json.url.endsWith(`/ac/pagina${i + 1}`) && e.json.html.includes("AnimeClick pagina")));
prova("l'esito dice riuscito, una volta", [{ riuscito: true, lavoro: "calendario", prova: false }], api(r, "POST", "/api/animeclick/esito").map((e) => e.json));
prova("firma dichiarata e lingua, su ogni richiesta", [true, true], [ac(r).every((e) => /^MangaVault\/1\.0 /.test(e.ua)), ac(r).every((e) => e.lingua === "it-IT,it;q=0.9")]);

console.log("\nLa distanza fra le pagine");
r = await esegui("pausa", { elenco: elenco3, ac: () => ({ status: 200 }) }, { pausa: "1" });
const ts = ac(r).map((e) => e.quando);
prova("una richiesta ogni secondo (qui PAUSA_SECONDI=1), non in fila", true, ts[1] - ts[0] >= 950 && ts[2] - ts[1] >= 950);

console.log("\nIl primo 403 ferma tutto");
r = await esegui("403", { elenco: elenco3, ac: (n) => ({ status: n === 2 ? 403 : 200 }) });
prova("due richieste e basta, la terza non parte", 2, ac(r).length);
prova("la prima pagina è stata mandata, la seconda no", 1, api(r, "POST", "/api/animeclick/pagina").length);
prova("esito: rifiutato, con il motivo, e il giro non finge di essere riuscito", [[{ riuscito: false, motivo: "HTTP 403", lavoro: "calendario", prova: false }], "1", "1"], [api(r, "POST", "/api/animeclick/esito").map((e) => e.json), r.output.rifiutato, r.output.scaricate]);
prova("lo script esce 0: sta al workflow farlo risultare fallito", 0, r.codice);

console.log("\nUn 429 alla prima pagina");
r = await esegui("429", { elenco: elenco3, ac: () => ({ status: 429, intestazioni: { "retry-after": "60" } }) });
prova("una richiesta, rifiuto, nessuna pagina mandata", [1, "1", 0], [ac(r).length, r.output.rifiutato, api(r, "POST", "/api/animeclick/pagina").length]);

console.log("\nUna pagina 200 che non è AnimeClick (verifica anti-bot)");
r = await esegui("antibot", { elenco: elenco3, ac: () => ({ status: 200, corpo: "<html><body>Verifica che sei umano</body></html>" }) });
prova("vale come rifiuto: si ferma alla prima", [1, "1", 0], [ac(r).length, r.output.rifiutato, api(r, "POST", "/api/animeclick/pagina").length]);

console.log("\nErrori di rete");
r = await esegui("5xx", { elenco: (p) => ({ tentare: true, urls: [1, 2, 3, 4, 5].map((i) => `http://127.0.0.1:${p}/ac/p${i}`) }), ac: () => ({ status: 503 }) });
prova("tre 503 di fila fermano il giro (non cinque richieste)", [3, "1"], [ac(r).length, r.output.rifiutato]);

r = await esegui("302", { elenco: elenco3, ac: () => ({ status: 302, intestazioni: { location: "/ac/altrove" } }) });
prova("un redirect non si segue: è un errore, non una richiesta in più", [3, true], [ac(r).length, !ac(r).some((e) => e.url === "/ac/altrove")]);

r = await esegui("404", { elenco: elenco3, ac: (n) => ({ status: n === 1 ? 404 : 200 }) });
prova("un 404 (serie tolta) si salta senza fermarsi", [3, "2", "0"], [ac(r).length, r.output.scaricate, r.output.rifiutato]);

console.log("\nIl backend non accetta le pagine (per esempio la tabella non c'è)");
r = await esegui("pagine-rifiutate", { elenco: elenco3, ac: () => ({ status: 200 }), paginaStato: 500 });
prova("le pagine si scaricano ma il giro NON risulta riuscito: scaricate 0, non accettate 3", [0, "0", "3", 0], [r.codice, r.output.scaricate, r.output.non_accettate, api(r, "POST", "/api/animeclick/esito").length]);

console.log("\nIn pausa");
r = await esegui("pausa-db", { elenco: () => ({ tentare: false, in_pausa_fino: "2026-12-01T00:00:00Z", urls: [] }), ac: () => ({ status: 200 }) });
prova("nessuna richiesta ad AnimeClick, esce 0, dice che è in pausa", [0, 0, "1", 0], [r.codice, ac(r).length, r.output.in_pausa, api(r, "POST", "/api/animeclick/esito").length]);

console.log("\nIndirizzi fuori da AnimeClick");
r = await esegui("fuori", { elenco: (p) => ({ tentare: true, urls: ["https://example.org/x", `http://127.0.0.1:${p}/ac/ok`] }), ac: () => ({ status: 200 }) });
prova("l'indirizzo estraneo si salta (non si scarica mai), l'altro sì", [1, "1"], [ac(r).length, r.output.scaricate]);

console.log("\nIl backend non risponde");
r = await esegui("giu", { elenco: elenco3, ac: () => ({ status: 200 }) }, { api: "http://127.0.0.1:1/api/animeclick" });
prova("esce 1 e non scarica niente", [1, 0], [r.codice, ac(r).length]);

console.log(falliti ? `\n${falliti} prove NON passano.` : "\nTutto a posto.");
server.close();
process.exit(falliti ? 1 : 0);
