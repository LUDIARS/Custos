/**
 * RuntimeStreamPrefs: patch セマンティクス + change emit。
 */
import { describe, expect, test, vi } from "vitest";
import { RuntimeStreamPrefs } from "../src/runtime/stream-prefs.js";

describe("RuntimeStreamPrefs", () => {
    test("starts empty", () => {
        const p = new RuntimeStreamPrefs();
        expect(p.get()).toEqual({});
    });

    test("apply with value sets the field and emits change", () => {
        const p = new RuntimeStreamPrefs();
        const spy = vi.fn();
        p.on("change", spy);
        p.apply({ intervalSec: 2.5 });
        expect(p.get()).toEqual({ intervalSec: 2.5 });
        expect(spy).toHaveBeenCalledTimes(1);
    });

    test("apply with null clears the field (back to apps.json default)", () => {
        const p = new RuntimeStreamPrefs();
        p.apply({ intervalSec: 2 });
        const spy = vi.fn();
        p.on("change", spy);
        p.apply({ intervalSec: null });
        expect(p.get()).toEqual({});
        expect(spy).toHaveBeenCalledTimes(1);
    });

    test("apply with undefined leaves the field alone (PATCH semantics)", () => {
        const p = new RuntimeStreamPrefs();
        p.apply({ intervalSec: 3, maxWidth: 800 });
        const spy = vi.fn();
        p.on("change", spy);
        p.apply({ maxWidth: 640 });
        expect(p.get()).toEqual({ intervalSec: 3, maxWidth: 640 });
        expect(spy).toHaveBeenCalledTimes(1);
    });

    test("no-op apply does not emit change", () => {
        const p = new RuntimeStreamPrefs();
        p.apply({ intervalSec: 2 });
        const spy = vi.fn();
        p.on("change", spy);
        p.apply({ intervalSec: 2 });
        expect(spy).not.toHaveBeenCalled();
    });

    test("reset clears + emits when non-empty, silent when already empty", () => {
        const p = new RuntimeStreamPrefs();
        const spy = vi.fn();
        p.on("change", spy);
        p.reset();
        expect(spy).not.toHaveBeenCalled();
        p.apply({ maxWidth: 1280 });
        spy.mockClear();
        p.reset();
        expect(p.get()).toEqual({});
        expect(spy).toHaveBeenCalledTimes(1);
    });
});
