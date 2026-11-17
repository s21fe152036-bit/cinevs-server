(() => {
  if (window !== window.top || window.__cvpLoaded) return;
  window.__cvpLoaded = true;

  // ---- Link de convite: lê ?cvparty=CODIGO antes do site (React) mexer na URL ----
  let inviteRoom = null;
  try {
    const u = new URL(location.href);
    inviteRoom = u.searchParams.get("cvparty");
    if (inviteRoom) {
      inviteRoom = inviteRoom.toUpperCase().slice(0, 20);
      u.searchParams.delete("cvparty");
      history.replaceState(history.state, "", u.pathname + u.search + u.hash);
    }
  } catch {}

  function init() {
    const SERVER = typeof WP_SERVER === "string" ? WP_SERVER : "ws://localhost:8080";
    const MODE_LABEL = {
      all: "Todos controlam (pausa para todos)",
      free: "Pausa livre (cada um pausa o seu)",
      host: "Só o host controla",
    };

    let ws = null, wantConnected = false;
    let pingTimer = null, tickTimer = null, reconnectTimer = null;
    let nick = "", room = "";
    let myId = null, hostId = null, hostNick = "", mode = "all", modeKnown = false;
    let pendingMode = "all";
    let video = null, quietUntil = 0, needInitialSync = false;
    let warnedSrc = null, warnedUrl = null;
    let lastDetail = null, hintedWatch = false;
    const peers = {}; // id -> {time, playing, src, at}

    // ================= UI (Shadow DOM) =================
    const host = document.createElement("div");
    host.id = "wp-host";
    host.style.cssText = "all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
    <style>
      *{box-sizing:border-box;font-family:system-ui,-apple-system,Segoe UI,sans-serif}
      #fab{position:fixed;right:16px;bottom:16px;width:44px;height:44px;border-radius:50%;border:0;background:#e50914;color:#fff;font-size:20px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.5);transition:opacity .35s}
      #fab.idle{opacity:0;pointer-events:none}
      #fab.unread{box-shadow:0 0 0 3px #ffd54a,0 4px 14px rgba(0,0,0,.5)}
      #toast{position:fixed;right:16px;bottom:70px;max-width:280px;padding:8px 12px;border-radius:10px;background:rgba(15,20,36,.92);color:#fff;font-size:13px;border:1px solid #2a3350;word-break:break-word}
      #panel{position:fixed;right:16px;bottom:74px;width:min(330px,calc(100vw - 24px));height:min(520px,75vh);background:#0f1424;color:#eee;border:1px solid #2a3350;border-radius:12px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 8px 30px rgba(0,0,0,.6)}
      .hidden{display:none!important}
      #head{display:flex;align-items:center;gap:6px;padding:10px 12px;background:#161c33;font-size:14px}
      #head b{flex:1}
      #head button{background:none;border:0;color:#aaa;cursor:pointer;font-size:15px}
      #setup{padding:14px;display:flex;flex-direction:column;gap:8px;overflow-y:auto}
      #createWrap{display:flex;flex-direction:column;gap:6px}
      input,select{padding:10px;border-radius:8px;border:1px solid #2a3350;background:#0a0e1a;color:#fff;font-size:13px;outline:none;max-width:100%}
      button.main{padding:10px;border:0;border-radius:8px;background:#e50914;color:#fff;font-weight:600;cursor:pointer;font-size:14px}
      button.sec{background:#2a3350}
      #err{color:#ff7b7b;font-size:12px;min-height:14px}
      #chat{flex:1;display:flex;flex-direction:column;min-height:0}
      #info{padding:6px 12px;font-size:12px;color:#8fa0c8}
      #modeRow{padding:0 12px 8px;border-bottom:1px solid #1f2745}
      #modeRow select{width:100%;padding:6px;font-size:12px}
      #msgs{flex:1;overflow-y:auto;padding:10px 12px;display:flex;flex-direction:column;gap:8px;font-size:14px}
      .m b{display:block;font-size:12px;color:#8fa0c8;margin-bottom:2px}
      .m.me b{color:#ff8a90}
      .m span{word-break:break-word}
      .sys{font-size:12px;color:#7d8bb0;text-align:center}
      .sys button{margin-left:6px;padding:4px 8px;border:0;border-radius:6px;background:#e50914;color:#fff;cursor:pointer;font-size:12px}
      #row{display:flex;gap:6px;padding:8px;border-top:1px solid #1f2745}
      #row input{flex:1;min-width:0}
      #row button{width:42px}
      #leave{margin:0 8px 8px}
      .hint{font-size:12px;color:#8fa0c8;line-height:1.4}
    @media (pointer:coarse){
        #fab{width:52px;height:52px;font-size:24px;bottom:84px}
        #panel{right:8px;bottom:8px;width:calc(100vw - 16px);height:68vh}
        #toast{bottom:150px}
      }
    </style>
    <button id="fab" title="CineVS Party">🎬</button>
    <div id="toast" class="hidden"></div>
    <div id="panel" class="hidden">
      <div id="head"><b>🎬 CineVS Party <span id="roomLbl"></span></b>
        <button id="link" class="hidden" title="Copiar link do convite">🔗</button>
        <button id="copy" class="hidden" title="Copiar código">📋</button>
        <button id="close" title="Fechar">✕</button></div>
      <div id="setup">
        <div id="inviteBox" class="hint hidden"></div>
        <input id="nick" maxlength="20" placeholder="Seu apelido">
        <input id="room" maxlength="20" placeholder="Código da sala">
        <button id="join" class="main">Entrar na sala</button>
        <div id="createWrap">
          <div class="hint">Ou crie uma sala nova. Modo de controle:</div>
          <select id="modeCreate">
            <option value="all">${MODE_LABEL.all}</option>
            <option value="free">${MODE_LABEL.free}</option>
            <option value="host">${MODE_LABEL.host}</option>
          </select>
          <button id="create" class="main sec">Criar sala e gerar link</button>
        </div>
        <div id="err"></div>
      </div>
      <div id="chat" class="hidden">
        <div id="info">Conectando...</div>
        <div id="modeRow">
          <select id="modeSel">
            <option value="all">${MODE_LABEL.all}</option>
            <option value="free">${MODE_LABEL.free}</option>
            <option value="host">${MODE_LABEL.host}</option>
          </select>
        </div>
        <div id="msgs"></div>
        <div id="row"><input id="text" maxlength="500" placeholder="Digite uma mensagem..."><button id="sendBtn" class="main">➤</button></div>
        <button id="leave" class="main sec">Sair da sala</button>
      </div>
    </div>`;
    document.documentElement.appendChild(host);
    const $ = (id) => root.getElementById(id);

    // Tela cheia: leva o painel junto
    document.addEventListener("fullscreenchange", () => {
      const fs = document.fullscreenElement;
      const target = fs && fs.tagName !== "VIDEO" ? fs : document.documentElement;
      target.appendChild(host);
    });

    // Atalhos do site não disparam enquanto digita
    root.querySelectorAll("input").forEach((i) =>
      ["keydown", "keyup", "keypress"].forEach((ev) => i.addEventListener(ev, (e) => e.stopPropagation()))
    );

    function showView(inRoom) {
      $("setup").classList.toggle("hidden", inRoom);
      $("chat").classList.toggle("hidden", !inRoom);
      $("copy").classList.toggle("hidden", !inRoom);
      $("link").classList.toggle("hidden", !inRoom);
      $("roomLbl").textContent = inRoom ? "· " + room : "";
    }
    function addSys(text) {
      const d = document.createElement("div");
      d.className = "sys"; d.textContent = text;
      $("msgs").appendChild(d); $("msgs").scrollTop = 1e9;
    }
    function addAction(text, label, fn) {
      const d = document.createElement("div");
      d.className = "sys"; d.textContent = text;
      const b = document.createElement("button");
      b.textContent = label; b.onclick = fn;
      d.appendChild(b);
      $("msgs").appendChild(d); $("msgs").scrollTop = 1e9;
    }
    function addMsg(who, text, me) {
      const d = document.createElement("div");
      d.className = "m" + (me ? " me" : "");
      const b = document.createElement("b"); b.textContent = me ? "Você" : who;
      const s = document.createElement("span"); s.textContent = text;
      d.append(b, s);
      $("msgs").appendChild(d); $("msgs").scrollTop = 1e9;
    }
    function renderInfo(count) {
      $("info").textContent = `👥 ${count} na sala · host: ${hostNick}${isHost() ? " (você)" : ""}`;
      $("modeSel").value = mode;
      $("modeSel").disabled = !isHost();
      $("modeSel").title = isHost() ? "Você é o host: pode mudar o modo" : "Só o host muda o modo";
    }

    $("fab").onclick = () => { $("panel").classList.toggle("hidden"); $("fab").classList.remove("unread"); $("toast").classList.add("hidden"); wake(); };
    $("close").onclick = () => { $("panel").classList.add("hidden"); wake(); };
    $("copy").onclick = () => navigator.clipboard.writeText(room).then(() => addSys("Código copiado!"));
    $("link").onclick = () => {
      const u = new URL(lastDetail || location.href);
      u.searchParams.set("cvparty", room);
      navigator.clipboard.writeText(u.toString()).then(() => {
        addSys("🔗 Link copiado! Ele abre a página do filme já na sua sala.");
        if (!lastDetail && location.pathname.startsWith("/player"))
          addSys("Dica: não achei a página do filme. Volte até ela e copie o link de novo.");
      });
    };

    const genCode = () => {
      const c = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      return Array.from({ length: 6 }, () => c[Math.floor(Math.random() * c.length)]).join("");
    };
    $("create").onclick = () => {
      const n = $("nick").value.trim();
      if (!n) return ($("err").textContent = "Digite seu apelido.");
      pendingMode = $("modeCreate").value;
      startParty(n, genCode());
      setTimeout(() => $("link").click(), 600); // já copia o link de convite
    };
    $("join").onclick = () => {
      const n = $("nick").value.trim(), r = $("room").value.trim().toUpperCase();
      if (!n) return ($("err").textContent = "Digite seu apelido.");
      if (!r) return ($("err").textContent = "Digite o código da sala.");
      pendingMode = "all";
      startParty(n, r);
    };
    $("leave").onclick = leaveParty;
    $("sendBtn").onclick = sendChat;
    $("text").addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); });
    $("modeSel").onchange = () => send({ type: "setmode", mode: $("modeSel").value });

    function sendChat() {
      const t = $("text").value.trim();
      if (!t) return;
      send({ type: "chat", text: t });
      addMsg(nick, t, true);
      $("text").value = "";
    }

    // ===== Lembra a página do filme (a última antes do /player) para o link do convite =====
    try { lastDetail = sessionStorage.getItem("cvp_detail"); } catch {}
    function trackUrl() {
      const p = location.pathname;
      if (p === "/" || p.startsWith("/player")) return;
      try {
        const u = new URL(location.href); u.searchParams.delete("cvparty");
        const str = u.toString();
        if (str !== lastDetail) { lastDetail = str; try { sessionStorage.setItem("cvp_detail", str); } catch {} }
      } catch {}
    }
    setInterval(trackUrl, 400);
    trackUrl();

    // ===== Botão some sozinho durante o filme; reaparece ao mexer o mouse =====
    let idleTimer = null, toastTimer = null;
    function wake() {
      $("fab").classList.remove("idle");
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (video && $("panel").classList.contains("hidden")) $("fab").classList.add("idle");
      }, 2500);
    }
    ["mousemove", "mousedown", "keydown", "touchstart"].forEach((ev) =>
      document.addEventListener(ev, wake, { passive: true, capture: true })
    );
    // Mensagem nova com o painel fechado: mostra um balão rápido
    function notify(who, text) {
      if (!$("panel").classList.contains("hidden")) return;
      $("fab").classList.add("unread");
      const t = $("toast");
      t.textContent = who + ": " + text;
      t.classList.remove("hidden");
      wake();
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => t.classList.add("hidden"), 5000);
    }

    // ================= Rede =================
    const send = (msg) => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); };
    const isHost = () => myId && myId === hostId;

    function startParty(n, r) {
      nick = n; room = r; wantConnected = true;
      modeKnown = false;
      chrome.storage.local.set({ wp_nick: nick, wp_room: room, wp_active: true });
      $("msgs").innerHTML = "";
      $("err").textContent = "";
      showView(true);
      connect();
    }

    function leaveParty() {
      wantConnected = false;
      clearTimeout(reconnectTimer);
      clearInterval(tickTimer);
      if (ws) ws.close();
      ws = null;
      chrome.storage.local.set({ wp_active: false });
      showView(false);
    }

    function connect() {
      if (ws || !wantConnected) return;
      $("info").textContent = "Conectando...";
      ws = new WebSocket(SERVER);
      ws.onopen = () => {
        Object.keys(peers).forEach((k) => delete peers[k]);
        send({ type: "join", room, nick, mode: pendingMode });
        needInitialSync = true;
        send({ type: "hello" });
        pingTimer = setInterval(() => send({ type: "ping" }), 25000);
        clearInterval(tickTimer);
        tickTimer = setInterval(() => { if (video) send(tickMsg()); }, 2000);
      };
      ws.onmessage = (e) => { try { onMessage(JSON.parse(e.data)); } catch {} };
      ws.onclose = () => {
        clearInterval(pingTimer); clearInterval(tickTimer);
        ws = null;
        if (wantConnected) {
          $("info").textContent = "Reconectando...";
          reconnectTimer = setTimeout(connect, 2500);
        }
      };
      ws.onerror = () => { $("info").textContent = "Erro ao conectar no servidor."; };
    }

    function onMessage(msg) {
      switch (msg.type) {
        case "welcome": myId = msg.id; break;
        case "room": {
          const changed = modeKnown && msg.mode !== mode;
          hostId = msg.hostId; hostNick = msg.hostNick; mode = msg.mode; modeKnown = true;
          renderInfo(msg.count);
          if (changed) addSys("Modo da sala: " + MODE_LABEL[mode]);
          break;
        }
        case "sys": addSys(msg.text); break;
        case "chat": addMsg(msg.nick, msg.text, false); notify(msg.nick, msg.text); break;
        case "hello": if (video) send(tickMsg()); break;
        case "tick": onTick(msg); break;
        case "play": case "pause": case "seeked": applyRemote(msg); break;
      }
    }

    // ================= Vídeo =================
    const usrState = () => { try { return (history.state && history.state.usr) || {}; } catch { return {}; } };
    // Identidade do vídeo: usa o ID do filme/episódio do site. O endereço do vídeo é
    // temporário (blob:) e muda por pessoa, então só serve de fallback.
    const srcKey = (v) => {
      const u = usrState();
      if (u.contentId != null) {
        const ep = u.episodeId ?? u.episode_id ?? (u.episode && u.episode.id) ?? u.episodeNumber ?? "";
        return `${u.contentType || ""}:${u.contentId}:${typeof ep === "object" ? "" : ep}`;
      }
      const s = (v.currentSrc || v.src || "").split("?")[0];
      return s.startsWith("blob:") ? "" : s;
    };
    const durOf = (v) => (isFinite(v.duration) ? v.duration : 0);
    const norm = (u) => { try { const x = new URL(u); x.searchParams.delete("cvparty"); return x.origin + x.pathname + x.search; } catch { return u; } };
    const tickMsg = () => {
      const u = usrState();
      return { type: "tick", time: video.currentTime, playing: !video.paused, src: srcKey(video), dur: durOf(video),
               url: location.href, detail: lastDetail, title: u.contentTitle || "", cid: u.contentId || null };
    };
    const quiet = (fn) => { quietUntil = Date.now() + 700; fn(); };

    function findVideo() {
      return [...document.querySelectorAll("video")].sort(
        (a, b) => b.offsetWidth * b.offsetHeight - a.offsetWidth * a.offsetHeight
      )[0];
    }

    function attach(v) {
      if (v.__wpAttached) return;
      v.__wpAttached = true;
      ["play", "pause", "seeked"].forEach((t) => v.addEventListener(t, () => onLocal(t)));
    }

    // Posição "do grupo" (usada no modo Pausa livre): quem está tocando agora
    function groupPos() {
      const now = Date.now();
      let best = null;
      for (const id in peers) {
        const p = peers[id];
        if (now - p.at > 8000) continue;
        const cand = { time: p.playing ? p.time + (now - p.at) / 1000 : p.time, playing: p.playing, at: p.at };
        if (!best || (cand.playing && !best.playing) || (cand.playing === best.playing && cand.at > best.at)) best = cand;
      }
      return best;
    }

    // Convidado no modo "só o host controla": desfaz o que ele fez
    function enforceHost() {
      const h = peers[hostId];
      if (!h || !video) return;
      const t = h.playing ? h.time + (Date.now() - h.at) / 1000 : h.time;
      quiet(() => {
        if (Math.abs(video.currentTime - t) > 1) video.currentTime = t;
        if (h.playing && video.paused) video.play().catch(() => {});
        if (!h.playing && !video.paused) video.pause();
      });
      addSys("🔒 Só o host controla o vídeo nesta sala.");
    }

    // Ação do usuário no vídeo local
    function onLocal(type) {
      if (Date.now() < quietUntil || !video) return;
      const base = { time: video.currentTime, playing: !video.paused, src: srcKey(video), dur: durOf(video) };
      if (mode === "all") {
        send({ type, ...base });
      } else if (mode === "host") {
        if (isHost()) send({ type, ...base }); else enforceHost();
      } else {
        // Pausa livre: pausar é só local; ao dar play, volta pra onde o grupo está
        if (type === "play") {
          const g = groupPos();
          if (g && Math.abs(g.time - video.currentTime) > 1.5) quiet(() => { video.currentTime = g.time; });
        } else if (type === "seeked" && !video.paused) {
          send({ type, ...base });
        }
      }
    }

    function srcMismatch(m) {
      if (!video) return false;
      const mine = srcKey(video);
      let diff = false;
      if (m.src && mine && mine !== m.src) diff = true;
      if (m.dur && durOf(video) && Math.abs(m.dur - durOf(video)) > 120) diff = true; // episódios diferentes
      if (diff) {
        const tag = (m.src || "") + ":" + Math.round(m.dur || 0);
        if (warnedSrc !== tag) { warnedSrc = tag; addSys("⚠️ Vocês estão em vídeos diferentes."); }
      }
      return diff;
    }

    function applyState(s) {
      quiet(() => {
        if (Math.abs(video.currentTime - s.time) > 0.7) video.currentTime = s.time;
        if (s.playing) video.play().catch(() => addSys("Clique na página para liberar o play automático."));
        else video.pause();
      });
    }

    function applyRemote(msg) {
      peers[msg.from] = { time: msg.time, playing: msg.playing, src: msg.src, at: Date.now() };
      if (!video || srcMismatch(msg)) return;
      if (mode === "free") {
        if (msg.type === "seeked" && !video.paused) quiet(() => { video.currentTime = msg.time; });
        return;
      }
      quiet(() => {
        if (Math.abs(video.currentTime - msg.time) > 0.7) video.currentTime = msg.time;
        if (msg.type === "play") video.play().catch(() => addSys("Clique na página para liberar o play automático."));
        if (msg.type === "pause") video.pause();
      });
    }

    function onTick(msg) {
      peers[msg.from] = { time: msg.time, playing: msg.playing, src: msg.src, at: Date.now() };

      // Sugere ir para o mesmo filme/episódio do par
      const differentVideo = !video || (msg.src && srcKey(video) && msg.src !== srcKey(video));
      const target = msg.detail || msg.url;
      if (target && differentVideo) {
        if (norm(target) !== norm(location.href)) {
          if (warnedUrl !== target) {
            warnedUrl = target;
            addAction("🎬 Seu par está assistindo" + (msg.title ? ` “${msg.title}”` : "") + ".", "Abrir o filme", () => { location.href = target; });
          }
        } else if (!video && !hintedWatch) {
          hintedWatch = true;
          addSys("👉 Você já está na página do filme. Clique em Assistir para sincronizar.");
        }
      }
      if (!video) return;

      const fromAuthority = mode !== "host" || msg.from === hostId;
      if (needInitialSync && fromAuthority) {
        needInitialSync = false;
        if (!srcMismatch(msg)) applyState(msg);
        return;
      }
      // Correção de deriva no modo host: convidado segue o host
      if (mode === "host" && !isHost() && msg.from === hostId && !srcMismatch(msg)) {
        if (msg.playing && !video.paused && Math.abs(video.currentTime - msg.time) > 2)
          quiet(() => { video.currentTime = msg.time; });
      }
    }

    // O site é SPA: o <video> aparece/troca sem recarregar
    new MutationObserver(() => {
      const v = findVideo();
      if (v && v !== video) {
        video = v; attach(v);
        if (ws && ws.readyState === WebSocket.OPEN) { needInitialSync = true; send({ type: "hello" }); }
      }
      if (!v) video = null;
    }).observe(document.documentElement, { childList: true, subtree: true });
    video = findVideo();
    if (video) attach(video);
    wake();

    // ================= Retomar sessão / convite =================
    chrome.storage.local.get(["wp_nick", "wp_room", "wp_active"], (s) => {
      if (s.wp_nick) $("nick").value = s.wp_nick;
      if (inviteRoom) {
        $("room").value = inviteRoom;
        $("createWrap").classList.add("hidden");
        $("inviteBox").classList.remove("hidden");
        $("inviteBox").textContent = "🎟️ Você foi convidado para a sala " + inviteRoom + ". Digite seu apelido e entre!";
        $("panel").classList.remove("hidden");
        if (s.wp_nick) startParty(s.wp_nick, inviteRoom);
        return;
      }
      if (s.wp_room) $("room").value = s.wp_room;
      if (s.wp_active && s.wp_nick && s.wp_room) startParty(s.wp_nick, s.wp_room);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
