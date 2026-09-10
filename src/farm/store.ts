/** Atomic, locked JSON transactions for a small local device farm. */
import { closeSync, fsyncSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { farmStateSchema, type FarmState } from "./schema.js";
import { FarmError } from "./error.js";

export interface FarmStore {
    transaction<T>(action: (state: FarmState) => T): T;
}

/** No cached state: another process must take the same lock and read the committed version. */
export class FileFarmStore implements FarmStore {
    private readonly path: string;

    constructor(path: string) {
        if (!isAbsolute(path)) throw new Error("CUSTOS_FARM_STATE_FILE must be an absolute local file path");
        // Directory junctions/symlinks must not create independent locks for the same file.
        this.path = realpathSync.native(path);
    }

    transaction<T>(action: (state: FarmState) => T): T {
        const lockPath = `${this.path}.lock`;
        let lock: number;
        try {
            lock = openSync(lockPath, "wx", 0o600);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new FarmError("farm_store_locked", 503);
            throw error;
        }
        const tempPath = `${this.path}.pending`;
        let ownsTemp = false;
        try {
            // The operator explicitly provisions an empty state once. Losing the state file
            // must never silently discard outstanding physical-device reservations.
            const state = farmStateSchema.parse(JSON.parse(readFileSync(this.path, "utf8")));
            const before = JSON.stringify(state);
            const result = action(state);
            const after = JSON.stringify(farmStateSchema.parse(state));
            if (after !== before) {
                // Exclusive creation deliberately refuses unexplained residue from a crash.
                const fd = openSync(tempPath, "wx", 0o600);
                ownsTemp = true;
                try {
                    writeFileSync(fd, after, "utf8");
                    fsyncSync(fd);
                } finally {
                    closeSync(fd);
                }
                renameSync(tempPath, this.path);
                ownsTemp = false;
            }
            return result;
        } finally {
            try {
                if (ownsTemp) unlinkSync(tempPath);
            } finally {
                try { closeSync(lock); } finally { unlinkSync(lockPath); }
            }
        }
    }
}
