/**
 * Custos 共通の状態・メッセージ型。
 *
 * `AppStatus` は registry が in-memory で持ち、API/WS の応答に直接乗る。
 * 配信ペイロードはすべてこのファイルから引いて統一する。
 */

import type { AudienceEvent, AudienceSubmission } from "../audience/room.js";

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

/** 接続から見た遠隔プレイの操作権。src/input/control-lease.ts の ControlRole と一致させる。 */
export type ControlRole = "player" | "spectator" | "free";

/** Server → Client. */
export type ServerMessage =
    | { type: "audience-event"; appId: string; event: AudienceEvent }
    | { type: "audience-history"; appId: string; events: AudienceEvent[] }
    /** 接続直後に 1 回。clientId は REST の `x-custos-client` ヘッダに付ける。 */
    | { type: "welcome";    clientId: string }
    /** subscribe 中の app の操作権が変わったとき (と subscribe 直後)。 */
    | { type: "control";    appId: string;  role: ControlRole }
    | { type: "hello";      appId: string;  status: AppStatus }
    | { type: "log";        appId: string;  kind: RunnerKind;  stream: "stdout" | "stderr"; text: string; ts: number }
    | { type: "status";     appId: string;  status: AppStatus }
    | { type: "exit";       appId: string;  kind: RunnerKind;  exitCode: number | null; signal: string | null; ts: number }
    | { type: "screenshot"; appId: string;  ts: number; png_b64: string; mime: "image/png"; bytes: number }
    /** 観戦者などの感想。その app を見ている全接続へ配る (本文は整形済み)。 */
    | { type: "comment";    appId: string;  text: string; ts: number }
    | { type: "error";      message: string };

/** Client → Server. */
export type ClientMessage =
    | AudienceSubmission
    | { type: "audience-subscribe"; appId: string }
    | { type: "subscribe";   appId: string }
    | { type: "unsubscribe"; appId: string }
    | { type: "key";         appId: string; key: string;  down: boolean }
    | { type: "click";       appId: string; x: number;    y: number; button?: "left" | "right" | "middle" }
    /** 遠隔プレイのポインタ。x / y は配信映像の左上原点 0..1。 */
    | { type: "pointer";     appId: string; x: number;    y: number; button: "left" | "right" | "middle"; phase: "down" | "up" | "move" }
    | { type: "button";      appId: string; id: string }
    /** 遠隔プレイの ON/OFF。want=true で操作権を取りにいき、false で手放す。 */
    | { type: "control";     appId: string; want: boolean }
    /** 感想を送る (観戦者の「見てるだけ」パネルから)。本文はサーバーが整形・検証する。 */
    | { type: "comment";     appId: string; text: string };
