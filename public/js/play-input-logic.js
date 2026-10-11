/**
 * 遠隔プレイ入力の純関数 (DOM に触らない。vitest 対象)。
 *
 * - 配信映像上のポインタ位置 → 映像の左上原点 0..1 (object-fit: contain のレターボックスを除く)
 * - KeyboardEvent.code → Custos のキー名 (`src/capture/ergo-custos-client.ts` の KEY_TABLE 名)
 * - PointerEvent.button → "left" | "middle" | "right"
 */

/**
 * @param {number} clientX
 * @param {number} clientY
 * @param {{left:number, top:number, width:number, height:number}} rect 要素の表示矩形
 * @param {number} mediaW 映像の本来の幅 (videoWidth / naturalWidth)。0 なら rect をそのまま使う
 * @param {number} mediaH
 * @returns {{x:number, y:number} | null} 映像外 (レターボックス上) なら null
 */
export function normalizePointer(clientX, clientY, rect, mediaW, mediaH) {
    if (!(rect.width > 0) || !(rect.height > 0)) return null;
    let contentW = rect.width;
    let contentH = rect.height;
    if (mediaW > 0 && mediaH > 0) {
        const scale = Math.min(rect.width / mediaW, rect.height / mediaH);
        contentW = mediaW * scale;
        contentH = mediaH * scale;
    }
    const offsetX = (rect.width  - contentW) / 2;
    const offsetY = (rect.height - contentH) / 2;
    const x = (clientX - rect.left - offsetX) / contentW;
    const y = (clientY - rect.top  - offsetY) / contentH;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x, y };
}

const CODE_TO_KEY = (() => {
    /** @type {Record<string, string>} */
    const m = {};
    for (let i = 0; i < 26; i++) {
        const ch = String.fromCharCode(65 + i);
        m[`Key${ch}`] = ch;
    }
    for (let i = 0; i <= 9; i++) {
        m[`Digit${i}`]  = String(i);
        m[`Numpad${i}`] = `Num${i}`;
    }
    for (let i = 1; i <= 12; i++) m[`F${i}`] = `F${i}`;
    Object.assign(m, {
        Enter: "Enter", NumpadEnter: "Enter", Escape: "Escape", Backspace: "Backspace",
        Tab: "Tab", Space: "Space",
        ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
        ControlLeft: "LCtrl", ShiftLeft: "LShift", AltLeft: "LAlt", MetaLeft: "LSuper",
        ControlRight: "Ctrl", ShiftRight: "Shift", AltRight: "Alt",
    });
    return m;
})();

/** @returns {string | null} 対応しないキーは null (送らない) */
export function codeToKeyName(code) {
    return CODE_TO_KEY[code] ?? null;
}

/** @returns {"left" | "middle" | "right"} */
export function pointerButtonName(button) {
    if (button === 1) return "middle";
    if (button === 2) return "right";
    return "left";
}

/** 直前の送信から minIntervalMs 経っていれば true。 */
export function shouldSendMove(lastSentAt, now, minIntervalMs) {
    return now - lastSentAt >= minIntervalMs;
}
