import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { DevicePool } from "../src/farm/pool.js";
import { FileFarmStore } from "../src/farm/store.js";
import { farmConfigSchema } from "../src/farm/schema.js";

const config = farmConfigSchema.parse({ version: 1, heartbeatTimeoutSec: 30,
    hosts: [{ id: "host", tokenEnv: "HOST_TOKEN" }], devices: [
        { id: "pixel", hostId: "host", platform: "android", serial: "a", model: "Pixel", osVersion: "16" },
        { id: "iphone", hostId: "host", platform: "ios", serial: "b", model: "iPhone", osVersion: "26" },
    ] });
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
    const dir = mkdtempSync(join(tmpdir(), "custos-farm-"));
    dirs.push(dir);
    const path = join(dir, "state.json");
    writeFileSync(path, '{"version":1,"devices":{}}', "utf8");
    let now = 1_000_000;
    const pool = new DevicePool(config, new FileFarmStore(path), () => now);
    const ready = (generation = 1) => pool.report("host", { devices: [
        { id: "pixel", connected: true, readyGeneration: generation },
        { id: "iphone", connected: true, readyGeneration: 1 },
    ] });
    return { path, pool, ready, clock: () => now, advance: (ms: number) => { now += ms; } };
}

describe("self-hosted device pool", () => {
    test("host observations alone cannot establish readiness", () => {
        const { pool } = fixture();
        expect(pool.list().every((d) => d.availability === "offline")).toBe(true);
        pool.report("host", { devices: [{ id: "pixel", connected: true }, { id: "iphone", connected: true }] });
        expect(() => pool.acquire("pixel", "alice", 60)).toThrow("device_unavailable");
    });

    test("two coordinators cannot reserve the same device; both platforms share the pool", () => {
        const f = fixture();
        f.ready();
        const second = new DevicePool(config, new FileFarmStore(f.path), f.clock);
        f.pool.acquire("pixel", "alice", 60);
        expect(() => second.acquire("pixel", "bob", 60)).toThrow("device_unavailable");
        expect(second.acquire("iphone", "bob", 60).lease?.ownerId).toBe("bob");
    });

    test("only the owner with the current lease id may renew or release", () => {
        const f = fixture(); f.ready();
        const lease = f.pool.acquire("pixel", "alice", 60).lease!;
        expect(() => f.pool.release("pixel", "bob", lease.id)).toThrow("lease_owner_mismatch");
        expect(() => f.pool.renew("pixel", "bob", lease.id, 60)).toThrow("lease_owner_mismatch");
        f.advance(1000);
        expect(f.pool.renew("pixel", "alice", lease.id, 60).lease!.expiresAt > lease.expiresAt).toBe(true);
        const released = f.pool.release("pixel", "alice", lease.id);
        expect(released.availability).toBe("cleanup");
        f.ready(lease.generation);
        expect(() => f.pool.acquire("pixel", "bob", 60)).toThrow("device_unavailable");
        f.ready(released.generation);
        const next = f.pool.acquire("pixel", "bob", 60).lease!;
        expect(next.generation).toBeGreaterThan(lease.generation);
        expect(() => f.pool.release("pixel", "alice", lease.id)).toThrow("stale_lease");
    });

    test("expiry fences input before a late heartbeat can acknowledge cleanup", () => {
        const f = fixture(); f.ready();
        const lease = f.pool.acquire("pixel", "alice", 10).lease!;
        f.advance(10_000);
        const expired = f.ready(lease.generation)[0]!;
        expect(expired.reason).toBe("expired");
        expect(expired.lease).toBeNull();
        expect(expired.availability).toBe("cleanup");
        expect(() => f.pool.renew("pixel", "alice", lease.id, 60)).toThrow("stale_lease");
    });

    test("host timeout across restart revokes reservations and requires fresh cleanup", () => {
        const f = fixture(); f.ready();
        const lease = f.pool.acquire("pixel", "alice", 120).lease!;
        const restarted = new DevicePool(config, new FileFarmStore(f.path), f.clock);
        expect(restarted.list()[0]!.lease!.id).toBe(lease.id);
        f.advance(30_000);
        expect(restarted.list()[0]!.availability).toBe("offline");
        expect(f.ready(lease.generation)[0]!.availability).toBe("cleanup");
    });

    test("disconnect invalidates the lease and cannot be undone with an old acknowledgement", () => {
        const f = fixture(); f.ready();
        const lease = f.pool.acquire("pixel", "alice", 60).lease!;
        f.pool.report("host", { devices: [{ id: "pixel", connected: false }, { id: "iphone", connected: true }] });
        expect(f.ready(lease.generation)[0]!.availability).toBe("cleanup");
    });

    test("foreign, partial and duplicate inventories fail before changing state", () => {
        const f = fixture();
        const before = readFileSync(f.path, "utf8");
        expect(() => f.pool.report("other", { devices: [] })).toThrow("unknown_host");
        expect(() => f.pool.report("host", { devices: [{ id: "pixel", connected: true }] })).toThrow("exact_host_inventory");
        expect(() => f.pool.report("host", { devices: [{ id: "pixel", connected: true }, { id: "pixel", connected: true }] })).toThrow("exact_host_inventory");
        expect(readFileSync(f.path, "utf8")).toBe(before);
    });

    test("a returned view cannot mutate durable state", () => {
        const f = fixture(); f.ready();
        const view = f.pool.acquire("pixel", "alice", 60);
        view.lease!.ownerId = "bob";
        view.tags.push("changed");
        expect(f.pool.list()[0]!.lease!.ownerId).toBe("alice");
        expect(f.pool.list()[0]!.tags).not.toContain("changed");
    });

    test("registration rejects duplicate physical devices across different hosts", () => {
        expect(() => farmConfigSchema.parse({ ...config,
            hosts: [...config.hosts, { id: "other", tokenEnv: "OTHER_TOKEN" }],
            devices: [...config.devices, { ...config.devices[0], id: "alias", hostId: "other" }],
        })).toThrow("duplicate physical device");
    });

    test("changing an identity never transfers an existing reservation", () => {
        const f = fixture(); f.ready(); f.pool.acquire("pixel", "alice", 60);
        const changed = { ...config, devices: config.devices.map((d) => ({ ...d, serial: `${d.serial}-new` })) };
        expect(() => new DevicePool(changed, new FileFarmStore(f.path), f.clock)).toThrow("identity change");
    });
});
