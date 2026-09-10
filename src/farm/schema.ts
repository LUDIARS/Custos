/** Wire contracts for the self-hosted device pool. */
import { z } from "zod";

export const farmIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const text = z.string().trim().min(1).max(160);
export const deviceSchema = z.object({
    id: farmIdSchema,
    hostId: farmIdSchema,
    platform: z.enum(["android", "ios"]),
    serial: text,
    model: text,
    osVersion: text,
    tags: z.array(text).max(32).default([]),
}).strict();
export const farmConfigSchema = z.object({
    version: z.literal(1),
    heartbeatTimeoutSec: z.number().int().min(10).max(300).default(60),
    hosts: z.array(z.object({
        id: farmIdSchema,
        tokenEnv: z.string().regex(/^[A-Z][A-Z0-9_]+$/),
    }).strict()).min(1).max(100),
    devices: z.array(deviceSchema).min(1).max(1000),
}).strict().superRefine((config, ctx) => {
    const unique = (values: string[], label: string): void => {
        if (new Set(values).size !== values.length) {
            ctx.addIssue({ code: "custom", message: `duplicate ${label}` });
        }
    };
    unique(config.hosts.map((h) => h.id), "host id");
    unique(config.hosts.map((h) => h.tokenEnv), "host token environment name");
    unique(config.devices.map((d) => d.id), "device id");
    // A physical device must not acquire a second identity through another host.
    unique(config.devices.map((d) => JSON.stringify([d.platform, d.serial])), "physical device");
    for (const device of config.devices) {
        if (!config.hosts.some((host) => host.id === device.hostId)) {
            ctx.addIssue({ code: "custom", message: `unknown host for device ${device.id}` });
        }
    }
});

export const leaseSchema = z.object({
    id: z.string().uuid(),
    ownerId: z.string().min(1),
    generation: z.number().int().positive(),
    expiresAt: z.number().int().nonnegative(),
}).strict();
export const deviceStateSchema = z.object({
    hostId: farmIdSchema,
    platform: z.enum(["android", "ios"]),
    serial: text,
    generation: z.number().int().positive(),
    lastSeenAt: z.number().int().nonnegative().nullable(),
    connected: z.boolean(),
    needsCleanup: z.boolean(),
    reason: z.enum(["not-reported", "ready", "leased", "released", "expired", "disconnected", "host-timeout"]),
    lease: leaseSchema.nullable(),
}).strict().superRefine((state, ctx) => {
    if (state.lease && (state.lease.generation !== state.generation || state.needsCleanup
        || !state.connected || state.lastSeenAt === null || state.reason !== "leased")) {
        ctx.addIssue({ code: "custom", message: "inconsistent lease state" });
    }
});
export const farmStateSchema = z.object({
    version: z.literal(1),
    devices: z.record(farmIdSchema, deviceStateSchema),
}).strict();

export const hostReportSchema = z.object({
    devices: z.array(z.object({
        id: farmIdSchema,
        connected: z.boolean(),
        readyGeneration: z.number().int().positive().optional(),
    }).strict()).max(1000),
}).strict();
export const acquireSchema = z.object({ ttlSec: z.number().int().min(10).max(1800) }).strict();
export const releaseSchema = z.object({ leaseId: z.string().uuid() }).strict();
export const renewSchema = releaseSchema.extend({ ttlSec: acquireSchema.shape.ttlSec }).strict();

export type FarmConfig = z.infer<typeof farmConfigSchema>;
export type Device = z.infer<typeof deviceSchema>;
export type Lease = z.infer<typeof leaseSchema>;
export type DeviceState = z.infer<typeof deviceStateSchema>;
export type FarmState = z.infer<typeof farmStateSchema>;
export type HostReport = z.infer<typeof hostReportSchema>;
