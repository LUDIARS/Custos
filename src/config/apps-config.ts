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
    /**
     * snapshot モードの自動配信間隔 (秒)。subscribe 中の WS クライアントに
     * `{ type: "screenshot" }` フレームを N 秒ごとに push する。
     * `0` で auto-stream を無効化 (REST `POST /screenshot` は使える)。
     * 既定 1.0 秒。`apps.json` の数値か、起動時 env
     * `CUSTOS_SCREENSHOT_INTERVAL_SEC` で全アプリ一括上書き可。
     */
    intervalSec: z.number().min(0).max(60).default(1),
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

/// ergo_custos モジュール接続先 (後方互換用 — 内部パース専用)。
///
/// 外部には公開しない。apps.json の旧形式 `ergoCustos: {host, port}` を
/// 受理して `inAppBridge {kind:"ergo"}` に正規化するためだけに使う。
const ergoCustosSchema = z.object({
    host: z.string().default("127.0.0.1"),
    port: z.number().int().min(1).max(65535).default(5198),
});

/// アプリ内 HTTP ブリッジの接続設定 (汎用)。
///
/// protocol は ergo / Unity どちらも同一:
///   GET /screenshot         → PNG バイナリ
///   GET /stream?fps=<F>     → raw BGRA8 連続バイト列 (動画ストリーム)
///   POST /key               → body `{ code: int, down: bool }` (HID usage コード)
///
/// kind:
///   "ergo"  — ergo_custos モジュール。既定ポート 5198。
///             `ergo::custos::start({ port: 5198 })` が必要。
///   "unity" — Unity アプリ内ブリッジ。既定ポート 17778。
///             同プロトコルを実装した C# HTTP サーバが対象アプリ内で動く想定。
///             ※ PORT-MAP 上 5170-5199 は Vite dev レンジで不適。
///               Custos 17777 の隣 17778 を Unity ブリッジ既定に割り当て。
///
/// port を省略すると kind に応じた既定値が使われる。
///
/// fps — 動画ストリーム (`GET /stream`) 要求 fps。既定 24。
///       snapshot (`GET /screenshot`) には影響しない。
const inAppBridgeSchema = z.object({
    kind: z.enum(["ergo", "unity"]).default("ergo"),
    host: z.string().default("127.0.0.1"),
    port: z.number().int().min(1).max(65535).optional(),
    /** 動画ストリーム要求 fps (GET /stream?fps=<F>)。既定 24。 */
    fps:  z.number().int().min(1).max(120).default(24),
}).transform((v) => ({
    kind: v.kind,
    host: v.host,
    port: v.port ?? (v.kind === "unity" ? 17778 : 5198),
    fps:  v.fps,
}));

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
    /**
     * @deprecated `inAppBridge` を使う。
     * 後方互換のため受理し、`inAppBridge { kind: "ergo" }` に正規化する。
     * `inAppBridge` が同時に指定された場合は `inAppBridge` が優先される。
     */
    ergoCustos:  ergoCustosSchema.optional(),
    /** アプリ内 HTTP ブリッジ設定。設定すると screenshot / key inject をブリッジ経由で処理する。 */
    inAppBridge: inAppBridgeSchema.optional(),
    input:   inputSchema.default({ buttons: [], allowKeyboard: true, allowMouse: false }),
    logs:    logsSchema.default({ stdout: true, stderr: true, files: [] }),
}).transform((v) => {
    // ergoCustos (deprecated alias) を inAppBridge {kind:"ergo"} に正規化する。
    // inAppBridge が明示されていれば ergoCustos は無視 (inAppBridge 優先)。
    const bridge = v.inAppBridge
        ?? (v.ergoCustos
            // fps は ergoCustos schema にないので inAppBridge の既定値 24 を補填する。
            ? { kind: "ergo" as const, host: v.ergoCustos.host, port: v.ergoCustos.port, fps: 24 }
            : undefined);
    // ergoCustos を出力型から除去して正規化済み inAppBridge だけを残す。
    const { ergoCustos: _dropped, ...rest } = v;
    return { ...rest, inAppBridge: bridge };
});

export const appsRootSchema = z.object({
    version: z.literal(1).default(1),
    apps:    z.array(appConfigSchema),
});

export type AppConfig       = z.infer<typeof appConfigSchema>;
export type CmdConfig       = z.infer<typeof cmdSchema>;
export type AppsConfig      = z.infer<typeof appsRootSchema>;
export type InAppBridgeConfig = z.infer<typeof inAppBridgeSchema>;

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
