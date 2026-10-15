/**
 * VideoPipelineSelector (H.264 が使えなければ BGRA + ffmpeg に戻す) と、
 * SharedRtpSourcePool のフィードバック経路 (途中参加のキーフレーム・PLI・帯域推定)。
 * ffmpeg もブリッジも起動しない (fake に差し替える)。
 */
import { afterEach, describe, expect, test } from "vitest";
import { EventEmitter } from "node:events";
import type { AppConfig, InAppBridgeConfig } from "../src/config/apps-config.js";
import { DEFAULT_BRIDGE_VIDEO } from "../src/config/apps-config.js";
import { H264UnavailableError } from "../src/capture/bridge-h264-stream.js";
import type { FfmpegPipeline } from "../src/capture/ffmpeg-pipeline.js";
import type { H264BridgePipeline } from "../src/capture/h264-bridge-pipeline.js";
import { VideoPipelineSelector } from "../src/capture/video-pipeline-selector.js";
import { createVideoSourcePool, type SharedRtpSourcePool, type VideoPipeline } from "../src/capture/shared-rtp-source.js";

function bridge(codec: "auto" | "h264" | "rawvideo" = "auto", kind: "unity" | "ergo" = "unity"): InAppBridgeConfig {
    return { kind, host: "127.0.0.1", port: 17778, fps: 30, video: { ...DEFAULT_BRIDGE_VIDEO, codec } };
}

class FakeFfmpeg extends EventEmitter {
    bridgeStarts = 0;
    stopped = 0;
    async startBridgeStream(): Promise<unknown> {
        this.bridgeStarts++;
        setImmediate(() => this.emit("spawn"));
        return { codec: "bgra" };
    }
    start(): void { setImmediate(() => this.emit("spawn")); }
    stop(): void { this.stopped++; }
}

class FakeH264 extends EventEmitter {
    keyframes = 0;
    bitrates: number[] = [];
    constructor(private readonly failWith: Error | null) { super(); }
    async start(): Promise<void> {
        if (this.failWith) throw this.failWith;
        setImmediate(() => this.emit("spawn"));
    }
    requestKeyFrame(): void { this.keyframes++; }
    setBitrate(bps: number): void { this.bitrates.push(bps); }
    stop(): void { /* no-op */ }
}

function selector(h264Error: Error | null) {
    const ffmpeg = new FakeFfmpeg();
    const h264 = new FakeH264(h264Error);
    const sel = new VideoPipelineSelector({
        createFfmpeg: () => ffmpeg as unknown as FfmpegPipeline,
        createH264:   () => h264 as unknown as H264BridgePipeline,
    });
    return { sel, ffmpeg, h264 };
}

describe("VideoPipelineSelector", () => {
    test("uses the bridge's h264 when available and forwards feedback to it", async () => {
        const { sel, ffmpeg, h264 } = selector(null);
        const spawned = new Promise((r) => sel.once("spawn", r));
        await sel.startBridgeStream(bridge(), { rtpPort: 5000 });
        await spawned;
        expect(sel.mode).toBe("h264");
        expect(ffmpeg.bridgeStarts).toBe(0);
        sel.requestKeyFrame();
        sel.setBitrate(800_000);
        expect(h264.keyframes).toBe(1);
        expect(h264.bitrates).toEqual([800_000]);
    });

    test("falls back to BGRA + ffmpeg when the bridge cannot stream h264 (auto)", async () => {
        const { sel, ffmpeg, h264 } = selector(new H264UnavailableError("HTTP 415"));
        const spawned = new Promise((r) => sel.once("spawn", r));
        await sel.startBridgeStream(bridge("auto"), { rtpPort: 5000 });
        await spawned;
        expect(sel.mode).toBe("ffmpeg");
        expect(ffmpeg.bridgeStarts).toBe(1);
        sel.requestKeyFrame();
        expect(h264.keyframes).toBe(0);   // ffmpeg の映像源では何もしない
    });

    test("does not fall back when codec is h264 only, nor on other errors", async () => {
        const forced = selector(new H264UnavailableError("HTTP 415"));
        await expect(forced.sel.startBridgeStream(bridge("h264"), { rtpPort: 5000 })).rejects.toThrow(/415/);
        expect(forced.ffmpeg.bridgeStarts).toBe(0);
        const broken = selector(new Error("connect refused"));
        await expect(broken.sel.startBridgeStream(bridge("auto"), { rtpPort: 5000 })).rejects.toThrow(/refused/);
        expect(broken.ffmpeg.bridgeStarts).toBe(0);
    });

    test("rawvideo and ergo bridges go straight to ffmpeg", async () => {
        for (const b of [bridge("rawvideo"), bridge("auto", "ergo")]) {
            const { sel, ffmpeg } = selector(null);
            await sel.startBridgeStream(b, { rtpPort: 5000 });
            expect(sel.mode).toBe("ffmpeg");
            expect(ffmpeg.bridgeStarts).toBe(1);
        }
    });
});

class FeedbackPipeline extends EventEmitter implements VideoPipeline {
    keyframes = 0;
    bitrates: number[] = [];
    start(): void { setImmediate(() => this.emit("spawn")); }
    async startBridgeStream(): Promise<unknown> { this.start(); return {}; }
    stop(): void { /* no-op */ }
    requestKeyFrame(): void { this.keyframes++; }
    setBitrate(bps: number): void { this.bitrates.push(bps); }
}

const pools: SharedRtpSourcePool<VideoPipeline>[] = [];
afterEach(() => { for (const p of pools.splice(0)) p.shutdown(); });

describe("SharedRtpSourcePool feedback", () => {
    function setup() {
        const pipelines: FeedbackPipeline[] = [];
        const pool = createVideoSourcePool({ createPipeline: () => { const p = new FeedbackPipeline(); pipelines.push(p); return p; } });
        pools.push(pool);
        const app = { id: "u", inAppBridge: bridge() } as unknown as AppConfig;
        const sink = { onPacket: () => { /* 使わない */ }, onEnd: () => { /* 使わない */ } };
        return { pool, pipelines, app, sink };
    }

    test("asks for a keyframe whenever a viewer joins", async () => {
        const { pool, pipelines, app, sink } = setup();
        await pool.acquire(app, "a", sink);
        await pool.acquire(app, "b", sink);
        expect(pipelines).toHaveLength(1);
        expect(pipelines[0]!.keyframes).toBe(2);
    });

    test("rate-limits PLI and follows the slowest viewer's estimate", async () => {
        const { pool, pipelines, app, sink } = setup();
        await pool.acquire(app, "a", sink);
        await pool.acquire(app, "b", sink);
        const p = pipelines[0]!;
        const before = p.keyframes;
        pool.feedback("u", "a", { kind: "pli" }, 10_000);
        pool.feedback("u", "b", { kind: "pli" }, 10_100);
        expect(p.keyframes - before).toBe(1);

        pool.feedback("u", "a", { kind: "estimate", bps: 1_000_000 }, 10_200);
        expect(p.bitrates).toEqual([1_000_000]);
        pool.feedback("u", "unknown", { kind: "estimate", bps: 100_000 }, 10_300);   // 購読していない session は無視
        expect(p.bitrates).toEqual([1_000_000]);
    });
});
