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
import { createUnityPanel } from "/js/unity-panel.js";

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
    const method = (opts.method ?? "GET").toUpperCase();
    const t0 = performance.now();
    appendLog({ kind: "api", stream: "stdout", text: `→ ${method} ${path}` });
    try {
        const res = await fetch(API + path, { ...opts, headers });
        const ms  = (performance.now() - t0).toFixed(0);
        appendLog({
            kind:   "api",
            stream: res.ok ? "stdout" : "stderr",
            text:   `← ${res.status} ${method} ${path} (${ms}ms)`,
        });
        return res;
    } catch (err) {
        const ms = (performance.now() - t0).toFixed(0);
        appendLog({ kind: "api", stream: "stderr",
            text: `✗ ${method} ${path} (${ms}ms) ${err.message ?? err}` });
        throw err;
    }
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
const mainTabs     = [...document.querySelectorAll(".main-tab")];
const mainPanels   = [...document.querySelectorAll(".main-panel")];
const streamVideo       = $("streamVideo");
const streamImage       = $("streamImage");
const streamPlaceholder = $("streamPlaceholder");
const captureMode       = $("captureMode");
const btnSnapshot       = $("btnSnapshot");
const btnStreamStart    = $("btnStreamStart");
const btnStreamStop     = $("btnStreamStop");
const btnDownload       = $("btnDownload");
// settings tab
const settingsForm      = $("settingsForm");
const settingIntervalEl = $("settingIntervalSec");
const settingMaxWidthEl = $("settingMaxWidth");
const settingResetBtn   = $("settingReset");
const settingStatusEl   = $("settingStatus");
const settingsCurrentEl = $("settingsCurrent");

// ─── state ──────────────────────────────────────
const state = {
    apps:    [],
    appId:   null,
    ws:      null,
    selectedConfig: null,
    captureSessionId: null,    // WebRTC session (if streaming)
    lastShotUrl: null,         // blob: URL for the latest snapshot (for download)
    boot:   { pending: false, appId: null },  // BOOT (build → run) チェイン状態
};
const CAPTURE_MODE_KEY = "custos.captureMode";
const unityPanel = createUnityPanel({ apiFetch, getAppId: () => state.appId });

// ─── boot ───────────────────────────────────────
async function boot() {
    // token ダイアログは出さない。Custos の標準運用は CUSTOS_OPEN=1 で
    // backend を立てるか、CERNERE_URL を設定しない anonymous モード。
    await loadApps();
    appSelect.addEventListener("change", onAppChange);
    btnBuild.addEventListener("click", () => bootApp());
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

    $("btnClearOutput").addEventListener("click", () => {
        logStream.textContent = "";
        testStream.textContent = "";
    });
    for (const t of mainTabs) t.addEventListener("click", () => switchMainTab(t.dataset.tab));
    setupSettingsTab();
    connectWs();
}

function switchMainTab(tabId) {
    for (const t of mainTabs)   t.classList.toggle("active", t.dataset.tab === tabId);
    for (const t of mainTabs)   t.setAttribute("aria-selected", String(t.dataset.tab === tabId));
    for (const p of mainPanels) p.classList.toggle("active", p.dataset.tab === tabId);
    if (tabId === "settings") loadStreamPrefs().catch(() => {});
    unityPanel.setActive(tabId === "unity");
}

// ─── settings tab ──────────────────────────────

function setupSettingsTab() {
    if (!settingsForm) return;
    settingsForm.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        await saveStreamPrefs();
    });
    settingResetBtn.addEventListener("click", async () => {
        // null patch でクリア → apps.json 既定値に戻る
        await putStreamPrefs({ intervalSec: null, maxWidth: null });
        settingIntervalEl.value = "";
        settingMaxWidthEl.value = "";
        setSettingStatus("Reset to defaults", "ok");
    });
}

async function loadStreamPrefs() {
    try {
        const res = await apiFetch("/settings/stream");
        if (!res.ok) {
            setSettingStatus(`HTTP ${res.status}`, "err");
            return;
        }
        const j = await res.json();
        const p = j.prefs ?? {};
        settingIntervalEl.value = p.intervalSec !== undefined ? String(p.intervalSec) : "";
        settingMaxWidthEl.value = p.maxWidth    !== undefined ? String(p.maxWidth)    : "";
        settingsCurrentEl.textContent = JSON.stringify(p, null, 2);
        setSettingStatus("", "");
    } catch (err) {
        setSettingStatus(`load error: ${err.message ?? err}`, "err");
    }
}

async function saveStreamPrefs() {
    const patch = {};
    const ivRaw = settingIntervalEl.value.trim();
    const mwRaw = settingMaxWidthEl.value.trim();
    patch.intervalSec = ivRaw === "" ? null : Number(ivRaw);
    patch.maxWidth    = mwRaw === "" ? null : Number(mwRaw);
    if (Number.isNaN(patch.intervalSec) || (patch.intervalSec !== null && patch.intervalSec < 0)) {
        setSettingStatus("intervalSec が不正", "err"); return;
    }
    if (Number.isNaN(patch.maxWidth) || (patch.maxWidth !== null && patch.maxWidth < 0)) {
        setSettingStatus("maxWidth が不正", "err"); return;
    }
    await putStreamPrefs(patch);
}

async function putStreamPrefs(patch) {
    try {
        const res = await apiFetch("/settings/stream", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(patch),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok || j.ok === false) {
            setSettingStatus(`save failed: ${j.error ?? `HTTP ${res.status}`}`, "err");
            return;
        }
        settingsCurrentEl.textContent = JSON.stringify(j.prefs ?? {}, null, 2);
        setSettingStatus("Saved — applied immediately", "ok");
    } catch (err) {
        setSettingStatus(`save error: ${err.message ?? err}`, "err");
    }
}

function setSettingStatus(msg, kind) {
    settingStatusEl.textContent = msg;
    settingStatusEl.className   = "settings-status" + (kind ? " " + kind : "");
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
    // 別 app に切り替えたら未完了 BOOT チェインは捨てる (前 app の build exit で
    // 別 app の run が走ったら混乱の元)。
    if (state.boot.pending && state.boot.appId !== id) {
        state.boot = { pending: false, appId: null };
    }
    state.appId = id || null;
    state.selectedConfig = state.apps.find((a) => a.config.id === id)?.config ?? null;
    unityPanel.setApp(state.selectedConfig);
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
    // BOOT は build が無いアプリでも押せる (その場合は run 直行)。
    btnBuild.disabled = !has;
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

    // ── ラベル + key からゲームパッドの slot を推定 ──
    // 同じ slot に複数アサインがあったら最初の 1 つだけ採用、残りは extras 行へ。
    const slots = {
        dpad:    { up:null, down:null, left:null, right:null },
        stick:   { up:null, down:null, left:null, right:null },
        actions: { a:null,  b:null,    x:null,    y:null },
        shoulder:{ lb:null, rb:null,   lt:null,   rt:null },
        menu:    [],   // Pause/Start/Select 系
        extras:  [],   // 何処にも入らなかった分
    };
    for (const b of buttons) {
        const slot = classifyButton(b);
        if (slot.zone === "menu")    { slots.menu.push(b); continue; }
        if (slot.zone === "extras")  { slots.extras.push(b); continue; }
        const target = slots[slot.zone][slot.slot];
        if (target == null) slots[slot.zone][slot.slot] = b;
        else                slots.extras.push(b);  // 衝突したら extras 落ち
    }

    const pad = document.createElement("div");
    pad.className = "vk-pad";

    // ── shoulders 行 ──
    const shoulderRow = document.createElement("div");
    shoulderRow.className = "vk-zone vk-zone-shoulder";
    const sLeft  = document.createElement("div"); sLeft.className  = "vk-shoulder-row left";
    const sRight = document.createElement("div"); sRight.className = "vk-shoulder-row right";
    appendGamepadButton(sLeft,  slots.shoulder.lt, "LT");
    appendGamepadButton(sLeft,  slots.shoulder.lb, "LB");
    appendGamepadButton(sRight, slots.shoulder.rb, "RB");
    appendGamepadButton(sRight, slots.shoulder.rt, "RT");
    shoulderRow.appendChild(sLeft); shoulderRow.appendChild(sRight);
    if (sLeft.children.length || sRight.children.length) pad.appendChild(shoulderRow);

    // ── D-pad ──
    if (Object.values(slots.dpad).some((v) => v)) {
        pad.appendChild(makePlusZone("vk-zone-dpad", "D-PAD", slots.dpad));
    }

    // ── center menu (Pause / Start) ──
    if (slots.menu.length) {
        const menuZone = document.createElement("div");
        menuZone.className = "vk-zone vk-zone-menu";
        const lbl = document.createElement("div"); lbl.className = "vk-zone-label"; lbl.textContent = "MENU";
        menuZone.appendChild(lbl);
        for (const b of slots.menu) appendGamepadButton(menuZone, b, b.label, { kind: "menu" });
        pad.appendChild(menuZone);
    }

    // ── actions diamond (ABXY) ──
    if (Object.values(slots.actions).some((v) => v)) {
        const z = document.createElement("div");
        z.className = "vk-zone vk-zone-actions";
        const diamond = document.createElement("div");
        diamond.className = "vk-diamond";
        appendGamepadButton(diamond, slots.actions.y, "Y", { area: "y", kind: "act-y" });
        appendGamepadButton(diamond, slots.actions.x, "X", { area: "x", kind: "act-x" });
        appendGamepadButton(diamond, slots.actions.b, "B", { area: "b", kind: "act-b" });
        appendGamepadButton(diamond, slots.actions.a, "A", { area: "a", kind: "act-a" });
        z.appendChild(diamond);
        const lbl = document.createElement("div"); lbl.className = "vk-zone-label"; lbl.textContent = "ACTIONS";
        z.appendChild(lbl);
        pad.appendChild(z);
    }

    // ── L stick (WASD) ──
    if (Object.values(slots.stick).some((v) => v)) {
        pad.appendChild(makePlusZone("vk-zone-stick", "L-STICK", slots.stick));
    }

    // ── extras row (kill / 余り) ──
    if (slots.extras.length) {
        const z = document.createElement("div");
        z.className = "vk-zone vk-zone-extras";
        for (const b of slots.extras) appendGamepadButton(z, b, b.label, { kind: "extras" });
        pad.appendChild(z);
    }

    vkGrid.appendChild(pad);
}

/// 上下左右 4 方向の十字 zone (D-pad / stick) を組み立てる。
function makePlusZone(zoneClass, label, slot) {
    const z = document.createElement("div");
    z.className = "vk-zone " + zoneClass;
    const cluster = document.createElement("div");
    cluster.className = "vk-plus";
    appendGamepadButton(cluster, slot.up,    "↑", { area: "up",    kind: "dir" });
    appendGamepadButton(cluster, slot.left,  "←", { area: "left",  kind: "dir" });
    appendGamepadButton(cluster, slot.right, "→", { area: "right", kind: "dir" });
    appendGamepadButton(cluster, slot.down,  "↓", { area: "down",  kind: "dir" });
    z.appendChild(cluster);
    const lbl = document.createElement("div"); lbl.className = "vk-zone-label"; lbl.textContent = label;
    z.appendChild(lbl);
    return z;
}

/// 1 ボタンを container に追加。`b` が null なら placeholder (空マス)。
/// 通常ボタンは pointerdown→key down / pointerup→key up の press-and-hold、
/// `action` ボタン (= kill 等) は単発 click。
function appendGamepadButton(container, b, fallbackLabel, opts = {}) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "vk-btn";
    if (opts.area) el.style.gridArea = opts.area;
    if (opts.kind) el.dataset.kind = opts.kind;

    if (!b) {
        el.classList.add("placeholder");
        el.textContent = fallbackLabel;
        el.disabled = true;
        container.appendChild(el);
        return;
    }
    if (b.action) el.dataset.action = b.action;
    el.dataset.id = labelToId(b.label);
    el.textContent = b.label || fallbackLabel;
    if (b.key) {
        const k = document.createElement("span");
        k.className = "vk-keytag";
        k.textContent = b.key;
        el.appendChild(k);
    }
    if (b.action === "kill") el.classList.add("danger");

    if (b.action) {
        // 単発 action (kill 等)。
        el.addEventListener("click", () => triggerButton(b, el.dataset.id));
    } else if (b.key) {
        // press-and-hold。pointerdown/up/cancel/leave で down/up を出す。
        // wsSend が `key` を投げると ws/handler 側の sendKey → ergoCustos
        // POST /key で実アプリにキーが入る。
        const press   = (ev) => { ev.preventDefault(); sendKeyHold(b.key, true,  el); };
        const release = (ev) => { ev.preventDefault(); sendKeyHold(b.key, false, el); };
        el.addEventListener("pointerdown",   press);
        el.addEventListener("pointerup",     release);
        el.addEventListener("pointercancel", release);
        el.addEventListener("pointerleave",  release);
    }
    container.appendChild(el);
}

/// down/up の重複送信を防ぐ簡易ガード (pointerdown と touchstart 二重発火対策)。
function sendKeyHold(key, down, el) {
    const flag = `_held_${key}`;
    if (el.dataset[flag] === (down ? "1" : "")) return;
    el.dataset[flag] = down ? "1" : "";
    if (down) el.classList.add("active");
    else      el.classList.remove("active");
    if (!state.appId) return;
    wsSend({ type: "key", appId: state.appId, key, down });
}

/// `b.label` / `b.key` から表示位置 (slot) を推定。`key` を最優先で見るので
/// 「Left キー (D-pad) と Left (key=A, WASD) ラベル」を取り違えない。
function classifyButton(b) {
    if (b.action) return { zone: "extras" };
    const key = (b.key ?? "").trim();
    const lab = (b.label ?? "").trim();
    const labL = lab.toLowerCase();

    // D-pad (矢印キー実体)
    if (key === "Up")    return { zone: "dpad", slot: "up" };
    if (key === "Down")  return { zone: "dpad", slot: "down" };
    if (key === "Left")  return { zone: "dpad", slot: "left" };
    if (key === "Right") return { zone: "dpad", slot: "right" };

    // L-stick (WASD)
    if (key === "W") return { zone: "stick", slot: "up" };
    if (key === "S") return { zone: "stick", slot: "down" };
    if (key === "A") return { zone: "stick", slot: "left" };
    if (key === "D") return { zone: "stick", slot: "right" };

    // Shoulders
    if (/^lb$|^l1$/i.test(lab)) return { zone: "shoulder", slot: "lb" };
    if (/^rb$|^r1$/i.test(lab)) return { zone: "shoulder", slot: "rb" };
    if (/^lt$|^l2$/i.test(lab)) return { zone: "shoulder", slot: "lt" };
    if (/^rt$|^r2$/i.test(lab)) return { zone: "shoulder", slot: "rt" };

    // Center menu
    if (key === "Escape" || /^pause$|^menu$|^start$|^select$|^back$/i.test(lab)) {
        return { zone: "menu" };
    }

    // Action buttons (label 優先 / key=Space は A、その他はラベル名で判定)
    if (lab === "A" || /^jump$/i.test(labL) || key === "Space") return { zone: "actions", slot: "a" };
    if (lab === "B" || /^attack$/i.test(labL))                  return { zone: "actions", slot: "b" };
    if (lab === "X" || /^special$|^dodge$/i.test(labL))         return { zone: "actions", slot: "x" };
    if (lab === "Y" || /^skill$|^use$/i.test(labL))             return { zone: "actions", slot: "y" };

    return { zone: "extras" };
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
            return false;
        }
        appendLog({ kind: "meta", stream: "stdout", text: `[${kind}] accepted (${kind === "kill" ? "killed=" + json.ok : Object.keys(json).filter((k) => k !== "ok").join(", ")})\n` });
        return true;
    } catch (err) {
        appendLog({ kind: "meta", stream: "stderr", text: `[${kind}] network error: ${err.message ?? err}\n` });
        return false;
    }
}

/// BOOT: build があれば build を蹴り、build exit (success) を待ってから run。
/// build が無い app はそのまま run。WS の `exit` メッセージで継続するので
/// バックエンドへの round-trip は最小限。チェイン中に他の build/run が
/// 走り出したら自動キャンセル (state.boot.pending = false に戻す)。
async function bootApp() {
    if (!state.appId) return;
    const cfg = state.selectedConfig;
    if (!cfg) return;
    if (!cfg.hasBuild) {
        appendLog({ kind: "meta", stream: "stdout", text: "[boot] no build step — going straight to run\n" });
        await apiAction("run");
        return;
    }
    state.boot = { pending: true, appId: state.appId };
    appendLog({ kind: "meta", stream: "stdout", text: "[boot] build → run chain started\n" });
    const ok = await apiAction("build");
    if (!ok) state.boot = { pending: false, appId: null };
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
            // BOOT チェイン: build が成功したら自動で run を蹴る。
            // appId が一致するときだけ反応 (別 app に切り替えてたら捨てる)。
            if (state.boot.pending && state.boot.appId === msg.appId && msg.kind === "build") {
                if (msg.exitCode === 0) {
                    appendLog({ kind: "meta", stream: "stdout", text: "[boot] build OK → starting run\n" });
                    state.boot = { pending: false, appId: null };
                    apiAction("run").catch(() => {});
                } else {
                    appendLog({ kind: "meta", stream: "stderr", text: `[boot] aborted — build failed (exitCode=${msg.exitCode})\n` });
                    state.boot = { pending: false, appId: null };
                }
            }
            return;
        case "screenshot":
            // サーバー側 ScreenshotStreamer から N 秒ごとに飛んでくる auto-frame。
            // snapshot モードのときだけ画面に反映 (webrtc モード時は <video> を
            // 邪魔しないよう無視)。snapshot ボタンの blob URL とは独立して
            // data: URL を当てるので、Snapshot 押下とも干渉しない。
            if (captureMode.value !== "snapshot") return;
            if (msg.appId !== state.appId) return;
            streamImage.src = `data:${msg.mime};base64,${msg.png_b64}`;
            streamImage.classList.add("active");
            streamVideo.classList.remove("active");
            streamPlaceholder.style.display = "none";
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
    // 改行で終わっていなければ追加 (api ログを 1 行 1 行きれいに揃えるため)
    const text = msg.text.endsWith("\n") ? msg.text : msg.text + "\n";
    span.textContent = text;
    target.appendChild(span);
    target.scrollTop = target.scrollHeight;
}

boot();
