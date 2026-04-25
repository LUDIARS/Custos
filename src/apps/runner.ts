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
import { resolve as pathResolve, isAbsolute as pathIsAbsolute } from "node:path";
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
    /** `kill()` から殺されたことを覚えておく (Windows の taskkill /F は
     *  signal を渡さず exit code 1 で返るため、それだけだと "crashed" と
     *  区別がつかない)。 */
    killed: boolean;
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

    /** 動作中の run を SIGKILL (Windows は taskkill /T /F)。 */
    kill(appId: string): boolean {
        const inner = this.active.get(appId);
        const a = inner?.get("run");
        if (!a || !a.proc.pid) return false;
        a.killed = true;     // exit handler が "killed" lifecycle に倒すため
        if (process.platform === "win32") {
            // Windows の Node.js process.kill は子プロセスツリーを落とさない。
            // taskkill /T (tree) /F (force) で子孫まとめて殺す。
            try {
                spawn("taskkill", ["/PID", String(a.proc.pid), "/T", "/F"], {
                    stdio: "ignore", shell: false,
                });
            } catch (err) {
                log.warn({ err }, "taskkill failed; falling back to proc.kill");
                try { a.proc.kill("SIGKILL"); } catch { /* ignore */ }
            }
        } else {
            try { a.proc.kill("SIGKILL"); } catch (err) {
                log.warn({ err }, "kill failed");
            }
        }
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

        // Windows + shell:true の cmd.exe は **cwd 内の exe を勝手に探さない**
        // ため、`adventurecube.exe` のような bare ファイル名 + `cwd: build/Debug`
        // で実行しようとすると "認識されていません" で exit 1 になる。
        // bare ファイル名で .exe / .bat / .cmd / .com 拡張子の場合は cwd
        // 基準の絶対パスへ昇格する。bash 系 (Linux/macOS) は cwd の `./` も
        // 同じく PATH に乗らないので同様に扱う。
        const resolvedCmd = resolveBareExe(cfg.cmd, cfg.cwd);
        log.info({ appId: app.id, kind, opId, cwd: cfg.cwd, cmd: resolvedCmd, raw: cfg.cmd }, "spawn");

        // shell:false で直接 exe を起動する。理由:
        //   1. shell:true (= cmd.exe 経由) だと kill が cmd.exe にしか届かず、
        //      子の exe が孤児化して残る (今回の AC kill 問題そのもの)
        //   2. PATH / 拡張子解決の謎挙動を排除できる (cwd の exe は resolve
        //      ヘルパで絶対パスに昇格済みのため shell 補助は不要)
        //   3. クォーティング不要、引数は配列のまま渡せる
        // shell トリック (パイプ・リダイレクト等) を使いたい人は cmd を
        // `cmd /c "..."` として書く運用にする (cmd.cmd 側で明示)。
        const proc = spawn(resolvedCmd, cfg.args, {
            cwd:   cfg.cwd,
            env:   { ...process.env, ...cfg.env },
            shell: false,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
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

        const active: ActiveProc = { kind, opId, proc, timer: null, killed: false };

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
                if (active.killed)                                 nextLifecycle = "killed";
                else if (signal === "SIGKILL" || signal === "SIGTERM") nextLifecycle = "killed";
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

/**
 * cmd が「bare な実行ファイル名」(パス区切り無し + 拡張子あり) なら、
 * cwd 基準の絶対パスへ昇格する。`adventurecube.exe` を `cwd: build/Debug`
 * で起動しようとして cmd.exe が PATH 内にしか目を向けないために
 * "認識されていません" になる事故の防止。
 *
 * - 既に絶対パス (`C:\..` / `/...`) → そのまま
 * - 既にパス区切りを含む (`./foo` / `bin/foo`) → そのまま
 * - cmake / npm / git 等の PATH 上のコマンド (拡張子無し) → そのまま
 *
 * 拡張子が `.exe` / `.bat` / `.cmd` / `.com` のときだけ昇格対象とする。
 */
export function resolveBareExe(cmd: string, cwd: string): string {
    if (pathIsAbsolute(cmd)) return cmd;
    if (cmd.includes("/") || cmd.includes("\\")) return cmd;
    if (!/\.(exe|bat|cmd|com)$/i.test(cmd)) return cmd;
    return pathResolve(cwd, cmd);
}
