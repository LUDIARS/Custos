/**
 * Custos 共通の状態・メッセージ型。
 *
 * `AppStatus` は registry が in-memory で持ち、API/WS の応答に直接乗る。
 * 配信ペイロードはすべてこのファイルから引いて統一する。
 */

export type RunnerKind = "build" | "run" | "test";

/// アプリのライフサイクル状態。`crashed` は exitCode != 0 で終わったケース。
/// `killed` は API 経由で SIGKILL/Stop した場合に区別して立てる。
export type AppLifecycle =
    | "idle"
    | "building"
    | "built"
    | "running"
    | "stopped"
    | "crashed"
    | "killed"
    | "testing";

export interface AppStatus {
    id:          string;
    lifecycle:   AppLifecycle;
    /** 現在 / 直近の run の PID。終了後も最後の値を保持。 */
    pid:         number | null;
    /** lastExitCode が null のときはまだ走ったことがない or 走行中。 */
    lastExitCode: number | null;
    /** 最後の状態遷移の epoch ms。 */
    lastChangeAt: number;
    /** 直近の操作 (API/WS から見える操作 ID)。 */
    lastBuildId: string | null;
    lastRunId:   string | null;
    lastTestId:  string | null;
}

// ─── WS message envelope ──────────────────────────────────────

/** Server → Client. */
export type ServerMessage =
    | { type: "hello";      appId: string;  status: AppStatus }
    | { type: "log";        appId: string;  kind: RunnerKind;  stream: "stdout" | "stderr"; text: string; ts: number }
    | { type: "status";     appId: string;  status: AppStatus }
    | { type: "exit";       appId: string;  kind: RunnerKind;  exitCode: number | null; signal: string | null; ts: number }
    | { type: "screenshot"; appId: string;  ts: number; png_b64: string; mime: "image/png"; bytes: number }
    | { type: "error";      message: string };

/** Client → Server. */
export type ClientMessage =
    | { type: "subscribe";   appId: string }
    | { type: "unsubscribe"; appId: string }
    | { type: "key";         appId: string; key: string;  down: boolean }
    | { type: "click";       appId: string; x: number;    y: number; button?: "left" | "right" | "middle" }
    | { type: "button";      appId: string; id: string };
