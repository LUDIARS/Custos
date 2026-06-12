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
import { fetchScreenshot }   from "../capture/ergo-custos-client.js";
import { getRtcDiagnostics } from "../capture/webrtc-broker.js";

export interface RtcRoutesDeps {
    registry: AppsRegistry;
    broker:   WebRTCBroker;
}

export function createRtcRoutes({ registry, broker }: RtcRoutesDeps) {
    const r = new Hono();

    /// POST /api/apps/:id/screenshot
    /// 単発スクリーンショット。レスポンスは image/png バイナリ。
    /// リアルタイム配信 (rtc/*) と独立しているのでどちらでも使える。
    ///
    /// 経路:
    ///   1. `app.inAppBridge` が設定されていれば、アプリ内 HTTP ブリッジ
    ///      (`/screenshot`) を叩く (ergo / Unity どちらも同一プロトコル)。
    ///      低レイテンシ + window フォーカスや title マッチ無関係。
    ///   2. それ以外は `app.capture` を使ってホスト ffmpeg gdigrab/
    ///      x11grab/avfoundation で取る (legacy path)。
    r.post("/:id/screenshot", async (c) => {
        const id  = c.req.param("id");
        const cfg = registry.getConfig(id);
        if (!cfg) return c.json({ error: "unknown app" }, 404);

        try {
            let png: Buffer;
            if (cfg.inAppBridge) {
                png = await fetchScreenshot(cfg.inAppBridge);
            } else if (cfg.capture) {
                const r = await captureScreenshot(cfg);
                png = r.png;
            } else {
                return c.json({ error: "app has neither inAppBridge nor capture config" }, 400);
            }
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
        // capture (gdigrab) か inAppBridge (bridge-stream) のどちらか一方が必要。
        if (!cfg.capture && !cfg.inAppBridge) {
            return c.json({ error: "app has neither capture nor inAppBridge config" }, 400);
        }

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

    /// GET /api/apps/_/rtc/diagnostic
    /// 直近 10 セッションぶんの WebRTC 診断情報を返す。映像が出ない原因の
    /// 切り分けに使う (ffmpeg stderr / pc 状態遷移 / RTP 受信数 / SDP 行数)。
    r.get("/_/rtc/diagnostic", (c) => {
        return c.json({ sessions: getRtcDiagnostics() });
    });

    return r;
}
