/**
 * /api/settings/* — 設定タブから叩かれる runtime 上書き面。
 *
 * 永続化はしない (Custos 再起動でデフォルトに戻る)。設定タブはここを
 * GET / PUT して RuntimeStreamPrefs を更新するだけ。実際に効くのは
 * ScreenshotStreamer が `prefs.on('change')` を購読しているから。
 */

import { Hono } from "hono";
import { streamPrefsPatchSchema, type RuntimeStreamPrefs } from "../runtime/stream-prefs.js";

export interface SettingsRoutesDeps {
    prefs: RuntimeStreamPrefs;
}

export function createSettingsRoutes({ prefs }: SettingsRoutesDeps) {
    const r = new Hono();

    r.get("/stream", (c) => {
        return c.json({ ok: true, prefs: prefs.get() });
    });

    /// PUT /stream — fields:
    ///   intervalSec: number (秒, 0 で auto-stream off) | null (apps.json 既定に戻す)
    ///   maxWidth:    number (横ピクセル上限, 0 で無制限) | null (元解像度のまま)
    /// 未指定フィールドは触らない (PATCH セマンティクス)。
    r.put("/stream", async (c) => {
        const body = await c.req.json().catch(() => null);
        if (!body || typeof body !== "object") {
            return c.json({ ok: false, error: "invalid JSON" }, 400);
        }
        const parsed = streamPrefsPatchSchema.safeParse(body);
        if (!parsed.success) {
            return c.json({ ok: false, error: parsed.error.message }, 400);
        }
        const next = prefs.apply(parsed.data);
        return c.json({ ok: true, prefs: next });
    });

    return r;
}
