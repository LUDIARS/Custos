/**
 * Custos frontend — vanilla ES module.
 *
 * 役割:
 *  - /api/apps を叩いてセレクタを埋める
 *  - 選択した app に対して /ws をはり、log / status / exit を受信
 *  - Build / Run / Test / Kill ボタンを REST に流す
 *  - app.input.buttons から virtual keys を生成 → クリックを WS で送信
 *  - Logs / Tests タブ切替
 */

const API = "/api";

// ─── DOM refs ──────────────────────────────────
const $ = (id) => document.getElementById(id);
const appSelect    = $("appSelect");
const btnBuild     = $("btnBuild");
const btnRun       = $("btnRun");
const btnTest      = $("btnTest");
const btnKill      = $("btnKill");
const statusPill   = $("statusPill");
const vkGrid       = $("vkGrid");
const logStream    = $("logStream");
const testStream   = $("testStream");
const wsStatusEl   = $("wsStatus");
const overlayToggle = $("overlayToggle");
const layoutEl     = document.querySelector(".layout");
const tabs         = [...document.querySelectorAll(".tab")];
const tabPanels    = [...document.querySelectorAll(".tab-panel")];

// ─── state ──────────────────────────────────────
const state = {
    apps:    [],          // /api/apps の items
    appId:   null,        // 選択中
    ws:      null,
    /** 同 appId に紐付けされた config (input.buttons 等を保持)。 */
    selectedConfig: null,
};

// ─── boot ───────────────────────────────────────
async function boot() {
    await loadApps();
    appSelect.addEventListener("change", onAppChange);
    btnBuild.addEventListener("click", () => apiAction("build"));
    btnRun  .addEventListener("click", () => apiAction("run"));
    btnTest .addEventListener("click", () => apiAction("test"));
    btnKill .addEventListener("click", () => apiAction("kill"));
    overlayToggle.addEventListener("change", () => {
        layoutEl.classList.toggle("overlay", overlayToggle.checked);
    });
    $("btnClearOutput").addEventListener("click", () => {
        logStream.textContent = "";
        testStream.textContent = "";
    });
    for (const t of tabs) t.addEventListener("click", () => switchTab(t.dataset.tab));
    connectWs();
}

async function loadApps() {
    try {
        const res = await fetch(`${API}/apps`);
        const json = await res.json();
        state.apps = json.apps ?? [];
        appSelect.innerHTML = "";
        appSelect.appendChild(opt("", "— 起動対象を選択 —"));
        for (const a of state.apps) {
            appSelect.appendChild(opt(a.config.id, `${a.config.name} (${a.config.target})`));
        }
        if (state.apps.length === 0) {
            appendLog({ kind: "meta", stream: "stdout", text: "config/apps.json にアプリが定義されていません。\n" });
        }
    } catch (err) {
        appendLog({ kind: "meta", stream: "stderr", text: `[custos] /api/apps fetch failed: ${err}\n` });
    }
}

function opt(value, label) {
    const o = document.createElement("option");
    o.value = value; o.textContent = label; return o;
}

function onAppChange() {
    const id = appSelect.value;
    state.appId = id || null;
    state.selectedConfig = state.apps.find((a) => a.config.id === id)?.config ?? null;
    renderVirtualKeys();
    updateActionButtons();
    if (state.appId) {
        applyStatus(state.apps.find((a) => a.config.id === id)?.status ?? null);
        wsSend({ type: "subscribe", appId: state.appId });
    }
}

function applyStatus(status) {
    if (!status) {
        statusPill.dataset.state = "idle";
        statusPill.textContent = "idle";
        return;
    }
    statusPill.dataset.state = status.lifecycle;
    statusPill.textContent = status.lifecycle + (status.pid ? ` · pid ${status.pid}` : "");
    updateActionButtons();
}

function updateActionButtons() {
    const cfg = state.selectedConfig;
    const has = Boolean(cfg);
    btnBuild.disabled = !(has && cfg.hasBuild);
    btnRun  .disabled = !has;
    btnTest .disabled = !(has && cfg.hasTest);
    btnKill .disabled = !has;
}

function renderVirtualKeys() {
    vkGrid.innerHTML = "";
    const cfg = state.selectedConfig;
    if (!cfg) {
        const empty = document.createElement("div");
        empty.className = "vk-empty";
        empty.textContent = "アプリを選択するとバーチャルキーが表示されます。";
        vkGrid.appendChild(empty);
        return;
    }
    const buttons = cfg.input?.buttons ?? [];
    if (buttons.length === 0) {
        const empty = document.createElement("div");
        empty.className = "vk-empty";
        empty.textContent = "このアプリにはバーチャルキーが定義されていません (config/apps.json で input.buttons を追加)。";
        vkGrid.appendChild(empty);
        return;
    }
    for (const b of buttons) {
        const id = labelToId(b.label);
        const el = document.createElement("button");
        el.className = "vk-button";
        if (b.action) el.dataset.action = b.action;
        el.dataset.id = id;
        const label = document.createElement("span");
        label.textContent = b.label;
        el.appendChild(label);
        if (b.key)    el.appendChild(hint(`KEY · ${b.key}`));
        if (b.action) el.appendChild(hint(`ACTION · ${b.action}`));
        el.addEventListener("click", () => triggerButton(b, id));
        vkGrid.appendChild(el);
    }
}

function hint(text) {
    const span = document.createElement("span");
    span.className = "vk-key-hint";
    span.textContent = text;
    return span;
}

function labelToId(label) {
    return label.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
}

async function triggerButton(btn, id) {
    if (btn.action === "kill") {
        await apiAction("kill");
        return;
    }
    if (!state.appId) return;
    wsSend({ type: "button", appId: state.appId, id });
}

async function apiAction(kind) {
    if (!state.appId) return;
    try {
        const res = await fetch(`${API}/apps/${encodeURIComponent(state.appId)}/${kind}`, { method: "POST" });
        const json = await res.json();
        if (!res.ok || json.ok === false) {
            appendLog({ kind: "meta", stream: "stderr", text: `[${kind}] failed: ${json.error ?? res.status}\n` });
        } else {
            appendLog({ kind: "meta", stream: "stdout", text: `[${kind}] accepted (${kind === "kill" ? "killed=" + json.ok : Object.keys(json).filter((k) => k !== "ok").join(", ")})\n` });
        }
    } catch (err) {
        appendLog({ kind: "meta", stream: "stderr", text: `[${kind}] network error: ${err}\n` });
    }
}

// ─── WS ─────────────────────────────────────────

function connectWs() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const tok = "dev-token";   // MVP: token は何でも OK (CUSTOS_OPEN=1 なら不要)
    const url = `${proto}//${location.host}/ws?token=${encodeURIComponent(tok)}`;
    const ws = new WebSocket(url);
    state.ws = ws;
    ws.addEventListener("open", () => {
        wsStatusEl.classList.remove("disconnected");
        wsStatusEl.classList.add("connected");
        wsStatusEl.textContent = "WS connected";
        if (state.appId) wsSend({ type: "subscribe", appId: state.appId });
    });
    ws.addEventListener("message", (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); }
        catch { return; }
        handleServerMessage(msg);
    });
    ws.addEventListener("close", () => {
        wsStatusEl.classList.remove("connected");
        wsStatusEl.classList.add("disconnected");
        wsStatusEl.textContent = "WS disconnected — retrying";
        setTimeout(connectWs, 1500);
    });
    ws.addEventListener("error", () => { /* close で再接続 */ });
}

function wsSend(obj) {
    const ws = state.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(obj));
}

function handleServerMessage(msg) {
    switch (msg.type) {
        case "hello":  applyStatus(msg.status); return;
        case "status": applyStatus(msg.status); return;
        case "log":    appendLog(msg); return;
        case "exit":
            appendLog({
                kind: msg.kind, stream: "stdout",
                text: `[exit] ${msg.kind} exitCode=${msg.exitCode} signal=${msg.signal ?? "-"}\n`,
            });
            return;
        case "error":
            appendLog({ kind: "meta", stream: "stderr", text: `[ws-error] ${msg.message}\n` });
            return;
    }
}

// ─── log routing ───────────────────────────────

function appendLog(msg) {
    const target = msg.kind === "test" ? testStream : logStream;
    const span = document.createElement("span");
    span.classList.add(msg.stream === "stderr" ? "stderr" : "stdout");
    if (msg.kind && msg.kind !== "meta") span.classList.add(msg.kind);
    if (msg.kind === "meta") span.classList.add("meta");
    span.textContent = `${msg.text}\n`;
    target.appendChild(span);
    target.scrollTop = target.scrollHeight;
}

function switchTab(tabId) {
    for (const t of tabs)      t.classList.toggle("active", t.dataset.tab === tabId);
    for (const t of tabs)      t.setAttribute("aria-selected", String(t.dataset.tab === tabId));
    for (const p of tabPanels) p.classList.toggle("active", p.dataset.tab === tabId);
}

boot();
