/**
 * Custos frontend — vanilla ES module.
 *
 * 役割:
 *  - /api/apps を叩いてセレクタを埋める (Bearer token 認証付き)
 *  - 選択した app に対して /ws をはり、log / status / exit を受信
 *  - Build / Run / Test / Kill ボタンを REST に流す
 *  - app.input.buttons から virtual keys を生成 → クリックを WS で送信
 *  - Logs / Tests タブ切替
 *  - Phase 2: WebRTC PC を生成、capture stream を <video> に流す
 */

import { connectWebRTC, closeWebRTC } from "/js/webrtc.js";

// **同 origin 運用**: backend と frontend は同じ Hono に乗っているので、
// API も WS も相対 URL でよい。CORS / config.js 注入は不要。
const API = "/api";
const TOKEN_KEY = "custos.token";

// ─── auth ──────────────────────────────────────
//
// 既定で **token ダイアログは出さない** 運用。Custos backend は CUSTOS_OPEN=1
// または CERNERE_URL 未設定 (= anonymous) で立てる前提で、フロントから
// token を要求する場面がない。Cernere 認証を有効にしたい場合のみ
// `sessionStorage.setItem("custos.token", "<jwt>")` を DevTools 等から
// 直接セットして使う (ダイアログでは案内しない)。

function getToken() {
    return sessionStorage.getItem(TOKEN_KEY) ?? "";
}
export async function apiFetch(path, opts = {}) {
    const headers = { "content-type": "application/json", ...(opts.headers ?? {}) };
    const tok = getToken();
    if (tok) headers["authorization"] = `Bearer ${tok}`;
    return await fetch(API + path, { ...opts, headers });
}
/** WebSocket 用の base URL (`ws://...` / `wss://...`)。同 origin。 */
export function wsBase() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}`;
}

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
const streamVideo       = $("streamVideo");
const streamImage       = $("streamImage");
const streamPlaceholder = $("streamPlaceholder");
const captureMode       = $("captureMode");
const btnSnapshot       = $("btnSnapshot");
const btnStreamStart    = $("btnStreamStart");
const btnStreamStop     = $("btnStreamStop");
const btnDownload       = $("btnDownload");

// ─── state ──────────────────────────────────────
const state = {
    apps:    [],
    appId:   null,
    ws:      null,
    selectedConfig: null,
    captureSessionId: null,    // WebRTC session (if streaming)
    lastShotUrl: null,         // blob: URL for the latest snapshot (for download)
};
const CAPTURE_MODE_KEY = "custos.captureMode";

// ─── boot ───────────────────────────────────────
async function boot() {
    // token ダイアログは出さない。Custos の標準運用は CUSTOS_OPEN=1 で
    // backend を立てるか、CERNERE_URL を設定しない anonymous モード。
    await loadApps();
    appSelect.addEventListener("change", onAppChange);
    btnBuild.addEventListener("click", () => apiAction("build"));
    btnRun  .addEventListener("click", () => apiAction("run"));
    btnTest .addEventListener("click", () => apiAction("test"));
    btnKill .addEventListener("click", () => apiAction("kill"));

    // Capture mode: localStorage に保存しておくのでセッション越しに記憶
    captureMode.value = localStorage.getItem(CAPTURE_MODE_KEY) ?? "snapshot";
    captureMode.addEventListener("change", () => {
        localStorage.setItem(CAPTURE_MODE_KEY, captureMode.value);
        applyCaptureMode();
    });
    applyCaptureMode();

    btnSnapshot   .addEventListener("click", takeSnapshot);
    btnStreamStart.addEventListener("click", () => startCapture(state.appId));
    btnStreamStop .addEventListener("click", () => teardownCapture());

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

function applyCaptureMode() {
    const m = captureMode.value;
    btnSnapshot   .hidden = m !== "snapshot";
    btnStreamStart.hidden = m !== "webrtc";
    btnStreamStop .hidden = m !== "webrtc";
    // モード切替時は対向側の表示を畳む
    if (m === "snapshot") {
        teardownCapture().catch(() => {});
        streamVideo.classList.remove("active");
    } else {
        streamImage.classList.remove("active");
        if (state.lastShotUrl) URL.revokeObjectURL(state.lastShotUrl);
        state.lastShotUrl = null;
        btnDownload.hidden = true;
    }
    streamPlaceholder.style.display =
        (streamVideo.classList.contains("active") || streamImage.classList.contains("active")) ? "none" : "";
}

async function loadApps() {
    appSelect.innerHTML = "";
    appSelect.appendChild(opt("", "— 起動対象を読み込み中… —"));
    try {
        const res = await apiFetch(`/apps`);
        if (!res.ok) {
            appendLog({ kind: "meta", stream: "stderr",
                text: `[custos] /api/apps HTTP ${res.status} — サーバー (${location.origin}) との通信に失敗。CUSTOS_OPEN=1 で立ち上げているか確認してください。\n` });
            appSelect.innerHTML = "";
            appSelect.appendChild(opt("", "— 取得失敗 —"));
            return;
        }
        const json = await res.json();
        state.apps = json.apps ?? [];
        appSelect.innerHTML = "";
        appSelect.appendChild(opt("", "— 起動対象を選択 —"));
        for (const a of state.apps) {
            appSelect.appendChild(opt(a.config.id, `${a.config.name} (${a.config.target})`));
        }
        if (state.apps.length === 0) {
            appendLog({ kind: "meta", stream: "stderr",
                text: "[custos] apps.json にアプリが 0 件です。CUSTOS_APPS_FILE / cwd を確認してください。\n" });
        } else {
            appendLog({ kind: "meta", stream: "stdout", text: `[custos] ${state.apps.length} apps loaded\n` });
        }
    } catch (err) {
        appendLog({ kind: "meta", stream: "stderr",
            text: `[custos] /api/apps fetch error: ${err.message ?? err}\n` });
        appSelect.innerHTML = "";
        appSelect.appendChild(opt("", "— 取得失敗 —"));
    }
}

function opt(value, label) {
    const o = document.createElement("option");
    o.value = value; o.textContent = label; return o;
}

async function onAppChange() {
    const id = appSelect.value;
    state.appId = id || null;
    state.selectedConfig = state.apps.find((a) => a.config.id === id)?.config ?? null;
    renderVirtualKeys();
    updateActionButtons();

    // 既存の capture を畳む
    await teardownCapture();
    streamVideo.classList.remove("active");
    streamImage.classList.remove("active");
    if (state.lastShotUrl) { URL.revokeObjectURL(state.lastShotUrl); state.lastShotUrl = null; }
    btnDownload.hidden = true;
    streamPlaceholder.style.display = "";

    if (state.appId) {
        applyStatus(state.apps.find((a) => a.config.id === id)?.status ?? null);
        wsSend({ type: "subscribe", appId: state.appId });
    }
}

async function takeSnapshot() {
    if (!state.appId) {
        appendLog({ kind: "meta", stream: "stderr", text: "[snapshot] アプリ未選択\n" });
        return;
    }
    btnSnapshot.disabled = true;
    try {
        const res = await apiFetch(`/apps/${encodeURIComponent(state.appId)}/screenshot`, { method: "POST" });
        if (!res.ok) {
            const j = await res.json().catch(() => ({}));
            appendLog({ kind: "meta", stream: "stderr",
                text: `[snapshot] HTTP ${res.status} ${j.error ?? ""}\n` });
            return;
        }
        const blob = await res.blob();
        // 古い blob URL は revoke して GC を助ける
        if (state.lastShotUrl) URL.revokeObjectURL(state.lastShotUrl);
        const url = URL.createObjectURL(blob);
        state.lastShotUrl = url;
        streamImage.src = url;
        streamImage.classList.add("active");
        streamVideo.classList.remove("active");
        streamPlaceholder.style.display = "none";
        btnDownload.href = url;
        btnDownload.download = `custos-${state.appId}-${Date.now()}.png`;
        btnDownload.hidden = false;
        appendLog({ kind: "meta", stream: "stdout", text: `[snapshot] ${(blob.size / 1024).toFixed(1)} KB\n` });
    } catch (err) {
        appendLog({ kind: "meta", stream: "stderr",
            text: `[snapshot] error: ${err.message ?? err}\n` });
    } finally {
        btnSnapshot.disabled = false;
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

    // running から外れたら WebRTC セッションだけ畳む。capture 開始は **常に
    // 手動** (Snapshot ボタンか Stream Start ボタン)。
    if (status.lifecycle !== "running" && state.captureSessionId) {
        teardownCapture().catch(() => {});
    }
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
        const res = await apiFetch(`/apps/${encodeURIComponent(state.appId)}/${kind}`, { method: "POST" });
        const json = await res.json();
        if (!res.ok || json.ok === false) {
            appendLog({ kind: "meta", stream: "stderr", text: `[${kind}] failed: ${json.error ?? res.status}\n` });
        } else {
            appendLog({ kind: "meta", stream: "stdout", text: `[${kind}] accepted (${kind === "kill" ? "killed=" + json.ok : Object.keys(json).filter((k) => k !== "ok").join(", ")})\n` });
        }
    } catch (err) {
        appendLog({ kind: "meta", stream: "stderr", text: `[${kind}] network error: ${err.message ?? err}\n` });
    }
}

// ─── capture (WebRTC) ─────────────────────────

async function startCapture(appId) {
    if (!appId) {
        appendLog({ kind: "meta", stream: "stderr", text: "[capture] アプリ未選択\n" });
        return;
    }
    if (!state.selectedConfig?.capture) {
        appendLog({ kind: "meta", stream: "stderr",
            text: "[capture] capture 設定が無いアプリです (apps.json の capture セクションを追加)\n" });
        return;
    }
    if (state.captureSessionId) {
        appendLog({ kind: "meta", stream: "stdout", text: "[capture] 既に streaming 中\n" });
        return;
    }
    btnStreamStart.disabled = true;
    try {
        const sessionId = await connectWebRTC({
            appId,
            videoEl:   streamVideo,
            apiFetch,
            onLog: (text, isErr) => appendLog({ kind: "meta", stream: isErr ? "stderr" : "stdout", text: `[capture] ${text}\n` }),
        });
        state.captureSessionId = sessionId;
        streamVideo.classList.add("active");
        streamImage.classList.remove("active");
        streamPlaceholder.style.display = "none";
    } catch (err) {
        appendLog({ kind: "meta", stream: "stderr", text: `[capture] start failed: ${err.message ?? err}\n` });
    } finally {
        btnStreamStart.disabled = false;
    }
}

async function teardownCapture() {
    if (!state.captureSessionId) return;
    try {
        await closeWebRTC({ apiFetch, sessionId: state.captureSessionId });
    } catch { /* ignore */ }
    state.captureSessionId = null;
}

// ─── WS ─────────────────────────────────────────

function connectWs() {
    // token は空でも繋ぐ。Cernere 不使用 (anonymous mode) なら backend が
    // 何も要求しない。401 / 4401 で close されたら setToken 経由で再接続。
    const tok = getToken();
    const url = `${wsBase()}/ws${tok ? `?token=${encodeURIComponent(tok)}` : ""}`;
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
