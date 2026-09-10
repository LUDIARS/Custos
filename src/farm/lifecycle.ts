/** Device availability and fencing transitions, independent of HTTP and disk. */
import type { DeviceState } from "./schema.js";

export function fenceDevice(state: DeviceState, reason: DeviceState["reason"]): void {
    state.generation += 1;
    state.lease = null;
    state.needsCleanup = true;
    state.reason = reason;
}

export function reconcileDevice(state: DeviceState, now: number, timeoutMs: number): void {
    if (state.connected && (state.lastSeenAt === null || now < state.lastSeenAt || now - state.lastSeenAt >= timeoutMs)) {
        state.connected = false;
        fenceDevice(state, "host-timeout");
    } else if (state.lease && state.lease.expiresAt <= now) {
        fenceDevice(state, "expired");
    }
}

export function deviceAvailability(state: DeviceState): "offline" | "leased" | "cleanup" | "available" {
    if (!state.connected) return "offline";
    if (state.lease) return "leased";
    return state.needsCleanup ? "cleanup" : "available";
}
