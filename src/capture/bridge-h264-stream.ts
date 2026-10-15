/**
 * Unity ブリッジの `GET /stream?codec=h264` に接続する (ブリッジ側でハードウェア H.264 済み)。
 * キーフレーム要求 (`POST /stream/keyframe`) とビットレート変更 (`POST /stream/bitrate`) も送る。
 *
 * ブリッジが H.264 を出せない (ネイティブのエンコーダが無い・古いブリッジ) ときは 415 / 404 が返るので、
 * H264UnavailableError で知らせ、呼び出し側が従来の BGRA + ffmpeg に切り替える。
 */

import * as http from "node:http";
import type { Readable } from "node:stream";
import type { InAppBridgeConfig } from "../config/apps-config.js";

const CONNECT_TIMEOUT_MS = 10_000;
const CONTROL_TIMEOUT_MS = 2_000;

export class H264UnavailableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "H264UnavailableError";
    }
}

export interface BridgeH264Connection {
    stream:  Readable;
    destroy: () => void;
}

export function connectBridgeH264(bridge: InAppBridgeConfig, bitrateBps: number): Promise<BridgeH264Connection> {
    const q = new URLSearchParams({
        codec:   "h264",
        fps:     String(bridge.fps),
        width:   String(bridge.video.width),
        height:  String(bridge.video.height),
        bitrate: String(bitrateBps),
    });
    return new Promise((resolve, reject) => {
        const req = http.request({ host: bridge.host, port: bridge.port, path: `/stream?${q}`, method: "GET" }, (res) => {
            const destroy = (): void => {
                try { req.destroy(); } catch { /* 後始末なので best-effort */ }
                try { res.destroy(); } catch { /* 後始末なので best-effort */ }
            };
            if (res.statusCode === 415 || res.statusCode === 404) {
                readBody(res).then((body) => reject(new H264UnavailableError(`bridge cannot stream h264 (HTTP ${res.statusCode}): ${body}`)));
                return;
            }
            if (res.statusCode !== 200 || res.headers["x-frame-codec"] !== "h264") {
                destroy();
                reject(new Error(`bridge /stream?codec=h264 returned HTTP ${res.statusCode ?? "?"} codec=${String(res.headers["x-frame-codec"] ?? "-")}`));
                return;
            }
            req.setTimeout(0);
            resolve({ stream: res, destroy });
        });
        req.setTimeout(CONNECT_TIMEOUT_MS, () => req.destroy(new Error(`bridge /stream connect timeout (${CONNECT_TIMEOUT_MS}ms)`)));
        req.on("error", reject);
        req.end();
    });
}

export function requestBridgeKeyframe(bridge: InAppBridgeConfig): Promise<void> {
    return post(bridge, "/stream/keyframe", "{}");
}

export function setBridgeBitrate(bridge: InAppBridgeConfig, bps: number): Promise<void> {
    return post(bridge, "/stream/bitrate", JSON.stringify({ bps: Math.round(bps) }));
}

function post(bridge: InAppBridgeConfig, path: string, body: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: bridge.host, port: bridge.port, path, method: "POST",
            headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
        }, (res) => {
            res.resume();
            if (res.statusCode === 200) resolve();
            else reject(new Error(`bridge ${path} returned HTTP ${res.statusCode ?? "?"}`));
        });
        req.setTimeout(CONTROL_TIMEOUT_MS, () => req.destroy(new Error(`bridge ${path} timeout`)));
        req.on("error", reject);
        req.end(body);
    });
}

function readBody(res: http.IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => { if (text.length < 500) text += c; });
        res.on("end", () => resolve(text.slice(0, 500)));
        res.on("error", () => resolve(text));
    });
}
