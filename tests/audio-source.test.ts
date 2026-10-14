/**
 * 音声の配信: 対象 PID の決め方、音声源プールの起動、ffmpeg (Opus RTP) の引数。
 * 取り込みプログラムと ffmpeg は起動しない (パイプラインと pid の取得を差し替える)。
 */
import { afterEach, describe, expect, test } from "vitest";
import { EventEmitter } from "node:events";
import type { AppConfig } from "../src/config/apps-config.js";
import { resolveAudioPid } from "../src/capture/audio-target.js";
import { createAudioSourcePool, type AudioSourcePipeline } from "../src/capture/audio-source.js";
import { buildAudioFfmpegArgs, OPUS_PAYLOAD_TYPE } from "../src/capture/audio-pipeline.js";
import type { SharedRtpSourcePool } from "../src/capture/shared-rtp-source.js";

const bridgeApp = {
    id: "game",
    inAppBridge: { kind: "unity", host: "127.0.0.1", port: 17778, fps: 24 },
    audio: { source: "process-loopback" },
} as unknown as AppConfig;
const runApp = { id: "native", audio: { source: "process-loopback" } } as unknown as AppConfig;

describe("resolveAudioPid", () => {
    test("ブリッジのある app はブリッジの /health の pid を使う", async () => {
        const pid = await resolveAudioPid(bridgeApp, {
            getRunPid: () => 999,
            fetchBridgePid: async () => 4242,
        });
        expect(pid).toBe(4242);
    });

    test("ブリッジが pid を返さなければ理由付きで失敗する (無音で流さない)", async () => {
        await expect(resolveAudioPid(bridgeApp, { getRunPid: () => 999, fetchBridgePid: async () => undefined }))
            .rejects.toThrow(/pid を返しません/);
    });

    test("ブリッジの無い app は Custos が起動した run の PID を使い、動いていなければ失敗する", async () => {
        expect(await resolveAudioPid(runApp, { getRunPid: () => 1234 })).toBe(1234);
        await expect(resolveAudioPid(runApp, { getRunPid: () => undefined })).rejects.toThrow(/動いていません/);
    });
});

class FakeAudioPipeline extends EventEmitter implements AudioSourcePipeline {
    pid = 0;
    async start(pid: number): Promise<void> {
        this.pid = pid;
        setImmediate(() => this.emit("spawn"));
    }
    stop(): void { /* 何も起動していない */ }
}

const pools: SharedRtpSourcePool<AudioSourcePipeline>[] = [];
afterEach(() => { for (const pool of pools.splice(0)) pool.shutdown(); });

describe("createAudioSourcePool", () => {
    test("対象の PID でパイプラインを起動し、2 つ目の購読は同じ音声源を使う", async () => {
        const pipelines: FakeAudioPipeline[] = [];
        const pool = createAudioSourcePool({
            getRunPid: () => undefined,
            fetchBridgePid: async () => 4242,
            createPipeline: () => { const p = new FakeAudioPipeline(); pipelines.push(p); return p; },
        });
        pools.push(pool);
        const sink = { onPacket: () => {}, onEnd: () => {} };
        const portA = await pool.acquire(bridgeApp, "a", sink);
        const portB = await pool.acquire(bridgeApp, "b", sink);
        expect(pipelines).toHaveLength(1);
        expect(pipelines[0]!.pid).toBe(4242);
        expect(portA).toBe(portB);
    });

    test("audio 設定の無い app は起動しない", async () => {
        const pool = createAudioSourcePool({ getRunPid: () => 1, createPipeline: () => new FakeAudioPipeline() });
        pools.push(pool);
        const noAudio = { id: "x", capture: { type: "window" } } as unknown as AppConfig;
        await expect(pool.acquire(noAudio, "a", { onPacket: () => {}, onEnd: () => {} })).rejects.toThrow(/no audio config/);
    });
});

describe("buildAudioFfmpegArgs", () => {
    test("取り込みプログラムの PCM (s16le / 48kHz / 2ch) を Opus にして RTP で送る", () => {
        const args = buildAudioFfmpegArgs(5006);
        const at = (flag: string) => args[args.indexOf(flag) + 1];
        expect(at("-f")).toBe("s16le");
        expect(at("-ar")).toBe("48000");
        expect(at("-ac")).toBe("2");
        expect(at("-i")).toBe("pipe:0");
        expect(at("-c:a")).toBe("libopus");
        expect(at("-payload_type")).toBe(String(OPUS_PAYLOAD_TYPE));
        expect(args.at(-1)).toBe("rtp://127.0.0.1:5006?pkt_size=1200");
    });
});
