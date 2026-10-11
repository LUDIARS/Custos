/**
 * /api/playlogs — 行動ログの一覧と取得 (spec/feature/remote-play-and-play-log.md §2.5)。
 */

import { Hono } from "hono";
import { listPlayLogs, readPlayLog } from "../playlog/playlog-store.js";

export interface PlayLogRoutesDeps {
    dir: string;
}

export function createPlayLogRoutes({ dir }: PlayLogRoutesDeps): Hono {
    const app = new Hono();

    app.get("/", (c) => {
        const appId = c.req.query("appId");
        return c.json({ logs: listPlayLogs(dir, appId === "" ? undefined : appId) });
    });

    app.get("/:appId/:run", (c) => {
        const body = readPlayLog(dir, c.req.param("appId"), c.req.param("run"));
        if (body === undefined) return c.json({ error: "not found" }, 404);
        return c.body(body, 200, { "content-type": "application/x-ndjson; charset=utf-8" });
    });

    return app;
}
