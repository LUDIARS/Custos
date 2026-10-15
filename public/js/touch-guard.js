/**
 * ページ全体のダブルタップズーム・ピンチズーム・スクロールを止める。
 *
 * viewport の user-scalable=no と CSS の touch-action だけでは iOS Safari が拡大することがあるため、
 * タッチイベント側でも打ち消す。LOG などのシートや操作メニューのように、中身がはみ出して
 * スクロールできる部分の 1 本指スクロールだけは残す。
 *
 * パッドと映像の操作は pointer イベントで受けているので、ここで touch の既定動作を止めても届く。
 */

const DOUBLE_TAP_MS = 350;
const TEXT_INPUT = "input, textarea, select, [contenteditable]";

export function installTouchGuard(root = document) {
    let lastTouchEndAt = 0;

    // iOS のピンチ (gesture*) と、2 本指以上の移動を止める。
    for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
        root.addEventListener(type, (ev) => ev.preventDefault(), { passive: false });
    }
    root.addEventListener("touchmove", (ev) => {
        if (ev.touches.length > 1 || !canScroll(ev.target)) ev.preventDefault();
    }, { passive: false });

    // 素早い 2 回目のタップを打ち消してダブルタップズームを止める。
    root.addEventListener("touchend", (ev) => {
        const now = ev.timeStamp;
        const isDoubleTap = now - lastTouchEndAt < DOUBLE_TAP_MS;
        lastTouchEndAt = now;
        if (isDoubleTap && !ev.target.closest?.(TEXT_INPUT)) ev.preventDefault();
    }, { passive: false });
    root.addEventListener("dblclick", (ev) => ev.preventDefault());
}

/** target から上へたどり、縦か横にスクロールできる要素の中なら true。 */
function canScroll(target) {
    for (let el = target; el && el !== document.body && el.nodeType === 1; el = el.parentElement) {
        const style = getComputedStyle(el);
        const scrollY = /(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight;
        const scrollX = /(auto|scroll)/.test(style.overflowX) && el.scrollWidth > el.clientWidth;
        if (scrollY || scrollX) return true;
    }
    return false;
}
