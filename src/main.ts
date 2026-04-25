/**
 * Custos エントリポイント。
 *
 *   1. apps.json を読み込み
 *   2. AppsRegistry / AppsRunner / WebRTCBroker を組み立てる
 *   3. Hono アプリを HTTP サーバーに乗せる
 *   4. /ws の WebSocket broker を attach する
 *
 * Electron 経由で起動する場合は `electron/main.cjs` がこのモジュールを
 * spawn して開いた window から localhost に接続する想定。
 */

import { serve } from "@hono/node-server";
import { loadAppsConfig } from "./config/apps-config.js";
import { AppsRegistry }   from "./apps/registry.js";
import { AppsRunner }     from "./apps/runner.js";
import { buildApp }       from "./app.js";
import { attachWebSocketBroker } from "./ws/handler.js";
import { WebRTCBroker } from "./capture/webrtc-broker.js";
import { logger } from "./shared/logger.js";

const PORT = Number(process.env.CUSTOS_PORT ?? process.env.PORT ?? 5180);
const HOST = process.env.CUSTOS_HOST ?? "0.0.0.0";

async function main() {
    const cfg = loadAppsConfig();
    logger.info({ apps: cfg.apps.length }, "apps config loaded");

    const registry = new AppsRegistry(cfg.apps);
    const runner   = new AppsRunner(registry);
    const broker   = new WebRTCBroker();

    // run プロセス終了 → そのアプリの capture も閉じる。
    runner.on("exit", (appId, kind) => {
        if (kind === "run") broker.closeAllForApp(appId);
    });

    const app = buildApp({ registry, runner, broker });

    const server = serve({ fetch: app.fetch, hostname: HOST, port: PORT }, (info) => {
        logger.info({ host: info.address, port: info.port }, "custos http server listening");
    });

    attachWebSocketBroker(server as unknown as import("node:http").Server, { registry, runner }, "/ws");

    const shutdown = (sig: NodeJS.Signals) => {
        logger.info({ sig }, "shutting down");
        broker.shutdown();
        runner.shutdown();
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(1), 5000).unref();
    };
    process.on("SIGINT",  shutdown);
    process.on("SIGTERM", shutdown);
}

main().catch((err) => {
    logger.error({ err }, "fatal");
    process.exit(1);
});
