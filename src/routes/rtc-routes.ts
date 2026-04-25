/**
 * /api/apps/:id/rtc/* — WebRTC SDP exchange と session lifecycle。
 *
 * Frontend は `RTCPeerConnection` を作って `offer` をここに POST、
 * 返ってきた `answer` を `setRemoteDescription` する。サーバー側は
 * 1 PC = 1 ffmpeg pipeline で配信。
 *
 * 経路は apps-routes と同じく "/api/apps" 配下にマウントするので、
 * パスは `/:id/rtc/offer` / `/:id/rtc/close` としてオフセットを揃える。
 */

import { Hono } from "hono";
import type { AppsRegistry } from "../apps/registry.js";
import type { WebRTCBroker } from "../capture/webrtc-broker.js";
import { captureScreenshot } from "../capture/screenshot.js";

export interface RtcRoutesDeps {
    registry: AppsRegistry;
    broker:   WebRTCBroker;
}

export function createRtcRoutes({ registry, broker }: RtcRoutesDeps) {
    const r = new Hono();

    /// POST /api/apps/:id/screenshot
    /// 単発スクリーンショット。レスポンスは image/png バイナリ。
    /// リアルタイム配信 (rtc/*) と独立しているのでどちらでも使える。
    r.post("/:id/screenshot", async (c) => {
        const id  = c.req.param("id");
        const cfg = registry.getConfig(id);
        if (!cfg) return c.json({ error: "unknown app" }, 404);
        if (!cfg.capture) return c.json({ error: "app has no capture config" }, 400);

        try {
            const { png } = await captureScreenshot(cfg);
            return new Response(png, {
                status: 200,
                headers: {
                    "content-type":  "image/png",
                    "content-length": String(png.length),
                    "cache-control": "no-store",
                },
            });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return c.json({ ok: false, error: msg }, 500);
        }
    });

    /** POST /api/apps/:id/rtc/offer { sdp } → { sessionId, sdp, type } */
    r.post("/:id/rtc/offer", async (c) => {
        const id = c.req.param("id");
        const cfg = registry.getConfig(id);
        if (!cfg) return c.json({ error: "unknown app" }, 404);
        if (!cfg.capture) return c.json({ error: "app has no capture config" }, 400);

        const body = await c.req.json<{ sdp?: string }>();
        if (!body.sdp) return c.json({ error: "sdp required" }, 400);

        try {
            const { sessionId, answer } = await broker.createSession(cfg, body.sdp);
            return c.json({ ok: true, sessionId, sdp: answer.sdp, type: answer.type });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return c.json({ ok: false, error: msg }, 500);
        }
    });

    /** POST /api/apps/:id/rtc/close { sessionId } */
    r.post("/:id/rtc/close", async (c) => {
        const body = await c.req.json<{ sessionId?: string }>();
        if (!body.sessionId) return c.json({ error: "sessionId required" }, 400);
        const ok = broker.closeSession(body.sessionId);
        return c.json({ ok });
    });

    return r;
}
