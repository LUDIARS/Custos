/**
 * /api/apps — REST 制御面。
 *
 * 副作用 (build/run/kill) はすべてここに集約する。状態はレジストリに、
 * 操作の即時応答は opId を返すだけで、完了は WS で通知される。
 */

import { Hono } from "hono";
import type { AppsRegistry } from "../apps/registry.js";
import type { AppsRunner }   from "../apps/runner.js";

export interface AppsRoutesDeps {
    registry: AppsRegistry;
    runner:   AppsRunner;
}

export function createAppsRoutes({ registry, runner }: AppsRoutesDeps) {
    const r = new Hono();

    /// アプリ一覧 (UI のセレクタを埋めるため、status も同梱)。
    r.get("/", (c) => {
        const items = registry.listConfigs().map((cfg) => ({
            config: redact(cfg),
            status: registry.getStatus(cfg.id),
        }));
        return c.json({ apps: items });
    });

    r.get("/:id", (c) => {
        const id  = c.req.param("id");
        const cfg = registry.getConfig(id);
        if (!cfg) return c.json({ error: "unknown app" }, 404);
        return c.json({
            config: redact(cfg),
            status: registry.getStatus(id),
        });
    });

    r.get("/:id/status", (c) => {
        const id  = c.req.param("id");
        const st  = registry.getStatus(id);
        if (!st) return c.json({ error: "unknown app" }, 404);
        return c.json(st);
    });

    r.post("/:id/build", (c) => {
        const id  = c.req.param("id");
        const cfg = registry.getConfig(id);
        if (!cfg) return c.json({ error: "unknown app" }, 404);
        try {
            const opId = runner.startBuild(cfg);
            return c.json({ ok: true, buildId: opId });
        } catch (err) {
            return c.json({ ok: false, error: errMsg(err) }, 409);
        }
    });

    r.post("/:id/run", (c) => {
        const id  = c.req.param("id");
        const cfg = registry.getConfig(id);
        if (!cfg) return c.json({ error: "unknown app" }, 404);
        try {
            const opId = runner.startRun(cfg);
            return c.json({ ok: true, runId: opId, pid: runner.getRunPid(id) ?? null });
        } catch (err) {
            return c.json({ ok: false, error: errMsg(err) }, 409);
        }
    });

    r.post("/:id/test", (c) => {
        const id  = c.req.param("id");
        const cfg = registry.getConfig(id);
        if (!cfg) return c.json({ error: "unknown app" }, 404);
        try {
            const opId = runner.startTest(cfg);
            return c.json({ ok: true, testId: opId });
        } catch (err) {
            return c.json({ ok: false, error: errMsg(err) }, 409);
        }
    });

    r.post("/:id/kill", (c) => {
        const id = c.req.param("id");
        if (!registry.getConfig(id)) return c.json({ error: "unknown app" }, 404);
        const ok = runner.kill(id);
        return c.json({ ok });
    });

    return r;
}

/** AppConfig のうち UI に出してよい情報だけを抜く (env / cwd の細部を表面に
 *  出すと運用上ノイズなので)。 */
function redact(cfg: import("../config/apps-config.js").AppConfig) {
    return {
        id:          cfg.id,
        name:        cfg.name,
        description: cfg.description ?? "",
        target:      cfg.target,
        hasBuild:    Boolean(cfg.build),
        hasTest:     Boolean(cfg.test),
        capture:     cfg.capture
            ? { type: cfg.capture.type, fps: cfg.capture.fps }
            : null,
        input:       cfg.input,   // buttons は UI が読むので公開
    };
}

function errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
