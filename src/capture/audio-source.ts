/**
 * 音声源のプール。app ごとに AudioPipeline (ProcessLoopback → ffmpeg Opus → RTP) を 1 本だけ持ち、
 * 映像と同じく購読中の全 WebRTC session に配る (shared-rtp-source.ts)。
 */

import type { AppConfig } from "../config/apps-config.js";
import { AudioPipeline } from "./audio-pipeline.js";
import { resolveAudioPid, type AudioTargetDeps } from "./audio-target.js";
import { SharedRtpSourcePool, type RtpPipeline } from "./shared-rtp-source.js";

/** AudioPipeline のうち、プールが使う部分。テストで差し替える。 */
export interface AudioSourcePipeline extends RtpPipeline {
    start(pid: number, opts: { rtpPort: number }): Promise<void>;
}

export interface AudioSourceDeps extends AudioTargetDeps {
    createPipeline?: () => AudioSourcePipeline;
}

export function createAudioSourcePool(deps: AudioSourceDeps): SharedRtpSourcePool<AudioSourcePipeline> {
    return new SharedRtpSourcePool<AudioSourcePipeline>({
        createPipeline: deps.createPipeline ?? (() => new AudioPipeline()),
        kind: "audio",
        launch: async (app: AppConfig, pipeline, opts) => {
            if (!app.audio) throw new Error(`app ${app.id} has no audio config`);
            const pid = await resolveAudioPid(app, deps);
            await pipeline.start(pid, opts);
        },
    });
}
