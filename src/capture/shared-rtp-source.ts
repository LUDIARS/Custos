/**
 * app ごとに 1 本の映像源 / 音声源 (→ RTP) を持ち、同じ RTP を複数の WebRTC session に配る。
 * 映像 (createVideoSourcePool) と音声 (createAudioSourcePool、audio-source.ts) で同じ仕組みを使い、
 * 違うのは「何を起動するか」(launch) だけ。
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

/**
 * RTP を送るパイプラインの共通契約。起動できたら "spawn"、失敗・異常は "error"、
 * 終了は "exit"、診断行は "stderr" を出す (FfmpegPipeline / AudioPipeline)。
 */
export interface RtpPipeline extends Pick<EventEmitter, "on"> {
    stop(): void;
}

/** FfmpegPipeline のうち、映像源の管理に使う部分。テストで差し替える。 */
export interface VideoPipeline extends RtpPipeline {
    start(app: AppConfig, opts: FfmpegStartOptions): void;
    startBridgeStream(bridge: NonNullable<AppConfig["inAppBridge"]>, opts: FfmpegStartOptions): Promise<unknown>;
}

/** パイプラインを起動する。起動の成否 ("spawn" / "error") はプールが待つので、ここは起動要求まで。 */
export type RtpLauncher<P extends RtpPipeline> = (app: AppConfig, pipeline: P, opts: { rtpPort: number }) => Promise<void>;

export interface SharedRtpSourceDeps<P extends RtpPipeline> {
    createPipeline: () => P;
    launch:         RtpLauncher<P>;
    createSocket?:  () => DgramSocket;
    /** ログ・エラーに出す種類名 ("video" / "audio")。 */
    kind?:          string;
}

/** 映像源のプール。既定は FfmpegPipeline (bridge-stream かデスクトップキャプチャ)。 */
export function createVideoSourcePool(
    deps: Partial<SharedRtpSourceDeps<VideoPipeline>> = {},
): SharedRtpSourcePool<VideoPipeline> {
    return new SharedRtpSourcePool<VideoPipeline>({
        createPipeline: deps.createPipeline ?? (() => new FfmpegPipeline()),
        launch:         deps.launch ?? launchVideo,
        kind:           "video",
        ...(deps.createSocket ? { createSocket: deps.createSocket } : {}),
    });
}

async function launchVideo(app: AppConfig, pipeline: VideoPipeline, opts: { rtpPort: number }): Promise<void> {
    if (app.inAppBridge) {
        const meta = await pipeline.startBridgeStream(app.inAppBridge, opts);
        log.info({ appId: app.id, meta, rtpPort: opts.rtpPort }, "video source starting (bridge-stream)");
    } else if (app.capture) {
        pipeline.start(app, opts);
        log.info({ appId: app.id, rtpPort: opts.rtpPort }, "video source starting (desktop capture)");
    } else {
        throw new Error(`app ${app.id} has neither capture nor inAppBridge config`);
    }
}

interface Source<P extends RtpPipeline> {
    appId:      string;
    udp:        DgramSocket;
    pipeline:   P;
    rtpPort:    number;
    sinks:      Map<string, RtpSink>;
    stderrTail: string[];
    ready:      Promise<void>;
    closed:     boolean;
}

export class SharedRtpSourcePool<P extends RtpPipeline> {
    private readonly sources = new Map<string, Source<P>>();
    private readonly createPipeline: () => P;
    private readonly launch:         RtpLauncher<P>;
    private readonly createSocket:   () => DgramSocket;
    private readonly kind:           string;

    constructor(deps: SharedRtpSourceDeps<P>) {
        this.createPipeline = deps.createPipeline;
        this.launch         = deps.launch;
        this.createSocket   = deps.createSocket ?? (() => dgram.createSocket("udp4"));
        this.kind           = deps.kind ?? "rtp";
    }

    /**
     * app の映像源を購読する。映像源が無ければ起動し、起動完了まで待つ。
     * 戻り値は ffmpeg が RTP を送っている loopback の UDP ポート (診断用)。
     */
    async acquire(app: AppConfig, subscriberId: string, sink: RtpSink): Promise<number> {
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
            throw new Error(`${this.kind} source for ${app.id} ended while starting`);
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

    /**
     * 診断用: 映像源の ffmpeg stderr の直近行。映像源が持つ配列そのものを返す (後から出た行も
     * 見えるように)。呼び出し側は書き換えない。
     */
    stderrTail(appId: string): readonly string[] {
        return this.sources.get(appId)?.stderrTail ?? [];
    }

    subscriberCount(appId: string): number {
        return this.sources.get(appId)?.sinks.size ?? 0;
    }

    shutdown(): void {
        for (const source of [...this.sources.values()]) this.teardown(source, true);
    }

    private open(app: AppConfig): Source<P> {
        const source: Source<P> = {
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

    private async start(app: AppConfig, source: Source<P>): Promise<void> {
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
        source.pipeline.on("error", (err: Error) => log.warn({ err, appId: source.appId, kind: this.kind }, "pipeline error"));
        source.pipeline.on("stderr", (line: string) => {
            source.stderrTail.push(line);
            if (source.stderrTail.length > STDERR_TAIL_MAX) source.stderrTail.shift();
        });

        // spawn の成否は起動直後に非同期で決まる。先に待ち受けてから起動する。
        const spawned = waitForSpawn(source.pipeline, this.kind);
        spawned.catch(() => { /* launch が先に失敗したときの未処理 reject を防ぐ。結果は下で await する */ });
        await this.launch(app, source.pipeline, { rtpPort: source.rtpPort });
        await spawned;
        log.info({ appId: app.id, kind: this.kind, rtpPort: source.rtpPort }, "source opened");
        // 起動後に落ちた (spawn 後の error) ときも、RTP の来ない session を残さない。
        source.pipeline.on("error", () => this.teardown(source, true));
    }

    private teardown(source: Source<P>, notify: boolean): void {
        if (source.closed) return;
        source.closed = true;
        if (this.sources.get(source.appId) === source) this.sources.delete(source.appId);
        try { source.pipeline.stop(); } catch { /* 既に終了していることがある。後始末なので best-effort */ }
        try { source.udp.close(); } catch { /* bind 前の失敗では未オープン。後始末なので best-effort */ }
        const sinks = [...source.sinks.values()];
        source.sinks.clear();
        log.info({ appId: source.appId, kind: this.kind, subscribers: sinks.length }, "source closed");
        if (notify) for (const sink of sinks) sink.onEnd();
    }
}

/**
 * パイプライン (ffmpeg など) が起動できたかを待つ。起動できなければ (未インストール・
 * CUSTOS_FFMPEG の誤り・取り込みプログラムの失敗)、RTP が永遠に来ない session を作らず、
 * 接続要求をその理由で失敗させる。
 */
function waitForSpawn(pipeline: RtpPipeline, kind: string): Promise<void> {
    return new Promise((resolve, reject) => {
        pipeline.on("spawn", () => resolve());
        pipeline.on("error", (err: Error) => reject(new Error(
            `${kind} のパイプラインを起動できません (${err.message})。ffmpeg は PATH に入れるか CUSTOS_FFMPEG で実行ファイルを指定してください`,
        )));
    });
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
