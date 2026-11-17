const http = require("http");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;
const server = http.createServer((req, res) => { res.writeHead(200); res.end("ok"); });
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
