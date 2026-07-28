/**
 * Unity ブリッジへの HTTP クライアント。
 *
 * ドメインリロードで接続が切れるのが**通常運転**なので、再接続の面倒は
 * ここで見る。呼び出し側 (CLI / backend route / LLM) に再接続ループを
 * 書かせないことが、この層の存在理由。
 */

import {
    DEFAULT_BRIDGE_PORT,
    isTransientBridgeError,
    nextCompileWaitPhase,
    type BridgeCompileStatus,
    type BridgeHealth,
    type BridgeLogPage,
    type BridgeStatus,
    type CompileWaitState,
} from "./bridge-contract.js";

export interface BridgeClientOptions {
    host?: string;
    port?: number;
    token?: string;
    /** 1 リクエストのタイムアウト (ms)。既定 10 秒 (メインスレッド待ちが 5 秒あるため)。 */
    timeoutMs?: number;
}

export class BridgeUnreachableError extends Error {
    constructor(baseUrl: string, cause: unknown) {
        super(`Unity bridge unreachable at ${baseUrl}: ${cause instanceof Error ? cause.message : String(cause)}`);
        this.name = "BridgeUnreachableError";
    }
}

export class BridgeHttpError extends Error {
    constructor(readonly status: number, readonly body: string) {
        super(`Unity bridge returned ${status}: ${body.slice(0, 200)}`);
        this.name = "BridgeHttpError";
    }
}

export class BridgeClient {
    private readonly host: string;
    private readonly port: number;
    private readonly token: string;
    private readonly timeoutMs: number;

    constructor(options: BridgeClientOptions = {}) {
        this.host = options.host ?? "127.0.0.1";
        this.port = options.port ?? DEFAULT_BRIDGE_PORT;
        this.token = options.token ?? "";
        this.timeoutMs = options.timeoutMs ?? 10_000;
    }

    get baseUrl(): string {
        return `http://${this.host}:${this.port}`;
    }

    async health(): Promise<BridgeHealth> {
        return this.getJson<BridgeHealth>("/health");
    }

    async status(): Promise<BridgeStatus> {
        return this.getJson<BridgeStatus>("/editor/status");
    }

    async compileStatus(): Promise<BridgeCompileStatus> {
        return this.getJson<BridgeCompileStatus>("/editor/compile-status");
    }

    async requestCompile(): Promise<void> {
        await this.postJson("/editor/compile", {});
    }

    /**
     * AssetDatabase.Refresh。asmdef / 新規アセットの取り込みに必要。
     * `requestCompile` は既存のアセンブリグラフで再コンパイルするだけで、
     * .asmdef の変更は取り込まれない。
     */
    async refresh(): Promise<void> {
        await this.postJson("/editor/refresh", {});
    }

    async log(sinceSeq: number, level?: string, limit = 200): Promise<BridgeLogPage> {
        const query = new URLSearchParams({ since: String(sinceSeq), limit: String(limit) });
        if (level) {
            query.set("level", level);
        }
        return this.getJson<BridgeLogPage>(`/editor/log?${query.toString()}`);
    }

    async play(): Promise<unknown> {
        return this.postJson("/editor/play", {});
    }

    async stop(): Promise<unknown> {
        return this.postJson("/editor/stop", {});
    }

    async scene(): Promise<unknown> {
        return this.getJson("/editor/scene");
    }

    async hierarchy(depth = 2, root?: string): Promise<unknown> {
        const query = new URLSearchParams({ depth: String(depth) });
        if (root) {
            query.set("root", root);
        }
        return this.getJson(`/editor/hierarchy?${query.toString()}`);
    }

    async publishCapture(caption: string, source = "gameview"): Promise<unknown> {
        return this.postJson("/editor/publish-capture", { caption, source });
    }

    /** 到達できるか。ドメインリロード中は false。 */
    async reachable(): Promise<boolean> {
        try {
            await this.health();
            return true;
        } catch (error) {
            if (isTransientBridgeError(error)) {
                return false;
            }
            // HTTP エラーが返るなら listener は生きている。
            return error instanceof BridgeHttpError;
        }
    }

    /**
     * 再コンパイルを要求し、ドメインリロードを跨いで完了まで待つ。
     *
     * リロード中は接続そのものが落ちるので「繋がらない = まだ処理中」と扱う。
     * ただし一度も繋がっていなければ Unity が居ないので即座に諦める。
     */
    async compileAndWait(options: {
        pollIntervalMs?: number;
        unreachableBudgetMs?: number;
        totalBudgetMs?: number;
        sleep?: (ms: number) => Promise<void>;
    } = {}): Promise<BridgeCompileStatus> {
        const pollIntervalMs = options.pollIntervalMs ?? 1_000;
        const totalBudgetMs = options.totalBudgetMs ?? 10 * 60_000;
        const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

        const state: CompileWaitState = {
            everReachable: await this.reachable(),
            unreachableMs: 0,
            unreachableBudgetMs: options.unreachableBudgetMs ?? 90_000,
        };
        if (!state.everReachable) {
            throw new BridgeUnreachableError(this.baseUrl, new Error("bridge not reachable before compile"));
        }

        await this.requestCompile();

        let elapsedMs = 0;
        // リロードが始まる前に読むと「コンパイル中でない」を拾ってしまうので一拍置く。
        await sleep(pollIntervalMs);
        elapsedMs += pollIntervalMs;

        for (;;) {
            let reachable = false;
            let isCompiling = true;
            let snapshot: BridgeCompileStatus | null = null;
            try {
                snapshot = await this.compileStatus();
                reachable = true;
                isCompiling = snapshot.isCompiling;
            } catch (error) {
                if (!isTransientBridgeError(error)) {
                    throw error;
                }
            }

            if (reachable) {
                state.everReachable = true;
                state.unreachableMs = 0;
            } else {
                state.unreachableMs += pollIntervalMs;
            }

            const phase = nextCompileWaitPhase(state, reachable, isCompiling);
            if (phase === "done" && snapshot) {
                return snapshot;
            }
            if (phase === "unreachable") {
                throw new BridgeUnreachableError(this.baseUrl, new Error("bridge did not come back after reload"));
            }
            if (elapsedMs >= totalBudgetMs) {
                throw new Error(`compile did not finish within ${Math.round(totalBudgetMs / 1000)}s`);
            }

            await sleep(pollIntervalMs);
            elapsedMs += pollIntervalMs;
        }
    }

    private async getJson<T>(path: string): Promise<T> {
        return this.request<T>("GET", path);
    }

    private async postJson<T = unknown>(path: string, body: unknown): Promise<T> {
        return this.request<T>("POST", path, body);
    }

    private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
        const headers: Record<string, string> = { accept: "application/json" };
        if (this.token) {
            headers["x-auth-token"] = this.token;
        }
        if (body !== undefined) {
            headers["content-type"] = "application/json";
        }

        const init: RequestInit = {
            method,
            headers,
            signal: AbortSignal.timeout(this.timeoutMs),
        };
        if (body !== undefined) {
            init.body = JSON.stringify(body);
        }

        let response: Response;
        try {
            response = await fetch(`${this.baseUrl}${path}`, init);
        } catch (error) {
            throw new BridgeUnreachableError(this.baseUrl, error);
        }

        const text = await response.text();
        if (!response.ok) {
            throw new BridgeHttpError(response.status, text);
        }
        return (text.length > 0 ? JSON.parse(text) : {}) as T;
    }
}
