/**
 * app の映像源を選ぶ: Unity ブリッジで H.264 が使えればそれ (ffmpeg 不要)、使えなければ
 * 従来の生 BGRA + ffmpeg、デスクトップキャプチャは ffmpeg。
 *
 * SharedRtpSourcePool からは 1 つの VideoPipeline に見える (中の pipeline のイベントを中継する)。
 * H.264 のときだけ VideoFeedbackTarget (キーフレーム要求・ビットレート変更) が効く。
 */

import { EventEmitter } from "node:events";
import { childLogger } from "../shared/logger.js";
import type { AppConfig, InAppBridgeConfig } from "../config/apps-config.js";
import { FfmpegPipeline, type FfmpegStartOptions } from "./ffmpeg-pipeline.js";
import { H264BridgePipeline, type VideoFeedbackTarget } from "./h264-bridge-pipeline.js";
import { H264UnavailableError } from "./bridge-h264-stream.js";

const log = childLogger("video-pipeline");

const RELAYED_EVENTS = ["spawn", "exit", "error", "stderr"] as const;

interface InnerPipeline extends EventEmitter {
    stop(): void;
}

export interface VideoPipelineSelectorDeps {
    createFfmpeg?: () => FfmpegPipeline;
    createH264?:   () => H264BridgePipeline;
}

export class VideoPipelineSelector extends EventEmitter implements VideoFeedbackTarget {
    private inner: InnerPipeline | null = null;
    private h264: H264BridgePipeline | null = null;
    private readonly createFfmpeg: () => FfmpegPipeline;
    private readonly createH264: () => H264BridgePipeline;

    constructor(deps: VideoPipelineSelectorDeps = {}) {
        super();
        this.createFfmpeg = deps.createFfmpeg ?? (() => new FfmpegPipeline());
        this.createH264 = deps.createH264 ?? (() => new H264BridgePipeline());
    }

    /** どちらの映像源で動いているか (診断用)。 */
    get mode(): "h264" | "ffmpeg" | "none" {
        if (!this.inner) return "none";
        return this.inner === this.h264 ? "h264" : "ffmpeg";
    }

    /** デスクトップキャプチャ (ffmpeg のみ)。 */
    start(app: AppConfig, opts: FfmpegStartOptions): void {
        const ffmpeg = this.adopt(this.createFfmpeg());
        ffmpeg.start(app, opts);
    }

    async startBridgeStream(bridge: InAppBridgeConfig, opts: FfmpegStartOptions): Promise<unknown> {
        const codec = bridge.kind === "unity" ? bridge.video.codec : "rawvideo";
        if (codec !== "rawvideo") {
            const h264 = this.createH264();
            this.adopt(h264);
            try {
                await h264.start(bridge, opts);
                this.h264 = h264;
                return { codec: "h264", video: bridge.video };
            } catch (err) {
                this.release();
                if (!(err instanceof H264UnavailableError) || codec === "h264") throw err;
                log.info({ reason: err.message }, "bridge h264 unavailable — falling back to BGRA + ffmpeg");
            }
        }
        const ffmpeg = this.adopt(this.createFfmpeg());
        return ffmpeg.startBridgeStream(bridge, opts);
    }

    requestKeyFrame(): void {
        this.h264?.requestKeyFrame();
    }

    setBitrate(bps: number): void {
        this.h264?.setBitrate(bps);
    }

    stop(): void {
        this.inner?.stop();
        this.release();
    }

    private adopt<T extends InnerPipeline>(pipeline: T): T {
        this.release();
        this.inner = pipeline;
        for (const event of RELAYED_EVENTS) {
            pipeline.on(event, (...args: unknown[]) => { if (this.inner === pipeline) this.emit(event, ...args); });
        }
        return pipeline;
    }

    private release(): void {
        this.inner = null;
        this.h264 = null;
    }
}
