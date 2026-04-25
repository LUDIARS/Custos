/**
 * ffmpeg subprocess を使って画面 / ウィンドウを H.264 (Annex-B) で
 * 連続キャプチャし、stdout を NAL unit ストリームとして返す。
 *
 * OS 別 input device:
 *   Windows: -f gdigrab -i title=<windowTitle> もしくは desktop
 *   Linux  : -f x11grab -i $DISPLAY
 *   macOS  : -f avfoundation -i "1:none"  (display index)
 *
 * 出力は Annex-B (`-f h264 -bsf:v h264_mp4toannexb`) を一定 fps で吐かせる。
 * 受け取り側 (webrtc-broker) が NAL を切り出して MediaStreamTrack に
 * 流し込む。
 *
 * Phase 2 では window 型 (Windows) のみ実装、それ以外は warn を出して
 * `Point` Capture (placeholder) として扱う。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { childLogger } from "../shared/logger.js";
import type { AppConfig } from "../config/apps-config.js";

const log = childLogger("ffmpeg-capture");

export interface FfmpegEvents {
    "data":  (chunk: Buffer) => void;
    "error": (err: Error) => void;
    "exit":  (code: number | null, signal: NodeJS.Signals | null) => void;
}

export class FfmpegPipeline extends EventEmitter {
    private proc: ChildProcess | null = null;

    /** ffmpeg 実行ファイルへのパス。env で上書き可、既定は PATH の `ffmpeg`。 */
    static binary(): string {
        return process.env.CUSTOS_FFMPEG ?? "ffmpeg";
    }

    /** capture 設定がない / 不明な場合は throw。 */
    start(app: AppConfig): void {
        if (this.proc) throw new Error("ffmpeg pipeline already running");
        const cap = app.capture;
        if (!cap) throw new Error(`app ${app.id} has no capture config`);

        const args = this.buildArgs(app);
        log.info({ appId: app.id, args }, "spawn ffmpeg");

        this.proc = spawn(FfmpegPipeline.binary(), args, {
            stdio: ["ignore", "pipe", "pipe"],
            shell: false,
        });

        this.proc.stdout?.on("data", (chunk: Buffer) => this.emit("data", chunk));

        // ffmpeg は info ログを stderr に吐く。連続エラーで埋もれるのでデバッグ
        // 時のみ INFO 化、平時は debug にする。
        this.proc.stderr?.on("data", (chunk: Buffer) => {
            const text = chunk.toString("utf8");
            if (/error|Error|failed/i.test(text)) log.warn({ msg: text.trim() }, "ffmpeg stderr");
            else                                   log.debug({ msg: text.trim() }, "ffmpeg stderr");
        });

        this.proc.on("error", (err) => {
            log.warn({ err }, "ffmpeg spawn error");
            this.emit("error", err);
        });
        this.proc.on("exit", (code, signal) => {
            log.info({ code, signal }, "ffmpeg exited");
            this.emit("exit", code, signal);
            this.proc = null;
        });
    }

    stop(): void {
        if (!this.proc) return;
        try { this.proc.kill("SIGTERM"); } catch { /* ignore */ }
        this.proc = null;
    }

    private buildArgs(app: AppConfig): string[] {
        const cap = app.capture!;
        const fps = String(cap.fps);
        const preset = cap.preset || "veryfast";

        // 共通の出力側引数 (Annex-B + ベースライン + zerolatency + 30fps GOP)
        const out: string[] = [
            "-c:v",   "libx264",
            "-preset", preset,
            "-tune",  "zerolatency",
            "-profile:v", "baseline",
            "-pix_fmt", "yuv420p",
            "-bf",    "0",                 // B フレーム無し (低遅延)
            "-g",     String(Math.max(2, cap.fps)),  // 1 秒ごとに keyframe
            "-bsf:v", "h264_mp4toannexb",
            "-f",     "h264",
            "pipe:1",
        ];

        // 入力側 OS 別
        const platform = process.platform;
        if (platform === "win32") {
            // window 指定なら gdigrab title=、なければ desktop。
            if (cap.type === "window" && cap.windowTitle) {
                return [
                    "-f", "gdigrab",
                    "-framerate", fps,
                    "-i", `title=${cap.windowTitle}`,
                    ...out,
                ];
            }
            return [
                "-f", "gdigrab",
                "-framerate", fps,
                "-i", "desktop",
                ...out,
            ];
        }
        if (platform === "linux") {
            const display = process.env.DISPLAY ?? ":0.0";
            return [
                "-f", "x11grab",
                "-framerate", fps,
                "-i", display,
                ...out,
            ];
        }
        if (platform === "darwin") {
            // 1: 主ディスプレイ、none: 音声無し。デバイス id は環境ごとに異なる
            // ので env で上書き可。
            const dev = process.env.CUSTOS_AVFOUNDATION_INPUT ?? "1:none";
            return [
                "-f", "avfoundation",
                "-framerate", fps,
                "-i", dev,
                ...out,
            ];
        }
        log.warn({ platform }, "unsupported platform — ffmpeg args may not work");
        return [
            "-f", "lavfi",
            "-i", `testsrc=size=640x480:rate=${fps}`,
            ...out,
        ];
    }
}
