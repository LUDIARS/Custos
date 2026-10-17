/**
 * /ws — クライアントごとの session を保持する WS broker。
 *
 * - クライアントは hello 後に `subscribe { appId }` を送る
 * - 同 appId のログ・status 変更がそのクライアントに forward される
 * - クライアントから来た key/click/button は input forwarder に渡る
 *
 * 1 接続が複数 appId に subscribe してもよい (`Set<string>` で持つ)。
 *
 * 入力 (key/click/pointer/button) は app の操作権を持つ接続だけが送れる。誰も持って
 * いなければ最初の入力で操作権を取り、他の接続は観戦者として入力を無視される
 * (src/input/control-lease.ts)。
 * 認証は `?token=` で渡された Cernere JWT を将来的に verify する。MVP では
 * `CUSTOS_OPEN=1` のときに完全オープン、未設定なら token 必須 (verify は stub)。
 */

import type { Server as HttpServer, IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { AudienceRoom, AudienceSubmission } from "../audience/room.js";
import { childLogger } from "../shared/logger.js";
import type { AppsRegistry } from "../apps/registry.js";
import type { AppsRunner }   from "../apps/runner.js";
import type {
    ClientMessage,
    ServerMessage,
    AppStatus,
} from "../shared/types.js";
import { sendKey, sendClick, sendPointer } from "../input/forwarder.js";
import type { PlayLogRecorder } from "../playlog/playlog-recorder.js";
import { isPointerMessage } from "./pointer-message.js";
import { canPostComment, isCommentMessage, normalizeCommentText } from "./comment-message.js";
import { getCernereAuth, type VerifiedUser } from "../auth/cernere-auth.js";
import type { ScreenshotStreamer, ScreenshotFrame } from "../capture/screenshot-stream.js";
import type { ControlLease } from "../input/control-lease.js";

const log = childLogger("ws");

interface Session {
    id:    string;
    ws:    WebSocket;
    appIds: Set<string>;
    audienceAppIds: Set<string>;
    lastAudienceAt: number | null;
    user:  VerifiedUser;
    /** 最後に感想を送った時刻 (連投の制限用)。 */
    lastCommentAt: number | null;
}

export interface WsBrokerDeps {
    registry:   AppsRegistry;
    runner:     AppsRunner;
    streamer:   ScreenshotStreamer;
    /** 行動ログ。未指定なら記録しない。 */
    playLog?:   PlayLogRecorder;
    audienceNow?: () => number;
    audience?: AudienceRoom;
    /** 遠隔プレイの操作権。全ポートの broker と REST で共有する。 */
    control:    ControlLease;
}

export function attachWebSocketBroker(
    httpServer: HttpServer,
    deps: WsBrokerDeps,
    path: string = "/ws",
): WebSocketServer {
    const wss = new WebSocketServer({ server: httpServer, path });
    const sessions = new Map<string, Session>();
    const audience = deps.audience ?? new AudienceRoom(deps.audienceNow);
    const releaseAudience = audience.subscribe((event) => {
        for (const session of sessions.values()) {
            if (session.audienceAppIds.has(event.appId)) send(session.ws, { type: "audience-event", appId: event.appId, event });
        }
    });
    wss.on("close", releaseAudience);

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
            audienceAppIds: new Set(),
            lastAudienceAt: null,
            user,
            lastCommentAt: null,
        };
        sessions.set(session.id, session);
        log.info({ sessionId: session.id, userId: user.id }, "ws connected");
        send(ws, { type: "welcome", clientId: session.id });

        ws.on("message", (data, isBinary) => {
            if (isBinary) return;   // バイナリ未使用
            let msg: ClientMessage;
            try {
                msg = JSON.parse(String(data)) as ClientMessage;
            } catch {
                send(ws, { type: "error", message: "invalid JSON" });
                return;
            }
            if (!msg || typeof msg !== "object") {
                send(ws, { type: "error", message: "invalid message" });
                return;
            }
            handleClient(session, msg, deps, audience, broadcastToApp).catch((err) => {
                log.warn({ err }, "client message handler failed");
                send(ws, { type: "error", message: errMsg(err) });
            });
        });

        ws.on("close", () => {
            // 切断 session が持っていた auto-stream 購読を一括 release。
            deps.streamer.releaseAll(session.id);
            deps.playLog?.closeSession(session.id, "disconnect");
            deps.control.releaseAll(session.id);
            sessions.delete(session.id);
            log.info({ sessionId: session.id }, "ws disconnected");
        });
    });

    /** その app を subscribe している全接続へ送る。 */
    function broadcastToApp(appId: string, message: ServerMessage): void {
        for (const s of sessions.values()) {
            if (s.appIds.has(appId)) send(s.ws, message);
        }
    }

    // ── 操作権の変化を、その app を見ている全接続へ (接続ごとに役割が違う) ──
    const onControlChanged = (appId: string) => {
        for (const s of sessions.values()) {
            if (s.appIds.has(appId)) send(s.ws, { type: "control", appId, role: deps.control.roleOf(appId, s.id) });
        }
    };
    deps.control.on("changed", onControlChanged);
    wss.on("close", () => deps.control.off("changed", onControlChanged));

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
    { registry, streamer, playLog, control, audienceNow = Date.now }: WsBrokerDeps,
    audience: AudienceRoom,
    broadcastToApp: (appId: string, message: ServerMessage) => void,
): Promise<void> {
    switch (msg.type) {
        case "audience-send": {
            const parsed = AudienceSubmission.safeParse(msg);
            if (!parsed.success || !session.appIds.has(parsed.data.appId)) {
                send(session.ws, { type: "error", message: "invalid audience message or subscription" });
                return;
            }
            const now = audienceNow();
            if (session.lastAudienceAt !== null && now - session.lastAudienceAt < 750) {
                send(session.ws, { type: "error", message: "少し待ってから送信してください。" });
                return;
            }
            session.lastAudienceAt = now;
            const sender = ["anon", "dev-anon", "stub"].includes(session.user.id)
                ? `観戦者 ${session.id.slice(0, 4)}` : session.user.name || "観戦者";
            audience.append(parsed.data, sender);
            if (parsed.data.kind === "message") playLog?.recordComment(parsed.data.appId, session.user.id, parsed.data.text);
            return;
        }
        case "audience-subscribe": {
            if (typeof msg.appId !== "string" || !registry.getConfig(msg.appId)) {
                send(session.ws, { type: "error", message: "unknown audience app" });
                return;
            }
            session.audienceAppIds.add(msg.appId);
            send(session.ws, { type: "audience-history", appId: msg.appId, events: audience.history(msg.appId) });
            return;
        }
        case "subscribe": {
            const cfg = registry.getConfig(msg.appId);
            if (!cfg) {
                send(session.ws, { type: "error", message: `unknown appId: ${msg.appId}` });
                return;
            }
            session.appIds.add(msg.appId);
            session.audienceAppIds.add(msg.appId);
            send(session.ws, { type: "audience-history", appId: msg.appId, events: audience.history(msg.appId) });
            const status = registry.getStatus(msg.appId);
            if (status) send(session.ws, { type: "hello", appId: msg.appId, status });
            send(session.ws, { type: "control", appId: msg.appId, role: control.roleOf(msg.appId, session.id) });
            // capture / inAppBridge 持ちの app は自動 stream を開始 (refcount)。
            streamer.acquire(cfg, session.id);
            return;
        }
        case "unsubscribe": {
            session.appIds.delete(msg.appId);
            session.audienceAppIds.delete(msg.appId);
            streamer.release(msg.appId, session.id);
            playLog?.closeSessionApp(session.id, msg.appId, "unsubscribe");
            control.release(msg.appId, session.id);
            return;
        }
        case "control": {
            if (!session.appIds.has(msg.appId)) return;
            if (msg.want) {
                // 取れなかった (他の接続がプレイ中) ときは、観戦者であることを本人に返す。
                if (!control.acquire(msg.appId, session.id)) {
                    send(session.ws, { type: "control", appId: msg.appId, role: "spectator" });
                }
            } else {
                control.release(msg.appId, session.id);
            }
            return;
        }
        case "comment": {
            // 感想は操作権に関係なく、その app を見ている接続なら送れる (UI は観戦者にだけ出す)。
            if (!isCommentMessage(msg) || !session.appIds.has(msg.appId)) return;
            const text = normalizeCommentText(msg.text);
            if (text === null) {
                send(session.ws, { type: "error", message: "comment must be 1-200 characters" });
                return;
            }
            const now = Date.now();
            if (!canPostComment(session.lastCommentAt, now)) return;   // 連投は黙って捨てる
            session.lastCommentAt = now;
            broadcastToApp(msg.appId, { type: "comment", appId: msg.appId, text, ts: now });
            audience.append({ type: "audience-send", appId: msg.appId, kind: "message", text }, "観戦者");
            playLog?.recordComment(msg.appId, session.user.id, text);
            return;
        }
        case "key": {
            const cfg = registry.getConfig(msg.appId);
            if (!cfg || !session.appIds.has(msg.appId)) return;
            if (!control.acquire(msg.appId, session.id)) return;   // 観戦中の入力は捨てる
            if (cfg.input.allowKeyboard) {
                playLog?.recordInput(session.id, session.user.id, msg.appId, { device: "key", key: msg.key, down: msg.down });
            }
            await sendKey(cfg, msg.key, msg.down);
            return;
        }
        case "click": {
            const cfg = registry.getConfig(msg.appId);
            if (!cfg || !session.appIds.has(msg.appId)) return;
            if (!control.acquire(msg.appId, session.id)) return;   // 観戦中の入力は捨てる
            await sendClick(cfg, msg.x, msg.y, msg.button);
            return;
        }
        case "pointer": {
            if (!isPointerMessage(msg)) {
                send(session.ws, { type: "error", message: "invalid pointer message" });
                return;
            }
            const cfg = registry.getConfig(msg.appId);
            if (!cfg || !session.appIds.has(msg.appId)) return;
            if (!control.acquire(msg.appId, session.id)) return;   // 観戦中の入力は捨てる
            if (cfg.input.allowMouse) {
                playLog?.recordInput(session.id, session.user.id, msg.appId, {
                    device: "pointer", x: msg.x, y: msg.y, button: msg.button, phase: msg.phase,
                });
            }
            await sendPointer(cfg, msg.x, msg.y, msg.button, msg.phase);
            return;
        }
        case "button": {
            const cfg = registry.getConfig(msg.appId);
            if (!cfg || !session.appIds.has(msg.appId)) return;
            if (!control.acquire(msg.appId, session.id)) return;   // 観戦中の入力は捨てる
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
                playLog?.recordInput(session.id, session.user.id, msg.appId, { device: "button", id: msg.id });
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
