import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { FileFarmStore } from "../src/farm/store.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
    const dir = mkdtempSync(join(tmpdir(), "custos-farm-store-")); dirs.push(dir);
    const path = join(dir, "state.json");
    writeFileSync(path, '{"version":1,"devices":{}}', "utf8");
    return { path, store: new FileFarmStore(path) };
}

test("a lock held by another writer is not stolen or deleted", () => {
    const { path, store } = fixture();
    writeFileSync(`${path}.lock`, "other writer", "utf8");
    expect(() => store.transaction(() => undefined)).toThrow("farm_store_locked");
    expect(readFileSync(`${path}.lock`, "utf8")).toBe("other writer");
});

test("corrupt or missing state fails closed and releases its own lock", () => {
    const { path, store } = fixture();
    writeFileSync(path, "broken", "utf8");
    expect(() => store.transaction(() => undefined)).toThrow();
    expect(readFileSync(path, "utf8")).toBe("broken");
    expect(existsSync(`${path}.lock`)).toBe(false);
    rmSync(path);
    expect(() => store.transaction(() => undefined)).toThrow();
    expect(existsSync(path)).toBe(false);
});

test("failed transactions never publish partial state", () => {
    const { path, store } = fixture();
    const before = readFileSync(path, "utf8");
    expect(() => store.transaction((state) => { state.version = 1; throw new Error("failed"); })).toThrow("failed");
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(existsSync(`${path}.lock`)).toBe(false);
});

test("unexplained pending writes prevent publishing a new reservation", () => {
    const { path, store } = fixture();
    writeFileSync(`${path}.pending`, "crash residue", "utf8");
    expect(() => store.transaction((state) => {
        state.devices["pixel"] = { hostId: "host", platform: "android", serial: "a", generation: 1,
            lastSeenAt: null, connected: false, needsCleanup: true, reason: "not-reported", lease: null };
    })).toThrow();
    expect(readFileSync(`${path}.pending`, "utf8")).toBe("crash residue");
    expect(JSON.parse(readFileSync(path, "utf8")).devices).toEqual({});
    expect(existsSync(`${path}.lock`)).toBe(false);
});
