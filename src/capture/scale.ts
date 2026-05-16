/**
 * `scalePngBuffer(png, maxWidth)` — PNG バッファを ffmpeg pipe に通して
 * 横幅 max を抑える。アスペクト比は保持。`maxWidth` が 0 / undefined / 入力
 * 幅以下なら **元バッファを即返す** (subprocess は起こさない)。
 *
 * sharp 等の native 依存を増やさないためにわざと ffmpeg を再利用している。
 * 1 fps スナップショットなら subprocess 起動コスト (~50–150ms) は許容範囲。
 * 高 fps 配信が必要になったら sharp に差し替える前提。
 */

import { spawn } from "node:child_process";
import { childLogger } from "../shared/logger.js";
import { FfmpegPipeline } from "./ffmpeg-pipeline.js";

const log = childLogger("scale");
const TIMEOUT_MS = 8_000;

/// PNG マジックバイトと IHDR からピクセル幅を抜く。失敗したら undefined。
/// (PNG IHDR は固定オフセット — magic 8 bytes + chunk_len 4 + chunk_type 4 = 16 bytes 目から
///  width が big-endian 32-bit。)
export function readPngWidth(buf: Buffer): number | undefined {
    if (buf.length < 24) return undefined;
    if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4E || buf[3] !== 0x47) return undefined;
    return buf.readUInt32BE(16);
}

export async function scalePngBuffer(input: Buffer, maxWidth: number | undefined): Promise<Buffer> {
    if (!maxWidth || maxWidth <= 0) return input;
    const w = readPngWidth(input);
    if (w !== undefined && w <= maxWidth) return input; // 既に十分小さい

    const args = [
        "-hide_banner", "-loglevel", "error",
        "-f", "image2pipe", "-vcodec", "png", "-i", "pipe:0",
        // min(maxWidth, iw):-1 でアスペクト維持。`fast_bilinear` は速さ優先。
        // -1 で偶数制約は不要 (PNG なので自由)。
        "-vf", `scale='min(${maxWidth},iw)':-1:flags=fast_bilinear`,
        "-frames:v", "1",
        "-f", "image2pipe", "-vcodec", "png",
        "pipe:1",
    ];

    return await new Promise<Buffer>((resolve, reject) => {
        const proc = spawn(FfmpegPipeline.binary(), args, {
            stdio: ["pipe", "pipe", "pipe"],
            shell: false,
            windowsHide: true,
        });
        const chunks: Buffer[] = [];
        let stderrTail = "";

        proc.stdout.on("data", (c: Buffer) => chunks.push(c));
        proc.stderr.on("data", (c: Buffer) => {
            stderrTail = (stderrTail + c.toString("utf8")).slice(-1500);
        });

        const timer = setTimeout(() => {
            try { proc.kill("SIGKILL"); } catch { /* ignore */ }
            reject(new Error(`ffmpeg scale timeout (${TIMEOUT_MS}ms)`));
        }, TIMEOUT_MS);

        proc.on("error", (err) => {
            clearTimeout(timer);
            reject(new Error(`ffmpeg scale spawn failed: ${err.message}`));
        });

        proc.on("exit", (code) => {
            clearTimeout(timer);
            if (code === 0 && chunks.length > 0) {
                const out = Buffer.concat(chunks);
                log.debug({ inBytes: input.length, outBytes: out.length, maxWidth }, "scaled");
                resolve(out);
            } else {
                const tail = stderrTail.split("\n").slice(-3).join(" | ");
                reject(new Error(`ffmpeg scale exit ${code} — ${tail || "no stderr"}`));
            }
        });

        // input を flush して即 EOF
        proc.stdin.end(input);
    });
}
