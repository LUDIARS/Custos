/**
 * プロセス音声の取り込みプログラム (process-loopback/ProcessLoopback.cs) を用意する。
 *
 * C# のソースを Windows 標準の csc.exe で初回にビルドし、OS の一時ディレクトリに置いて使い回す。
 * ファイル名にソースのハッシュを含めるので、ソースが変われば自動で作り直す。
 * Windows 以外・csc が無い・ビルド失敗は、音声を黙って諦めず理由付きのエラーにする。
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { childLogger } from "../shared/logger.js";

const log = childLogger("process-loopback");
const __dirname = dirname(fileURLToPath(import.meta.url));

/** src/capture からも dist/capture からも、リポの src にあるソースを指す。 */
const SOURCE_PATH = resolve(__dirname, "..", "..", "src", "capture", "process-loopback", "ProcessLoopback.cs");
const BUILD_TIMEOUT_MS = 60_000;

let building: Promise<string> | null = null;

/** 取り込みプログラムの実行ファイルのパス。無ければビルドする (同時呼び出しは 1 回にまとめる)。 */
export function ensureProcessLoopbackExe(): Promise<string> {
    building ??= build().catch((err: unknown) => {
        building = null;   // 失敗は覚えない。原因 (csc など) を直したら次の呼び出しで作り直せるように
        throw err;
    });
    return building;
}

async function build(): Promise<string> {
    if (process.platform !== "win32") {
        throw new Error("音声 (process-loopback) は Windows でだけ使えます");
    }
    const source = readFileSync(SOURCE_PATH);
    const hash = createHash("sha256").update(source).digest("hex").slice(0, 12);
    const exe = join(tmpdir(), `custos-process-loopback-${hash}.exe`);
    if (existsSync(exe)) return exe;

    const csc = cscPath();
    log.info({ csc, exe }, "building process loopback helper");
    await new Promise<void>((resolvePromise, reject) => {
        execFile(
            csc,
            ["-nologo", "-optimize+", "-platform:x64", `-out:${exe}`, SOURCE_PATH],
            { timeout: BUILD_TIMEOUT_MS, windowsHide: true },
            (err, stdout) => {
                if (err) reject(new Error(`ProcessLoopback.cs のビルドに失敗しました: ${stdout.trim() || err.message}`));
                else resolvePromise();
            },
        );
    });
    return exe;
}

/** .NET Framework 4 の csc。Windows 10 / 11 には標準で入っている。 */
function cscPath(): string {
    const windir = process.env.WINDIR ?? process.env.SystemRoot;
    if (!windir) throw new Error("WINDIR が未設定のため csc.exe を探せません");
    const csc = join(windir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
    if (!existsSync(csc)) throw new Error(`csc.exe が見つかりません (${csc})。.NET Framework 4 が必要です`);
    return csc;
}
