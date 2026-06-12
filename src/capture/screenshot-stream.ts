/**
 * ScreenshotStreamer — `app.capture.intervalSec` 秒ごとに 1 フレーム取り、
 * 'frame' イベントで購読者に push する subscribe 駆動の broker。
 *
 * 設計:
 *   - acquire(appId, key) / release(appId, key) で参照カウント。最初の
 *     acquire で interval timer 起動、最後の release で timer 停止。
 *     `key` は WS session.id を想定 (重複 acquire 防止 + 切断時の取り漏れ
 *     を session.id 単位で清掃できる)。
 *   - 1 アプリ 1 timer。in-flight ガードでオーバーラップ防止
 *     (撮影が interval より遅い環境でも timer が暴れない)。
 *   - capture 失敗 (アプリ未起動 / window 未発見など) は debug ログのみで
 *     timer は継続。アプリ起動後の自動再開を簡潔にするため。
 *   - 経路は POST /api/apps/:id/screenshot と同じ:
 *       1. cfg.inAppBridge が設定されていれば in-app HTTP bridge (ergo / Unity)
 *       2. それ以外は cfg.capture (ホスト ffmpeg)
 *     どちらも無いアプリは acquire しても何も起きない (debug ログ 1 回)。
 *
 * env:
 *   CUSTOS_SCREENSHOT_INTERVAL_SEC  全アプリ一括上書き (config 値より優先)。
 */

import { EventEmitter } from "node:events";
import { childLogger } from "../shared/logger.js";
import type { AppsRegistry } from "../apps/registry.js";
import type { AppConfig } from "../config/apps-config.js";
import type { RuntimeStreamPrefs } from "../runtime/stream-prefs.js";
import { captureScreenshot } from "./screenshot.js";
import { fetchScreenshot }   from "./ergo-custos-client.js";
import { scalePngBuffer }    from "./scale.js";

const log = childLogger("screenshot-stream");

export interface ScreenshotFrame {
    appId: string;
    ts:    number;
    png:   Buffer;
}

/// イベント:
///   - 'frame' (frame: ScreenshotFrame): 1 フレーム取れた
///   - 'capture-error' (appId, err): 1 ティック分の失敗 (timer は継続)
export class ScreenshotStreamer extends EventEmitter {
    /** appId → 起動中タイマー + 参照を持つ key 集合 */
    private streams = new Map<string, {
        timer:    NodeJS.Timeout;
        refs:     Set<string>;
        inflight: boolean;
        cfg:      AppConfig;
    }>();

    constructor(
        private registry: AppsRegistry,
        private prefs?: RuntimeStreamPrefs,
    ) {
        super();
        if (prefs) {
            // 設定タブで intervalSec が変わったら全 timer を貼り替える。
            // maxWidth はフレーム送出時に毎回読み直すので timer は触らない。
            prefs.on("change", () => this.restartAllTimers());
        }
    }

    private restartAllTimers(): void {
        for (const [appId, s] of this.streams) {
            const sec = effectiveIntervalSec(s.cfg, this.prefs);
            clearInterval(s.timer);
            if (sec <= 0) {
                this.streams.delete(appId);
                log.info({ appId }, "auto-stream stopped (intervalSec became 0)");
                continue;
            }
            s.timer = setInterval(() => { void this.tick(appId); }, sec * 1000);
            log.info({ appId, intervalSec: sec }, "auto-stream interval updated");
        }
    }

    /**
     * 1 件の購読を追加。最初の購読で timer 起動。
     * `key` は WS session id を渡す (release で同じ key を渡せば
     * 重複 acquire しても 1 件として清算される)。
     *
     * 戻り値: ストリームが今アクティブか (capture/inAppBridge が無いと false)
     */
    acquire(cfg: AppConfig, key: string): boolean {
        const intervalSec = effectiveIntervalSec(cfg, this.prefs);
        if (intervalSec <= 0) {
            log.debug({ appId: cfg.id }, "auto-stream disabled (intervalSec <= 0)");
            return false;
        }
        if (!cfg.capture && !cfg.inAppBridge) {
            log.debug({ appId: cfg.id }, "no capture / inAppBridge config — auto-stream skipped");
            return false;
        }
        let s = this.streams.get(cfg.id);
        if (s) {
            s.refs.add(key);
            return true;
        }
        const timer = setInterval(() => { void this.tick(cfg.id); }, intervalSec * 1000);
        // refs に最低 1 件入っている状態で初回 tick も即時ベストエフォートで投げる
        s = { timer, refs: new Set([key]), inflight: false, cfg };
        this.streams.set(cfg.id, s);
        log.info({ appId: cfg.id, intervalSec }, "auto-stream started");
        // 初回 tick を 1 イベントループ後に投げて、acquire 後すぐ frame を返す
        setImmediate(() => { void this.tick(cfg.id); });
        return true;
    }

    /**
     * 購読を 1 件外す。`key` で identification (同じ key を複数 acquire しても
     * 1 件としてのみカウントされる)。最後の release で timer 停止。
     */
    release(appId: string, key: string): void {
        const s = this.streams.get(appId);
        if (!s) return;
        s.refs.delete(key);
        if (s.refs.size === 0) {
            clearInterval(s.timer);
            this.streams.delete(appId);
            log.info({ appId }, "auto-stream stopped (no subscribers)");
        }
    }

    /** session 切断などで 1 key の全購読を外す。registry 反復してまとめて release。 */
    releaseAll(key: string): void {
        for (const appId of [...this.streams.keys()]) {
            this.release(appId, key);
        }
    }

    /** appId に対応する全 timer を即停止 (アプリの exit 時など)。 */
    stop(appId: string): void {
        const s = this.streams.get(appId);
        if (!s) return;
        clearInterval(s.timer);
        this.streams.delete(appId);
        log.info({ appId }, "auto-stream stopped (forced)");
    }

    /** 全 timer 停止。shutdown 用。 */
    shutdown(): void {
        for (const [, s] of this.streams) clearInterval(s.timer);
        this.streams.clear();
    }

    /** 監視 / 診断用。 */
    snapshot(): { appId: string; subscribers: number; intervalSec: number }[] {
        const out: { appId: string; subscribers: number; intervalSec: number }[] = [];
        for (const [appId, s] of this.streams) {
            out.push({ appId, subscribers: s.refs.size, intervalSec: effectiveIntervalSec(s.cfg, this.prefs) });
        }
        return out;
    }

    private async tick(appId: string): Promise<void> {
        const s = this.streams.get(appId);
        if (!s || s.inflight) return;
        s.inflight = true;
        try {
            let png = s.cfg.inAppBridge
                ? await fetchScreenshot(s.cfg.inAppBridge)
                : (await captureScreenshot(s.cfg)).png;
            // 設定タブの maxWidth でダウンスケール (毎フレーム参照なので runtime 反映)。
            const maxW = this.prefs?.get().maxWidth;
            if (maxW && maxW > 0) {
                png = await scalePngBuffer(png, maxW);
            }
            this.emit("frame", { appId, ts: Date.now(), png } satisfies ScreenshotFrame);
        } catch (err) {
            log.debug({ appId, err: errMsg(err) }, "tick capture failed (ignored — timer continues)");
            this.emit("capture-error", appId, err);
        } finally {
            // 最新 streams を見直す (途中で stop された可能性)
            const cur = this.streams.get(appId);
            if (cur) cur.inflight = false;
        }
    }
}

function effectiveIntervalSec(cfg: AppConfig, prefs?: RuntimeStreamPrefs): number {
    // 優先順位:
    //   1. RuntimeStreamPrefs.intervalSec (設定タブからの上書き)
    //   2. CUSTOS_SCREENSHOT_INTERVAL_SEC (env、起動時のグローバル既定)
    //   3. apps.json の cfg.capture.intervalSec
    //   4. ハード既定 1.0
    const ov = prefs?.get().intervalSec;
    if (ov !== undefined) return ov;
    const env = process.env.CUSTOS_SCREENSHOT_INTERVAL_SEC;
    if (env !== undefined && env !== "") {
        const v = Number(env);
        if (Number.isFinite(v) && v >= 0) return v;
    }
    return cfg.capture?.intervalSec ?? 1;
}

function errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
