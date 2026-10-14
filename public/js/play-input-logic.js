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

/** タッチを長押しとみなして右クリックにするまでの時間 (ms)。 */
export const LONG_PRESS_MS = 500;
/** タッチがこれ以上動いたらドラッグとみなす (px)。指の揺れでタップが崩れないための遊び。 */
export const DRAG_THRESHOLD_PX = 8;

/** タッチジェスチャの初期状態。 */
export const TOUCH_IDLE = Object.freeze({ phase: "idle" });

/**
 * 1 本指のタッチを、マウスのボタン操作に変換する状態遷移 (スマホ操作の前提)。
 *
 * - タップ (動かさずに離す)       → 左クリック (down → up)
 * - ドラッグ (しきい値以上動かす) → 左ボタンを押したまま移動
 * - 長押し (動かさずに LONG_PRESS_MS) → 右クリック
 *
 * 押した瞬間には何も送らない。タップか長押しかドラッグかは、動いたか・時間が来たか・
 * 離したかで初めて決まるため。
 *
 * @param {{phase:string, startX?:number, startY?:number, startPos?:{x:number,y:number}, lastPos?:{x:number,y:number}}} state
 * @param {{type:"down"|"move"|"up"|"timer", clientX?:number, clientY?:number, pos?:{x:number,y:number}|null}} event
 *   pos は映像上の 0..1 座標 (映像外なら null)
 * @returns {{state:object, actions:Array<{button:"left"|"right", phase:"down"|"up"|"move", pos:{x:number,y:number}}>}}
 */
export function touchGestureStep(state, event, dragThresholdPx = DRAG_THRESHOLD_PX) {
    switch (event.type) {
        case "down": {
            if (!event.pos) return { state: TOUCH_IDLE, actions: [] };
            return {
                state: { phase: "pending", startX: event.clientX, startY: event.clientY, startPos: event.pos, lastPos: event.pos },
                actions: [],
            };
        }
        case "move": {
            if (state.phase === "pending") {
                const moved = Math.hypot(event.clientX - state.startX, event.clientY - state.startY);
                if (moved < dragThresholdPx) return { state, actions: [] };
                const pos = event.pos ?? state.lastPos;
                return {
                    state: { ...state, phase: "dragging", lastPos: pos },
                    actions: [
                        { button: "left", phase: "down", pos: state.startPos },
                        { button: "left", phase: "move", pos },
                    ],
                };
            }
            if (state.phase === "dragging") {
                const pos = event.pos ?? state.lastPos;
                return { state: { ...state, lastPos: pos }, actions: [{ button: "left", phase: "move", pos }] };
            }
            return { state, actions: [] };
        }
        case "timer": {
            if (state.phase !== "pending") return { state, actions: [] };
            return {
                state: { ...state, phase: "held" },
                actions: [
                    { button: "right", phase: "down", pos: state.startPos },
                    { button: "right", phase: "up", pos: state.startPos },
                ],
            };
        }
        case "up": {
            if (state.phase === "pending") {
                return {
                    state: TOUCH_IDLE,
                    actions: [
                        { button: "left", phase: "down", pos: state.startPos },
                        { button: "left", phase: "up", pos: state.startPos },
                    ],
                };
            }
            if (state.phase === "dragging") {
                return { state: TOUCH_IDLE, actions: [{ button: "left", phase: "up", pos: event.pos ?? state.lastPos }] };
            }
            return { state: TOUCH_IDLE, actions: [] };
        }
        default:
            return { state, actions: [] };
    }
}
