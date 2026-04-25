/**
 * アプリ build / run / test の subprocess 管理。
 *
 * 各アプリには「build proc」「run proc」「test proc」の最大 3 系統が同時に
 * 走り得るが、実際には build → run のシーケンシャル運用が想定なので、
 * ここでは「同 kind は 1 並列まで」の単純なルールで扱う。kill は run のみ。
 *
 * 出力 (stdout/stderr) は EventEmitter で 1 行単位に投げる。WS broker が
 * subscribe して接続中クライアントへフォワードする。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { AppConfig, CmdConfig } from "../config/apps-config.js";
import type { AppsRegistry } from "./registry.js";
import type { RunnerKind, AppLifecycle } from "../shared/types.js";
import { childLogger } from "../shared/logger.js";

const log = childLogger("runner");

export interface RunnerEvents {
    "log":  (appId: string, kind: RunnerKind, stream: "stdout" | "stderr", text: string) => void;
    "exit": (appId: string, kind: RunnerKind, exitCode: number | null, signal: string | null) => void;
}

interface ActiveProc {
    kind:   RunnerKind;
    /** API から見える操作 ID。 */
    opId:   string;
    proc:   ChildProcess;
    /** タイムアウト用の setTimeout ハンドル。 */
    timer:  NodeJS.Timeout | null;
}

export class AppsRunner extends EventEmitter {
    /** appId → kind → ActiveProc */
    private active = new Map<string, Map<RunnerKind, ActiveProc>>();

    constructor(private readonly registry: AppsRegistry) {
        super();
    }

    /** 同 (appId, kind) で既に走っているかどうか。 */
    isActive(appId: string, kind: RunnerKind): boolean {
        return Boolean(this.active.get(appId)?.get(kind));
    }

    /** 直近 PID。run プロセスのみ意味あり。 */
    getRunPid(appId: string): number | undefined {
        return this.active.get(appId)?.get("run")?.proc.pid;
    }

    /** build を起動。既に走っていれば throw。 */
    startBuild(app: AppConfig): string {
        if (!app.build) throw new Error(`app ${app.id} has no build command`);
        return this.startKind(app, "build", app.build);
    }

    /** run を起動。 */
    startRun(app: AppConfig): string {
        return this.startKind(app, "run", app.run);
    }

    /** test を起動。 */
    startTest(app: AppConfig): string {
        if (!app.test) throw new Error(`app ${app.id} has no test command`);
        return this.startKind(app, "test", app.test);
    }

    /** 動作中の run を SIGKILL。返り値は kill 対象が見つかったかどうか。 */
    kill(appId: string): boolean {
        const inner = this.active.get(appId);
        const a = inner?.get("run");
        if (!a) return false;
        try {
            // process.kill on Windows → tree.kill 使うべきだがまずは SIGKILL で素直に。
            a.proc.kill("SIGKILL");
        } catch (err) {
            log.warn({ err }, "kill failed");
        }
        // 状態は exit ハンドラが拾う
        return true;
    }

    /** すべての proc を終了 (graceful shutdown 用)。 */
    shutdown(): void {
        for (const [, kindMap] of this.active) {
            for (const [, a] of kindMap) {
                try { a.proc.kill("SIGTERM"); } catch { /* ignore */ }
                if (a.timer) clearTimeout(a.timer);
            }
        }
        this.active.clear();
    }

    // ─── internal ────────────────────────────────────────────

    private startKind(app: AppConfig, kind: RunnerKind, cfg: CmdConfig): string {
        if (this.isActive(app.id, kind)) {
            throw new Error(`${kind} already running for ${app.id}`);
        }

        const opId = randomUUID();
        log.info({ appId: app.id, kind, opId, cwd: cfg.cwd, cmd: cfg.cmd }, "spawn");

        // shell: false の方が安全だが、cmd に空白入りパスや shell 構文が混じる
        // ことがあるので shell: true で起動する。`cmd` + `args` は空白 join される。
        const argsStr = cfg.args.length > 0 ? " " + cfg.args.map(quoteArg).join(" ") : "";
        const proc = spawn(cfg.cmd + argsStr, [], {
            cwd:   cfg.cwd,
            env:   { ...process.env, ...cfg.env },
            shell: true,
            stdio: ["ignore", "pipe", "pipe"],
        });

        const reg = this.registry;
        const lifecycleStart:  AppLifecycle = ({ build: "building", run: "running", test: "testing" } as const)[kind];
        const lifecycleNormal: AppLifecycle = ({ build: "built",    run: "stopped", test: "idle"    } as const)[kind];

        reg.setLifecycle(app.id, lifecycleStart, {
            pid:          proc.pid ?? null,
            lastBuildId:  kind === "build" ? opId : reg.getStatus(app.id)?.lastBuildId ?? null,
            lastRunId:    kind === "run"   ? opId : reg.getStatus(app.id)?.lastRunId   ?? null,
            lastTestId:   kind === "test"  ? opId : reg.getStatus(app.id)?.lastTestId  ?? null,
        });

        proc.stdout?.on("data", (chunk: Buffer) => this.emitLines(app.id, kind, "stdout", chunk));
        proc.stderr?.on("data", (chunk: Buffer) => this.emitLines(app.id, kind, "stderr", chunk));

        const active: ActiveProc = { kind, opId, proc, timer: null };

        if (cfg.timeoutSec && cfg.timeoutSec > 0) {
            active.timer = setTimeout(() => {
                log.warn({ appId: app.id, kind, opId }, "timeout — sending SIGKILL");
                try { proc.kill("SIGKILL"); } catch { /* ignore */ }
            }, cfg.timeoutSec * 1000);
        }

        proc.on("exit", (code, signal) => {
            if (active.timer) clearTimeout(active.timer);
            const inner = this.active.get(app.id);
            inner?.delete(kind);
            if (inner && inner.size === 0) this.active.delete(app.id);

            this.emit("exit", app.id, kind, code, signal);

            // run のみ kill / crashed を区別。build は exit code != 0 のとき
            // "idle" に戻すことで UI 上 "built" と視覚的に分ける。
            let nextLifecycle: AppLifecycle = lifecycleNormal;
            if (kind === "run") {
                if (signal === "SIGKILL" || signal === "SIGTERM") nextLifecycle = "killed";
                else if (typeof code === "number" && code !== 0)  nextLifecycle = "crashed";
            }
            if (kind === "build" && typeof code === "number" && code !== 0) {
                nextLifecycle = "idle";
            }
            reg.setLifecycle(app.id, nextLifecycle, {
                pid:          null,
                lastExitCode: code,
            });
        });

        proc.on("error", (err) => {
            log.error({ err, appId: app.id, kind }, "spawn error");
            this.emit("log", app.id, kind, "stderr", `[custos] spawn error: ${err.message}\n`);
        });

        if (!this.active.has(app.id)) this.active.set(app.id, new Map());
        this.active.get(app.id)!.set(kind, active);
        return opId;
    }

    private partialBuf = new Map<string, string>();   // `${appId}:${kind}:${stream}` -> 未完行

    private emitLines(appId: string, kind: RunnerKind, stream: "stdout" | "stderr", chunk: Buffer): void {
        const key = `${appId}:${kind}:${stream}`;
        const partial = (this.partialBuf.get(key) ?? "") + chunk.toString("utf8");
        const lines = partial.split(/\r?\n/);
        const tail  = lines.pop() ?? "";
        for (const line of lines) {
            this.emit("log", appId, kind, stream, line);
        }
        this.partialBuf.set(key, tail);
    }
}

/** shell: true 用のクォート (POSIX/win32 両対応の最低限)。 */
function quoteArg(s: string): string {
    if (/^[\w./\\:=+-]+$/.test(s)) return s;
    return `"${s.replace(/"/g, '\\"')}"`;
}
