/**
 * ScreenshotStreamer: refcount + interval timer + capture failure 耐性。
 *
 * capture 関数は両方 vi.mock で差し替えて実 ffmpeg / 実 ergo_custos に
 * 触らない。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { AppConfig } from "../src/config/apps-config.js";

// 実 fetch は使わない。Streamer 内の dynamic import を考慮して default = path 文字列で mock。
vi.mock("../src/capture/screenshot.js", () => ({
    captureScreenshot: vi.fn(),
}));
vi.mock("../src/capture/ergo-custos-client.js", () => ({
    fetchScreenshot: vi.fn(),
}));

import { captureScreenshot } from "../src/capture/screenshot.js";
import { fetchScreenshot }   from "../src/capture/ergo-custos-client.js";
import { ScreenshotStreamer, type ScreenshotFrame } from "../src/capture/screenshot-stream.js";

class FakeRegistry extends EventEmitter {}

function appWithErgo(intervalSec = 0.05): AppConfig {
    return {
        id:    "demo",
        name:  "Demo",
        target: "desktop",
        run:    { workingDir: ".", cwd: ".", cmd: "x", args: [], env: {} },
        inAppBridge: { kind: "ergo", host: "127.0.0.1", port: 5198 },
        capture:     { type: "window", fps: 30, preset: "veryfast", intervalSec },
        input:       { buttons: [], allowKeyboard: true, allowMouse: false },
        logs:        { stdout: true, stderr: true, files: [] },
    };
}

function appWithUnity(intervalSec = 0.05): AppConfig {
    return {
        id:    "demo-unity",
        name:  "Demo Unity",
        target: "desktop",
        run:    { workingDir: ".", cwd: ".", cmd: "x", args: [], env: {} },
        inAppBridge: { kind: "unity", host: "127.0.0.1", port: 5199 },
        capture:     { type: "window", fps: 30, preset: "veryfast", intervalSec },
        input:       { buttons: [], allowKeyboard: true, allowMouse: false },
        logs:        { stdout: true, stderr: true, files: [] },
    };
}

function appWithoutCapture(): AppConfig {
    return {
        id:    "demo2",
        name:  "Demo2",
        target: "desktop",
        run:    { workingDir: ".", cwd: ".", cmd: "x", args: [], env: {} },
        input:  { buttons: [], allowKeyboard: true, allowMouse: false },
        logs:   { stdout: true, stderr: true, files: [] },
    };
}

const PNG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

describe("ScreenshotStreamer", () => {
    beforeEach(() => {
        vi.mocked(fetchScreenshot).mockReset();
        vi.mocked(captureScreenshot).mockReset();
        delete process.env.CUSTOS_SCREENSHOT_INTERVAL_SEC;
    });
    afterEach(() => {});

    test("acquire on app without capture returns false (no timer)", () => {
        const reg = new FakeRegistry() as unknown as Parameters<typeof ScreenshotStreamer>[0] extends infer _ ? any : any;
        const s = new ScreenshotStreamer(reg);
        const ok = s.acquire(appWithoutCapture(), "k1");
        expect(ok).toBe(false);
        expect(s.snapshot()).toEqual([]);
        s.shutdown();
    });

    test("intervalSec=0 disables the streamer", () => {
        const reg = new FakeRegistry() as any;
        const s = new ScreenshotStreamer(reg);
        const ok = s.acquire(appWithErgo(0), "k1");
        expect(ok).toBe(false);
        s.shutdown();
    });

    test("inAppBridge (ergo) path: emits frame then second frame after interval", async () => {
        vi.mocked(fetchScreenshot).mockResolvedValue(PNG);
        const reg = new FakeRegistry() as any;
        const s = new ScreenshotStreamer(reg);

        const frames: ScreenshotFrame[] = [];
        s.on("frame", (f: ScreenshotFrame) => frames.push(f));

        s.acquire(appWithErgo(0.05), "session-1");
        // 0.2 秒待つ → 初回 setImmediate + interval ≥3 回
        await new Promise((r) => setTimeout(r, 200));
        s.shutdown();

        expect(frames.length).toBeGreaterThanOrEqual(2);
        expect(frames[0]!.appId).toBe("demo");
        expect(frames[0]!.png.equals(PNG)).toBe(true);
        expect(typeof frames[0]!.ts).toBe("number");
    });

    test("refcount: second acquire is dedup-safe; only last release stops", async () => {
        vi.mocked(fetchScreenshot).mockResolvedValue(PNG);
        const reg = new FakeRegistry() as any;
        const s = new ScreenshotStreamer(reg);

        const cfg = appWithErgo(0.05);
        s.acquire(cfg, "s1");
        s.acquire(cfg, "s2");
        expect(s.snapshot()).toEqual([{ appId: "demo", subscribers: 2, intervalSec: 0.05 }]);

        s.release("demo", "s1");
        expect(s.snapshot()).toEqual([{ appId: "demo", subscribers: 1, intervalSec: 0.05 }]);

        s.release("demo", "s2");
        expect(s.snapshot()).toEqual([]);
        s.shutdown();
    });

    test("releaseAll cleans every subscription for a key", () => {
        vi.mocked(fetchScreenshot).mockResolvedValue(PNG);
        const reg = new FakeRegistry() as any;
        const s = new ScreenshotStreamer(reg);

        const a = appWithErgo(0.05);
        const b: AppConfig = { ...a, id: "demo-b" };
        s.acquire(a, "session-X");
        s.acquire(b, "session-X");
        s.acquire(a, "session-Y");
        expect(s.snapshot()).toHaveLength(2);

        s.releaseAll("session-X");
        const snap = s.snapshot();
        expect(snap).toEqual([{ appId: "demo", subscribers: 1, intervalSec: 0.05 }]);
        s.shutdown();
    });

    test("capture failure emits capture-error but timer continues", async () => {
        // 失敗 → 成功 の順で答えるよう mock を仕込む
        vi.mocked(fetchScreenshot)
            .mockRejectedValueOnce(new Error("boom"))
            .mockResolvedValue(PNG);

        const reg = new FakeRegistry() as any;
        const s = new ScreenshotStreamer(reg);

        const errors: unknown[] = [];
        const frames: ScreenshotFrame[] = [];
        s.on("capture-error", (_id, err) => errors.push(err));
        s.on("frame", (f) => frames.push(f));

        s.acquire(appWithErgo(0.05), "k1");
        await new Promise((r) => setTimeout(r, 200));
        s.shutdown();

        expect(errors.length).toBeGreaterThanOrEqual(1);
        expect(frames.length).toBeGreaterThanOrEqual(1);
    });

    test("env CUSTOS_SCREENSHOT_INTERVAL_SEC overrides config", () => {
        process.env.CUSTOS_SCREENSHOT_INTERVAL_SEC = "0.05";
        const reg = new FakeRegistry() as any;
        const s = new ScreenshotStreamer(reg);
        s.acquire(appWithErgo(99 /* ignored */), "k1");
        expect(s.snapshot()).toEqual([{ appId: "demo", subscribers: 1, intervalSec: 0.05 }]);
        s.shutdown();
    });

    test("inAppBridge (unity) path: uses fetchScreenshot via same protocol", async () => {
        vi.mocked(fetchScreenshot).mockResolvedValue(PNG);
        const reg = new FakeRegistry() as any;
        const s = new ScreenshotStreamer(reg);

        const frames: ScreenshotFrame[] = [];
        s.on("frame", (f: ScreenshotFrame) => frames.push(f));

        s.acquire(appWithUnity(0.05), "session-unity");
        await new Promise((r) => setTimeout(r, 200));
        s.shutdown();

        // Unity bridge uses the same fetchScreenshot code path
        expect(frames.length).toBeGreaterThanOrEqual(2);
        expect(frames[0]!.appId).toBe("demo-unity");
        expect(frames[0]!.png.equals(PNG)).toBe(true);
        // fetchScreenshot must have been called with the Unity endpoint (port 5199)
        const calls = vi.mocked(fetchScreenshot).mock.calls;
        expect(calls.length).toBeGreaterThanOrEqual(1);
        expect(calls[0]![0]).toMatchObject({ kind: "unity", port: 5199 });
    });
});
