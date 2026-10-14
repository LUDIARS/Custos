/**
 * フローティングウインドウの配置計算 (DOM に触らない純関数。vitest 対象)。
 *
 * - 既定配置: 画面幅に対する割合で VIEW を大きく、周りに LOG / PAD などを置く
 * - 画面内への収め込み: タイトルバーが画面外に出て掴めなくならないようにする
 * - 保存形式の検証: localStorage の中身は壊れていることがある前提で読む
 */

/** ウインドウの最小サイズ (px)。これより小さくするとタイトルバーのボタンが押せない。 */
export const MIN_WINDOW_SIZE = { w: 220, h: 140 };

/** 画面外に出してよいのは、タイトルバーがこれだけ見えている範囲まで (px)。 */
const VISIBLE_GRIP = 48;

/** 既定で開いておくウインドウ。他は閉じた状態で始まる。 */
const OPEN_BY_DEFAULT = new Set(["view", "pad", "logs"]);

/**
 * 画面サイズから既定の配置を作る。割合で決めるので、どの画面幅でも重なりが少ない。
 * @param {string[]} ids ウインドウ ID
 * @param {{w:number, h:number}} viewport
 * @returns {Record<string, {x:number, y:number, w:number, h:number, hidden:boolean, minimized:boolean, z:number}>}
 */
export function defaultLayout(ids, viewport) {
    const gap = 12;
    const mainW = Math.round(viewport.w * 0.62);
    const sideX = mainW + gap * 2;
    const sideW = Math.max(MIN_WINDOW_SIZE.w, viewport.w - sideX - gap);
    const halfH = Math.round((viewport.h - gap * 3) / 2);
    const presets = {
        view:     { x: gap,   y: gap,             w: mainW, h: viewport.h - gap * 2 },
        pad:      { x: sideX, y: gap,             w: sideW, h: halfH },
        logs:     { x: sideX, y: gap * 2 + halfH, w: sideW, h: halfH },
        tests:    { x: sideX, y: gap * 2 + halfH, w: sideW, h: halfH },
        settings: { x: sideX, y: gap,             w: sideW, h: halfH },
    };
    /** @type {Record<string, {x:number, y:number, w:number, h:number, hidden:boolean, minimized:boolean, z:number}>} */
    const layout = {};
    ids.forEach((id, index) => {
        const preset = presets[id] ?? { x: gap * (index + 1), y: gap * (index + 1), w: 420, h: 320 };
        layout[id] = {
            ...clampRect(preset, viewport),
            hidden: !OPEN_BY_DEFAULT.has(id),
            minimized: false,
            z: index + 1,
        };
    });
    return layout;
}

/**
 * 矩形を画面に収める。大きさは最小サイズ以上・画面以下、位置はタイトルバーが掴める範囲。
 * @param {{x:number, y:number, w:number, h:number}} rect
 * @param {{w:number, h:number}} viewport
 */
export function clampRect(rect, viewport) {
    const w = clamp(rect.w, MIN_WINDOW_SIZE.w, Math.max(MIN_WINDOW_SIZE.w, viewport.w));
    const h = clamp(rect.h, MIN_WINDOW_SIZE.h, Math.max(MIN_WINDOW_SIZE.h, viewport.h));
    const x = clamp(rect.x, VISIBLE_GRIP - w, viewport.w - VISIBLE_GRIP);
    const y = clamp(rect.y, 0, Math.max(0, viewport.h - VISIBLE_GRIP));
    return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

/**
 * 保存された配置を既定配置に重ねて読む。壊れた値・知らないウインドウは捨てる。
 * @param {unknown} stored JSON.parse 済みの値
 * @param {ReturnType<typeof defaultLayout>} fallback
 * @param {{w:number, h:number}} viewport
 */
export function restoreLayout(stored, fallback, viewport) {
    if (!stored || typeof stored !== "object") return fallback;
    /** @type {ReturnType<typeof defaultLayout>} */
    const layout = {};
    for (const [id, base] of Object.entries(fallback)) {
        const entry = /** @type {Record<string, unknown>} */ (stored)[id];
        if (!isStoredEntry(entry)) {
            layout[id] = base;
            continue;
        }
        layout[id] = {
            ...clampRect(entry, viewport),
            hidden: entry.hidden === true,
            minimized: entry.minimized === true,
            z: Number.isFinite(entry.z) ? entry.z : base.z,
        };
    }
    return layout;
}

/** 前面に出したウインドウの z。最大値 + 1 にして、他の順序は保つ。 */
export function nextZ(layout) {
    return Math.max(0, ...Object.values(layout).map((entry) => entry.z)) + 1;
}

function isStoredEntry(entry) {
    return Boolean(entry) && typeof entry === "object"
        && ["x", "y", "w", "h"].every((key) => Number.isFinite(entry[key]));
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}
