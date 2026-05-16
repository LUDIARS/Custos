/**
 * Hono アプリの組み立て。HTTP サーバーは main.ts が起こす。
 *
 * Custos は **単一 Hono アプリ**で静的ファイル・REST API・WebSocket を
 * すべてサーブする。同 origin で動かすことで CORS / 別ポート別 origin の
 * 罠 (preflight 拒否、credentials 設定の食い違い、ブラウザキャッシュ) を
 * まとめて排除する。`main.ts` がこのアプリを 4649 と 7676 両方で listen
 * させて「どちらを開いても同じ内容」を保証する。
 */

import { Hono } from "hono";
import { logger as honoLogger } from "hono/logger";
import { serveStatic } from "@hono/node-server/serve-static";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createAppsRoutes }     from "./routes/apps-routes.js";
import { createRtcRoutes }      from "./routes/rtc-routes.js";
import { createSettingsRoutes } from "./routes/settings-routes.js";
import { cernereAuthMiddleware } from "./auth/middleware.js";
import type { AppsRegistry } from "./apps/registry.js";
import type { AppsRunner }   from "./apps/runner.js";
import type { WebRTCBroker } from "./capture/webrtc-broker.js";
import type { RuntimeStreamPrefs } from "./runtime/stream-prefs.js";
import { getResolvedEncoder } from "./capture/ffmpeg-pipeline.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface AppDeps {
    registry: AppsRegistry;
    runner:   AppsRunner;
    broker:   WebRTCBroker;
    prefs:    RuntimeStreamPrefs;
}

export function buildApp({ registry, runner, broker, prefs }: AppDeps) {
    const app = new Hono();

    app.use("*", honoLogger());

    // 開発時のキャッシュ完全無効化。古い app.js が残るとデバッグが噛み合わない。
    app.use("*", async (c, next) => {
        await next();
        // Hono の Response は一部 path で immutable なので header 追加だけ試す。
        try {
            c.header("Cache-Control", "no-store, no-cache, must-revalidate");
            c.header("Pragma",        "no-cache");
        } catch { /* immutable response — skip */ }
    });

    // /api/health は認証不要 (監視 / Electron readiness 用)。
    app.get("/api/health", (c) => c.json({
        status:  "ok",
        service: "custos",
        version: "0.1.0",
        apps:    registry.listConfigs().length,
    }));

    // /api/video/encoder — 現在採用されている H.264 encoder を返す
    // (`nvenc` / `qsv` / `amf` / `x264`)。初回呼び出しで probe が走る (~数秒)。
    app.get("/api/video/encoder", (c) => c.json({
        encoder: getResolvedEncoder(),
        forced:  Boolean(process.env.CUSTOS_VIDEO_ENCODER),
    }));

    // 認証必須エンドポイント (CUSTOS_OPEN=1 で素通し)。
    app.use("/api/apps/*", cernereAuthMiddleware());
    app.route("/api/apps", createAppsRoutes({ registry, runner }));
    app.route("/api/apps", createRtcRoutes({ registry, broker }));

    // /api/settings/* — runtime 上書き面 (設定タブ)。
    app.use("/api/settings/*", cernereAuthMiddleware());
    app.route("/api/settings", createSettingsRoutes({ prefs }));

    // 静的ファイル。tsx で動かすときも dist 経由のときも src/ の隣の public/ を見る。
    const publicRoot = resolve(__dirname, "..", "public");
    app.use("/*", serveStatic({ root: relativeFromCwd(publicRoot) }));

    return app;
}

function relativeFromCwd(abs: string): string {
    const cwd = process.cwd();
    if (abs.startsWith(cwd)) {
        return "./" + abs.slice(cwd.length).replace(/^[\\/]+/, "").replace(/\\/g, "/");
    }
    return abs;
}
