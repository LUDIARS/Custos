/**
 * 遠隔プレイ: 配信映像の上のポインタ / タッチと、映像にフォーカスがある間の物理キーボードを
 * WS (`pointer` / `key`) に流す (spec/feature/remote-play-and-play-log.md §1.3)。
 *
 * - マウス: そのままボタンの押下 / 移動 / 解放を送る
 * - タッチ: タップ=左クリック、ドラッグ=左ボタンを押したまま移動、長押し=右クリック
 *   (判定は play-input-logic.js の touchGestureStep)
 *
 * 遠隔プレイは常に有効で、送るかどうかは自動で決める (app を選んでいて、操作権を持てるときだけ送る)。
 * 観戦中 (他の接続がプレイ中) は何も送らない。操作の説明はパッドの見出しに出す。
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

/**
 * @param {{
 *   frame: HTMLElement,
 *   hint: HTMLElement,
 *   getMedia: () => (HTMLVideoElement | HTMLImageElement | null),
 *   getAppId: () => (string | null),
 *   getConfig: () => (object | null),
 *   canOperate: () => boolean,
 *   send: (msg: object) => void,
 * }} deps
 */
export function createPlayInput({ frame, hint, getMedia, getAppId, getConfig, canOperate, send }) {
    let lastMoveAt = 0;
    let heldButton = null;
    let lastPos = { x: 0, y: 0 };
    const heldKeys = new Set();
    let touch = TOUCH_IDLE;
    let touchPointerId = null;
    let longPressTimer = null;

    frame.tabIndex = 0;

    frame.addEventListener("pointerdown", onPointerDown);
    frame.addEventListener("pointermove", onPointerMove);
    frame.addEventListener("pointerup", onPointerUp);
    frame.addEventListener("pointercancel", onPointerUp);
    frame.addEventListener("contextmenu", (ev) => ev.preventDefault());
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
        return canOperate() && getAppId() !== null;
    }

    function refresh() {
        frame.classList.toggle("play-active", active());
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
