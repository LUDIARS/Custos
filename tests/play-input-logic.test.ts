import { describe, expect, it } from "vitest";
import {
    codeToKeyName,
    normalizePointer,
    pointerButtonName,
    shouldSendMove,
} from "../public/js/play-input-logic.js";

describe("play input logic", () => {
    const rect = { left: 100, top: 50, width: 400, height: 300 };

    it("normalizes a pointer inside an element that matches the media aspect", () => {
        expect(normalizePointer(300, 200, rect, 800, 600)).toEqual({ x: 0.5, y: 0.5 });
        expect(normalizePointer(100, 50, rect, 800, 600)).toEqual({ x: 0, y: 0 });
    });

    it("removes object-fit: contain letterboxing", () => {
        // 16:9 映像を 400x300 に contain → 高さ 225、上下に 37.5 の帯
        const pos = normalizePointer(300, 50 + 37.5, rect, 1600, 900);
        expect(pos?.x).toBeCloseTo(0.5);
        expect(pos?.y).toBeCloseTo(0);
        expect(normalizePointer(300, 60, rect, 1600, 900)).toBeNull();
    });

    it("falls back to the element rect when the media size is unknown", () => {
        expect(normalizePointer(500, 350, rect, 0, 0)).toEqual({ x: 1, y: 1 });
        expect(normalizePointer(10, 10, { left: 0, top: 0, width: 0, height: 0 }, 0, 0)).toBeNull();
    });

    it("maps KeyboardEvent.code to Custos key names", () => {
        expect(codeToKeyName("KeyW")).toBe("W");
        expect(codeToKeyName("Digit1")).toBe("1");
        expect(codeToKeyName("Space")).toBe("Space");
        expect(codeToKeyName("ArrowLeft")).toBe("Left");
        expect(codeToKeyName("ShiftLeft")).toBe("LShift");
        expect(codeToKeyName("F5")).toBe("F5");
        expect(codeToKeyName("IntlYen")).toBeNull();
    });

    it("maps pointer buttons and throttles moves", () => {
        expect(pointerButtonName(0)).toBe("left");
        expect(pointerButtonName(1)).toBe("middle");
        expect(pointerButtonName(2)).toBe("right");
        expect(shouldSendMove(0, 32, 33)).toBe(false);
        expect(shouldSendMove(0, 33, 33)).toBe(true);
    });
});
