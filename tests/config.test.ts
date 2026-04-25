/**
 * apps-config: zod schema の正常系 + 異常系。
 */
import { describe, expect, test } from "vitest";
import { appsRootSchema } from "../src/config/apps-config.js";

describe("appsRootSchema", () => {
    test("minimal app passes (run only)", () => {
        const v = appsRootSchema.parse({
            apps: [{
                id: "demo",
                name: "Demo",
                run: { cwd: ".", cmd: "echo", args: ["hi"] },
            }],
        });
        expect(v.apps[0]?.target).toBe("desktop");
        expect(v.apps[0]?.input.buttons).toEqual([]);
        expect(v.apps[0]?.input.allowKeyboard).toBe(true);
    });

    test("button must specify exactly one of key or action", () => {
        expect(() => appsRootSchema.parse({
            apps: [{
                id: "demo", name: "Demo",
                run: { cwd: ".", cmd: "x" },
                input: { buttons: [{ label: "broken" }] },
            }],
        })).toThrow();

        expect(() => appsRootSchema.parse({
            apps: [{
                id: "demo", name: "Demo",
                run: { cwd: ".", cmd: "x" },
                input: { buttons: [{ label: "both", key: "W", action: "kill" }] },
            }],
        })).toThrow();
    });

    test("rejects bad id", () => {
        expect(() => appsRootSchema.parse({
            apps: [{ id: "Bad ID with spaces", name: "x", run: { cwd: ".", cmd: "x" } }],
        })).toThrow();
    });

    test("preserves explicit env / timeout", () => {
        const v = appsRootSchema.parse({
            apps: [{
                id: "x", name: "X",
                run: { cwd: ".", cmd: "x", env: { FOO: "bar" }, timeoutSec: 60 },
            }],
        });
        expect(v.apps[0]?.run.env).toEqual({ FOO: "bar" });
        expect(v.apps[0]?.run.timeoutSec).toBe(60);
    });

    test("workingDir is the new explicit name; both workingDir and cwd populate the runtime cwd", () => {
        const v = appsRootSchema.parse({
            apps: [{
                id: "wd1", name: "WD1",
                run: { workingDir: "/tmp/work", cmd: "x" },
            }],
        });
        expect(v.apps[0]?.run.workingDir).toBe("/tmp/work");
        expect(v.apps[0]?.run.cwd).toBe("/tmp/work");
    });

    test("legacy cwd-only still parses (backward compat)", () => {
        const v = appsRootSchema.parse({
            apps: [{
                id: "wd2", name: "WD2",
                run: { cwd: "/legacy", cmd: "x" },
            }],
        });
        expect(v.apps[0]?.run.workingDir).toBe("/legacy");
        expect(v.apps[0]?.run.cwd).toBe("/legacy");
    });

    test("workingDir wins when both are present", () => {
        const v = appsRootSchema.parse({
            apps: [{
                id: "wd3", name: "WD3",
                run: { workingDir: "/new", cwd: "/old", cmd: "x" },
            }],
        });
        expect(v.apps[0]?.run.cwd).toBe("/new");
    });

    test("missing workingDir AND cwd → reject", () => {
        expect(() => appsRootSchema.parse({
            apps: [{
                id: "wd4", name: "WD4",
                run: { cmd: "x" } as unknown,
            }],
        })).toThrow();
    });

    test("build / test も独立した workingDir を持てる", () => {
        const v = appsRootSchema.parse({
            apps: [{
                id: "multi", name: "Multi",
                build: { workingDir: "/build/dir", cmd: "cmake", args: ["--build", "."] },
                run:   { workingDir: "/run/dir",   cmd: "x" },
                test:  { workingDir: "/test/dir",  cmd: "ctest" },
            }],
        });
        expect(v.apps[0]?.build?.cwd).toBe("/build/dir");
        expect(v.apps[0]?.run.cwd).toBe("/run/dir");
        expect(v.apps[0]?.test?.cwd).toBe("/test/dir");
    });
});
