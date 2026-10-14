/**
 * app ごとに 1 本の映像源 (ffmpeg → RTP) を持ち、同じ RTP を複数の WebRTC session に配る。
 *
 * 観戦者が増えるたびに ffmpeg を起動すると、同じ画面を何本もエンコードすることになる
 * (bridge-stream ではアプリ側の /stream 接続も増える)。最初の購読で起動し、最後の購読
 * 解除で止める refcount 方式にする。ffmpeg は 1 秒 GOP なので、途中参加の session も
 * 1 秒以内に keyframe を受け取れる (ffmpeg-pipeline.ts の `-g`)。
 */

import dgram, { type Socket as DgramSocket } from "node:dgram";
import type { EventEmitter } from "node:events";
import { childLogger } from "../shared/logger.js";
import type { AppConfig } from "../config/apps-config.js";
import { FfmpegPipeline, type FfmpegStartOptions } from "./ffmpeg-pipeline.js";

const log = childLogger("rtp-source");

/** 診断用に保持する ffmpeg stderr の行数。 */
const STDERR_TAIL_MAX = 20;

/** 映像源の購読者。RTP datagram を受け、映像源が終わったら onEnd が呼ばれる。 */
export interface RtpSink {
    onPacket: (packet: Buffer) => void;
    onEnd:    () => void;
}

/** FfmpegPipeline のうち、映像源の管理に使う部分。テストで差し替える。 */
export interface VideoPipeline extends Pick<EventEmitter, "on"> {
    start(app: AppConfig, opts: FfmpegStartOptions): void;
    startBridgeStream(bridge: NonNullable<AppConfig["inAppBridge"]>, opts: FfmpegStartOptions): Promise<unknown>;
    stop(): void;
}

export interface SharedRtpSourceDeps {
    createPipeline?: () => VideoPipeline;
    createSocket?:   () => DgramSocket;
}

interface Source {
    appId:      string;
    udp:        DgramSocket;
    pipeline:   VideoPipeline;
    rtpPort:    number;
    sinks:      Map<string, RtpSink>;
    stderrTail: string[];
    ready:      Promise<void>;
    closed:     boolean;
}

export class SharedRtpSourcePool {
    private readonly sources = new Map<string, Source>();
    private readonly createPipeline: () => VideoPipeline;
    private readonly createSocket:   () => DgramSocket;

    constructor(deps: SharedRtpSourceDeps = {}) {
        this.createPipeline = deps.createPipeline ?? (() => new FfmpegPipeline());
        this.createSocket   = deps.createSocket   ?? (() => dgram.createSocket("udp4"));
    }

    /**
     * app の映像源を購読する。映像源が無ければ起動し、起動完了まで待つ。
     * 戻り値は ffmpeg が RTP を送っている loopback の UDP ポート (診断用)。
     */
    async acquire(app: AppConfig, subscriberId: string, sink: RtpSink): Promise<number> {
        if (!app.capture && !app.inAppBridge) {
            throw new Error(`app ${app.id} has neither capture nor inAppBridge config`);
        }
        let source = this.sources.get(app.id);
        if (!source) {
            source = this.open(app);
            this.sources.set(app.id, source);
        }
        source.sinks.set(subscriberId, sink);
        try {
            await source.ready;
        } catch (err) {
            source.sinks.delete(subscriberId);
            throw err;
        }
        if (source.closed || !source.sinks.has(subscriberId)) {
            source.sinks.delete(subscriberId);
            throw new Error(`video source for ${app.id} ended while starting`);
        }
        return source.rtpPort;
    }

    /** 購読を外す。最後の購読者なら映像源を止める。 */
    release(appId: string, subscriberId: string): void {
        const source = this.sources.get(appId);
        if (!source || !source.sinks.delete(subscriberId)) return;
        if (source.sinks.size > 0) return;
        // 起動中に止めると、起動処理が stop の後で ffmpeg を spawn して取り残す。
        // 起動の決着を待ってから、まだ誰も購読していなければ止める。
        source.ready.then(
            () => { if (source.sinks.size === 0) this.teardown(source, false); },
            () => { /* 起動失敗は open() 側で teardown 済み */ },
        );
    }

    /** 診断用: 映像源の ffmpeg stderr の直近行。 */
    stderrTail(appId: string): string[] {
        return this.sources.get(appId)?.stderrTail.slice() ?? [];
    }

    subscriberCount(appId: string): number {
        return this.sources.get(appId)?.sinks.size ?? 0;
    }

    shutdown(): void {
        for (const source of [...this.sources.values()]) this.teardown(source, true);
    }

    private open(app: AppConfig): Source {
        const source: Source = {
            appId:      app.id,
            udp:        this.createSocket(),
            pipeline:   this.createPipeline(),
            rtpPort:    0,
            sinks:      new Map(),
            stderrTail: [],
            ready:      Promise.resolve(),
            closed:     false,
        };
        source.ready = this.start(app, source).catch((err: unknown) => {
            this.teardown(source, false);
            throw err;
        });
        return source;
    }

    private async start(app: AppConfig, source: Source): Promise<void> {
        source.rtpPort = await bindLoopback(source.udp);
        source.udp.on("message", (packet: Buffer) => {
            for (const [subscriberId, sink] of source.sinks) {
                try {
                    sink.onPacket(packet);
                } catch (err) {
                    log.warn({ err: errMsg(err), appId: source.appId, subscriberId }, "RTP sink failed");
                }
            }
        });
        source.udp.on("error", (err: Error) => {
            log.warn({ err: err.message, appId: source.appId }, "udp socket error");
        });
        source.pipeline.on("exit", () => this.teardown(source, true));
        source.pipeline.on("error", (err: Error) => log.warn({ err, appId: source.appId }, "ffmpeg pipeline error"));
        source.pipeline.on("stderr", (line: string) => {
            source.stderrTail.push(line);
            if (source.stderrTail.length > STDERR_TAIL_MAX) source.stderrTail.shift();
        });

        const opts = { rtpPort: source.rtpPort };
        if (app.inAppBridge) {
            const meta = await source.pipeline.startBridgeStream(app.inAppBridge, opts);
            log.info({ appId: app.id, meta, rtpPort: source.rtpPort }, "video source opened (bridge-stream)");
        } else {
            source.pipeline.start(app, opts);
            log.info({ appId: app.id, rtpPort: source.rtpPort }, "video source opened (desktop capture)");
        }
    }

    private teardown(source: Source, notify: boolean): void {
        if (source.closed) return;
        source.closed = true;
        if (this.sources.get(source.appId) === source) this.sources.delete(source.appId);
        try { source.pipeline.stop(); } catch { /* 既に終了していることがある。後始末なので best-effort */ }
        try { source.udp.close(); } catch { /* bind 前の失敗では未オープン。後始末なので best-effort */ }
        const sinks = [...source.sinks.values()];
        source.sinks.clear();
        log.info({ appId: source.appId, subscribers: sinks.length }, "video source closed");
        if (notify) for (const sink of sinks) sink.onEnd();
    }
}

function bindLoopback(udp: DgramSocket): Promise<number> {
    return new Promise<number>((resolve, reject) => {
        udp.once("error", reject);
        udp.bind({ address: "127.0.0.1", port: 0 }, () => {
            udp.off("error", reject);
            const address = udp.address();
            if (typeof address === "string" || !address) {
                reject(new Error("udp bind: no address"));
                return;
            }
            resolve(address.port);
        });
    });
}

function errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
