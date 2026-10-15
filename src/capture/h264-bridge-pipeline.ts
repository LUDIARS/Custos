/**
 * ffmpeg を使わない映像源: Unity ブリッジがハードウェアで作った H.264 を受け、RTP にして
 * ローカルの UDP (SharedRtpSourcePool が受けている rtpPort) へ送る。
 *
 * FfmpegPipeline と同じイベント ("spawn" / "exit" / "error" / "stderr") を出すので、プール側は
 * どちらの映像源かを気にしない。キーフレーム要求とビットレート変更をブリッジへ中継できる
 * (VideoFeedbackTarget)。
 */

import dgram from "node:dgram";
import { EventEmitter } from "node:events";
import { childLogger } from "../shared/logger.js";
import type { InAppBridgeConfig } from "../config/apps-config.js";
import { BridgeH264FrameReader } from "./bridge-h264-frames.js";
import { connectBridgeH264, requestBridgeKeyframe, setBridgeBitrate } from "./bridge-h264-stream.js";
import { H264RtpPacketizer } from "./h264-rtp-packetizer.js";

const log = childLogger("h264-bridge");

/** 映像源に、キーフレーム要求とビットレート変更を渡せる (ブラウザの PLI / REMB)。 */
export interface VideoFeedbackTarget {
    requestKeyFrame(): void;
    setBitrate(bps: number): void;
}

export class H264BridgePipeline extends EventEmitter implements VideoFeedbackTarget {
    private bridge: InAppBridgeConfig | null = null;
    private destroyConnection: (() => void) | null = null;
    private udp: dgram.Socket | null = null;
    private stopped = false;
    private ended = false;

    /**
     * ブリッジに接続して配信を始める。H.264 を出せないブリッジなら H264UnavailableError で reject する
     * (このときは何も起動していない)。
     */
    async start(bridge: InAppBridgeConfig, opts: { rtpPort: number; rtpHost?: string; payloadType?: number }): Promise<void> {
        this.bridge = bridge;
        const connection = await connectBridgeH264(bridge, bridge.video.bitrate);
        if (this.stopped) {
            connection.destroy();
            return;
        }
        this.destroyConnection = connection.destroy;
        const udp = dgram.createSocket("udp4");
        this.udp = udp;
        const host = opts.rtpHost ?? "127.0.0.1";
        const reader = new BridgeH264FrameReader();
        const packetizer = new H264RtpPacketizer(opts.payloadType ?? 96);
        let frames = 0;

        connection.stream.on("data", (chunk: Buffer) => {
            try {
                for (const frame of reader.push(chunk)) {
                    for (const packet of packetizer.packetize(frame.data, frame.timestampUs)) udp.send(packet, opts.rtpPort, host);
                    if (++frames === 1) log.info({ keyframe: frame.keyframe, bytes: frame.data.length }, "first h264 frame from bridge");
                }
            } catch (err) {
                this.emit("stderr", `h264 stream parse error: ${errMsg(err)}`);
                this.finish();
            }
        });
        connection.stream.on("error", (err) => {
            log.warn({ err: errMsg(err) }, "bridge h264 stream error");
            this.finish();
        });
        connection.stream.on("end", () => {
            log.info("bridge h264 stream ended");
            this.finish();
        });
        log.info({ host: bridge.host, port: bridge.port, rtpPort: opts.rtpPort, video: bridge.video }, "bridge h264 stream connected");
        this.emit("spawn");
    }

    requestKeyFrame(): void {
        if (!this.bridge || this.ended) return;
        requestBridgeKeyframe(this.bridge).catch((err) => log.warn({ err: errMsg(err) }, "keyframe request failed"));
    }

    setBitrate(bps: number): void {
        if (!this.bridge || this.ended) return;
        log.info({ bps }, "set bridge bitrate");
        setBridgeBitrate(this.bridge, bps).catch((err) => log.warn({ err: errMsg(err), bps }, "bitrate change failed"));
    }

    stop(): void {
        this.stopped = true;
        this.ended = true;
        this.close();
    }

    private finish(): void {
        if (this.ended) return;
        this.ended = true;
        this.close();
        this.emit("exit", null, null);
    }

    private close(): void {
        try { this.destroyConnection?.(); } catch { /* 後始末なので best-effort */ }
        this.destroyConnection = null;
        try { this.udp?.close(); } catch { /* 後始末なので best-effort */ }
        this.udp = null;
    }
}

function errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
