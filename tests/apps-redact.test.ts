import { describe, expect, it } from "vitest";
import { redact } from "../src/routes/apps-routes.js";
import type { AppConfig } from "../src/config/apps-config.js";

/**
 * `/api/apps` が返す config は redact() を通る。
 *
 * Unity パネルはこの応答だけを見てタブの出し分けを決めるので、判定に必要な
 * フラグが落ちると **UI からは「ブリッジが無い」ようにしか見えず、Unity 側が
 * 正常に動いていても永久にポーリングを始めない**。実際に一度そうなった
 * (2026-07-26) ので、フラグの有無をテストで固定する。
 */
function baseConfig(extra: Partial<AppConfig>): AppConfig {
    return {
        id: "x",
        name: "X",
        target: "desktop",
        run: { workingDir: "C:/x", cwd: "C:/x", cmd: "x.exe", args: [], env: {} },
        ...extra,
    } as AppConfig;
}

describe("redact", () => {
    it("exposes hasUnityBridge for unity bridges", () => {
        const cfg = baseConfig({
            inAppBridge: { kind: "unity", host: "127.0.0.1", port: 17778, fps: 24 },
        } as Partial<AppConfig>);

        expect(redact(cfg).hasUnityBridge).toBe(true);
    });

    it("does not flag ergo bridges as unity", () => {
        // ergo ブリッジは /editor/* を持たないので Unity パネルの対象外。
        const cfg = baseConfig({
            inAppBridge: { kind: "ergo", host: "127.0.0.1", port: 5201, fps: 30 },
        } as Partial<AppConfig>);

        expect(redact(cfg).hasUnityBridge).toBe(false);
    });

    it("reports false when there is no bridge at all", () => {
        expect(redact(baseConfig({})).hasUnityBridge).toBe(false);
    });

    it("keeps the bridge host and port off the wire", () => {
        // ブラウザは /api/unity/:appId/* 経由でしか触らないので接続先を知る必要がない。
        const cfg = baseConfig({
            inAppBridge: { kind: "unity", host: "127.0.0.1", port: 17778, fps: 24 },
        } as Partial<AppConfig>);

        const serialized = JSON.stringify(redact(cfg));
        expect(serialized).not.toContain("17778");
        expect(serialized).not.toContain("inAppBridge");
    });
});
