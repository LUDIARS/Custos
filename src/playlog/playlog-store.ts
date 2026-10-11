/**
 * 記録済み行動ログの一覧と読み出し。パス要素を検証してディレクトリ外を読まない。
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { APP_ID_PATTERN, RUN_ID_PATTERN } from "./playlog-row.js";

export interface PlayLogEntry {
    appId:     string;
    run:       string;
    bytes:     number;
    updatedAt: string;
}

export function isValidAppId(appId: string): boolean {
    return APP_ID_PATTERN.test(appId);
}

export function isValidRunId(run: string): boolean {
    return RUN_ID_PATTERN.test(run);
}

/** 新しい順の一覧。`appId` 指定時はその app だけ。 */
export function listPlayLogs(dir: string, appId?: string): PlayLogEntry[] {
    if (!existsSync(dir)) return [];
    const apps = appId !== undefined
        ? (isValidAppId(appId) ? [appId] : [])
        : readdirSync(dir, { withFileTypes: true })
            .filter((d) => d.isDirectory() && isValidAppId(d.name))
            .map((d) => d.name);
    const entries: PlayLogEntry[] = [];
    for (const app of apps) {
        const appDir = join(dir, app);
        if (!existsSync(appDir)) continue;
        for (const name of readdirSync(appDir)) {
            if (!name.endsWith(".jsonl")) continue;
            const run = name.slice(0, -".jsonl".length);
            if (!isValidRunId(run)) continue;
            const st = statSync(join(appDir, name));
            entries.push({ appId: app, run, bytes: st.size, updatedAt: st.mtime.toISOString() });
        }
    }
    return entries.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}

/** 1 run の JSONL 本体。無い・不正な ID は undefined。 */
export function readPlayLog(dir: string, appId: string, run: string): string | undefined {
    if (!isValidAppId(appId) || !isValidRunId(run)) return undefined;
    const file = join(dir, appId, `${run}.jsonl`);
    if (!existsSync(file)) return undefined;
    return readFileSync(file, "utf8");
}
