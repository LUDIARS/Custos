/**
 * プロセス音声の配信パイプライン: ProcessLoopback.exe (PCM) → ffmpeg (Opus) → RTP。
 *
 * 映像の FfmpegPipeline と同じく、SharedRtpSourcePool が app ごとに 1 本だけ持つ。
 * イベントも同じ契約にする: 起動できたら "spawn"、起動失敗・異常は "error"、
 * どちらかのプロセスが終わったら "exit"、ffmpeg のエラー行は "stderr"。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { childLogger } from "../shared/logger.js";
import { FfmpegPipeline } from "./ffmpeg-pipeline.js";
import { ensureProcessLoopbackExe } from "./process-loopback.js";

const log = childLogger("audio-pipeline");

/** ProcessLoopback.exe が出す PCM の形 (ProcessLoopback.cs と一致させる)。 */
export const PCM_FORMAT = { sampleRate: 48_000, channels: 2 } as const;
/** WebRTC の Opus。webrtc-broker.ts の codec 定義と一致させる。 */
export const OPUS_PAYLOAD_TYPE = 111;

/** PCM (stdin) → Opus → RTP の ffmpeg 引数。 */
export function buildAudioFfmpegArgs(rtpPort: number, rtpHost = "127.0.0.1"): string[] {
    return [
        "-loglevel", "warning",
        "-f", "s16le",
        "-ar", String(PCM_FORMAT.sampleRate),
        "-ac", String(PCM_FORMAT.channels),
        "-i", "pipe:0",
        "-vn",
        "-c:a", "libopus",
        "-b:a", "96k",
        "-application", "lowdelay",
        "-frame_duration", "20",
        "-payload_type", String(OPUS_PAYLOAD_TYPE),
        "-f", "rtp",
        `rtp://${rtpHost}:${rtpPort}?pkt_size=1200`,
    ];
}

export class AudioPipeline extends EventEmitter {
    private capture: ChildProcess | null = null;
    private encoder: ChildProcess | null = null;
    private stopped = false;

    /** 対象プロセスの音を取り込み始める。spawn の成否は "spawn" / "error" で知らせる。 */
    async start(pid: number, opts: { rtpPort: number }): Promise<void> {
        if (this.capture || this.encoder) throw new Error("audio pipeline already running");
        const exe = await ensureProcessLoopbackExe();
        if (this.stopped) return;   // ビルド待ちの間に止められた

        const encoder = spawn(FfmpegPipeline.binary(), buildAudioFfmpegArgs(opts.rtpPort), {
            stdio: ["pipe", "ignore", "pipe"],
            shell: false,
            windowsHide: true,
        });
        const capture = spawn(exe, [String(pid)], {
            stdio: ["ignore", "pipe", "pipe"],
            shell: false,
            windowsHide: true,
        });
        this.encoder = encoder;
        this.capture = capture;

        let spawned = 0;
        const onSpawn = () => { if (++spawned === 2) this.emit("spawn"); };
        encoder.once("spawn", onSpawn);
        capture.once("spawn", onSpawn);
        encoder.on("error", (err) => this.fail("ffmpeg", err));
        capture.on("error", (err) => this.fail("process loopback", err));
        encoder.on("exit", (code, signal) => this.ended("ffmpeg", code, signal));
        capture.on("exit", (code, signal) => this.ended("process loopback", code, signal));

        // stdin の EPIPE は停止の途中で起きる。終了は exit で扱うので、ここでは握りつぶす。
        encoder.stdin?.on("error", () => { /* teardown 中の EPIPE */ });
        if (capture.stdout && encoder.stdin) capture.stdout.pipe(encoder.stdin);

        encoder.stderr?.on("data", (chunk: Buffer) => this.stderrLine("ffmpeg", chunk));
        capture.stderr?.on("data", (chunk: Buffer) => this.stderrLine("process loopback", chunk));
        log.info({ pid, rtpPort: opts.rtpPort }, "audio pipeline starting");
    }

    stop(): void {
        this.stopped = true;
        for (const proc of [this.capture, this.encoder]) {
            try { proc?.kill(); } catch { /* 既に終了していることがある。後始末なので best-effort */ }
        }
        this.capture = null;
        this.encoder = null;
    }

    private fail(name: string, err: Error): void {
        log.warn({ err: err.message, process: name }, "audio pipeline process error");
        this.emit("error", new Error(`${name}: ${err.message}`));
    }

    private ended(name: string, code: number | null, signal: NodeJS.Signals | null): void {
        if (this.stopped) return;
        log.info({ process: name, code, signal }, "audio pipeline process exited");
        this.stop();
        this.emit("exit", code, signal);
    }

    private stderrLine(name: string, chunk: Buffer): void {
        const text = chunk.toString("utf8").trim();
        if (!text) return;
        log.warn({ process: name, msg: text }, "audio pipeline stderr");
        this.emit("stderr", `${name}: ${text}`);
    }
}
