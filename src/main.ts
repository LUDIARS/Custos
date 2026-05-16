/**
 * Custos エントリポイント。
 *
 * **単一 Hono アプリを 4649 と 7676 の両方で listen** させる:
 *   - http://localhost:4649/  (frontend port、慣例)
 *   - http://localhost:7676/  (backend port、慣例)
 *   - どちらを開いても同じ内容 (静的 UI + /api/* + /ws)
 *
 * これにより CORS / 別 origin の罠を完全排除する。フロント JS は相対 URL
 * (`/api/...` / `/ws`) だけ使えばよく、`/config.js` 注入も不要。
 *
 * ポートは `CUSTOS_PORT` (主) と `CUSTOS_FRONTEND_PORT` (副) で上書きでき、
 * どちらか片方だけ無効化したい場合は値を `0` にする。
 */

import { serve } from "@hono/node-server";
import type { Server as HttpServer } from "node:http";
import { loadAppsConfig } from "./config/apps-config.js";
import { AppsRegistry }   from "./apps/registry.js";
import { AppsRunner }     from "./apps/runner.js";
import { buildApp }       from "./app.js";
import { attachWebSocketBroker } from "./ws/handler.js";
import { WebRTCBroker } from "./capture/webrtc-broker.js";
import { ScreenshotStreamer } from "./capture/screenshot-stream.js";
import { RuntimeStreamPrefs } from "./runtime/stream-prefs.js";
import { logger } from "./shared/logger.js";

const BACKEND_PORT  = Number(process.env.CUSTOS_PORT          ?? 7676);
const FRONTEND_PORT = Number(process.env.CUSTOS_FRONTEND_PORT ?? 4649);
const HOST          = process.env.CUSTOS_HOST                  ?? "0.0.0.0";

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
    const prefs    = new RuntimeStreamPrefs();
    const streamer = new ScreenshotStreamer(registry, prefs);

    runner.on("exit", (appId, kind) => {
        if (kind === "run") {
            broker.closeAllForApp(appId);
            // アプリ終了で auto-stream も止める。再起動後 subscribe があれば
            // streamer.acquire 経由で再開される。
            streamer.stop(appId);
        }
    });

    // 単一の app instance を 2 ポートで listen させる。
    const app = buildApp({ registry, runner, broker, prefs });
    const servers: HttpServer[] = [];

    const ports: { port: number; label: string }[] = [];
    if (FRONTEND_PORT > 0) ports.push({ port: FRONTEND_PORT, label: "frontend" });
    if (BACKEND_PORT  > 0 && BACKEND_PORT !== FRONTEND_PORT) {
        ports.push({ port: BACKEND_PORT, label: "backend" });
    }

    for (const { port, label } of ports) {
        const s = serve({ fetch: app.fetch, hostname: HOST, port }, (info) => {
            logger.info({ host: info.address, port: info.port, label }, "listening");
        });
        // WS broker は全ポートで attach する (どちらに繋いでも /ws が動く)。
        attachWebSocketBroker(s as unknown as HttpServer, { registry, runner, streamer }, "/ws");
        servers.push(s as unknown as HttpServer);
    }

    started = true;

    // eslint-disable-next-line no-console
    console.log(`\n  ▶ Open Custos: http://localhost:${FRONTEND_PORT}/   (or http://localhost:${BACKEND_PORT}/)\n`);

    const shutdown = (sig: NodeJS.Signals) => {
        logger.info({ sig }, "shutting down");
        broker.shutdown();
        streamer.shutdown();
        runner.shutdown();
        for (const s of servers) {
            try { s.close(); } catch { /* ignore */ }
        }
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
