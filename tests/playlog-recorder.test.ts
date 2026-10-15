import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../src/config/apps-config.js";
import { PlayLogRecorder } from "../src/playlog/playlog-recorder.js";
import type { PlayLogRow } from "../src/playlog/playlog-row.js";
import type { PlayLogWriter } from "../src/playlog/playlog-writer.js";
import { listPlayLogs, readPlayLog } from "../src/playlog/playlog-store.js";
import { createPlayLogRoutes } from "../src/routes/playlog-routes.js";

function app(playLog: AppConfig["playLog"], withBridge = false): AppConfig {
    return {
        id: "demo", name: "Demo", target: "desktop",
        run: { workingDir: ".", cwd: ".", cmd: "x", args: [], env: {} },
        input: { buttons: [], allowKeyboard: true, allowMouse: true },
        logs: { stdout: true, stderr: true, files: [] },
        inAppBridge: withBridge ? { kind: "unity", host: "127.0.0.1", port: 17778, fps: 24 } : undefined,
        playLog,
    } as AppConfig;
}

function harness(cfg: AppConfig, state: Record<string, unknown> | null = null) {
    let clock = 1_000_000;
    const files = new Map<string, PlayLogRow[]>();
    const closed: string[] = [];
    const recorder = new PlayLogRecorder({
        dir:        "/plays",
        getConfig:  (id) => (id === cfg.id ? cfg : undefined),
        hashPlayer: (id) => `h(${id})`,
        now:        () => clock,
        openWriter: (path): PlayLogWriter => {
            const rows: PlayLogRow[] = [];
            files.set(path, rows);
            return { write: (row) => rows.push(row), close: () => closed.push(path) };
        },
        fetchState: async () => ({ isPlaying: true, state }),
    });
    return {
        recorder, files, closed,
        advance: (ms: number) => { clock += ms; },
        rows: () => [...files.values()][0] ?? [],
    };
}

const enabled = { enabled: true, statePollMs: 500, idleStopSec: 300 };
const recorders: PlayLogRecorder[] = [];
afterEach(() => { for (const r of recorders.splice(0)) r.shutdown(); });

describe("PlayLogRecorder", () => {
    it("does nothing when the app has no playLog", () => {
        const h = harness(app(undefined));
        recorders.push(h.recorder);
        h.recorder.recordInput("s1", "user", "demo", { device: "key", key: "W", down: true });
        expect(h.files.size).toBe(0);
        expect(h.recorder.openRuns).toBe(0);
    });

    it("opens a run on the first input and closes it with an end row", () => {
        const h = harness(app(enabled));
        recorders.push(h.recorder);
        h.recorder.recordInput("s1", "user-1", "demo", { device: "key", key: "W", down: true });
        h.advance(250);
        h.recorder.recordInput("s1", "user-1", "demo", { device: "key", key: "W", down: false });
        h.recorder.closeSession("s1", "disconnect");

        const rows = h.rows();
        expect(rows.map((r) => r.kind)).toEqual(["start", "input", "input", "end"]);
        expect(rows.map((r) => r.seq)).toEqual([0, 1, 2, 3]);
        expect(rows[2]).toMatchObject({ input: "key:W:up", t_ms: 250, player: "h(user-1)", app: "demo" });
        expect(rows[3]).toMatchObject({ reason: "disconnect" });
        expect(JSON.stringify(rows)).not.toContain("\"user-1\"");
        expect([...h.files.keys()][0]).toMatch(/[\\/]plays[\\/]demo[\\/]\d{8}-\d{6}-[a-z0-9]{6}\.jsonl$/);
        expect(h.closed).toHaveLength(1);
        expect(h.recorder.openRuns).toBe(0);
    });

    it("writes a spectator comment into the open run of the app with a hashed commenter", () => {
        const h = harness(app(enabled));
        recorders.push(h.recorder);
        h.recorder.recordComment("demo", "viewer-1", "いいね");               // 記録中の run が無い: 何もしない
        expect(h.files.size).toBe(0);
        h.recorder.recordInput("s1", "player-1", "demo", { device: "key", key: "W", down: true });
        h.advance(40);
        h.recorder.recordComment("demo", "viewer-1", "いいね");
        h.recorder.recordComment("other", "viewer-1", "別 app");              // 別 app の run は無い
        const rows = h.rows();
        expect(rows.map((r) => r.kind)).toEqual(["start", "input", "comment"]);
        expect(rows[2]).toMatchObject({ comment: "いいね", commenter: "h(viewer-1)", player: "h(player-1)", t_ms: 40 });
        expect(JSON.stringify(rows)).not.toContain("\"viewer-1\"");
        expect(h.recorder.openRuns).toBe(1);
    });

    it("records pointer moves only while pressed and at most every 100ms", () => {
        const h = harness(app(enabled));
        recorders.push(h.recorder);
        const move = { device: "pointer" as const, x: 0.1, y: 0.2, button: "left" as const, phase: "move" as const };
        h.recorder.recordInput("s1", "u", "demo", move);                       // 未押下: run は開くが move は捨てる
        h.recorder.recordInput("s1", "u", "demo", { ...move, phase: "down" });
        h.advance(150);
        h.recorder.recordInput("s1", "u", "demo", move);
        h.advance(50);
        h.recorder.recordInput("s1", "u", "demo", move);                       // 間引かれる
        h.recorder.recordInput("s1", "u", "demo", { ...move, phase: "up" });
        h.advance(200);
        h.recorder.recordInput("s1", "u", "demo", move);                       // 離した後: 捨てる
        expect(h.rows().map((r) => r.input ?? r.kind)).toEqual(["start", "pointer:left", "pointer:move", "pointer:left:up"]);
    });

    it("writes state rows only when the game state changes and stamps state columns", async () => {
        const h = harness(app(enabled, true), { stage: "1-1" });
        recorders.push(h.recorder);
        h.recorder.recordInput("s1", "u", "demo", { device: "button", id: "jump" });
        // 開いた直後の 1 回目の取得を待つ
        await new Promise((r) => setTimeout(r, 10));
        h.recorder.onState("demo", { stage: "1-1" });
        h.recorder.recordInput("s1", "u", "demo", { device: "key", key: "Space", down: true });
        const rows = h.rows();
        expect(rows.map((r) => r.kind)).toEqual(["start", "input", "state", "input"]);
        expect(rows[2]?.["state.stage"]).toBe("1-1");
        expect(rows[3]?.["state.stage"]).toBe("1-1");
    });

    it("closes idle runs and runs of an exited app", () => {
        const h = harness(app({ ...enabled, idleStopSec: 10 }));
        recorders.push(h.recorder);
        h.recorder.recordInput("s1", "u", "demo", { device: "key", key: "A", down: true });
        h.advance(9_000);
        h.recorder.closeIdle();
        expect(h.recorder.openRuns).toBe(1);
        h.advance(1_000);
        h.recorder.closeIdle();
        expect(h.recorder.openRuns).toBe(0);
        expect(h.rows().at(-1)).toMatchObject({ kind: "end", reason: "idle" });

        h.recorder.recordInput("s2", "u", "demo", { device: "key", key: "A", down: true });
        h.recorder.closeApp("demo", "exit");
        expect(h.recorder.openRuns).toBe(0);
    });

    it("keeps separate runs per session", () => {
        const h = harness(app(enabled));
        recorders.push(h.recorder);
        h.recorder.recordInput("s1", "a", "demo", { device: "key", key: "A", down: true });
        h.recorder.recordInput("s2", "b", "demo", { device: "key", key: "B", down: true });
        expect(h.recorder.openRuns).toBe(2);
        h.recorder.closeSessionApp("s1", "demo", "unsubscribe");
        expect(h.recorder.openRuns).toBe(1);
    });
});

describe("play log store and routes", () => {
    let dir = "";
    afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ""; });

    function seed() {
        dir = mkdtempSync(join(tmpdir(), "custos-plays-"));
        mkdirSync(join(dir, "demo"));
        writeFileSync(join(dir, "demo", "20261011-000000-abcdef.jsonl"), "{\"seq\":0}\n");
        writeFileSync(join(dir, "demo", "notes.txt"), "x");
        writeFileSync(join(dir, ".salt"), "s");
    }

    it("lists only valid run files and reads them back", () => {
        seed();
        const list = listPlayLogs(dir);
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({ appId: "demo", run: "20261011-000000-abcdef", bytes: 10 });
        expect(listPlayLogs(dir, "other")).toEqual([]);
        expect(readPlayLog(dir, "demo", "20261011-000000-abcdef")).toBe("{\"seq\":0}\n");
        expect(readPlayLog(dir, "..", "20261011-000000-abcdef")).toBeUndefined();
        expect(readPlayLog(dir, "demo", "../.salt")).toBeUndefined();
    });

    it("serves the list and NDJSON bodies", async () => {
        seed();
        const routes = createPlayLogRoutes({ dir });
        const list = await routes.request("/?appId=demo");
        expect(await list.json()).toMatchObject({ logs: [{ run: "20261011-000000-abcdef" }] });
        const body = await routes.request("/demo/20261011-000000-abcdef");
        expect(body.headers.get("content-type")).toContain("application/x-ndjson");
        expect(await body.text()).toBe("{\"seq\":0}\n");
        expect((await routes.request("/demo/nope")).status).toBe(404);
    });
});
