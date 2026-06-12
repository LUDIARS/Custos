/**
 * /ws — クライアントごとの session を保持する WS broker。
 *
 * - クライアントは hello 後に `subscribe { appId }` を送る
 * - 同 appId のログ・status 変更がそのクライアントに forward される
 * - クライアントから来た key/click/button は input forwarder に渡る
 *
 * 1 接続が複数 appId に subscribe してもよい (`Set<string>` で持つ)。
 * 認証は `?token=` で渡された Cernere JWT を将来的に verify する。MVP では
 * `CUSTOS_OPEN=1` のときに完全オープン、未設定なら token 必須 (verify は stub)。
 */

import type { Server as HttpServer, IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { childLogger } from "../shared/logger.js";
import type { AppsRegistry } from "../apps/registry.js";
import type { AppsRunner }   from "../apps/runner.js";
import type {
    ClientMessage,
    ServerMessage,
    AppStatus,
} from "../shared/types.js";
import { sendKey, sendClick } from "../input/forwarder.js";
import { getCernereAuth, type VerifiedUser } from "../auth/cernere-auth.js";
import type { ScreenshotStreamer, ScreenshotFrame } from "../capture/screenshot-stream.js";

const log = childLogger("ws");

interface Session {
    id:    string;
    ws:    WebSocket;
    appIds: Set<string>;
    user:  VerifiedUser;
}

export interface WsBrokerDeps {
    registry:   AppsRegistry;
    runner:     AppsRunner;
    streamer:   ScreenshotStreamer;
}

export function attachWebSocketBroker(
    httpServer: HttpServer,
    deps: WsBrokerDeps,
    path: string = "/ws",
): WebSocketServer {
    const wss = new WebSocketServer({ server: httpServer, path });
    const sessions = new Map<string, Session>();

    wss.on("connection", async (ws, req: IncomingMessage) => {
        const user = await authorize(req);
        if (!user) {
            ws.close(4401, "unauthorized");
            return;
        }
        const session: Session = {
            id: randomUUID(),
            ws,
            appIds: new Set(),
            user,
        };
        sessions.set(session.id, session);
        log.info({ sessionId: session.id, userId: user.id }, "ws connected");

        ws.on("message", (data, isBinary) => {
            if (isBinary) return;   // バイナリ未使用
            let msg: ClientMessage;
            try {
                msg = JSON.parse(String(data)) as ClientMessage;
            } catch {
                send(ws, { type: "error", message: "invalid JSON" });
                return;
            }
            handleClient(session, msg, deps).catch((err) => {
                log.warn({ err }, "client message handler failed");
                send(ws, { type: "error", message: errMsg(err) });
            });
        });

        ws.on("close", () => {
            // 切断 session が持っていた auto-stream 購読を一括 release。
            deps.streamer.releaseAll(session.id);
            sessions.delete(session.id);
            log.info({ sessionId: session.id }, "ws disconnected");
        });
    });

    // ── registry / runner からの broadcast ──
    deps.registry.on("status-changed", (appId: string, status: AppStatus) => {
        for (const s of sessions.values()) {
            if (s.appIds.has(appId)) send(s.ws, { type: "status", appId, status });
        }
    });

    deps.runner.on("log", (appId, kind, stream, text) => {
        const ts = Date.now();
        for (const s of sessions.values()) {
            if (s.appIds.has(appId)) send(s.ws, { type: "log", appId, kind, stream, text, ts });
        }
    });

    deps.runner.on("exit", (appId, kind, exitCode, signal) => {
        const ts = Date.now();
        for (const s of sessions.values()) {
            if (s.appIds.has(appId)) send(s.ws, { type: "exit", appId, kind, exitCode, signal, ts });
        }
    });

    // ── screenshot streamer からの自動配信 ──
    // capture / inAppBridge が設定された app に subscribe しているクライアント
    // 全員に N 秒ごとの PNG を base64 で push。binary フレームを使わないのは
    // 既存の app.js が JSON only で実装されているのを壊さないため。
    deps.streamer.on("frame", (frame: ScreenshotFrame) => {
        const png_b64 = frame.png.toString("base64");
        const bytes   = frame.png.length;
        for (const s of sessions.values()) {
            if (s.appIds.has(frame.appId)) {
                send(s.ws, {
                    type:    "screenshot",
                    appId:   frame.appId,
                    ts:      frame.ts,
                    png_b64,
                    mime:    "image/png",
                    bytes,
                });
            }
        }
    });

    return wss;
}

async function handleClient(
    session: Session,
    msg: ClientMessage,
    { registry, streamer }: WsBrokerDeps,
): Promise<void> {
    switch (msg.type) {
        case "subscribe": {
            const cfg = registry.getConfig(msg.appId);
            if (!cfg) {
                send(session.ws, { type: "error", message: `unknown appId: ${msg.appId}` });
                return;
            }
            session.appIds.add(msg.appId);
            const status = registry.getStatus(msg.appId);
            if (status) send(session.ws, { type: "hello", appId: msg.appId, status });
            // capture / inAppBridge 持ちの app は自動 stream を開始 (refcount)。
            streamer.acquire(cfg, session.id);
            return;
        }
        case "unsubscribe": {
            session.appIds.delete(msg.appId);
            streamer.release(msg.appId, session.id);
            return;
        }
        case "key": {
            const cfg = registry.getConfig(msg.appId);
            if (!cfg || !session.appIds.has(msg.appId)) return;
            await sendKey(cfg, msg.key, msg.down);
            return;
        }
        case "click": {
            const cfg = registry.getConfig(msg.appId);
            if (!cfg || !session.appIds.has(msg.appId)) return;
            await sendClick(cfg, msg.x, msg.y, msg.button);
            return;
        }
        case "button": {
            const cfg = registry.getConfig(msg.appId);
            if (!cfg || !session.appIds.has(msg.appId)) return;
            const btn = cfg.input.buttons.find((b) => labelToId(b.label) === msg.id);
            if (!btn) {
                send(session.ws, { type: "error", message: `unknown button: ${msg.id}` });
                return;
            }
            if (btn.action === "kill") {
                // kill は registry 経由で runner を呼びたいが、深い循環依存を避け
                // るため runner 経由は API から行う。WS button は API へリダイ
                // レクトする HTTP fetch を Frontend から発行する想定で、ここは
                // ログだけ出して noop にする (MVP)。
                send(session.ws, { type: "error", message: "use POST /api/apps/:id/kill for kill button" });
                return;
            }
            if (btn.key) {
                // 短い tap として press → release
                await sendKey(cfg, btn.key, true);
                await new Promise((r) => setTimeout(r, 50));
                await sendKey(cfg, btn.key, false);
            }
            return;
        }
    }
}

/** label → button id (label を kebab-case 化したもの)。 */
export function labelToId(label: string): string {
    return label.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
}

async function authorize(req: IncomingMessage): Promise<VerifiedUser | null> {
    // クエリ token を最優先 (ブラウザの WS は Authorization ヘッダを付けにくい)。
    // 次点で Authorization: Bearer ヘッダ。
    const url = new URL(req.url ?? "/", "http://localhost");
    const tok = url.searchParams.get("token")
        ?? (() => {
            const h = req.headers["authorization"];
            const m = typeof h === "string" ? /^Bearer\s+(.+)$/i.exec(h) : null;
            return m?.[1] ?? "";
        })();
    return await getCernereAuth().verify(tok);
}

function send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify(msg));
}

function errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
