/**
 * 行動ログの run 管理: 開閉・seq / t 採番・idle 判定・ゲーム状態の差分行。
 *
 * 1 run = (WS セッション, app) の連続した操作。最初の入力で開き、unsubscribe /
 * 切断 / idle / app 終了 / Custos 停止で `end` 行を書いて閉じる
 * (spec/feature/remote-play-and-play-log.md §2.3)。
 */

import { join } from "node:path";
import { childLogger } from "../shared/logger.js";
import type { AppConfig } from "../config/apps-config.js";
import {
    buildRow,
    inputFields,
    makeRunId,
    type GameState,
    type PlayInput,
    type PlayLogEndReason,
    type PlayLogRowBase,
    type PlayLogRowKind,
} from "./playlog-row.js";
import { openPlayLogFile, type PlayLogWriter } from "./playlog-writer.js";
import { StatePoller, type StateFetcher } from "./state-poller.js";

const log = childLogger("playlog");

/** 押下中のポインタ移動を記録する最短間隔。 */
const POINTER_MOVE_MIN_MS = 100;
const IDLE_CHECK_MS = 5_000;

export interface PlayLogRecorderDeps {
    dir:        string;
    getConfig:  (appId: string) => AppConfig | undefined;
    hashPlayer: (userId: string) => string;
    now?:       () => number;
    openWriter?: (path: string) => PlayLogWriter;
    fetchState?: StateFetcher;
}

interface Run {
    key:        string;
    id:         string;
    appId:      string;
    sessionId:  string;
    player:     string;
    startedAt:  number;
    lastActive: number;
    idleStopMs: number;
    seq:        number;
    writer:     PlayLogWriter;
    lastStateJson: string | null;
    pointerHeld:   boolean;
    lastMoveAt:    number;
}

export class PlayLogRecorder {
    private readonly runs = new Map<string, Run>();
    private readonly poller: StatePoller;
    private readonly now: () => number;
    private readonly openWriter: (path: string) => PlayLogWriter;
    private readonly idleTimer: NodeJS.Timeout;

    constructor(private readonly deps: PlayLogRecorderDeps) {
        this.now = deps.now ?? Date.now;
        this.openWriter = deps.openWriter ?? openPlayLogFile;
        this.poller = new StatePoller((appId, state) => this.onState(appId, state), deps.fetchState);
        this.idleTimer = setInterval(() => this.closeIdle(), IDLE_CHECK_MS);
        this.idleTimer.unref?.();
    }

    /** 入力 1 件を記録する。playLog 無効の app は何もしない。 */
    recordInput(sessionId: string, userId: string, appId: string, input: PlayInput): void {
        const run = this.runs.get(runKey(sessionId, appId)) ?? this.open(sessionId, userId, appId);
        if (!run) return;
        const now = this.now();
        if (input.device === "pointer") {
            if (input.phase === "move") {
                if (!run.pointerHeld || now - run.lastMoveAt < POINTER_MOVE_MIN_MS) return;
                run.lastMoveAt = now;
            } else {
                run.pointerHeld = input.phase === "down";
            }
        }
        run.lastActive = now;
        this.write(run, "input", inputFields(input));
    }

    /**
     * 感想 1 件を、その app で記録中の run (= 操作中の人のプレイ) に `comment` 行として書く。
     * 記録中の run が無ければ何もしない (感想だけで run は開かない)。送った人は生の ID を書かずハッシュにする。
     */
    recordComment(appId: string, userId: string, text: string): void {
        const commenter = this.deps.hashPlayer(userId);
        for (const run of this.runs.values()) {
            if (run.appId === appId) this.write(run, "comment", { comment: text, commenter });
        }
    }

    closeSessionApp(sessionId: string, appId: string, reason: PlayLogEndReason): void {
        const run = this.runs.get(runKey(sessionId, appId));
        if (run) this.close(run, reason);
    }

    closeSession(sessionId: string, reason: PlayLogEndReason): void {
        for (const run of [...this.runs.values()]) {
            if (run.sessionId === sessionId) this.close(run, reason);
        }
    }

    closeApp(appId: string, reason: PlayLogEndReason): void {
        for (const run of [...this.runs.values()]) {
            if (run.appId === appId) this.close(run, reason);
        }
    }

    shutdown(): void {
        clearInterval(this.idleTimer);
        for (const run of [...this.runs.values()]) this.close(run, "shutdown");
        this.poller.shutdown();
    }

    /** 記録中の run 数 (テスト・診断用)。 */
    get openRuns(): number {
        return this.runs.size;
    }

    /** idle 判定を今すぐ行う (タイマーからも呼ばれる)。 */
    closeIdle(): void {
        const now = this.now();
        for (const run of [...this.runs.values()]) {
            if (now - run.lastActive >= run.idleStopMs) this.close(run, "idle");
        }
    }

    /** ゲーム状態が前回から変わった run にだけ `state` 行を書く。 */
    onState(appId: string, state: GameState | null): void {
        if (!state) return;
        const json = JSON.stringify(state);
        for (const run of this.runs.values()) {
            if (run.appId !== appId || run.lastStateJson === json) continue;
            run.lastActive = this.now();
            this.write(run, "state", {});
        }
    }

    private open(sessionId: string, userId: string, appId: string): Run | undefined {
        const cfg = this.deps.getConfig(appId);
        if (!cfg?.playLog?.enabled) return undefined;
        const now = this.now();
        const id = makeRunId(new Date(now));
        let writer: PlayLogWriter;
        try {
            writer = this.openWriter(join(this.deps.dir, appId, `${id}.jsonl`));
        } catch (err) {
            log.warn({ appId, msg: err instanceof Error ? err.message : String(err) }, "play log open failed");
            return undefined;
        }
        const run: Run = {
            key: runKey(sessionId, appId),
            id, appId, sessionId,
            player:     this.deps.hashPlayer(userId),
            startedAt:  now,
            lastActive: now,
            idleStopMs: cfg.playLog.idleStopSec * 1000,
            seq:        0,
            writer,
            lastStateJson: null,
            pointerHeld:   false,
            lastMoveAt:    0,
        };
        this.runs.set(run.key, run);
        this.poller.acquire(cfg, run.key);
        this.write(run, "start", { source: "ws" });
        log.info({ appId, run: id }, "play log started");
        return run;
    }

    private close(run: Run, reason: PlayLogEndReason): void {
        if (!this.runs.has(run.key)) return;
        this.write(run, "end", { reason });
        this.runs.delete(run.key);
        this.poller.release(run.appId, run.key);
        run.writer.close();
        log.info({ appId: run.appId, run: run.id, reason, rows: run.seq }, "play log closed");
    }

    private write(run: Run, kind: PlayLogRowKind, fields: Record<string, unknown>): void {
        const now = this.now();
        const base: PlayLogRowBase = {
            run:    run.id,
            player: run.player,
            app:    run.appId,
            seq:    run.seq,
            t_ms:   now - run.startedAt,
            at:     new Date(now).toISOString(),
        };
        const state = this.poller.current(run.appId);
        if (state) run.lastStateJson = JSON.stringify(state);
        try {
            run.writer.write(buildRow(base, kind, fields, state));
            run.seq += 1;
        } catch (err) {
            log.warn({ appId: run.appId, run: run.id, msg: err instanceof Error ? err.message : String(err) }, "play log write failed");
        }
    }
}

function runKey(sessionId: string, appId: string): string {
    return `${sessionId}\u0000${appId}`;
}
