import { describe, expect, it } from "vitest";
import {
    MIN_WINDOW_SIZE,
    clampRect,
    defaultLayout,
    nextZ,
    restoreLayout,
} from "../public/js/window-layout-logic.js";

const viewport = { w: 1600, h: 900 };
const ids = ["view", "pad", "logs", "tests", "settings"];

describe("window layout logic", () => {
    it("opens VIEW / PAD / LOG by default and keeps every window inside the screen", () => {
        const layout = defaultLayout(ids, viewport);
        expect(Object.keys(layout)).toEqual(ids);
        expect(layout.view!.hidden).toBe(false);
        expect(layout.pad!.hidden).toBe(false);
        expect(layout.logs!.hidden).toBe(false);
        expect(layout.tests!.hidden).toBe(true);
        expect(layout.settings!.hidden).toBe(true);
        for (const entry of Object.values(layout)) {
            expect(entry.x + entry.w).toBeLessThanOrEqual(viewport.w);
            expect(entry.y + entry.h).toBeLessThanOrEqual(viewport.h);
        }
        // VIEW は他より大きい (主役)。
        expect(layout.view!.w).toBeGreaterThan(layout.pad!.w);
    });

    it("never shrinks a window below the minimum size", () => {
        const rect = clampRect({ x: 10, y: 10, w: 20, h: 20 }, viewport);
        expect(rect.w).toBe(MIN_WINDOW_SIZE.w);
        expect(rect.h).toBe(MIN_WINDOW_SIZE.h);
    });

    it("keeps the title bar reachable when a window is dragged off screen", () => {
        const left = clampRect({ x: -5000, y: -100, w: 400, h: 300 }, viewport);
        expect(left.x + left.w).toBeGreaterThan(0);
        expect(left.y).toBe(0);

        const right = clampRect({ x: 5000, y: 5000, w: 400, h: 300 }, viewport);
        expect(right.x).toBeLessThan(viewport.w);
        expect(right.y).toBeLessThan(viewport.h);
    });

    it("restores a saved layout and falls back per window on broken entries", () => {
        const fallback = defaultLayout(ids, viewport);
        const stored = {
            view: { x: 100, y: 50, w: 800, h: 600, hidden: false, minimized: true, z: 9 },
            pad: { x: "oops" },
            unknown: { x: 0, y: 0, w: 300, h: 300 },
        };
        const layout = restoreLayout(stored, fallback, viewport);
        expect(layout.view).toEqual({ x: 100, y: 50, w: 800, h: 600, hidden: false, minimized: true, z: 9 });
        expect(layout.pad).toEqual(fallback.pad);
        expect(layout).not.toHaveProperty("unknown");
    });

    it("uses the default layout when the stored value is not an object", () => {
        const fallback = defaultLayout(ids, viewport);
        expect(restoreLayout(null, fallback, viewport)).toBe(fallback);
        expect(restoreLayout("x", fallback, viewport)).toBe(fallback);
    });

    it("brings a window to the front with a z above every other window", () => {
        const layout = defaultLayout(ids, viewport);
        expect(nextZ(layout)).toBe(ids.length + 1);
    });
});
