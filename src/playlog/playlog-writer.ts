/**
 * 1 run 分の JSONL 追記。既存ファイルは再利用しない (2 つの run を 1 ファイルに繋げない)。
 */

import { mkdirSync, openSync, writeSync, closeSync } from "node:fs";
import { dirname } from "node:path";
import type { PlayLogRow } from "./playlog-row.js";

export interface PlayLogWriter {
    write(row: PlayLogRow): void;
    close(): void;
}

export function openPlayLogFile(path: string): PlayLogWriter {
    mkdirSync(dirname(path), { recursive: true });
    // "wx": 既に在れば失敗させる。
    let fd: number | null = openSync(path, "wx");
    return {
        write(row) {
            if (fd === null) return;
            writeSync(fd, JSON.stringify(row) + "\n");
        },
        close() {
            if (fd === null) return;
            closeSync(fd);
            fd = null;
        },
    };
}
