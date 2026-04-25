/**
 * WebRTC peer connection broker。
 *
 * ブラウザから来る SDP offer に対して answer を返し、ffmpeg pipeline の
 * NAL unit を werift の MediaStreamTrack に流し込む。1 セッション = 1 PC。
 *
 * werift API バージョンによって `writeSample` / `writeRtp` の差異があり
 * うるため、`MediaStreamTrack.writeSample(buffer, time?)` を試して
 * 失敗したら `writeRtp` フォールバックする。**MVP ではどちらか動けば良し**
 * とし、フォールバックでも上手くいかないケースは Phase 2.5 で werift API
 * 固定 + 専用 packetizer を入れる。
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { childLogger } from "../shared/logger.js";
import type { AppConfig } from "../config/apps-config.js";
import { FfmpegPipeline } from "./ffmpeg-pipeline.js";
import { H264NalParser, type NalUnit } from "./h264.js";

const log = childLogger("webrtc-broker");

interface WeriftLike {
    RTCPeerConnection: new (config?: unknown) => {
        addTrack:           (track: unknown) => unknown;
        createOffer:        () => Promise<{ sdp: string; type: string }>;
        createAnswer:       () => Promise<{ sdp: string; type: string }>;
        setLocalDescription:  (desc: { sdp: string; type: string }) => Promise<void>;
        setRemoteDescription: (desc: { sdp: string; type: string }) => Promise<void>;
        localDescription:     { sdp: string; type: string } | null;
        close:                () => void;
        connectionState:      string;
        on:                   (ev: string, cb: (v: unknown) => void) => void;
    };
    MediaStreamTrack: new (init: { kind: "video" | "audio" }) => {
        kind: string;
        writeSample?: (sample: Buffer, time?: number) => void;
        writeRtp?:    (packet: unknown) => void;
    };
}

let weriftPromise: Promise<WeriftLike | null> | null = null;
async function getWerift(): Promise<WeriftLike | null> {
    if (!weriftPromise) {
        weriftPromise = (async () => {
            try {
                const mod = await import("werift") as unknown as WeriftLike;
                if (!mod.RTCPeerConnection || !mod.MediaStreamTrack) {
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
    pc:          ReturnType<WeriftLike["RTCPeerConnection"]["prototype"]["constructor"]> | unknown;
    track:       ReturnType<WeriftLike["MediaStreamTrack"]["prototype"]["constructor"]> | unknown;
    pipeline:    FfmpegPipeline;
    parser:      H264NalParser;
    /** 生成時刻 ms。デバッグ用。 */
    createdAt:   number;
    onClose?:    () => void;
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

        const pc = new w.RTCPeerConnection();
        const track = new w.MediaStreamTrack({ kind: "video" });
        pc.addTrack(track);

        const pipeline = new FfmpegPipeline();
        const parser = new H264NalParser();
        const sessionId = randomUUID();

        pipeline.on("data", (chunk: Buffer) => {
            const nals = parser.push(chunk);
            for (const nal of nals) feedTrack(track, nal);
        });
        pipeline.on("exit", () => this.closeSession(sessionId));
        pipeline.on("error", (err: Error) => log.warn({ err }, "ffmpeg pipeline error"));

        pc.on("connectionstatechange", () => {
            const st = (pc as { connectionState: string }).connectionState;
            log.info({ sessionId, state: st }, "pc state");
            if (st === "failed" || st === "disconnected" || st === "closed") {
                this.closeSession(sessionId);
            }
        });

        await pc.setRemoteDescription({ sdp: offerSdp, type: "offer" });
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        // ICE 完了 (ローカルで gather 終了) を待つ簡易版。trickle ICE は MVP では未対応。
        const finalAnswer = await waitForIceGatheringComplete(pc as { localDescription: { sdp: string; type: string } | null; on: (ev: string, cb: () => void) => void });

        try {
            pipeline.start(app);
        } catch (err) {
            pc.close();
            throw err;
        }

        const session: CaptureSession = {
            id: sessionId, appId: app.id, pc, track, pipeline, parser,
            createdAt: Date.now(),
        };
        this.sessions.set(sessionId, session);
        log.info({ sessionId, appId: app.id }, "capture session opened");

        return { sessionId, answer: finalAnswer };
    }

    closeSession(sessionId: string): boolean {
        const s = this.sessions.get(sessionId);
        if (!s) return false;
        try { s.pipeline.stop(); } catch { /* ignore */ }
        try { (s.pc as { close: () => void }).close(); } catch { /* ignore */ }
        this.sessions.delete(sessionId);
        this.emit("session-closed", sessionId);
        log.info({ sessionId }, "capture session closed");
        s.onClose?.();
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

/** track に NAL unit を流し込む。werift API バージョン差異を吸収する。 */
function feedTrack(track: unknown, nal: NalUnit): void {
    const t = track as { writeSample?: (b: Buffer, time?: number) => void; writeRtp?: (b: Buffer) => void };
    try {
        if (typeof t.writeSample === "function") {
            t.writeSample(nal.data);
            return;
        }
        if (typeof t.writeRtp === "function") {
            // 簡易: NAL を直接 RTP payload として渡す (werift 側で packetize される前提)。
            t.writeRtp(nal.data);
            return;
        }
    } catch (err) {
        log.warn({ err }, "track feed failed");
    }
}

/** localDescription が ICE gathering complete で確定するまで待つ。 */
async function waitForIceGatheringComplete(
    pc: { localDescription: { sdp: string; type: string } | null; on: (ev: string, cb: () => void) => void },
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
