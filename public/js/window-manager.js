/**
 * ウインドウ (.fw) の表示・配置を管理する。
 *
 * PC: フローティング。タイトルバーで移動、右下の角で大きさ変更、押したウインドウを前面へ。
 *     最小化・閉じる・ヘッダのボタンで出し入れ。配置はブラウザに保存して次回戻す。
 * スマホ: VIEW と PAD は常に表示 (CSS で縦に並ぶ)。LOG / TEST / SETTINGS は
 *     下からのシートとして 1 枚だけ開く。位置の inline style は付けない。
 */

import { clampRect, defaultLayout, nextZ, restoreLayout } from "/js/window-layout-logic.js";

const STORAGE_KEY = "custos.windows.v1";
/** スマホで常に表示するウインドウ。 */
const MOBILE_FIXED = new Set(["view", "pad"]);

export function createWindowManager({ desk, isMobile, onVisibilityChange = () => {} }) {
    const windows = new Map(
        [...desk.querySelectorAll(".fw")].map((el) => [el.dataset.window, el]),
    );
    const ids = [...windows.keys()];
    const toggles = [...document.querySelectorAll("[data-window-toggle]")];
    let layout = loadLayout();
    /** スマホで開いているシート (1 枚だけ)。 */
    let openSheet = null;

    for (const [id, el] of windows) wireWindow(id, el);
    for (const toggle of toggles) {
        toggle.addEventListener("click", () => toggleWindow(toggle.dataset.windowToggle));
    }
    window.addEventListener("resize", () => {
        if (isMobile()) return;
        for (const id of ids) layout[id] = { ...layout[id], ...clampRect(layout[id], viewport()) };
        render();
    });

    function viewport() {
        return { w: desk.clientWidth || window.innerWidth, h: desk.clientHeight || window.innerHeight };
    }

    function loadLayout() {
        const fallback = defaultLayout(ids, viewport());
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            return raw ? restoreLayout(JSON.parse(raw), fallback, viewport()) : fallback;
        } catch {
            return fallback;   // 保存が読めない (壊れている / ストレージ不可) なら既定配置で始める
        }
    }

    function saveLayout() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
        } catch {
            /* 保存できない環境でも表示はそのまま使える。配置が次回に戻らないだけ */
        }
    }

    function isOpen(id) {
        if (isMobile()) return MOBILE_FIXED.has(id) || openSheet === id;
        return !layout[id]?.hidden;
    }

    function render() {
        const mobile = isMobile();
        for (const [id, el] of windows) {
            const entry = layout[id];
            el.classList.toggle("fw-hidden", !isOpen(id));
            el.classList.toggle("fw-minimized", !mobile && entry.minimized);
            if (mobile) {
                el.removeAttribute("style");
                continue;
            }
            el.style.left = `${entry.x}px`;
            el.style.top = `${entry.y}px`;
            el.style.width = `${entry.w}px`;
            el.style.height = `${entry.h}px`;
            el.style.zIndex = String(entry.z);
        }
        for (const toggle of toggles) toggle.classList.toggle("open", isOpen(toggle.dataset.windowToggle));
        onVisibilityChange();
    }

    function toggleWindow(id) {
        if (!windows.has(id)) return;
        if (isMobile()) {
            if (MOBILE_FIXED.has(id)) return;
            openSheet = openSheet === id ? null : id;
            render();
            return;
        }
        const entry = layout[id];
        if (entry.hidden || entry.minimized) {
            layout[id] = { ...entry, hidden: false, minimized: false, z: nextZ(layout) };
        } else {
            layout[id] = { ...entry, hidden: true };
        }
        saveLayout();
        render();
    }

    function close(id) {
        if (isMobile()) {
            if (openSheet === id) openSheet = null;
        } else {
            layout[id] = { ...layout[id], hidden: true };
            saveLayout();
        }
        render();
    }

    function focus(id) {
        if (isMobile() || layout[id].z === nextZ(layout) - 1) return;
        layout[id] = { ...layout[id], z: nextZ(layout) };
        saveLayout();
        render();
    }

    function wireWindow(id, el) {
        const titlebar = el.querySelector(".fw-titlebar");
        const grip = el.querySelector("[data-fw-resize]");
        el.addEventListener("pointerdown", () => focus(id), { capture: true });
        el.querySelector("[data-fw-close]")?.addEventListener("click", () => close(id));
        el.querySelector("[data-fw-minimize]")?.addEventListener("click", () => {
            layout[id] = { ...layout[id], minimized: !layout[id].minimized };
            saveLayout();
            render();
        });
        titlebar?.addEventListener("pointerdown", (ev) => {
            if (isMobile() || ev.target.closest("button")) return;
            startGesture(ev, id, (dx, dy, start) => ({ ...start, x: start.x + dx, y: start.y + dy }));
        });
        grip?.addEventListener("pointerdown", (ev) => {
            if (isMobile()) return;
            startGesture(ev, id, (dx, dy, start) => ({ ...start, w: start.w + dx, h: start.h + dy }));
        });
    }

    /** ドラッグ (移動 / 大きさ変更) の共通処理。move で矩形を作り、画面内に収めて反映する。 */
    function startGesture(ev, id, nextRect) {
        ev.preventDefault();
        const target = ev.currentTarget;
        target.setPointerCapture?.(ev.pointerId);
        const start = { ...layout[id] };
        const origin = { x: ev.clientX, y: ev.clientY };
        document.body.classList.add("fw-dragging");
        const onMove = (move) => {
            const rect = nextRect(move.clientX - origin.x, move.clientY - origin.y, start);
            layout[id] = { ...layout[id], ...clampRect(rect, viewport()) };
            render();
        };
        const onEnd = () => {
            target.removeEventListener("pointermove", onMove);
            target.removeEventListener("pointerup", onEnd);
            target.removeEventListener("pointercancel", onEnd);
            document.body.classList.remove("fw-dragging");
            saveLayout();
        };
        target.addEventListener("pointermove", onMove);
        target.addEventListener("pointerup", onEnd);
        target.addEventListener("pointercancel", onEnd);
    }

    function resetLayout() {
        layout = defaultLayout(ids, viewport());
        saveLayout();
        render();
    }

    return {
        render,
        resetLayout,
        isOpen,
        open(id) {
            if (!isOpen(id)) toggleWindow(id);
        },
    };
}
