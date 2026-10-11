import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRow, inputFields, inputName, makeRunId, RUN_ID_PATTERN } from "../src/playlog/playlog-row.js";
import { parseBridgeState } from "../src/capture/ergo-custos-client.js";
import { hashPlayer, resolvePlayerSalt } from "../src/playlog/player-hash.js";
import { isPointerMessage } from "../src/ws/pointer-message.js";

const base = { run: "r", player: "p", app: "demo", seq: 3, t_ms: 120, at: "2026-10-11T00:00:00.000Z" };

describe("play log rows", () => {
    it("flattens game state into state.<key> columns", () => {
        const row = buildRow(base, "state", {}, { stage: "1-1", pos: [1, 2, 3] });
        expect(row).toEqual({ ...base, kind: "state", "state.stage": "1-1", "state.pos": [1, 2, 3] });
        expect(buildRow(base, "start", { source: "ws" }, null)).toEqual({ ...base, kind: "start", source: "ws" });
    });

    it("names inputs for Commentarii action verbs", () => {
        expect(inputName({ device: "key", key: "Space", down: true })).toBe("key:Space");
        expect(inputName({ device: "key", key: "Space", down: false })).toBe("key:Space:up");
        expect(inputName({ device: "pointer", x: 0, y: 0, button: "left", phase: "down" })).toBe("pointer:left");
        expect(inputName({ device: "pointer", x: 0, y: 0, button: "right", phase: "up" })).toBe("pointer:right:up");
        expect(inputName({ device: "pointer", x: 0, y: 0, button: "left", phase: "move" })).toBe("pointer:move");
        expect(inputName({ device: "button", id: "jump" })).toBe("button:jump");
    });

    it("adds a position column for pointer inputs", () => {
        expect(inputFields({ device: "pointer", x: 0.25, y: 0.5, button: "left", phase: "down" })).toMatchObject({
            device: "pointer", pos: [0.25, 0.5, 0],
        });
    });

    it("makes sortable run ids", () => {
        const id = makeRunId(new Date(Date.UTC(2026, 9, 11, 3, 4, 5)), () => 0);
        expect(id).toBe("20261011-030405-aaaaaa");
        expect(RUN_ID_PATTERN.test(id)).toBe(true);
    });
});

describe("bridge state parsing", () => {
    it("keeps only an object state", () => {
        expect(parseBridgeState({ isPlaying: true, state: { stage: "a" } })).toEqual({ isPlaying: true, state: { stage: "a" } });
        expect(parseBridgeState({ isPlaying: true, state: [1] })).toEqual({ isPlaying: true, state: null });
        expect(parseBridgeState(null)).toEqual({ isPlaying: false, state: null });
    });
});

describe("player hash", () => {
    it("is stable per salt and does not contain the raw id", () => {
        const h = hashPlayer("salt", "user-123");
        expect(h).toHaveLength(16);
        expect(h).toBe(hashPlayer("salt", "user-123"));
        expect(h).not.toBe(hashPlayer("other", "user-123"));
        expect(h).not.toContain("user-123");
    });

    it("prefers the env salt and otherwise persists a generated one", () => {
        const dir = mkdtempSync(join(tmpdir(), "custos-salt-"));
        try {
            expect(resolvePlayerSalt(dir, { CUSTOS_PLAYLOG_SALT: "fixed" })).toBe("fixed");
            const generated = resolvePlayerSalt(dir, {});
            expect(generated).toMatch(/^[0-9a-f]{64}$/);
            expect(readFileSync(join(dir, ".salt"), "utf8")).toBe(generated);
            expect(resolvePlayerSalt(dir, {})).toBe(generated);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("pointer message validation", () => {
    it("accepts only normalized coordinates and known phases", () => {
        const ok = { type: "pointer", appId: "demo", x: 0.5, y: 1, button: "left", phase: "move" };
        expect(isPointerMessage(ok)).toBe(true);
        expect(isPointerMessage({ ...ok, x: 1.5 })).toBe(false);
        expect(isPointerMessage({ ...ok, phase: "drag" })).toBe(false);
        expect(isPointerMessage({ ...ok, button: "back" })).toBe(false);
    });
});
