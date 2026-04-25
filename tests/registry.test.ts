/**
 * AppsRegistry: 状態遷移と event emit。
 */
import { describe, expect, test, vi } from "vitest";
import { AppsRegistry } from "../src/apps/registry.js";

const sample = [{
    id: "demo", name: "Demo", target: "desktop" as const,
    run: { cwd: ".", cmd: "x", args: [], env: {} },
    input: { buttons: [], allowKeyboard: true, allowMouse: false },
    logs: { stdout: true, stderr: true, files: [] },
}];

describe("AppsRegistry", () => {
    test("initial status is idle", () => {
        const r = new AppsRegistry(sample);
        const st = r.getStatus("demo");
        expect(st?.lifecycle).toBe("idle");
        expect(st?.pid).toBeNull();
    });

    test("setLifecycle emits status-changed", () => {
        const r = new AppsRegistry(sample);
        const spy = vi.fn();
        r.on("status-changed", spy);
        r.setLifecycle("demo", "running", { pid: 1234 });
        expect(spy).toHaveBeenCalledTimes(1);
        const [appId, status] = spy.mock.calls[0]!;
        expect(appId).toBe("demo");
        expect(status.lifecycle).toBe("running");
        expect(status.pid).toBe(1234);
    });

    test("setLifecycle returns false for unknown id", () => {
        const r = new AppsRegistry(sample);
        expect(r.setLifecycle("nope", "running")).toBe(false);
    });
});
