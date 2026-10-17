/**
 * Custos frontend — vanilla ES module の入口。各部品を組み立てて配線する。
 *
 * - app の選択と BOOT / Run / Test / Kill (REST)
 * - WS の受信を各部品へ振り分ける
 * - VIEW (映像・Unity パネル・タップ操作) / PAD / LOG / TEST / SETTINGS はウインドウ
 *   (PC はフローティング、スマホは縦 3 段 + シート)
 * - 操作権: 他のユーザがプレイ中なら観戦モード (入力・Unity 操作を止める)
 */

import { apiFetch, setApiLogger, setClientId } from "/js/api.js";
import { createLogView } from "/js/log-view.js";
import { createLayoutMode } from "/js/layout-mode.js";
import { createWindowManager } from "/js/window-manager.js";
import { createStreamView } from "/js/stream-view.js";
import { createControlState } from "/js/control-state.js";
import { createVirtualPad } from "/js/virtual-pad.js";
import { createPlayInput } from "/js/play-input.js";
import { createUnityPanel } from "/js/unity-panel.js";
import { createSettingsPanel } from "/js/settings-panel.js";
import { createWsClient } from "/js/ws-client.js";
import { createStatusMenu } from "/js/status-menu.js";
import { installTouchGuard } from "/js/touch-guard.js";
import { createAudiencePanel } from "/js/audience-panel.js";

const $ = (id) => document.getElementById(id);
const appSelect = $("appSelect");
const btnBuild = $("btnBuild");
const btnRun = $("btnRun");
const btnTest = $("btnTest");
const btnKill = $("btnKill");
const statusPill = $("statusPill");

const state = {
    apps: [],
    appId: null,
    config: null,
    lifecycle: null,
    unityPlaying: null,   // Unity ブリッジの app で Play 中か (null = まだ分からない)
    boot: { pending: false, appId: null },   // BOOT (build → run) チェイン状態
};

// ─── 部品 ───────────────────────────────────────
installTouchGuard();
const logView = createLogView({ logEl: $("logStream"), testEl: $("testStream") });
setApiLogger(logView.append);
const log = (text, isError = false) => logView.meta(`${text}\n`, isError);

const statusMenu = createStatusMenu({
    pill: $("statusPill"),
    menu: $("statusMenu"),
    closeButton: $("statusMenuClose"),
    actionsSlot: $("statusMenuActions"),
    unitySlot: $("statusMenuUnity"),
    headerActions: $("headerActions"),
    unityStrip: $("unityStrip"),
});

let windowManager = null;
const layoutMode = createLayoutMode({
    onChange: (mobile) => {
        statusMenu.setMobile(mobile);
        windowManager?.render();
    },
});
windowManager = createWindowManager({
    desk: $("desk"),
    isMobile: () => layoutMode.isMobile(),
    onVisibilityChange: () => {
        if (windowManager?.isOpen("settings")) settingsPanel.load();
    },
});

const ws = createWsClient({
    statusEl: $("wsStatus"),
    onOpen: () => {
        audiencePanel.setConnected(true);
        if (state.appId) ws.send({ type: "subscribe", appId: state.appId });
    },
    onMessage: handleServerMessage,
    onClose: () => audiencePanel.setConnected(false),
});

const stream = createStreamView({
    elements: {
        video: $("streamVideo"),
        image: $("streamImage"),
        placeholder: $("streamPlaceholder"),
        placeholderTitle: $("streamPlaceholderTitle"),
        placeholderHint: $("streamPlaceholderHint"),
        status: $("rtcStatus"),
        audioToggle: $("btnAudio"),
    },
    apiFetch,
    log,
});

const audiencePanel = createAudiencePanel({
    send: (msg) => ws.send(msg),
    getAppId: () => state.appId,
});

const control = createControlState({
    badge: $("roleBadge"),
    banner: $("spectatorBanner"),
    onChange: (role) => {
        audiencePanel.setRole(role);
        const operable = control.canOperate();
        if (!operable) pad.releaseAll();
        playInput.onRoleChanged();
        unityPanel.setOperable(operable);
    },
});

const sendKey = (key, down) => {
    if (state.appId) ws.send({ type: "key", appId: state.appId, key, down });
};

const pad = createVirtualPad({
    root: $("padRoot"),
    sendKey,
    onAction: (action) => {
        if (action === "kill") apiAction("kill");
        if (action === "screenshot") {
            stream.snapshot().catch((err) => log(`[snapshot] error: ${err.message ?? err}`, true));
        }
    },
    canOperate: () => control.canOperate(),
});

const playInput = createPlayInput({
    frame: $("streamFrame"),
    hint: $("playHint"),
    getMedia: () => stream.getMedia(),
    getAppId: () => state.appId,
    getConfig: () => state.config,
    canOperate: () => control.canOperate(),
    isGameStopped: () => isGameStopped(),
    send: (msg) => ws.send(msg),
});

const unityPanel = createUnityPanel({
    apiFetch,
    getAppId: () => state.appId,
    onPlayingChange: (playing) => {
        state.unityPlaying = playing;
        updateGameRunning();
    },
});
const settingsPanel = createSettingsPanel({ apiFetch });

// ─── 起動 ───────────────────────────────────────
async function boot() {
    windowManager.render();
    appSelect.addEventListener("change", onAppChange);
    btnBuild.addEventListener("click", () => bootApp());
    btnRun.addEventListener("click", () => apiAction("run"));
    btnTest.addEventListener("click", () => apiAction("test"));
    btnKill.addEventListener("click", () => apiAction("kill"));
    $("btnSnapshot").addEventListener("click", () => {
        stream.snapshot().catch((err) => log(`[snapshot] error: ${err.message ?? err}`, true));
    });
    $("btnResetLayout").addEventListener("click", () => windowManager.resetLayout());
    for (const button of document.querySelectorAll("[data-clear-log]")) {
        button.addEventListener("click", () => logView.clear($(button.dataset.clearLog)));
    }
    // Unity パネルは VIEW の一部なので常に有効 (ブリッジの無い app では何もしない)。
    unityPanel.setActive(true);
    await loadApps();
}

async function loadApps() {
    appSelect.replaceChildren(option("", "— 起動対象を読み込み中… —"));
    try {
        const res = await apiFetch("/apps");
        if (!res.ok) {
            log(`[custos] /api/apps HTTP ${res.status} — サーバー (${location.origin}) との通信に失敗。CUSTOS_OPEN=1 で立ち上げているか確認してください。`, true);
            appSelect.replaceChildren(option("", "— 取得失敗 —"));
            return;
        }
        state.apps = (await res.json()).apps ?? [];
        appSelect.replaceChildren(option("", "— 起動対象を選択 —"));
        for (const a of state.apps) appSelect.appendChild(option(a.config.id, `${a.config.name} (${a.config.target})`));
        if (state.apps.length === 0) log("[custos] apps.json にアプリが 0 件です。CUSTOS_APPS_FILE / cwd を確認してください。", true);
        else log(`[custos] ${state.apps.length} apps loaded`);
    } catch (err) {
        log(`[custos] /api/apps fetch error: ${err.message ?? err}`, true);
        appSelect.replaceChildren(option("", "— 取得失敗 —"));
    }
}

function option(value, label) {
    const el = document.createElement("option");
    el.value = value;
    el.textContent = label;
    return el;
}

async function onAppChange() {
    const id = appSelect.value || null;
    // 別 app に切り替えたら未完了の BOOT チェインは捨てる (前の app の build 完了で
    // 別 app の run が走ると混乱する)。
    if (state.boot.pending && state.boot.appId !== id) state.boot = { pending: false, appId: null };
    playInput.onAppChanged();
    if (state.appId) ws.send({ type: "unsubscribe", appId: state.appId });

    state.appId = id;
    state.config = state.apps.find((a) => a.config.id === id)?.config ?? null;
    state.lifecycle = null;
    state.unityPlaying = null;
    control.setApp(id);
    audiencePanel.onAppChanged();
    audiencePanel.setRole(control.role());
    unityPanel.setApp(state.config);
    pad.setApp(state.config);
    playInput.onAppChanged();
    updateActionButtons();
    applyStatus(state.apps.find((a) => a.config.id === id)?.status ?? null);

    if (id) ws.send({ type: "subscribe", appId: id });
    await stream.setApp(state.config);
}

function applyStatus(status) {
    if (!status) {
        statusPill.dataset.state = "idle";
        statusPill.textContent = "idle";
        return;
    }
    statusPill.dataset.state = status.lifecycle;
    statusPill.textContent = status.lifecycle + (status.pid ? ` · pid ${status.pid}` : "");
    // app が起動し直したら、切れていた映像を待たずにつなぎ直す。
    if (status.lifecycle === "running" && state.lifecycle !== "running") stream.retryNow();
    state.lifecycle = status.lifecycle;
    updateActionButtons();
    updateGameRunning();
}

/**
 * ゲームが動いているか (スマホの操作メニューの開閉に使う)。Unity ブリッジの app は Play 中か、
 * それ以外は run が動いているか。
 */
function updateGameRunning() {
    const running = state.config?.hasUnityBridge ? state.unityPlaying === true : state.lifecycle === "running";
    statusMenu.setGameRunning(running);
    playInput.onGameStateChanged();
}

/**
 * ゲームが止まっていると分かっているか (PAD の見出しに出す)。状態がまだ届いていない (null) 間は止まっているとしない。
 * Unity ブリッジの app は Play していない、それ以外は run が動いていない。
 */
function isGameStopped() {
    if (state.config?.hasUnityBridge) return state.unityPlaying === false;
    return state.lifecycle !== null && state.lifecycle !== "running";
}

function updateActionButtons() {
    const cfg = state.config;
    const has = Boolean(cfg);
    // BOOT は build が無い app でも押せる (その場合は run に直行)。
    btnBuild.disabled = !has;
    btnRun.disabled = !has;
    btnTest.disabled = !(has && cfg.hasTest);
    btnKill.disabled = !has;
}

async function apiAction(kind) {
    if (!state.appId) return false;
    try {
        const res = await apiFetch(`/apps/${encodeURIComponent(state.appId)}/${kind}`, { method: "POST" });
        const json = await res.json();
        if (!res.ok || json.ok === false) {
            log(`[${kind}] failed: ${json.error ?? res.status}`, true);
            return false;
        }
        const detail = kind === "kill" ? `killed=${json.ok}` : Object.keys(json).filter((k) => k !== "ok").join(", ");
        log(`[${kind}] accepted (${detail})`);
        return true;
    } catch (err) {
        log(`[${kind}] network error: ${err.message ?? err}`, true);
        return false;
    }
}

/**
 * BOOT: build があれば build を蹴り、WS の build exit (成功) を待ってから run。
 * build が無い app はそのまま run。
 */
async function bootApp() {
    const cfg = state.config;
    if (!state.appId || !cfg) return;
    if (!cfg.hasBuild) {
        log("[boot] no build step — going straight to run");
        await apiAction("run");
        return;
    }
    state.boot = { pending: true, appId: state.appId };
    log("[boot] build → run chain started");
    const ok = await apiAction("build");
    if (!ok) state.boot = { pending: false, appId: null };
}

// ─── WS 受信 ────────────────────────────────────
function handleServerMessage(msg) {
    switch (msg.type) {
        case "welcome":
            setClientId(msg.clientId);
            return;
        case "control":
            control.handleMessage(msg);
            return;
        case "hello":
        case "status":
            if (msg.appId === state.appId) applyStatus(msg.status);
            return;
        case "log":
            logView.append(msg);
            return;
        case "exit":
            logView.append({ kind: msg.kind, stream: "stdout", text: `[exit] ${msg.kind} exitCode=${msg.exitCode} signal=${msg.signal ?? "-"}\n` });
            continueBootChain(msg);
            return;
        case "screenshot":
            stream.showFrame(msg);
            return;
        case "audience-event":
        case "audience-history": audiencePanel.receive(msg); return;
        case "error":
            log(`[ws-error] ${msg.message}`, true);
            return;
    }
}

/** BOOT チェイン: build が成功したら run を蹴る。別 app に切り替えていたら捨てる。 */
function continueBootChain(msg) {
    if (!state.boot.pending || state.boot.appId !== msg.appId || msg.kind !== "build") return;
    state.boot = { pending: false, appId: null };
    if (msg.exitCode === 0) {
        log("[boot] build OK → starting run");
        apiAction("run");
    } else {
        log(`[boot] aborted — build failed (exitCode=${msg.exitCode})`, true);
    }
}

boot();
