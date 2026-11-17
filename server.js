const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;
const SHIM = `const chrome = (window.chrome && window.chrome.storage) ? window.chrome : { storage: { local: {
  get(keys, cb) { const o = {}; keys.forEach((k) => { try { const v = localStorage.getItem("cvp:" + k); if (v !== null) o[k] = JSON.parse(v); } catch {} }); cb(o); },
  set(obj) { Object.keys(obj).forEach((k) => { try { localStorage.setItem("cvp:" + k, JSON.stringify(obj[k])); } catch {} }); }
} } };`;

function celularPage(base) {
  const bm = "javascript:(function(){var s=document.createElement('script');s.src='" + base + "/party.js?'+Date.now();document.documentElement.appendChild(s)})();";
  return `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CineVS Party no celular</title>
<style>body{font-family:system-ui,sans-serif;max-width:560px;margin:auto;padding:16px;background:#0f1424;color:#eee;line-height:1.5}
textarea{width:100%;height:120px;background:#0a0e1a;color:#fff;border:1px solid #2a3350;border-radius:8px;padding:8px;font-size:12px}
button{padding:14px;width:100%;border:0;border-radius:8px;background:#e50914;color:#fff;font-weight:600;font-size:16px;margin:8px 0}
h3{margin-top:24px}</style>
<h2>🎬 CineVS Party no celular</h2>
<p><b>Passo 1.</b> Toque no botão para copiar o código do favorito:</p>
<textarea id="c" readonly>${bm}</textarea>
<button onclick="var t=document.getElementById('c');t.select();navigator.clipboard.writeText(t.value).then(function(){alert('Copiado!')},function(){document.execCommand('copy');alert('Copiado!')})">Copiar código</button>
<h3>Android (Chrome)</h3>
<ol><li>Abra qualquer página, toque nos três pontinhos ⋮ e na estrela ⭐ para adicionar aos favoritos.</li>
<li>⋮ → Favoritos → segure o favorito que você criou → <b>Editar</b>.</li>
<li>Nome: <b>CineVS Party</b>. No campo do endereço, apague tudo e <b>cole o código</b>. Salve.</li>
<li>Abra o <b>webcinevs2.com</b> (ou o link que o seu par mandou), faça login e entre na página do filme.</li>
<li>Na barra de endereço, digite <b>CineVS Party</b> e toque na sugestão com a estrela ⭐. O botão 🎬 aparece na tela.</li></ol>
<h3>iPhone (Safari)</h3>
<ol><li>Toque em Compartilhar → <b>Adicionar Favorito</b> (nome: CineVS Party).</li>
<li>Toque no ícone de favoritos (livro) → <b>Editar</b> → toque em CineVS Party → apague o endereço e <b>cole o código</b>. Concluir.</li>
<li>Abra o <b>webcinevs2.com</b> (ou o link do convite) e entre na página do filme.</li>
<li>Toque no ícone de favoritos e em <b>CineVS Party</b>. O botão 🎬 aparece.</li></ol>
<p>Toda vez que abrir o site de novo, repita só o último passo.</p>`;
}

const server = http.createServer((req, res) => {
  const url = (req.url || "/").split("?")[0];
  const rawHost = String(req.headers["x-forwarded-host"] || req.headers.host || "");
  const host = /^[a-z0-9.-]+(:\d+)?$/i.test(rawHost) ? rawHost : "localhost:8080";
  const local = /^(localhost|127\.)/.test(host);

  if (url === "/party.js") {
    try {
      const code = fs.readFileSync(path.join(__dirname, "content.js"), "utf8");
      const body = `(function(){\n${SHIM}\nconst WP_SERVER = "${local ? "ws" : "wss"}://${host}";\n${code}\n})();`;
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-cache" });
      res.end(body);
    } catch (e) { res.writeHead(500); res.end("erro"); }
    return;
  }
  if (url === "/celular") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(celularPage((local ? "http" : "https") + "://" + host));
    return;
  }
  res.writeHead(200); res.end("ok");
});
const wss = new WebSocketServer({ server, maxPayload: 10 * 1024 });

const rooms = new Map(); // código -> { members:Set, host:ws, mode }
const MODES = new Set(["all", "free", "host"]);
const RELAY = new Set(["play", "pause", "seeked", "hello", "chat", "tick"]);
let nextId = 1;

const send = (ws, m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
const broadcast = (r, m, except) => { for (const p of r.members) if (p !== except) send(p, m); };
const info = (r) => ({ type: "room", count: r.members.size, hostId: r.host.id, hostNick: r.host.nick, mode: r.mode });

wss.on("connection", (ws) => {
  ws.id = String(nextId++);
  send(ws, { type: "welcome", id: ws.id });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "join") {
      const code = String(msg.room || "").slice(0, 20).toUpperCase();
      if (!code) return;
      ws.nick = String(msg.nick || "Anônimo").slice(0, 20);
      let r = rooms.get(code);
      if (!r) {
        r = { members: new Set(), host: ws, mode: MODES.has(msg.mode) ? msg.mode : "all" };
        rooms.set(code, r);
      }
      ws.room = r;
      r.members.add(ws);
      broadcast(r, { type: "sys", text: `${ws.nick} entrou na sala` }, ws);
      broadcast(r, info(r));
      return;
    }

    const r = ws.room;
    if (!r) return;

    if (msg.type === "setmode") {
      if (r.host === ws && MODES.has(msg.mode)) { r.mode = msg.mode; broadcast(r, info(r)); }
      return;
    }

    if (!RELAY.has(msg.type)) return;
    // Modo "só o host controla": ignora controles de quem não é host
    if (r.mode === "host" && r.host !== ws && ["play", "pause", "seeked"].includes(msg.type)) return;

    msg.from = ws.id;
    if (msg.type === "chat") { msg.text = String(msg.text || "").slice(0, 500); msg.nick = ws.nick; }
    broadcast(r, msg, ws);
  });

  ws.on("close", () => {
    const r = ws.room;
    if (!r) return;
    r.members.delete(ws);
    if (!r.members.size) {
      for (const [k, v] of rooms) if (v === r) rooms.delete(k);
      return;
    }
    if (r.host === ws) r.host = [...r.members][0]; // passa o host para o próximo
    broadcast(r, { type: "sys", text: `${ws.nick} saiu da sala` });
    broadcast(r, info(r));
  });
});

server.listen(PORT, () => console.log("Servidor na porta", PORT));
