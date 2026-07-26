/**
 * PrivateGame 側 Unity ブリッジ (既定 loopback:17778) の契約。
 *
 * 実装の正本は Unity 側 (`PrivateGame/Assets/PrivateGame/Editor/RemoteDev/`)。
 * ここはその形を TypeScript に写しただけで、**追加の意味を持たせない**。
 * 設計: `PrivateGame/spec/remote-unity-dev-design.md` §4-B。
 */

/** ブリッジ既定ポート。Unity 側が塞がっていれば 17779.. へ退避する。 */
export const DEFAULT_BRIDGE_PORT = 17778;

/** ポート自動退避の探索範囲 (Unity 側と揃える)。 */
export const BRIDGE_PORT_SCAN_COUNT = 11;

export interface BridgeHealth {
    status: string;
    isPlaying: boolean;
}

export interface BridgeStatus {
    unityVersion: string;
    projectPath: string;
    isPlaying: boolean;
    isPaused: boolean;
    isCompiling: boolean;
    isReloading: boolean;
    activeScene: string;
    dirtyScenes: string[];
}

export interface BridgeCompileMessage {
    file: string;
    line: number;
    column: number;
    message: string;
    assembly: string;
}

export interface BridgeCompileStatus {
    isCompiling: boolean;
    errorCount: number;
    warningCount: number;
    errors: BridgeCompileMessage[];
    warnings: BridgeCompileMessage[];
    finishedAt: string;
}

export interface BridgeLogEntry {
    seq: number;
    ts: string;
    level: string;
    message: string;
    stackTrace: string;
}

export interface BridgeLogPage {
    entries: BridgeLogEntry[];
    nextSeq: number;
}

/**
 * ブリッジが「一時的に居ない」状態かどうか。
 *
 * ドメインリロード中は HttpListener ごと落ちるので接続が拒否される。
 * これは障害ではなく通常運転なので、呼び出し側は落とさずに再接続する。
 */
export function isTransientBridgeError(error: unknown): boolean {
    const code = (error as { code?: string } | null)?.code;
    if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "ETIMEDOUT") {
        return true;
    }
    const message = error instanceof Error ? error.message : String(error ?? "");
    return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up|fetch failed/i.test(message);
}

/**
 * `compile --wait` の待ち状態を 1 ステップ進める判定。
 *
 * リロードで接続が切れるため「繋がらない = まだコンパイル中」と見なす必要がある。
 * ただし最初から一度も繋がっていない場合は Unity 自体が居ないので諦める。
 */
export type CompileWaitPhase = "waiting" | "done" | "unreachable";

export interface CompileWaitState {
    /** 一度でもブリッジへ到達できたか。 */
    everReachable: boolean;
    /** 到達できないまま経過したミリ秒。 */
    unreachableMs: number;
    /** 到達不能を諦めるまでのミリ秒。 */
    unreachableBudgetMs: number;
}

export function nextCompileWaitPhase(
    state: CompileWaitState,
    reachable: boolean,
    isCompiling: boolean,
): CompileWaitPhase {
    if (reachable) {
        return isCompiling ? "waiting" : "done";
    }
    if (!state.everReachable) {
        // 一度も繋がっていない = Unity が起動していない。待っても無駄。
        return "unreachable";
    }
    return state.unreachableMs >= state.unreachableBudgetMs ? "unreachable" : "waiting";
}
