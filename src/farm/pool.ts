/** The sole owner of device reservations and host observations. */
import { randomUUID } from "node:crypto";
import { FarmError } from "./error.js";
import { deviceAvailability, fenceDevice, reconcileDevice } from "./lifecycle.js";
import { acquireSchema, farmConfigSchema, hostReportSchema, releaseSchema, renewSchema,
    type Device, type DeviceState, type FarmConfig, type FarmState, type HostReport, type Lease } from "./schema.js";
import type { FarmStore } from "./store.js";

export interface FarmDeviceView extends Device {
    availability: ReturnType<typeof deviceAvailability>;
    generation: number;
    lastSeenAt: string | null;
    reason: DeviceState["reason"];
    lease: { id: string; ownerId: string; generation: number; expiresAt: string } | null;
}

export class DevicePool {
    private readonly config: FarmConfig;
    constructor(config: FarmConfig, private readonly store: FarmStore,
        private readonly now: () => number = Date.now,
        private readonly newId: () => string = randomUUID) {
        this.config = farmConfigSchema.parse(config);
        this.change(() => undefined);
    }

    list(): FarmDeviceView[] {
        return this.change((state) => this.config.devices.map((device) => this.view(device, this.requireDevice(state, device.id))));
    }

    report(hostId: string, input: HostReport): FarmDeviceView[] {
        const report = hostReportSchema.parse(input);
        const devices = this.config.devices.filter((d) => d.hostId === hostId);
        if (!this.config.hosts.some((h) => h.id === hostId)) throw new FarmError("unknown_host", 404);
        const ids = new Set(report.devices.map((d) => d.id));
        if (ids.size !== report.devices.length || ids.size !== devices.length || devices.some((d) => !ids.has(d.id))) {
            throw new FarmError("report_must_include_exact_host_inventory", 400);
        }
        return this.change((state, now) => {
            for (const observation of report.devices) {
                const current = this.requireDevice(state, observation.id);
                if (!observation.connected && current.connected) fenceDevice(current, "disconnected");
                current.connected = observation.connected;
                current.lastSeenAt = now;
                // A heartbeat alone cannot clear quarantine or override a reservation.
                if (current.connected && !current.lease && observation.readyGeneration === current.generation) {
                    current.needsCleanup = false;
                    current.reason = "ready";
                }
            }
            return devices.map((device) => this.view(device, this.requireDevice(state, device.id)));
        });
    }

    acquire(deviceId: string, ownerId: string, ttlSec: number): FarmDeviceView {
        acquireSchema.parse({ ttlSec });
        this.requireOwner(ownerId);
        return this.change((state, now) => {
            const current = this.requireDevice(state, deviceId);
            if (deviceAvailability(current) !== "available") throw new FarmError("device_unavailable", 409);
            current.generation += 1;
            current.lease = { id: this.newId(), ownerId, generation: current.generation, expiresAt: now + ttlSec * 1000 };
            current.reason = "leased";
            return this.view(this.definition(deviceId), current);
        });
    }

    renew(deviceId: string, ownerId: string, leaseId: string, ttlSec: number): FarmDeviceView {
        renewSchema.parse({ leaseId, ttlSec });
        return this.change((state, now) => {
            const current = this.requireDevice(state, deviceId);
            const lease = this.ownedLease(current, ownerId, leaseId);
            lease.expiresAt = now + ttlSec * 1000;
            return this.view(this.definition(deviceId), current);
        });
    }

    release(deviceId: string, ownerId: string, leaseId: string): FarmDeviceView {
        releaseSchema.parse({ leaseId });
        return this.change((state) => {
            const current = this.requireDevice(state, deviceId);
            this.ownedLease(current, ownerId, leaseId);
            fenceDevice(current, "released");
            return this.view(this.definition(deviceId), current);
        });
    }

    private requireOwner(ownerId: string): void {
        if (!ownerId.trim()) throw new FarmError("owner_required", 403);
    }

    private ownedLease(current: DeviceState, ownerId: string, leaseId: string): Lease {
        this.requireOwner(ownerId);
        if (!current.lease || current.lease.id !== leaseId) throw new FarmError("stale_lease", 409);
        if (current.lease.ownerId !== ownerId) throw new FarmError("lease_owner_mismatch", 403);
        return current.lease;
    }

    private change<T>(action: (state: FarmState, now: number) => T): T {
        return this.store.transaction((state) => {
            const now = this.now();
            for (const id of Object.keys(state.devices)) {
                if (!this.config.devices.some((d) => d.id === id)) throw new Error("farm inventory removal requires an explicit state migration");
            }
            for (const device of this.config.devices) {
                let current = Object.hasOwn(state.devices, device.id) ? state.devices[device.id] : undefined;
                if (!current) {
                    current = { hostId: device.hostId, platform: device.platform, serial: device.serial,
                        generation: 1, lastSeenAt: null, connected: false, needsCleanup: true, reason: "not-reported", lease: null };
                    state.devices[device.id] = current;
                }
                if (current.hostId !== device.hostId || current.platform !== device.platform || current.serial !== device.serial) {
                    throw new Error("farm device identity change requires an explicit state migration");
                }
                reconcileDevice(current, now, this.config.heartbeatTimeoutSec * 1000);
            }
            return action(state, now);
        });
    }

    private definition(id: string): Device {
        const device = this.config.devices.find((d) => d.id === id);
        if (!device) throw new FarmError("unknown_device", 404);
        return device;
    }

    private requireDevice(state: FarmState, id: string): DeviceState {
        this.definition(id);
        const device = state.devices[id];
        if (!device) throw new Error("missing farm device state");
        return device;
    }

    private view(device: Device, state: DeviceState): FarmDeviceView {
        return { ...device, tags: [...device.tags], availability: deviceAvailability(state), generation: state.generation,
            lastSeenAt: state.lastSeenAt === null ? null : new Date(state.lastSeenAt).toISOString(), reason: state.reason,
            lease: state.lease ? { ...state.lease, expiresAt: new Date(state.lease.expiresAt).toISOString() } : null };
    }
}
