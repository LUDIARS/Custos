/**
 * Hono アプリの組み立て。HTTP サーバーは main.ts が起こす。
 *
 * Custos は backend (API + WS) と frontend (静的ファイル) を **別ポート**
 * で動かす運用 (デフォルト 4649 / 7676)。frontend 側は `/config.js` で
 * `window.__CUSTOS_BACKEND__` を注入し、ブラウザ JS は CORS 越しで
 * backend を呼ぶ。同一プロセス内に 2 つ Hono を立てるだけなので
 * orchestration コストはゼロ。
 */

import { Hono } from "hono";
import { cors }   from "hono/cors";
import { logger as honoLogger } from "hono/logger";
import { serveStatic } from "@hono/node-server/serve-static";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createAppsRoutes } from "./routes/apps-routes.js";
import { createRtcRoutes }  from "./routes/rtc-routes.js";
import { cernereAuthMiddleware } from "./auth/middleware.js";
import type { AppsRegistry } from "./apps/registry.js";
import type { AppsRunner }   from "./apps/runner.js";
import type { WebRTCBroker } from "./capture/webrtc-broker.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Backend (API + WS) ────────────────────────────────────

export interface BackendDeps {
    registry: AppsRegistry;
    runner:   AppsRunner;
    broker:   WebRTCBroker;
}

export function buildBackendApp({ registry, runner, broker }: BackendDeps) {
    const app = new Hono();

    app.use("*", honoLogger());
    // CORS: frontend (4649) と backend (7676) の origin が違うので必須。
    // credentials:true + origin:"*" の組合せはブラウザに拒否される
    // (Access-Control-Allow-Origin: * と Access-Control-Allow-Credentials: true
    // が同居できない仕様)。CORS_ORIGIN 未設定時は credentials OFF にする。
    // Bearer ヘッダだけで認証しているので Cookie は不要。
    const corsOrigin = process.env.CORS_ORIGIN ?? "*";
    const useCredentials = corsOrigin !== "*" && corsOrigin !== "";
    app.use("*", cors({
        origin:       corsOrigin,
        credentials:  useCredentials,
        allowHeaders: ["content-type", "authorization"],
        allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    }));

    // /api/health は認証不要 (監視 / Electron readiness 用)。
    app.get("/api/health", (c) => c.json({
        status:  "ok",
        service: "custos",
        version: "0.1.0",
        apps:    registry.listConfigs().length,
    }));

    // 認証必須エンドポイント (CUSTOS_OPEN=1 で素通し、CERNERE_URL 未設定なら token 非空)。
    app.use("/api/apps/*", cernereAuthMiddleware());
    app.route("/api/apps", createAppsRoutes({ registry, runner }));
    app.route("/api/apps", createRtcRoutes({ registry, broker }));

    return app;
}

// ─── Frontend (static) ─────────────────────────────────────

export interface FrontendDeps {
    /** ブラウザ JS が API を叩くための backend URL。空文字なら同 origin/api。 */
    backendUrl: string;
}

export function buildFrontendApp({ backendUrl }: FrontendDeps) {
    const app = new Hono();
    app.use("*", honoLogger());

    // 開発時はキャッシュ無効化 (ブラウザに古い app.js が残るとデバッグが
    // 噛み合わなくなるため)。production で外部 CDN に乗せるならこのヘッダ
    // は外す前提だが、Custos は dev box ローカルツールなので no-store 固定。
    app.use("*", async (c, next) => {
        await next();
        c.header("Cache-Control", "no-store, no-cache, must-revalidate");
        c.header("Pragma",        "no-cache");
    });

    // /config.js — ブラウザに backend URL を渡す。index.html から先読みする。
    app.get("/config.js", (c) => c.text(
        `window.__CUSTOS_BACKEND__ = ${JSON.stringify(backendUrl)};\n`,
        200,
        { "content-type": "application/javascript; charset=utf-8" },
    ));

    // /api/health (frontend 単体での readiness 用、backend を呼ばずに即返す)。
    app.get("/api/health", (c) => c.json({ status: "ok", service: "custos-frontend" }));

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
