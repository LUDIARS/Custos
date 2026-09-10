import { expect, test } from "vitest";
import { FarmHostAuth } from "../src/farm/host-auth.js";
import { loadFarmRuntime } from "../src/farm/runtime.js";

test("host credentials are distinct, required and restricted to one host", () => {
    const hosts = [{ id: "a", tokenEnv: "HOST_A" }, { id: "b", tokenEnv: "HOST_B" }];
    const env = { HOST_A: "a".repeat(40), HOST_B: "b".repeat(40) };
    const auth = new FarmHostAuth(hosts, env);
    expect(auth.verify("a", `Bearer ${env.HOST_A}`)).toBe(true);
    expect(auth.verify("b", `Bearer ${env.HOST_A}`)).toBe(false);
    expect(auth.verify("unknown", `Bearer ${env.HOST_A}`)).toBe(false);
    expect(auth.verify("a", "Bearer invalid")).toBe(false);
    expect(() => new FarmHostAuth(hosts, {})).toThrow("missing or invalid");
    expect(() => new FarmHostAuth(hosts, { ...env, HOST_B: env.HOST_A })).toThrow("distinct");
});

test("farm is opt-in and explicit invalid configuration does not silently disable it", () => {
    expect(loadFarmRuntime({})).toBeUndefined();
    expect(() => loadFarmRuntime({ CUSTOS_FARM_CONFIG: "" })).toThrow("absolute file path");
});
