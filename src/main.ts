/**
 * Custos エントリポイント。
 *
 * Backend (API + WS) と Frontend (静的) を **別ポート** で立てる。
 *   既定: frontend 4649 / backend 7676
 *   override: CUSTOS_PORT (backend) / CUSTOS_FRONTEND_PORT (frontend)
 *
 * Frontend は `/config.js` で `window.__CUSTOS_BACKEND__ = ...` を注入する。
 * ブラウザ JS はこれを使って CORS 越しに backend を呼ぶ。
 *
 * Electron 経由で起動する場合は `electron/main.cjs` が frontend port に
 * BrowserWindow を向ける。
 */

import { serve } from "@hono/node-server";
import type { Server as HttpServer } from "node:http";
import { loadAppsConfig } from "./config/apps-config.js";
import { AppsRegistry }   from "./apps/registry.js";
import { AppsRunner }     from "./apps/runner.js";
import { buildBackendApp, buildFrontendApp } from "./app.js";
import { attachWebSocketBroker } from "./ws/handler.js";
import { WebRTCBroker } from "./capture/webrtc-broker.js";
import { logger } from "./shared/logger.js";

const BACKEND_PORT  = Number(process.env.CUSTOS_PORT ?? 7676);
const FRONTEND_PORT = Number(process.env.CUSTOS_FRONTEND_PORT ?? 4649);
const HOST          = process.env.CUSTOS_HOST ?? "0.0.0.0";

/// frontend が JS に注入する backend URL。明示指定が無ければ同ホストの BACKEND_PORT を指す。
const BACKEND_URL_FOR_BROWSER = process.env.CUSTOS_BACKEND_URL
    ?? `http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${BACKEND_PORT}`;

// 子プロセス由来の例外がメインを落とさないようにグローバル安全網を張る。
// ただし bind エラー (EADDRINUSE) や起動時に出るエラーは exit すべきなので、
// `started` フラグが立つまでは fail-fast、立った後は継続する。
let started = false;
process.on("uncaughtException", (err: Error & { code?: string }) => {
    if (!started || err.code === "EADDRINUSE") {
        logger.error({ err }, "fatal during startup");
        process.exit(1);
    }
    logger.error({ err }, "uncaughtException — server continues");
});
process.on("unhandledRejection", (reason) => {
    if (!started) {
        logger.error({ reason: String(reason) }, "fatal during startup (rejection)");
        process.exit(1);
    }
    logger.error({ reason: String(reason) }, "unhandledRejection — server continues");
});

async function main() {
    const cfg = loadAppsConfig();
    const authMode = process.env.CUSTOS_OPEN === "1"
        ? "open (CUSTOS_OPEN=1)"
        : process.env.CERNERE_URL
            ? `cernere (${process.env.CERNERE_URL})`
            : process.env.CUSTOS_AUTH_REQUIRED === "1"
                ? "stub (token required)"
                : "anonymous (no auth)";
    logger.info({ apps: cfg.apps.length, authMode }, "apps config loaded");

    const registry = new AppsRegistry(cfg.apps);
    const runner   = new AppsRunner(registry);
    const broker   = new WebRTCBroker();

    // run プロセス終了 → そのアプリの capture も閉じる。
    runner.on("exit", (appId, kind) => {
        if (kind === "run") broker.closeAllForApp(appId);
    });

    // ── Backend ──
    const backend = buildBackendApp({ registry, runner, broker });
    const backendServer = serve({ fetch: backend.fetch, hostname: HOST, port: BACKEND_PORT }, (info) => {
        logger.info({ host: info.address, port: info.port }, "backend listening");
    });
    attachWebSocketBroker(backendServer as unknown as HttpServer, { registry, runner }, "/ws");

    // ── Frontend ──
    const frontend = buildFrontendApp({ backendUrl: BACKEND_URL_FOR_BROWSER });
    const frontendServer = serve({ fetch: frontend.fetch, hostname: HOST, port: FRONTEND_PORT }, (info) => {
        logger.info({
            host: info.address, port: info.port,
            backendForBrowser: BACKEND_URL_FOR_BROWSER,
        }, "frontend listening");
        started = true;       // bind 成功後は uncaughtException で死なない
        // ブラウザで開く URL を判りやすく出す。
        // eslint-disable-next-line no-console
        console.log(`\n  ▶ Open Custos: http://localhost:${info.port}/\n`);
    });

    const shutdown = (sig: NodeJS.Signals) => {
        logger.info({ sig }, "shutting down");
        broker.shutdown();
        runner.shutdown();
        backendServer.close();
        frontendServer.close();
        setTimeout(() => process.exit(0), 200).unref();
        setTimeout(() => process.exit(1), 5000).unref();
    };
    process.on("SIGINT",  shutdown);
    process.on("SIGTERM", shutdown);
}

main().catch((err) => {
    logger.error({ err }, "fatal");
    process.exit(1);
});
