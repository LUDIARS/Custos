/**
 * in-app bridge の動画ストリーム接続モジュール。
 *
 * Unity ブリッジ (既定 port 17778) / ergo_custos が提供する
 *   GET /stream?fps=<F>
 * に HTTP 接続し、レスポンスヘッダからフレームメタデータを取得したうえで
 * レスポンス本体 (raw BGRA8 連続バイト列) を Readable stream として返す。
 *
 * ストリーム契約 (Unity ブリッジ側と固定合意):
 *   - ステータス 200
 *   - ヘッダ: X-Frame-Width, X-Frame-Height, X-Frame-Pixfmt (="bgra"), X-Frame-Fps
 *   - 本体: フレーム間ヘッダ無しの raw BGRA8 連続バイト列 (1 frame = W*H*4 bytes)
 *   - 接続を閉じると配信停止
 *
 * ffmpeg は `-f rawvideo -pix_fmt bgra -s WxH -r F -i pipe:0` で
 * このストリームを stdin から受け取る。
 */

import * as http from "node:http";
import { Readable } from "node:stream";
import type { InAppBridgeConfig } from "../config/apps-config.js";

export interface BridgeStreamMeta {
    width:  number;
    height: number;
    /** ピクセルフォーマット。現在は "bgra" 固定。 */
    pixfmt: string;
    /** ブリッジが報告した fps (フォールバック: 設定値)。 */
    fps:    number;
}

export interface BridgeStreamResult {
    meta:   BridgeStreamMeta;
    /** raw バイト列を流す Readable。ffmpeg.stdin に pipe する。 */
    stream: Readable;
    /** 接続を能動的に切断する。ffmpeg 側から teardown する時に呼ぶ。 */
    destroy: () => void;
}

const CONNECT_TIMEOUT_MS = 10_000;

/**
 * bridge の `GET /stream` に接続し、ヘッダ解析後に結果を返す。
 *
 * 接続 or ヘッダ解析に失敗したら reject する。
 * 成功したら caller は `result.stream` を ffmpeg.stdin に pipe し、
 * セッション終了時に `result.destroy()` を呼ぶ。
 */
export function connectBridgeStream(
    bridge: InAppBridgeConfig,
): Promise<BridgeStreamResult> {
    return new Promise<BridgeStreamResult>((resolve, reject) => {
        const url   = `/stream?fps=${bridge.fps}`;
        const reqOpts: http.RequestOptions = {
            host:    bridge.host,
            port:    bridge.port,
            path:    url,
            method:  "GET",
        };

        const req = http.request(reqOpts, (res) => {
            if (res.statusCode !== 200) {
                res.destroy();
                req.destroy();
                reject(new Error(
                    `bridge /stream returned HTTP ${res.statusCode ?? "?"} — expected 200`,
                ));
                return;
            }

            const meta = parseFrameHeaders(res.headers, bridge.fps);
            if (!meta) {
                res.destroy();
                req.destroy();
                reject(new Error(
                    "bridge /stream response is missing required X-Frame-* headers " +
                    "(X-Frame-Width, X-Frame-Height, X-Frame-Pixfmt, X-Frame-Fps)",
                ));
                return;
            }

            const stream = res as unknown as Readable;

            const destroy = (): void => {
                try { req.destroy(); }  catch { /* ignore */ }
                try { res.destroy(); }  catch { /* ignore */ }
            };

            resolve({ meta, stream, destroy });
        });

        req.setTimeout(CONNECT_TIMEOUT_MS, () => {
            req.destroy(new Error(`bridge /stream connect timeout (${CONNECT_TIMEOUT_MS}ms)`));
        });

        req.on("error", (err) => {
            reject(err);
        });

        req.end();
    });
}

/**
 * HTTP レスポンスヘッダから BridgeStreamMeta を解析する。
 * 必須ヘッダ (Width / Height / Pixfmt / Fps) が 1 つでも欠けたら null。
 */
export function parseFrameHeaders(
    headers: http.IncomingHttpHeaders,
    fallbackFps: number,
): BridgeStreamMeta | null {
    const wRaw  = headers["x-frame-width"];
    const hRaw  = headers["x-frame-height"];
    const pfRaw = headers["x-frame-pixfmt"];
    const fRaw  = headers["x-frame-fps"];

    const width  = parseInt(Array.isArray(wRaw)  ? (wRaw[0] ?? "")  : (wRaw  ?? ""), 10);
    const height = parseInt(Array.isArray(hRaw)  ? (hRaw[0] ?? "")  : (hRaw  ?? ""), 10);
    const fps    = parseInt(Array.isArray(fRaw)  ? (fRaw[0] ?? "")  : (fRaw  ?? ""), 10);
    const pixfmt =        (Array.isArray(pfRaw) ? (pfRaw[0] ?? "") : (pfRaw ?? "")).trim();

    if (!Number.isFinite(width)  || width  <= 0) return null;
    if (!Number.isFinite(height) || height <= 0) return null;
    if (!pixfmt) return null;

    return {
        width,
        height,
        pixfmt,
        fps: Number.isFinite(fps) && fps > 0 ? fps : fallbackFps,
    };
}
