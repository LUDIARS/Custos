/**
 * 遠隔プレイ: 配信映像の上のポインタと、映像にフォーカスがある間の物理キーボードを
 * WS (`pointer` / `key`) に流す (spec/feature/remote-play-and-play-log.md §1.3)。
 */

import {
    codeToKeyName,
    normalizePointer,
    pointerButtonName,
    shouldSendMove,
} from "/js/play-input-logic.js";

const MOVE_INTERVAL_MS = 33;   // 約 30Hz

/**
 * @param {{
 *   frame: HTMLElement,
 *   toggle: HTMLInputElement,
 *   hint: HTMLElement,
 *   getMedia: () => (HTMLVideoElement | HTMLImageElement | null),
 *   getAppId: () => (string | null),
 *   getConfig: () => (object | null),
 *   send: (msg: object) => void,
 * }} deps
 */
export function createPlayInput({ frame, toggle, hint, getMedia, getAppId, getConfig, send }) {
    let enabled = false;
    let lastMoveAt = 0;
    let heldButton = null;
    let lastPos = { x: 0, y: 0 };
    const heldKeys = new Set();

    frame.tabIndex = 0;

    toggle.addEventListener("change", () => setEnabled(toggle.checked));
    frame.addEventListener("pointerdown", onPointerDown);
    frame.addEventListener("pointermove", onPointerMove);
    frame.addEventListener("pointerup", onPointerUp);
    frame.addEventListener("pointercancel", onPointerUp);
    frame.addEventListener("contextmenu", (ev) => { if (enabled) ev.preventDefault(); });
    frame.addEventListener("keydown", (ev) => onKey(ev, true));
    frame.addEventListener("keyup", (ev) => onKey(ev, false));
    frame.addEventListener("blur", releaseAll);

    function allow() {
        const input = getConfig()?.input ?? {};
        return { mouse: input.allowMouse === true, keyboard: input.allowKeyboard !== false };
    }

    function setEnabled(on) {
        if (!on) releaseAll();
        enabled = on;
        frame.classList.toggle("play-active", on);
        refreshHint();
        if (on) frame.focus();
    }

    function refreshHint() {
        if (!enabled) { hint.textContent = ""; return; }
        const a = allow();
        const parts = [];
        parts.push(a.mouse ? "マウス操作: 有効" : "マウス操作: この app は無効 (input.allowMouse)");
        parts.push(a.keyboard ? "キーボード: 映像をクリックしてから入力" : "キーボード: この app は無効");
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
        if (!enabled) return;
        frame.focus();
        if (!allow().mouse) return;
        const pos = pointerPayload(ev);
        if (!pos) return;
        ev.preventDefault();
        frame.setPointerCapture?.(ev.pointerId);
        heldButton = pointerButtonName(ev.button);
        lastPos = pos;
        sendPointer(pos, heldButton, "down");
    }

    function onPointerMove(ev) {
        if (!enabled || !allow().mouse) return;
        const now = performance.now();
        if (!shouldSendMove(lastMoveAt, now, MOVE_INTERVAL_MS)) return;
        const pos = pointerPayload(ev);
        if (!pos) return;
        lastMoveAt = now;
        lastPos = pos;
        sendPointer(pos, heldButton ?? "left", "move");
    }

    function onPointerUp(ev) {
        if (!enabled || heldButton === null) return;
        // 映像の外で離したら最後に映像上で見えた位置で離す。
        const pos = pointerPayload(ev) ?? lastPos;
        sendPointer(pos, heldButton, "up");
        heldButton = null;
    }

    function onKey(ev, down) {
        if (!enabled || !allow().keyboard) return;
        const key = codeToKeyName(ev.code);
        if (!key) return;
        ev.preventDefault();
        if (down && ev.repeat) return;
        if (down) heldKeys.add(key); else heldKeys.delete(key);
        const appId = getAppId();
        if (appId) send({ type: "key", appId, key, down });
    }

    /** フォーカスを失ったら押しっぱなしを残さない。 */
    function releaseAll() {
        const appId = getAppId();
        if (appId) {
            for (const key of heldKeys) send({ type: "key", appId, key, down: false });
            if (heldButton !== null) send({ type: "pointer", appId, x: lastPos.x, y: lastPos.y, button: heldButton, phase: "up" });
        }
        heldKeys.clear();
        heldButton = null;
    }

    return {
        /** app が切り替わったら押下を離して表示を更新する。 */
        onAppChanged() {
            releaseAll();
            refreshHint();
        },
    };
}
