/**
 * ffmpeg subprocess を使って画面 / ウィンドウを H.264 でキャプチャし、
 * RFC 6184 / 3984 RTP パケットを UDP に送る。
 *
 * 受け取り側 (webrtc-broker) は dgram で datagram = 1 RTP パケットとして
 * 受信し、werift の `MediaStreamTrack.writeRtp(buffer)` に渡す。werift が
 * peer に転送するときは payload type を track の codec に合わせて書き換える
 * ので、ffmpeg 側の payload_type は適当 (96) で良い。
 *
 * OS 別 input device:
 *   Windows: -f gdigrab -i title=<windowTitle> もしくは desktop
 *   Linux  : -f x11grab -i $DISPLAY
 *   macOS  : -f avfoundation -i "1:none"
 *
 * 旧 stdout (Annex-B) 経路は werift に直接喋れず、独自 RTP パケタイザが必要
 * だったため廃止した。ffmpeg の `-f rtp` を使う方が依存ゼロで済む。
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { childLogger } from "../shared/logger.js";
import type { AppConfig } from "../config/apps-config.js";

const log = childLogger("ffmpeg-capture");

// ─── encoder selection ──────────────────────────────────────────
// 既定は **auto-detect**: ffmpeg の `-encoders` 一覧に h264_nvenc があれば NVENC、
// 無ければ libx264 にフォールバック。`CUSTOS_VIDEO_ENCODER` で `nvenc` / `x264` /
// `amf` / `qsv` / `auto` を強制指定可能。
type Encoder = "nvenc" | "x264" | "amf" | "qsv";

let resolvedEncoder: Encoder | null = null;
/// 実際に短い encode を 1 回試して通った encoder を採用する。
///
/// `-encoders` 一覧に出るだけでは不十分: NVIDIA driver の API mismatch
/// (driver が古くて ffmpeg の要求する NVENC API バージョンを満たさない、
/// 等) は実 encode を試さないと検出できない。
function probeEncoder(enc: Encoder): boolean {
    const testArgs = [
        "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "color=c=red:size=320x240:rate=10",
        "-frames:v", "5",
        "-pix_fmt", "yuv420p",
        "-c:v", encoderCodec(enc),
        "-f", "null", "-",
    ];
    try {
        const r = spawnSync(FfmpegPipeline.binary(), testArgs, {
            stdio: ["ignore", "ignore", "pipe"],
            shell: false,
            timeout: 8000,
        });
        if (r.status !== 0) {
            const err = r.stderr?.toString("utf8") ?? "";
            log.info({ encoder: enc, status: r.status, err: err.slice(-200).trim() },
                     "encoder probe failed");
            return false;
        }
        return true;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.info({ encoder: enc, err: msg }, "encoder probe threw");
        return false;
    }
}

function encoderCodec(enc: Encoder): string {
    switch (enc) {
        case "nvenc": return "h264_nvenc";
        case "amf":   return "h264_amf";
        case "qsv":   return "h264_qsv";
        case "x264":  return "libx264";
    }
}

/// 外から「今 auto-detect された encoder は何か」を問い合わせる。lazy 評価。
export function getResolvedEncoder(): Encoder {
    return resolveEncoder();
}

function resolveEncoder(): Encoder {
    if (resolvedEncoder) return resolvedEncoder;
    const force = (process.env.CUSTOS_VIDEO_ENCODER ?? "auto").toLowerCase();
    if (force === "nvenc" || force === "x264" || force === "amf" || force === "qsv") {
        resolvedEncoder = force;
        log.info({ encoder: force, mode: "forced" }, "video encoder selected (forced — no probe)");
        return resolvedEncoder;
    }

    // auto: ハード優先で probe、最後の砦は libx264。
    const order: Encoder[] = ["nvenc", "qsv", "amf", "x264"];
    for (const enc of order) {
        if (probeEncoder(enc)) {
            resolvedEncoder = enc;
            log.info({ encoder: enc, mode: "auto" }, "video encoder selected (probed)");
            return resolvedEncoder;
        }
    }
    resolvedEncoder = "x264";
    log.warn({ encoder: "x264", mode: "fallback" }, "no encoder probe succeeded — using libx264");
    return resolvedEncoder;
}

/// 指定エンコーダ用の ffmpeg 引数 (encode 部のみ。muxer / 入力は別)。
function encoderArgs(enc: Encoder, fps: number, bitrateBps: number): string[] {
    const gop  = String(Math.max(2, fps));   // 1 秒 GOP (keyframe interval)
    const kbps = Math.round(bitrateBps / 1000);
    const max  = Math.round(kbps * 1.5);

    if (enc === "nvenc") {
        // 低遅延 H.264 baseline: NVENC SDK 9+ の `tune=ll` (low-latency) preset。
        // p4 はバランス、p1 が最速 (品質ガタガタ)。
        return [
            "-c:v",        "h264_nvenc",
            "-preset",     "p4",
            "-tune",       "ll",
            "-rc",         "vbr",
            "-cq",         "28",
            "-b:v",        `${kbps}k`,
            "-maxrate",    `${max}k`,
            "-profile:v",  "baseline",
            "-pix_fmt",    "yuv420p",
            "-bf",         "0",
            "-g",          gop,
        ];
    }
    if (enc === "amf") {
        // AMD 用。usage=ultralowlatency が WebRTC 系 preset。
        return [
            "-c:v",        "h264_amf",
            "-usage",      "ultralowlatency",
            "-quality",    "speed",
            "-rc",         "vbr_peak",
            "-b:v",        `${kbps}k`,
            "-maxrate",    `${max}k`,
            "-profile:v",  "baseline",
            "-pix_fmt",    "yuv420p",
            "-bf",         "0",
            "-g",          gop,
        ];
    }
    if (enc === "qsv") {
        return [
            "-c:v",        "h264_qsv",
            "-preset",     "veryfast",
            "-b:v",        `${kbps}k`,
            "-maxrate",    `${max}k`,
            "-profile:v",  "baseline",
            "-pix_fmt",    "yuv420p",
            "-bf",         "0",
            "-g",          gop,
        ];
    }
    // x264 fallback (CPU)。
    return [
        "-c:v",        "libx264",
        "-preset",     "veryfast",
        "-tune",       "zerolatency",
        "-profile:v",  "baseline",
        "-level",      "3.1",
        "-pix_fmt",    "yuv420p",
        "-b:v",        `${kbps}k`,
        "-maxrate",    `${max}k`,
        "-bufsize",    `${kbps}k`,
        "-bf",         "0",
        "-g",          gop,
    ];
}

export interface FfmpegStartOptions {
    /** ffmpeg が RTP を送る先のホスト (受信は dgram で listen)。既定 127.0.0.1。 */
    rtpHost?: string;
    /** ffmpeg が RTP を送る先のポート (UDP)。webrtc-broker が割り当てる。 */
    rtpPort: number;
    /** RTP payload type。werift 側で書き換えるので 96 固定で問題ない。 */
    payloadType?: number;
}

export class FfmpegPipeline extends EventEmitter {
    private proc: ChildProcess | null = null;

    /** ffmpeg 実行ファイルへのパス。env で上書き可、既定は PATH の `ffmpeg`。 */
    static binary(): string {
        return process.env.CUSTOS_FFMPEG ?? "ffmpeg";
    }

    /** capture 設定がない / 不明な場合は throw。 */
    start(app: AppConfig, opts: FfmpegStartOptions): void {
        if (this.proc) throw new Error("ffmpeg pipeline already running");
        const cap = app.capture;
        if (!cap) throw new Error(`app ${app.id} has no capture config`);

        const args = this.buildArgs(app, opts);
        log.info({ appId: app.id, args }, "spawn ffmpeg (rtp)");

        this.proc = spawn(FfmpegPipeline.binary(), args, {
            stdio: ["ignore", "ignore", "pipe"],
            shell: false,
        });

        // ffmpeg は info ログを stderr に吐く。エラー検出用に warn 上げる。
        this.proc.stderr?.on("data", (chunk: Buffer) => {
            const text = chunk.toString("utf8").trim();
            if (!text) return;
            if (/error|Error|failed|Could not/i.test(text)) {
                log.warn({ msg: text }, "ffmpeg stderr");
                this.emit("stderr", text);
            } else {
                log.debug({ msg: text }, "ffmpeg stderr");
            }
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

    private buildArgs(app: AppConfig, opts: FfmpegStartOptions): string[] {
        const cap = app.capture!;
        const fps = String(cap.fps);
        const rtpHost = opts.rtpHost ?? "127.0.0.1";
        const rtpPort = opts.rtpPort;
        const pt      = opts.payloadType ?? 96;

        const enc        = resolveEncoder();
        const bitrateBps = Number(process.env.CUSTOS_VIDEO_BITRATE ?? 4_000_000);
        const encArgs    = encoderArgs(enc, cap.fps, bitrateBps);

        // 出力側 muxer: RTP。pkt_size=1200 で MTU 抑制。
        const out: string[] = [
            "-an",
            ...encArgs,
            "-payload_type", String(pt),
            "-f",     "rtp",
            `rtp://${rtpHost}:${rtpPort}?pkt_size=1200`,
        ];

        const platform = process.platform;
        if (platform === "win32") {
            if (cap.type === "window" && cap.windowTitle) {
                return [
                    "-loglevel", "warning",
                    "-f", "gdigrab",
                    "-framerate", fps,
                    "-i", `title=${cap.windowTitle}`,
                    ...out,
                ];
            }
            return [
                "-loglevel", "warning",
                "-f", "gdigrab",
                "-framerate", fps,
                "-i", "desktop",
                ...out,
            ];
        }
        if (platform === "linux") {
            const display = process.env.DISPLAY ?? ":0.0";
            return [
                "-loglevel", "warning",
                "-f", "x11grab",
                "-framerate", fps,
                "-i", display,
                ...out,
            ];
        }
        if (platform === "darwin") {
            const dev = process.env.CUSTOS_AVFOUNDATION_INPUT ?? "1:none";
            return [
                "-loglevel", "warning",
                "-f", "avfoundation",
                "-framerate", fps,
                "-i", dev,
                ...out,
            ];
        }
        log.warn({ platform }, "unsupported platform — using lavfi testsrc");
        return [
            "-loglevel", "warning",
            "-f", "lavfi",
            "-i", `testsrc=size=640x480:rate=${fps}`,
            ...out,
        ];
    }
}
