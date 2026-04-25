/**
 * apps.json (事前設定) の zod スキーマ + ローダ。
 *
 * 設定ファイルは `CUSTOS_APPS_FILE` (既定 `<cwd>/config/apps.json`)。
 * 起動時に検証してメモリに保持し、API は読み込み済みのレジストリだけを参照する。
 * ホットリロードはしない (現状)。変更したら Custos を再起動する運用。
 */

import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// ─── Schemas ────────────────────────────────────────────────

/// build / run / test それぞれの実行コマンド設定。
///
/// **作業ディレクトリ (working directory)** は build / run / test ごとに
/// 個別に指定できる。`workingDir` (推奨) と `cwd` (旧名・互換) のどちらか
/// 1 つを書く。両方書かれた場合は workingDir を優先。
///
/// `cmd` は次のいずれか:
///   - bare な実行ファイル名 (`adventurecube.exe` など) → workingDir 直下
///     の実体に解決される (`runner.ts:resolveBareExe`)。Windows で cmd.exe
///     経由だと PATH しか見ない問題の回避策
///   - 相対パス (`build/Debug/foo.exe`) → workingDir 起点で解決
///   - 絶対パス (`C:/tools/foo.exe`) → そのまま
///   - PATH 上のコマンド (`cmake` / `npm` / `git`) → spawn の解決に任せる
const cmdSchema = z.object({
    /** 作業ディレクトリ (working directory)。子プロセスの cwd に渡す。 */
    workingDir: z.string().min(1).optional(),
    /** workingDir の旧名 (alias、互換のため残す)。 */
    cwd:        z.string().min(1).optional(),
    cmd: z.string().min(1),
    args: z.array(z.string()).default([]),
    /** 環境変数の上書き。実行プロセスの env にマージされる。 */
    env: z.record(z.string()).default({}),
    /** タイムアウト (秒)。0/undefined は無制限。 */
    timeoutSec: z.number().int().nonnegative().optional(),
})
    .refine((v) => Boolean(v.workingDir || v.cwd), {
        message: "workingDir (or legacy `cwd`) is required",
        path:    ["workingDir"],
    })
    .transform((v) => {
        // workingDir / cwd を統合。runner からは常に `cwd` を見れば良い。
        const dir = v.workingDir ?? v.cwd ?? "";
        return { ...v, workingDir: dir, cwd: dir };
    });

const captureSchema = z.object({
    type: z.enum(["window", "fullscreen", "android"]),
    /** 特定ウィンドウのタイトル (window 型)。 */
    windowTitle: z.string().optional(),
    /** Android adb device serial (android 型)。空なら最初の認可済 device。 */
    androidSerial: z.string().optional(),
    fps: z.number().int().min(1).max(60).default(30),
    /** ffmpeg preset (encoder dependent)。 */
    preset: z.string().default("veryfast"),
});

const buttonSchema = z.object({
    label: z.string().min(1),
    /** key 押下系。`key` 値は nut-js の Key enum 名 (例: "W", "Space") か文字。 */
    key: z.string().optional(),
    /** action 系。"kill" / "screenshot" 等の名前付き動作。 */
    action: z.enum(["kill", "screenshot", "noop"]).optional(),
}).refine((v) => Boolean(v.key) !== Boolean(v.action), {
    message: "button must specify exactly one of `key` or `action`",
});

const inputSchema = z.object({
    /** バーチャルキー定義。Frontend で 1 つ 1 つボタンとして表示する。 */
    buttons: z.array(buttonSchema).default([]),
    allowKeyboard: z.boolean().default(true),
    allowMouse:    z.boolean().default(false),
});

const logsSchema = z.object({
    stdout: z.boolean().default(true),
    stderr: z.boolean().default(true),
    /** 監視対象の追加ログファイル (tail)。MVP では未実装、将来の拡張点。 */
    files: z.array(z.string()).default([]),
});

export const appConfigSchema = z.object({
    id:    z.string().regex(/^[a-z0-9][a-z0-9-]*$/i, "id は英数字 + ハイフン"),
    name:  z.string().min(1),
    description: z.string().optional(),
    /** android なら adb 経由、desktop なら native subprocess。 */
    target: z.enum(["desktop", "android"]).default("desktop"),

    build:   cmdSchema.optional(),
    run:     cmdSchema,
    test:    cmdSchema.optional(),
    capture: captureSchema.optional(),
    input:   inputSchema.default({ buttons: [], allowKeyboard: true, allowMouse: false }),
    logs:    logsSchema.default({ stdout: true, stderr: true, files: [] }),
});

export const appsRootSchema = z.object({
    version: z.literal(1).default(1),
    apps:    z.array(appConfigSchema),
});

export type AppConfig  = z.infer<typeof appConfigSchema>;
export type CmdConfig  = z.infer<typeof cmdSchema>;
export type AppsConfig = z.infer<typeof appsRootSchema>;

// ─── Loader ─────────────────────────────────────────────────

export interface LoadOptions {
    file?: string;
}

/** apps.json を同期読み込み + 検証して返す。 */
export function loadAppsConfig(opts: LoadOptions = {}): AppsConfig {
    const file = opts.file
        ?? process.env.CUSTOS_APPS_FILE
        ?? resolve(process.cwd(), "config", "apps.json");

    if (!existsSync(file)) {
        // 設定ファイル無しでも空アプリ群で起動できるように
        return { version: 1, apps: [] };
    }
    const raw = readFileSync(file, "utf8");
    const obj = JSON.parse(raw) as unknown;
    const parsed = appsRootSchema.parse(obj);

    // id 一意性 (zod では catch しにくいので手動)
    const ids = new Set<string>();
    for (const a of parsed.apps) {
        if (ids.has(a.id)) {
            throw new Error(`duplicate app id: ${a.id}`);
        }
        ids.add(a.id);
    }
    return parsed;
}
