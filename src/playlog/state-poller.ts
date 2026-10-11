/**
 * inAppBridge の `GET /state` を app ごとに周期取得する (refcount)。
 *
 * 記録中の run が 1 つでもある app だけを取得する。404 (未対応ブリッジ) なら
 * その app の取得を止め、以後は状態無しで記録する。
 */

import { childLogger } from "../shared/logger.js";
import type { AppConfig } from "../config/apps-config.js";
import {
    fetchBridgeState,
    BridgeUnsupportedError,
    type BridgeState,
    type EndpointConfig,
} from "../capture/ergo-custos-client.js";
import type { GameState } from "./playlog-row.js";

const log = childLogger("playlog-state");

export type StateFetcher = (ep: EndpointConfig) => Promise<BridgeState>;
export type StateListener = (appId: string, state: GameState | null) => void;

interface Entry {
    refs:     Set<string>;
    timer:    NodeJS.Timeout;
    inFlight: boolean;
}

export class StatePoller {
    private readonly entries = new Map<string, Entry>();
    private readonly latest  = new Map<string, GameState | null>();
    private readonly unsupported = new Set<string>();

    constructor(
        private readonly onState: StateListener,
        private readonly fetcher: StateFetcher = fetchBridgeState,
    ) {}

    /** 最後に取得した状態 (未取得なら null)。 */
    current(appId: string): GameState | null {
        return this.latest.get(appId) ?? null;
    }

    acquire(app: AppConfig, ref: string): void {
        const bridge = app.inAppBridge;
        if (!bridge || !app.playLog || this.unsupported.has(app.id)) return;
        const existing = this.entries.get(app.id);
        if (existing) {
            existing.refs.add(ref);
            return;
        }
        const entry: Entry = {
            refs:     new Set([ref]),
            inFlight: false,
            timer:    setInterval(() => void this.tick(app.id, bridge), app.playLog.statePollMs),
        };
        entry.timer.unref?.();
        this.entries.set(app.id, entry);
        void this.tick(app.id, bridge);
    }

    release(appId: string, ref: string): void {
        const entry = this.entries.get(appId);
        if (!entry) return;
        entry.refs.delete(ref);
        if (entry.refs.size === 0) this.stop(appId);
    }

    shutdown(): void {
        for (const appId of [...this.entries.keys()]) this.stop(appId);
    }

    private stop(appId: string): void {
        const entry = this.entries.get(appId);
        if (!entry) return;
        clearInterval(entry.timer);
        this.entries.delete(appId);
    }

    private async tick(appId: string, ep: EndpointConfig): Promise<void> {
        const entry = this.entries.get(appId);
        if (!entry || entry.inFlight) return;
        entry.inFlight = true;
        try {
            const { state } = await this.fetcher(ep);
            this.latest.set(appId, state);
            this.onState(appId, state);
        } catch (err) {
            if (err instanceof BridgeUnsupportedError) {
                log.warn({ appId }, "bridge has no /state — play log continues without game state");
                this.unsupported.add(appId);
                this.stop(appId);
                return;
            }
            log.debug({ appId, msg: err instanceof Error ? err.message : String(err) }, "state poll failed");
        } finally {
            entry.inFlight = false;
        }
    }
}
