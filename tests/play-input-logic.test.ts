import { describe, expect, it } from "vitest";
import {
    codeToKeyName,
    normalizePointer,
    pointerButtonName,
    shouldSendMove,
    touchGestureStep,
    TOUCH_IDLE,
    DRAG_THRESHOLD_PX,
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

describe("touch gestures", () => {
    const start = { x: 0.25, y: 0.5 };
    const down = { type: "down" as const, clientX: 100, clientY: 100, pos: start };

    it("turns a tap into a left click at the touch point", () => {
        let step = touchGestureStep(TOUCH_IDLE, down);
        expect(step.actions).toEqual([]);
        step = touchGestureStep(step.state, { type: "up", pos: start });
        expect(step.actions).toEqual([
            { button: "left", phase: "down", pos: start },
            { button: "left", phase: "up", pos: start },
        ]);
        expect(step.state).toBe(TOUCH_IDLE);
    });

    it("ignores finger jitter below the drag threshold", () => {
        let step = touchGestureStep(TOUCH_IDLE, down);
        step = touchGestureStep(step.state, { type: "move", clientX: 103, clientY: 102, pos: { x: 0.26, y: 0.5 } });
        expect(step.actions).toEqual([]);
        expect(step.state.phase).toBe("pending");
    });

    it("turns a drag into a held left button that moves", () => {
        let step = touchGestureStep(TOUCH_IDLE, down);
        const moved = { x: 0.4, y: 0.5 };
        step = touchGestureStep(step.state, { type: "move", clientX: 100 + DRAG_THRESHOLD_PX, clientY: 100, pos: moved });
        expect(step.actions).toEqual([
            { button: "left", phase: "down", pos: start },
            { button: "left", phase: "move", pos: moved },
        ]);
        step = touchGestureStep(step.state, { type: "up", pos: null });
        expect(step.actions).toEqual([{ button: "left", phase: "up", pos: moved }]);
    });

    it("turns a long press into a right click and sends nothing on release", () => {
        let step = touchGestureStep(TOUCH_IDLE, down);
        step = touchGestureStep(step.state, { type: "timer" });
        expect(step.actions).toEqual([
            { button: "right", phase: "down", pos: start },
            { button: "right", phase: "up", pos: start },
        ]);
        step = touchGestureStep(step.state, { type: "up", pos: start });
        expect(step.actions).toEqual([]);
    });

    it("does not start a gesture outside the video", () => {
        const step = touchGestureStep(TOUCH_IDLE, { ...down, pos: null });
        expect(step.state).toBe(TOUCH_IDLE);
        expect(touchGestureStep(step.state, { type: "up", pos: null }).actions).toEqual([]);
    });

    it("ignores the long-press timer once the touch became a drag", () => {
        let step = touchGestureStep(TOUCH_IDLE, down);
        step = touchGestureStep(step.state, { type: "move", clientX: 140, clientY: 100, pos: { x: 0.5, y: 0.5 } });
        expect(touchGestureStep(step.state, { type: "timer" }).actions).toEqual([]);
    });
});
