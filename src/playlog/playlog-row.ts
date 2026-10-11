/**
 * 行動ログ 1 行の型と組み立て (純関数)。
 *
 * 列は全てトップレベルのキー。Commentarii の `guide import plays` mapping が
 * 列名で引くため、ゲーム状態は `state.<key>` に平らに展開する
 * (spec/feature/remote-play-and-play-log.md §2.4)。
 */

import type { PointerButton, PointerPhase } from "../capture/ergo-custos-client.js";

export type PlayLogRowKind = "start" | "input" | "state" | "end";
export type PlayLogEndReason = "unsubscribe" | "disconnect" | "idle" | "exit" | "shutdown";

/** 記録対象の操作。 */
export type PlayInput =
    | { device: "key";     key: string; down: boolean }
    | { device: "pointer"; x: number; y: number; button: PointerButton; phase: PointerPhase }
    | { device: "button";  id: string };

/** 全行に共通する列。 */
export interface PlayLogRowBase {
    run:    string;
    player: string;
    app:    string;
    seq:    number;
    t_ms:   number;
    at:     string;
}

export type PlayLogRow = Record<string, unknown>;

export type GameState = Record<string, unknown>;

/** 共通列 + kind 固有列 + 最新のゲーム状態 (`state.<key>`) を 1 行にする。 */
export function buildRow(
    base: PlayLogRowBase,
    kind: PlayLogRowKind,
    fields: Record<string, unknown>,
    state: GameState | null,
): PlayLogRow {
    const row: PlayLogRow = { ...base, kind, ...fields };
    if (state) {
        for (const [key, value] of Object.entries(state)) row[`state.${key}`] = value;
    }
    return row;
}

/** Commentarii の `action.verbs` に書きやすい操作名。 */
export function inputName(input: PlayInput): string {
    switch (input.device) {
        case "key":     return input.down ? `key:${input.key}` : `key:${input.key}:up`;
        case "button":  return `button:${input.id}`;
        case "pointer":
            if (input.phase === "move") return "pointer:move";
            return input.phase === "down" ? `pointer:${input.button}` : `pointer:${input.button}:up`;
    }
}

/** input 行の kind 固有列。 */
export function inputFields(input: PlayInput): Record<string, unknown> {
    const name = inputName(input);
    switch (input.device) {
        case "key":
            return { input: name, device: "key", key: input.key, down: input.down };
        case "button":
            return { input: name, device: "button", button: input.id };
        case "pointer":
            return {
                input: name, device: "pointer",
                x: input.x, y: input.y, button: input.button, phase: input.phase,
                pos: [input.x, input.y, 0],
            };
    }
}

/** run ID `YYYYMMDD-HHmmss-<6 桁>` (UTC)。 */
export function makeRunId(now: Date, random: () => number = Math.random): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    const date = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;
    const time = `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
    const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
    let suffix = "";
    for (let i = 0; i < 6; i++) suffix += alphabet[Math.floor(random() * alphabet.length)];
    return `${date}-${time}-${suffix}`;
}

export const RUN_ID_PATTERN = /^\d{8}-\d{6}-[a-z0-9]{6}$/;
export const APP_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/i;
