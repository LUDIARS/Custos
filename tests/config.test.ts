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
});
