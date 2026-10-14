import { describe, expect, it } from "vitest";
import {
    classifyButton,
    diffPressed,
    directionKeys,
    labelToId,
    layoutPadButtons,
    normalizeStick,
    stickDirections,
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
