/**
 * 遠隔プレイ: 配信映像の上のポインタ / タッチと、映像にフォーカスがある間の物理キーボードを
 * WS (`pointer` / `key`) に流す (spec/feature/remote-play-and-play-log.md §1.3)。
 *
 * - マウス: そのままボタンの押下 / 移動 / 解放を送る
 * - タッチ: タップ=左クリック、ドラッグ=左ボタンを押したまま移動、長押し=右クリック
 *   (判定は play-input-logic.js の touchGestureStep)
 *
 * 「遠隔プレイ」トグルは既定 ON。OFF にすると入力を止め、持っている操作権を手放す。
 * 観戦中 (他の接続がプレイ中) は何も送らない。
 */

import {
    LONG_PRESS_MS,
    TOUCH_IDLE,
    codeToKeyName,
    normalizePointer,
    pointerButtonName,
    shouldSendMove,
    touchGestureStep,
} from "/js/play-input-logic.js";

const MOVE_INTERVAL_MS = 33;   // 約 30Hz
const ENABLED_KEY = "custos.remotePlay";

/**
 * @param {{
 *   frame: HTMLElement,
 *   toggle: HTMLInputElement,
 *   hint: HTMLElement,
 *   getMedia: () => (HTMLVideoElement | HTMLImageElement | null),
 *   getAppId: () => (string | null),
 *   getConfig: () => (object | null),
 *   canOperate: () => boolean,
 *   send: (msg: object) => void,
 * }} deps
 */
export function createPlayInput({ frame, toggle, hint, getMedia, getAppId, getConfig, canOperate, send }) {
    let enabled = readEnabled();
    let lastMoveAt = 0;
    let heldButton = null;
    let lastPos = { x: 0, y: 0 };
    const heldKeys = new Set();
    let touch = TOUCH_IDLE;
    let touchPointerId = null;
    let longPressTimer = null;

    frame.tabIndex = 0;
    toggle.checked = enabled;

    toggle.addEventListener("change", () => setEnabled(toggle.checked));
    frame.addEventListener("pointerdown", onPointerDown);
    frame.addEventListener("pointermove", onPointerMove);
    frame.addEventListener("pointerup", onPointerUp);
    frame.addEventListener("pointercancel", onPointerUp);
    frame.addEventListener("contextmenu", (ev) => { if (enabled) ev.preventDefault(); });
    frame.addEventListener("keydown", (ev) => onKey(ev, true));
    frame.addEventListener("keyup", (ev) => onKey(ev, false));
    frame.addEventListener("blur", releaseAll);
    refresh();

    function allow() {
        const input = getConfig()?.input ?? {};
        // スマホのタップ操作を前提にするので、マウスは明示的に false の app だけ止める。
        return { mouse: input.allowMouse !== false, keyboard: input.allowKeyboard !== false };
    }

    function active() {
        return enabled && canOperate() && getAppId() !== null;
    }

    function setEnabled(on) {
        if (!on) {
            releaseAll();
            const appId = getAppId();
            // 遠隔プレイをやめたら操作権を手放し、観戦していた人が操作できるようにする。
            if (appId) send({ type: "control", appId, want: false });
        }
        enabled = on;
        writeEnabled(on);
        refresh();
        if (on) frame.focus();
    }

    function refresh() {
        frame.classList.toggle("play-active", active());
        if (!enabled) { hint.textContent = "遠隔プレイ OFF — 映像を見るだけ"; return; }
        if (!canOperate()) { hint.textContent = "観戦中 — 他のユーザがプレイしています"; return; }
        const a = allow();
        const parts = [];
        parts.push(a.mouse ? "タップ / クリックで操作 (長押し=右クリック)" : "マウス操作: この app は無効 (input.allowMouse)");
        parts.push(a.keyboard ? "キーボード: 映像を押してから入力" : "キーボード: この app は無効");
        if (getConfig()?.playLog?.enabled) parts.push("● 操作を記録中");
        hint.textContent = parts.join(" / ");
    }

    function pointerPayload(ev) {
        const media = getMedia();
        if (!media) return null;
        const mediaW = media.videoWidth ?? media.naturalWidth ?? 0;
        const mediaH = media.videoHeight ?? media.naturalHeight ?? 0;
        return normalizePointer(ev.clientX, ev.clientY, media.getBoundingClientRect(), mediaW, mediaH);
    }

    function sendPointer(pos, button, phase) {
        const appId = getAppId();
        if (!appId) return;
        send({ type: "pointer", appId, x: pos.x, y: pos.y, button, phase });
    }

    function onPointerDown(ev) {
        if (!active()) return;
        frame.focus();
        if (!allow().mouse) return;
        const pos = pointerPayload(ev);
        if (!pos) return;
        ev.preventDefault();
        frame.setPointerCapture?.(ev.pointerId);
        if (ev.pointerType === "touch") {
            if (touchPointerId !== null) return;   // 2 本目の指は無視 (1 本指の操作だけ)
            touchPointerId = ev.pointerId;
            stepTouch({ type: "down", clientX: ev.clientX, clientY: ev.clientY, pos });
            longPressTimer = window.setTimeout(() => {
                longPressTimer = null;
                stepTouch({ type: "timer" });
            }, LONG_PRESS_MS);
            return;
        }
        heldButton = pointerButtonName(ev.button);
        lastPos = pos;
        sendPointer(pos, heldButton, "down");
    }

    function onPointerMove(ev) {
        if (!active() || !allow().mouse) return;
        if (ev.pointerType === "touch") {
            if (ev.pointerId !== touchPointerId) return;
            stepTouch({ type: "move", clientX: ev.clientX, clientY: ev.clientY, pos: pointerPayload(ev) });
            return;
        }
        const now = performance.now();
        if (!shouldSendMove(lastMoveAt, now, MOVE_INTERVAL_MS)) return;
        const pos = pointerPayload(ev);
        if (!pos) return;
        lastMoveAt = now;
        lastPos = pos;
        sendPointer(pos, heldButton ?? "left", "move");
    }

    function onPointerUp(ev) {
        if (ev.pointerType === "touch") {
            if (ev.pointerId !== touchPointerId) return;
            touchPointerId = null;
            clearLongPress();
            stepTouch({ type: "up", pos: pointerPayload(ev) });
            return;
        }
        if (heldButton === null) return;
        // 映像の外で離したら最後に映像上で見えた位置で離す。
        const pos = pointerPayload(ev) ?? lastPos;
        sendPointer(pos, heldButton, "up");
        heldButton = null;
    }

    /** タッチの状態を進め、決まったボタン操作を送る。移動は 30Hz に間引く (押下・解放は必ず送る)。 */
    function stepTouch(event) {
        const { state, actions } = touchGestureStep(touch, event);
        touch = state;
        for (const action of actions) {
            if (action.phase === "move") {
                const now = performance.now();
                if (!shouldSendMove(lastMoveAt, now, MOVE_INTERVAL_MS)) continue;
                lastMoveAt = now;
            }
            lastPos = action.pos;
            heldButton = action.phase === "up" ? null : action.button;
            sendPointer(action.pos, action.button, action.phase);
        }
    }

    function clearLongPress() {
        if (longPressTimer !== null) window.clearTimeout(longPressTimer);
        longPressTimer = null;
    }

    function onKey(ev, down) {
        if (!active() || !allow().keyboard) return;
        const key = codeToKeyName(ev.code);
        if (!key) return;
        ev.preventDefault();
        if (down && ev.repeat) return;
        if (down) heldKeys.add(key); else heldKeys.delete(key);
        const appId = getAppId();
        if (appId) send({ type: "key", appId, key, down });
    }

    /** フォーカスを失った・観戦になった・app が変わったときに押しっぱなしを残さない。 */
    function releaseAll() {
        const appId = getAppId();
        if (appId && canOperate()) {
            for (const key of heldKeys) send({ type: "key", appId, key, down: false });
            if (heldButton !== null) send({ type: "pointer", appId, x: lastPos.x, y: lastPos.y, button: heldButton, phase: "up" });
        }
        heldKeys.clear();
        heldButton = null;
        clearLongPress();
        touch = TOUCH_IDLE;
        touchPointerId = null;
    }

    return {
        /** app が切り替わったら押下を離して表示を更新する。 */
        onAppChanged() {
            releaseAll();
            refresh();
        },
        /** 操作権が変わったら表示を更新する。観戦になったら押下を捨てる (送っても無視される)。 */
        onRoleChanged() {
            if (!canOperate()) releaseAll();
            refresh();
        },
    };
}

function readEnabled() {
    try {
        return localStorage.getItem(ENABLED_KEY) !== "off";
    } catch {
        return true;   // ストレージが使えなければ既定の ON
    }
}

function writeEnabled(on) {
    try {
        localStorage.setItem(ENABLED_KEY, on ? "on" : "off");
    } catch {
        /* 保存できなくても今のページでは効く。次回は既定の ON に戻るだけ */
    }
}
