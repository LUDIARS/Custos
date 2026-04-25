/**
 * WebRTC peer connection broker。
 *
 * フロー:
 *   1. ブラウザ from offer SDP
 *   2. werift PC を作る (codec H.264 を明示)、sendonly トランシーバ追加
 *   3. UDP listener を起動 (ランダムポート、127.0.0.1)
 *   4. ffmpeg を `-f rtp rtp://127.0.0.1:<port>` で起動 → RTP datagram が
 *      UDP listener に届く
 *   5. datagram = 1 RTP packet を `track.writeRtp(buf)` に流し込む
 *   6. werift が peer に転送
 *
 * 旧来の「Annex-B NAL を直接 writeRtp に渡す」アプローチは werift が
 * H.264 RTP packetizer を提供しないため動かなかった。ffmpeg の RTP muxer
 * (RFC 6184 準拠) を使うのが最短。
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import dgram, { type Socket as DgramSocket } from "node:dgram";
import { childLogger } from "../shared/logger.js";
import type { AppConfig } from "../config/apps-config.js";
import { FfmpegPipeline } from "./ffmpeg-pipeline.js";

const log = childLogger("webrtc-broker");

/// 診断用: 過去 10 セッションぶんのトレース。`/api/apps/:id/rtc/diagnostic` から見られる。
interface SessionDiag {
    sessionId:       string;
    appId:           string;
    createdAt:       number;
    closedAt?:       number;
    rtpPort:         number;
    rtpReceived:     number;
    firstRtpAtMs?:   number;
    pcStates:        string[];
    iceStates:       string[];
    ffmpegStderr:    string[];
    answerSdpLines:  number;
}
const DIAG_HISTORY_MAX = 10;
const diagHistory: SessionDiag[] = [];

export function getRtcDiagnostics(): SessionDiag[] {
    return diagHistory.slice().reverse();
}

interface RTCRtpCodecParametersLike {
    new (props: {
        mimeType:    string;
        clockRate:   number;
        payloadType: number;
        rtcpFeedback?: { type: string; parameter?: string }[];
        parameters?:  string;
    }): unknown;
}

interface PCLike {
    addTransceiver:       (trackOrKind: unknown, options?: { direction?: string }) => unknown;
    createAnswer:         () => Promise<{ sdp: string; type: string }>;
    setLocalDescription:  (desc: { sdp: string; type: string }) => Promise<void>;
    setRemoteDescription: (desc: { sdp: string; type: string }) => Promise<void>;
    localDescription:     { sdp: string; type: string } | null;
    close:                () => void;
    connectionState:      string;
    on?:                  (ev: string, cb: (v: unknown) => void) => void;
    iceGatheringStateChange?: { subscribe: (cb: (s: string) => void) => void };
}

interface MediaTrackLike {
    kind:     string;
    writeRtp: (rtp: Buffer) => void;
}

interface WeriftLike {
    RTCPeerConnection:        new (config?: unknown) => PCLike;
    MediaStreamTrack:         new (init: { kind: "video" | "audio"; codec?: unknown }) => MediaTrackLike;
    RTCRtpCodecParameters:    RTCRtpCodecParametersLike;
}

let weriftPromise: Promise<WeriftLike | null> | null = null;
async function getWerift(): Promise<WeriftLike | null> {
    if (!weriftPromise) {
        weriftPromise = (async () => {
            try {
                const mod = await import("werift") as unknown as WeriftLike;
                if (!mod.RTCPeerConnection || !mod.MediaStreamTrack || !mod.RTCRtpCodecParameters) {
                    log.warn("werift loaded but API unexpected");
                    return null;
                }
                return mod;
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                log.warn({ msg }, "werift not available");
                return null;
            }
        })();
    }
    return weriftPromise;
}

interface CaptureSession {
    id:          string;
    appId:       string;
    pc:          PCLike;
    track:       MediaTrackLike;
    pipeline:    FfmpegPipeline;
    udp:         DgramSocket;
    rtpPort:     number;
    createdAt:   number;
    rtpReceived: number;
    diag:        SessionDiag;
}

export interface BrokerEvents {
    "session-closed": (sessionId: string) => void;
}

export class WebRTCBroker extends EventEmitter {
    private sessions = new Map<string, CaptureSession>();

    /** werift が使えるか + capture 設定があるかの事前チェック。 */
    async available(): Promise<boolean> {
        return Boolean(await getWerift());
    }

    /**
     * offer を受け取って answer を返す。session id は内部で生成し、
     * client は次の close 呼び出しで使う。
     */
    async createSession(app: AppConfig, offerSdp: string): Promise<{ sessionId: string; answer: { sdp: string; type: string } }> {
        if (!app.capture) throw new Error(`app ${app.id} has no capture config`);
        const w = await getWerift();
        if (!w) throw new Error("werift not available");

        // H.264 baseline を明示。WebRTC 標準の payload_type 96 + level-asymmetry-allowed=1
        // + packetization-mode=1 + profile-level-id=42e01f (baseline 3.1)。
        const h264 = new w.RTCRtpCodecParameters({
            mimeType:    "video/H264",
            clockRate:   90000,
            payloadType: 96,
            parameters:  "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
            rtcpFeedback: [
                { type: "nack" },
                { type: "nack", parameter: "pli" },
                { type: "ccm",  parameter: "fir" },
                { type: "goog-remb" },
            ],
        });

        const pc = new w.RTCPeerConnection({
            codecs: { video: [h264] },
        });

        // codec を track にも紐付けると writeRtp が payloadType=96 に rewrite する。
        const track = new w.MediaStreamTrack({ kind: "video", codec: h264 });
        pc.addTransceiver(track, { direction: "sendonly" });

        const sessionId = randomUUID();
        const diag: SessionDiag = {
            sessionId, appId: app.id, createdAt: Date.now(),
            rtpPort: 0, rtpReceived: 0,
            pcStates: [], iceStates: [], ffmpegStderr: [],
            answerSdpLines: 0,
        };

        // ── UDP listener (ffmpeg が送ってくる RTP) ──────────────────
        const udp = dgram.createSocket("udp4");
        const rtpPort = await new Promise<number>((resolveOuter, rejectOuter) => {
            udp.once("error", rejectOuter);
            udp.bind({ address: "127.0.0.1", port: 0 }, () => {
                const a = udp.address();
                if (typeof a === "string" || !a) {
                    rejectOuter(new Error("udp bind: no address"));
                    return;
                }
                resolveOuter(a.port);
            });
        });

        diag.rtpPort = rtpPort;

        let rtpReceived = 0;
        udp.on("message", (msg) => {
            try {
                track.writeRtp(msg);
                rtpReceived++;
                diag.rtpReceived = rtpReceived;
                if (rtpReceived === 1) {
                    diag.firstRtpAtMs = Date.now() - diag.createdAt;
                    log.info({ sessionId, firstRtpAtMs: diag.firstRtpAtMs, size: msg.length },
                             "first RTP datagram arrived");
                } else if (rtpReceived % 60 === 0) {
                    log.info({ sessionId, rtpReceived, lastSize: msg.length },
                             "RTP forwarded");
                }
            } catch (err) {
                const msgErr = err instanceof Error ? err.message : String(err);
                log.warn({ err: msgErr, sessionId, datagramSize: msg.length },
                         "writeRtp failed");
            }
        });
        udp.on("error", (err) => {
            log.warn({ err: err.message, sessionId }, "udp socket error");
        });

        // ── PC state hooks ───────────────────────────────────────
        const onState = (state: string) => {
            diag.pcStates.push(`${Date.now() - diag.createdAt}ms:${state}`);
            log.info({ sessionId, state, pcStateHistory: diag.pcStates }, "pc state");
            if (state === "failed" || state === "disconnected" || state === "closed") {
                this.closeSession(sessionId);
            }
        };
        // werift の event 購読は version で違うので両対応。
        const pcAny = pc as unknown as Record<string, unknown>;
        if (typeof pc.on === "function") {
            pc.on("connectionstatechange", () => onState(pc.connectionState));
        }
        // ICE 状態変化も購読 (werift 0.22+ は Event objects を expose する)。
        const subscribe = (key: string, cb: (v: string) => void) => {
            const ev = pcAny[key] as { subscribe?: (cb: (v: string) => void) => void } | undefined;
            if (ev && typeof ev.subscribe === "function") {
                ev.subscribe(cb);
            }
        };
        subscribe("iceGatheringStateChange", (s) => {
            diag.iceStates.push(`${Date.now() - diag.createdAt}ms:gather=${s}`);
            log.info({ sessionId, iceGatheringState: s }, "ice gathering state");
        });
        subscribe("iceConnectionStateChange", (s) => {
            diag.iceStates.push(`${Date.now() - diag.createdAt}ms:conn=${s}`);
            log.info({ sessionId, iceConnectionState: s }, "ice connection state");
        });
        subscribe("connectionStateChange", (s) => {
            // 既に on(connectionstatechange) で取れているはずだが冗長に。
            diag.pcStates.push(`${Date.now() - diag.createdAt}ms:conn=${s}`);
            log.info({ sessionId, connectionState: s }, "pc connection state (event)");
        });

        // ── SDP exchange ─────────────────────────────────────────
        log.info({ sessionId, offerSdpLines: offerSdp.split("\n").length },
                 "received offer");
        await pc.setRemoteDescription({ sdp: offerSdp, type: "offer" });
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        const finalAnswer = await waitForIceGatheringComplete(pc);
        diag.answerSdpLines = finalAnswer.sdp.split("\n").length;
        // SDP の m=video 行と payloadType / fmtp / candidate を抜粋して log。
        const summary = sdpSummary(finalAnswer.sdp);
        log.info({ sessionId, ...summary }, "answer SDP summary");

        // ── ffmpeg pipeline ─────────────────────────────────────
        const pipeline = new FfmpegPipeline();
        pipeline.on("exit", () => this.closeSession(sessionId));
        pipeline.on("error", (err: Error) => log.warn({ err }, "ffmpeg pipeline error"));
        pipeline.on("stderr", (line: string) => {
            // 重大な失敗は session close 候補だが、起動初期のノイズもあるので
            // ここでは log だけ + diag に直近 20 行を保持。
            diag.ffmpegStderr.push(line);
            if (diag.ffmpegStderr.length > 20) diag.ffmpegStderr.shift();
            log.debug({ line }, "ffmpeg stderr");
        });

        try {
            pipeline.start(app, { rtpPort });
        } catch (err) {
            try { udp.close(); } catch { /* ignore */ }
            try { pc.close(); }   catch { /* ignore */ }
            throw err;
        }

        const session: CaptureSession = {
            id: sessionId, appId: app.id, pc, track, pipeline, udp,
            rtpPort, createdAt: Date.now(), rtpReceived: 0, diag,
        };
        this.sessions.set(sessionId, session);

        // 診断履歴に登録。
        diagHistory.push(diag);
        if (diagHistory.length > DIAG_HISTORY_MAX) diagHistory.shift();

        log.info({ sessionId, appId: app.id, rtpPort }, "capture session opened");

        // 5 秒後に RTP がまだ届いていなければ警告 (ffmpeg / window 不在の typical)。
        setTimeout(() => {
            if (this.sessions.has(sessionId) && rtpReceived === 0) {
                log.warn({
                    sessionId,
                    rtpReceived,
                    pcStates:    diag.pcStates,
                    iceStates:   diag.iceStates,
                    ffmpegTail:  diag.ffmpegStderr.slice(-5),
                }, "no RTP after 5s — check ffmpeg / window title");
            }
        }, 5000);

        return { sessionId, answer: finalAnswer };
    }

    closeSession(sessionId: string): boolean {
        const s = this.sessions.get(sessionId);
        if (!s) return false;
        try { s.pipeline.stop(); } catch { /* ignore */ }
        try { s.udp.close(); }      catch { /* ignore */ }
        try { s.pc.close(); }        catch { /* ignore */ }
        s.diag.closedAt = Date.now();
        this.sessions.delete(sessionId);
        this.emit("session-closed", sessionId);
        log.info({
            sessionId,
            rtpReceived:  s.diag.rtpReceived,
            firstRtpMs:   s.diag.firstRtpAtMs,
            pcStates:     s.diag.pcStates,
            iceStates:    s.diag.iceStates,
        }, "capture session closed");
        return true;
    }

    closeAllForApp(appId: string): void {
        for (const [sid, s] of this.sessions) {
            if (s.appId === appId) this.closeSession(sid);
        }
    }

    shutdown(): void {
        for (const sid of [...this.sessions.keys()]) this.closeSession(sid);
    }
}

/// SDP から重要行 (m=video, a=rtpmap:H264, a=fmtp, a=candidate) を抜粋。
function sdpSummary(sdp: string): {
    mLines: string[];
    rtpmaps: string[];
    fmtps:   string[];
    candidates: number;
    setup:   string;
}{
    const mLines:  string[] = [];
    const rtpmaps: string[] = [];
    const fmtps:   string[] = [];
    let   candidates = 0;
    let   setup = "";
    for (const raw of sdp.split(/\r?\n/)) {
        if (raw.startsWith("m=")) mLines.push(raw);
        else if (/^a=rtpmap:.*(?:H264|VP8|VP9|AV1)/i.test(raw)) rtpmaps.push(raw);
        else if (raw.startsWith("a=fmtp:")) fmtps.push(raw);
        else if (raw.startsWith("a=candidate:")) candidates++;
        else if (raw.startsWith("a=setup:")) setup = raw;
    }
    return { mLines, rtpmaps, fmtps, candidates, setup };
}

/** localDescription が ICE gathering complete で確定するまで待つ。 */
async function waitForIceGatheringComplete(
    pc: PCLike,
    timeoutMs = 5000,
): Promise<{ sdp: string; type: string }> {
    return new Promise((resolveOuter) => {
        const start = Date.now();
        const tick = () => {
            if (pc.localDescription && pc.localDescription.sdp.includes("a=end-of-candidates")) {
                resolveOuter(pc.localDescription);
                return;
            }
            if (Date.now() - start >= timeoutMs) {
                resolveOuter(pc.localDescription ?? { sdp: "", type: "answer" });
                return;
            }
            setTimeout(tick, 50);
        };
        tick();
    });
}
