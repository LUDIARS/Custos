/**
 * 単発スクリーンショット (1 フレーム) を ffmpeg で取って PNG Buffer を返す。
 * リアルタイム配信 (webrtc-broker) とは独立した API 駆動の取り口。
 *
 * OS 別 input device:
 *   Windows: gdigrab (-i title=<windowTitle> または desktop)
 *   Linux  : x11grab
 *   macOS  : avfoundation
 */

import { spawn } from "node:child_process";
import { childLogger } from "../shared/logger.js";
import type { AppConfig } from "../config/apps-config.js";
import { FfmpegPipeline } from "./ffmpeg-pipeline.js";

const log = childLogger("screenshot");

const TIMEOUT_MS = 8_000;

export interface ShotResult {
    /** PNG raw bytes。 */
    png: Buffer;
}

/**
 * `app.capture` 設定に従って 1 フレーム取得する。capture 未設定 / ffmpeg 不在 /
 * ウィンドウ未発見など、いずれかの理由で失敗したら throw。
 */
export async function captureScreenshot(app: AppConfig): Promise<ShotResult> {
    if (!app.capture) {
        throw new Error(`app ${app.id} has no capture config`);
    }
    const args = buildArgs(app);
    log.info({ appId: app.id, args }, "screenshot spawn");

    return await new Promise<ShotResult>((resolveOuter, rejectOuter) => {
        const proc = spawn(FfmpegPipeline.binary(), args, {
            stdio: ["ignore", "pipe", "pipe"],
            shell: false,
            windowsHide: true,
        });
        const chunks: Buffer[] = [];
        let stderrTail = "";

        proc.stdout.on("data", (c: Buffer) => chunks.push(c));
        proc.stderr.on("data", (c: Buffer) => {
            // ffmpeg は info を stderr に吐く。失敗時の文脈用に末尾だけ保持。
            stderrTail = (stderrTail + c.toString("utf8")).slice(-2000);
        });

        const timer = setTimeout(() => {
            try { proc.kill("SIGKILL"); } catch { /* ignore */ }
            rejectOuter(new Error(`ffmpeg screenshot timeout (${TIMEOUT_MS}ms)`));
        }, TIMEOUT_MS);

        proc.on("error", (err) => {
            clearTimeout(timer);
            rejectOuter(new Error(`ffmpeg spawn failed: ${err.message}`));
        });

        proc.on("exit", (code) => {
            clearTimeout(timer);
            if (code === 0 && chunks.length > 0) {
                resolveOuter({ png: Buffer.concat(chunks) });
            } else {
                const tail = stderrTail.split("\n").slice(-5).join(" | ");
                rejectOuter(new Error(`ffmpeg exit ${code} — ${tail || "no stderr"}`));
            }
        });
    });
}

function buildArgs(app: AppConfig): string[] {
    const cap = app.capture!;
    const platform = process.platform;
    // 単発フレームなので framerate は 1 で十分。loglevel error で stderr ノイズを減らす。
    const out = [
        "-frames:v", "1",
        "-f", "image2pipe",
        "-vcodec", "png",
        "-",
    ];

    if (platform === "win32") {
        if (cap.type === "window" && cap.windowTitle) {
            return [
                "-loglevel", "error",
                "-f", "gdigrab",
                "-framerate", "1",
                "-i", `title=${cap.windowTitle}`,
                ...out,
            ];
        }
        return [
            "-loglevel", "error",
            "-f", "gdigrab",
            "-framerate", "1",
            "-i", "desktop",
            ...out,
        ];
    }
    if (platform === "linux") {
        return [
            "-loglevel", "error",
            "-f", "x11grab",
            "-framerate", "1",
            "-i", process.env.DISPLAY ?? ":0.0",
            ...out,
        ];
    }
    if (platform === "darwin") {
        return [
            "-loglevel", "error",
            "-f", "avfoundation",
            "-framerate", "1",
            "-i", process.env.CUSTOS_AVFOUNDATION_INPUT ?? "1:none",
            ...out,
        ];
    }
    throw new Error(`unsupported platform for screenshot: ${platform}`);
}
