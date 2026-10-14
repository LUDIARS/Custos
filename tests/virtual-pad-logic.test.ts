import { describe, expect, it } from "vitest";
import {
    classifyButton,
    diffPressed,
    directionKeys,
    labelToId,
    layoutPadButtons,
    normalizeStick,
    stickDirections,
    padDefinition,
    isDoubleTap,
    DOUBLE_TAP_MS,
} from "../public/js/virtual-pad-logic.js";

describe("virtual pad logic", () => {
    it("places arrow keys on the D-pad and WASD on the stick", () => {
        expect(classifyButton({ label: "Up", key: "Up" })).toEqual({ zone: "dpad", slot: "up" });
        expect(classifyButton({ label: "Forward", key: "W" })).toEqual({ zone: "stick", slot: "up" });
        expect(classifyButton({ label: "Left", key: "A" })).toEqual({ zone: "stick", slot: "left" });
    });

    it("places face, shoulder, menu and action buttons", () => {
        expect(classifyButton({ label: "Jump", key: "Space" })).toEqual({ zone: "actions", slot: "a" });
        expect(classifyButton({ label: "LB", key: "Q" })).toEqual({ zone: "shoulder", slot: "lb" });
        expect(classifyButton({ label: "Pause", key: "P" })).toEqual({ zone: "menu" });
        expect(classifyButton({ label: "Kill", action: "kill" })).toEqual({ zone: "extras" });
    });

    it("sends a second button for an occupied slot to extras", () => {
        const slots = layoutPadButtons([
            { label: "Jump", key: "Space" },
            { label: "A", key: "J" },
        ]);
        expect(slots.actions.a?.key).toBe("Space");
        expect(slots.extras.map((b) => b.key)).toEqual(["J"]);
    });

    it("drives the stick with WASD and fills missing directions from the arrow keys", () => {
        const slots = layoutPadButtons([
            { label: "Forward", key: "W" },
            { label: "Back", key: "S" },
            { label: "Left", key: "Left" },
            { label: "Right", key: "Right" },
        ]);
        expect(directionKeys(slots)).toEqual({ up: "W", down: "S", left: "Left", right: "Right" });
    });

    it("maps the stick tilt to 8 directions with a dead zone", () => {
        expect([...stickDirections(0.1, 0.1)]).toEqual([]);
        expect([...stickDirections(0, -1)]).toEqual(["up"]);
        expect([...stickDirections(1, 0)]).toEqual(["right"]);
        expect(new Set(stickDirections(0.7, 0.7))).toEqual(new Set(["down", "right"]));
        expect(new Set(stickDirections(-0.7, -0.7))).toEqual(new Set(["up", "left"]));
        // 軸から 22.5° 未満なら斜めにしない。
        expect([...stickDirections(1, -0.2)]).toEqual(["right"]);
    });

    it("clamps the stick offset to the radius", () => {
        expect(normalizeStick(200, 0, 50)).toEqual({ dx: 1, dy: 0 });
        expect(normalizeStick(25, 0, 50)).toEqual({ dx: 0.5, dy: 0 });
        expect(normalizeStick(10, 10, 0)).toEqual({ dx: 0, dy: 0 });
    });

    it("diffs pressed directions into press and release", () => {
        expect(diffPressed(new Set(["up", "left"]), new Set(["up", "right"]))).toEqual({
            press: ["right"],
            release: ["left"],
        });
    });

    it("builds button ids the same way as the WS handler", () => {
        expect(labelToId("Special Move!")).toBe("special-move");
    });
});

describe("padDefinition", () => {
    it("uses the explicit pad and drops empty groups", () => {
        const pad = padDefinition({
            pad: {
                leftStick: { up: "W", down: "S", left: "A", right: "D", press: "LShift" },
                face: { a: "Space" },
                shoulders: {},
                menu: [{ label: "Menu", key: "F1" }],
            },
        });
        expect(pad.leftStick).toEqual({ up: "W", down: "S", left: "A", right: "D", press: "LShift" });
        expect(pad.rightStick).toBeNull();
        expect(pad.dpad).toBeNull();
        expect(pad.face).toEqual({ a: "Space" });
        expect(pad.shoulders).toBeNull();
        expect(pad.menu).toEqual([{ label: "Menu", key: "F1" }]);
    });

    it("derives the same shape from buttons when there is no pad", () => {
        const pad = padDefinition({
            buttons: [
                { label: "Forward", key: "W" },
                { label: "Up", key: "Up" },
                { label: "Jump", key: "Space" },
                { label: "Pause", key: "P" },
                { label: "Kill", action: "kill" },
            ],
        });
        expect(pad.leftStick).toEqual({ up: "W" });
        expect(pad.dpad).toEqual({ up: "Up" });
        expect(pad.face).toEqual({ a: "Space" });
        expect(pad.menu.map((b) => b.label)).toEqual(["Pause", "Kill"]);
    });

    it("returns no parts for an app without input", () => {
        const pad = padDefinition(undefined);
        expect([pad.leftStick, pad.rightStick, pad.dpad, pad.face, pad.shoulders]).toEqual([null, null, null, null, null]);
        expect(pad.menu).toEqual([]);
    });
});

describe("isDoubleTap", () => {
    it("treats a second press within the interval as a double tap", () => {
        expect(isDoubleTap(null, 1000)).toBe(false);
        expect(isDoubleTap(1000, 1000 + DOUBLE_TAP_MS)).toBe(true);
        expect(isDoubleTap(1000, 1000 + DOUBLE_TAP_MS + 1)).toBe(false);
    });
});
