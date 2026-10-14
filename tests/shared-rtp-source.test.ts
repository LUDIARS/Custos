/**
 * SharedRtpSourcePool: app ごとに映像源 1 本を共有し、最後の購読解除で止める。
 *
 * ffmpeg は起動しない (VideoPipeline を fake に差し替える)。UDP は実 socket を
 * loopback で使い、送った datagram が全購読者に届くことを確かめる。
 */
import { afterEach, describe, expect, test } from "vitest";
import { EventEmitter } from "node:events";
import dgram from "node:dgram";
import type { AppConfig } from "../src/config/apps-config.js";
import { SharedRtpSourcePool, type RtpSink, type VideoPipeline } from "../src/capture/shared-rtp-source.js";

class FakePipeline extends EventEmitter implements VideoPipeline {
    started = 0;
    stopped = 0;
    rtpPort = 0;
    start(_app: AppConfig, opts: { rtpPort: number }): void {
        this.started++;
        this.rtpPort = opts.rtpPort;
        // 実 ffmpeg と同じく、起動の成否は非同期で知らせる。
        setImmediate(() => this.emit("spawn"));
    }
    async startBridgeStream(_bridge: unknown, opts: { rtpPort: number }): Promise<unknown> {
        this.start({} as AppConfig, opts);
        return {};
    }
    stop(): void { this.stopped++; }
}

function captureApp(id = "demo"): AppConfig {
    return {
        id,
        capture: { type: "window", windowTitle: "Demo", fps: 30, preset: "veryfast" },
    } as unknown as AppConfig;
}

function recordingSink(): RtpSink & { packets: Buffer[]; ended: number } {
    const sink = {
        packets: [] as Buffer[],
        ended: 0,
        onPacket: (p: Buffer) => { sink.packets.push(p); },
        onEnd: () => { sink.ended++; },
    };
    return sink;
}

function sendTo(port: number, payload: string): Promise<void> {
    const client = dgram.createSocket("udp4");
    return new Promise((resolve, reject) => {
        client.send(Buffer.from(payload), port, "127.0.0.1", (err) => {
            client.close();
            if (err) reject(err); else resolve();
        });
    });
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    while (!check()) {
        if (Date.now() - start > timeoutMs) throw new Error("timed out");
        await new Promise((r) => setTimeout(r, 10));
    }
}

const pools: SharedRtpSourcePool[] = [];
function newPool(pipelines: FakePipeline[]): SharedRtpSourcePool {
    const pool = new SharedRtpSourcePool({
        createPipeline: () => {
            const p = new FakePipeline();
            pipelines.push(p);
            return p;
        },
    });
    pools.push(pool);
    return pool;
}

afterEach(() => {
    for (const pool of pools.splice(0)) pool.shutdown();
});

describe("SharedRtpSourcePool", () => {
    test("2 つの購読で映像源は 1 本だけ起動し、RTP は両方に届く", async () => {
        const pipelines: FakePipeline[] = [];
        const pool = newPool(pipelines);
        const a = recordingSink();
        const b = recordingSink();

        const portA = await pool.acquire(captureApp(), "a", a);
        const portB = await pool.acquire(captureApp(), "b", b);

        expect(pipelines).toHaveLength(1);
        expect(pipelines[0]!.started).toBe(1);
        expect(portA).toBe(portB);
        expect(pool.subscriberCount("demo")).toBe(2);

        await sendTo(portA, "rtp-1");
        await waitFor(() => a.packets.length === 1 && b.packets.length === 1);
        expect(a.packets[0]!.toString()).toBe("rtp-1");
        expect(b.packets[0]!.toString()).toBe("rtp-1");
    });

    test("同時に acquire しても映像源は 1 本", async () => {
        const pipelines: FakePipeline[] = [];
        const pool = newPool(pipelines);
        await Promise.all([
            pool.acquire(captureApp(), "a", recordingSink()),
            pool.acquire(captureApp(), "b", recordingSink()),
        ]);
        expect(pipelines).toHaveLength(1);
    });

    test("最後の購読解除で映像源を止め、次の購読で起動し直す", async () => {
        const pipelines: FakePipeline[] = [];
        const pool = newPool(pipelines);
        await pool.acquire(captureApp(), "a", recordingSink());
        await pool.acquire(captureApp(), "b", recordingSink());

        pool.release("demo", "a");
        await Promise.resolve();
        expect(pipelines[0]!.stopped).toBe(0);

        pool.release("demo", "b");
        await waitFor(() => pipelines[0]!.stopped === 1);
        expect(pool.subscriberCount("demo")).toBe(0);

        await pool.acquire(captureApp(), "c", recordingSink());
        expect(pipelines).toHaveLength(2);
    });

    test("映像源が終了したら全購読者に onEnd を通知する", async () => {
        const pipelines: FakePipeline[] = [];
        const pool = newPool(pipelines);
        const a = recordingSink();
        const b = recordingSink();
        await pool.acquire(captureApp(), "a", a);
        await pool.acquire(captureApp(), "b", b);

        pipelines[0]!.emit("exit", 1, null);

        expect(a.ended).toBe(1);
        expect(b.ended).toBe(1);
        expect(pool.subscriberCount("demo")).toBe(0);
    });

    test("起動に失敗したら acquire は reject し、映像源は残らない", async () => {
        const pool = new SharedRtpSourcePool({
            createPipeline: () => {
                const p = new FakePipeline();
                p.start = () => { throw new Error("ffmpeg missing"); };
                return p;
            },
        });
        pools.push(pool);
        await expect(pool.acquire(captureApp(), "a", recordingSink())).rejects.toThrow("ffmpeg missing");
        expect(pool.subscriberCount("demo")).toBe(0);
    });

    test("ffmpeg を起動できなければ acquire は理由付きで reject し、映像源は残らない", async () => {
        const pool = new SharedRtpSourcePool({
            createPipeline: () => {
                const p = new FakePipeline();
                p.start = () => { setImmediate(() => p.emit("error", new Error("spawn ffmpeg ENOENT"))); };
                return p;
            },
        });
        pools.push(pool);
        await expect(pool.acquire(captureApp(), "a", recordingSink())).rejects.toThrow(/ffmpeg を起動できません.*ENOENT/);
        expect(pool.subscriberCount("demo")).toBe(0);
    });

    test("起動後に ffmpeg が error を出したら購読者に onEnd を通知する", async () => {
        const pipelines: FakePipeline[] = [];
        const pool = newPool(pipelines);
        const a = recordingSink();
        await pool.acquire(captureApp(), "a", a);
        pipelines[0]!.emit("error", new Error("broken pipe"));
        expect(a.ended).toBe(1);
        expect(pool.subscriberCount("demo")).toBe(0);
    });

    test("capture も inAppBridge も無い app は拒否する", async () => {
        const pool = newPool([]);
        await expect(pool.acquire({ id: "x" } as unknown as AppConfig, "a", recordingSink()))
            .rejects.toThrow("neither capture nor inAppBridge");
    });
});
