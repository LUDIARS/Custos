/**
 * Hono アプリの組み立て。HTTP サーバーは main.ts が起こす。
 */

import { Hono } from "hono";
import { cors }   from "hono/cors";
import { logger as honoLogger } from "hono/logger";
import { serveStatic } from "@hono/node-server/serve-static";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createAppsRoutes } from "./routes/apps-routes.js";
import type { AppsRegistry } from "./apps/registry.js";
import type { AppsRunner }   from "./apps/runner.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface BuildAppDeps {
    registry: AppsRegistry;
    runner:   AppsRunner;
}

export function buildApp({ registry, runner }: BuildAppDeps) {
    const app = new Hono();

    app.use("*", honoLogger());
    app.use("*", cors({ origin: process.env.CORS_ORIGIN ?? "*", credentials: true }));

    app.get("/api/health", (c) => c.json({
        status:  "ok",
        service: "custos",
        version: "0.1.0",
        apps:    registry.listConfigs().length,
    }));

    app.route("/api/apps", createAppsRoutes({ registry, runner }));

    // 静的ファイル (frontend)。tsx で動かすときは src/ の隣の public/ を、
    // dist 経由のときは <dist>/.. の public/ を見る。process.cwd() 基準にして
    // どちらでも使えるようにする。
    const publicRoot = resolve(__dirname, "..", "public");
    app.use("/*", serveStatic({ root: relativeFromCwd(publicRoot) }));

    return app;
}

function relativeFromCwd(abs: string): string {
    // hono serve-static は cwd 相対が安定するのでここで変換する。
    const cwd = process.cwd();
    if (abs.startsWith(cwd)) {
        return "./" + abs.slice(cwd.length).replace(/^[\\/]+/, "").replace(/\\/g, "/");
    }
    return abs;
}
