import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CernereAuth, setCernereAuth } from "../src/auth/cernere-auth.js";
import { DevicePool } from "../src/farm/pool.js";
import { FileFarmStore } from "../src/farm/store.js";
import { FarmHostAuth } from "../src/farm/host-auth.js";
import { farmConfigSchema } from "../src/farm/schema.js";
import { createFarmRoutes } from "../src/routes/farm-routes.js";

const dirs: string[] = [];
beforeEach(() => {
    const auth = new CernereAuth();
    vi.spyOn(auth, "verify").mockImplementation(async (token) =>
        ["alice", "bob"].includes(token) ? { id: token, name: token, email: "", role: "general" } : null);
    setCernereAuth(auth);
});
afterEach(() => {
    vi.restoreAllMocks();
    setCernereAuth(new CernereAuth());
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
    const dir = mkdtempSync(join(tmpdir(), "custos-farm-http-")); dirs.push(dir);
    const path = join(dir, "state.json");
    writeFileSync(path, '{"version":1,"devices":{}}', "utf8");
    const config = farmConfigSchema.parse({ version: 1, hosts: [{ id: "host", tokenEnv: "HOST_TOKEN" }],
        devices: [{ id: "pixel", hostId: "host", platform: "android", serial: "a", model: "Pixel", osVersion: "16" }] });
    const pool = new DevicePool(config, new FileFarmStore(path));
    const token = "x".repeat(40);
    const app = createFarmRoutes({ pool, hostAuth: new FarmHostAuth(config.hosts, { HOST_TOKEN: token }) });
    const post = (url: string, bearer: string, body: unknown) => app.request(url, { method: "POST",
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { app, path, pool, token, post };
}

test("both exact device-list path and lease subpaths require user authentication", async () => {
    const { app, post } = fixture();
    expect((await app.request("/devices")).status).toBe(401);
    expect((await app.request("/devices", { headers: { authorization: "Bearer alice" } })).status).toBe(200);
    expect((await post("/devices/pixel/lease", "", { ttlSec: 60 })).status).toBe(401);
});

test("host credentials cannot be used as user credentials and vice versa", async () => {
    const { post, token } = fixture();
    const report = { devices: [{ id: "pixel", connected: true, readyGeneration: 1 }] };
    expect((await post("/hosts/host/report", "alice", report)).status).toBe(401);
    expect((await post("/hosts/other/report", token, report)).status).toBe(401);
    expect((await post("/hosts/host/report", token, report)).status).toBe(200);
    expect((await post("/devices/pixel/lease", token, { ttlSec: 60 })).status).toBe(401);
});

test("HTTP leases cannot impersonate an owner or steal another reservation", async () => {
    const { post, token } = fixture();
    await post("/hosts/host/report", token, { devices: [{ id: "pixel", connected: true, readyGeneration: 1 }] });
    expect((await post("/devices/pixel/lease", "alice", { ttlSec: 60, ownerId: "bob" })).status).toBe(400);
    const acquired = await post("/devices/pixel/lease", "alice", { ttlSec: 60 });
    expect(acquired.status).toBe(201);
    const { lease } = await acquired.json();
    expect((await post("/devices/pixel/lease", "bob", { ttlSec: 60 })).status).toBe(409);
    expect((await post("/devices/pixel/lease/release", "bob", { leaseId: lease.id })).status).toBe(403);
    const released = await post("/devices/pixel/lease/release", "alice", { leaseId: lease.id });
    expect((await released.json()).availability).toBe("cleanup");
});

test("bad client JSON is 400; corrupt persisted JSON is 503 without exposing its contents", async () => {
    const { app, path } = fixture();
    const invalid = await app.request("/devices/pixel/lease", { method: "POST",
        headers: { authorization: "Bearer alice", "content-type": "application/json" }, body: "{" });
    expect(invalid.status).toBe(400);
    writeFileSync(path, "private-corrupt-state", "utf8");
    const failure = await app.request("/devices", { headers: { authorization: "Bearer alice" } });
    expect(failure.status).toBe(503);
    expect(await failure.json()).toEqual({ error: "farm_storage_unavailable" });
});

test("an uncommitted acquisition is never returned as a success", async () => {
    const { path, post, token } = fixture();
    await post("/hosts/host/report", token, { devices: [{ id: "pixel", connected: true, readyGeneration: 1 }] });
    writeFileSync(`${path}.pending`, "unresolved-write", "utf8");
    expect((await post("/devices/pixel/lease", "alice", { ttlSec: 60 })).status).toBe(503);
});
