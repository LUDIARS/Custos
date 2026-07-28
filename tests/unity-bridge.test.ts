import { describe, expect, it } from "vitest";
import { resolveBridgeTarget } from "../src/unity/bridge-target.js";
import { parseBridgePortFile } from "../src/unity/bridge-port.js";
import {
    isTransientBridgeError,
    nextCompileWaitPhase,
    type CompileWaitState,
} from "../src/unity/bridge-contract.js";
import { parseUnityctlArgs, splitHostPort, UnityctlArgError } from "../src/unity/unityctl-args.js";
import { compileExitCode, formatCompileMessage } from "../src/unity/unityctl-render.js";

describe("resolveBridgeTarget", () => {
    const configs = [
        { id: "PrivateGame-unity", inAppBridge: { kind: "unity", host: "127.0.0.1", port: 17778 } },
        { id: "suika", inAppBridge: { kind: "ergo", host: "127.0.0.1", port: 5201 } },
        { id: "plain" },
    ];

    it("resolves a unity bridge", () => {
        expect(resolveBridgeTarget(configs, "PrivateGame-unity")).toEqual({ host: "127.0.0.1", port: 17778 });
    });

    it("rejects ergo bridges", () => {
        // ergo ブリッジは /editor/* を持たない。繋ぐと 404 の山になるので未設定扱いにする。
        expect(resolveBridgeTarget(configs, "suika")).toBeNull();
    });

    it("rejects apps without a bridge", () => {
        expect(resolveBridgeTarget(configs, "plain")).toBeNull();
    });

    it("rejects unknown and missing app ids", () => {
        expect(resolveBridgeTarget(configs, "nope")).toBeNull();
        expect(resolveBridgeTarget(configs, undefined)).toBeNull();
    });

    it("rejects a unity bridge without a usable port", () => {
        expect(resolveBridgeTarget([{ id: "x", inAppBridge: { kind: "unity" } }], "x")).toBeNull();
    });
});

describe("parseBridgePortFile", () => {
    it("reads a written port", () => {
        expect(parseBridgePortFile("17779\n")).toBe(17779);
    });

    it("rejects junk and out-of-range values", () => {
        expect(parseBridgePortFile("")).toBeNull();
        expect(parseBridgePortFile("abc")).toBeNull();
        expect(parseBridgePortFile("0")).toBeNull();
        expect(parseBridgePortFile("70000")).toBeNull();
        expect(parseBridgePortFile(null)).toBeNull();
    });
});

describe("isTransientBridgeError", () => {
    it("treats connection loss as transient", () => {
        // ドメインリロード中は接続が落ちる。障害ではなく通常運転。
        expect(isTransientBridgeError(Object.assign(new Error("x"), { code: "ECONNREFUSED" }))).toBe(true);
        expect(isTransientBridgeError(new Error("fetch failed"))).toBe(true);
    });

    it("does not swallow real errors", () => {
        expect(isTransientBridgeError(new Error("boom"))).toBe(false);
    });
});

describe("nextCompileWaitPhase", () => {
    const base: CompileWaitState = { everReachable: true, unreachableMs: 0, unreachableBudgetMs: 90_000 };

    it("keeps waiting while compiling", () => {
        expect(nextCompileWaitPhase(base, true, true)).toBe("waiting");
    });

    it("finishes when compilation stops", () => {
        expect(nextCompileWaitPhase(base, true, false)).toBe("done");
    });

    it("keeps waiting through a domain reload", () => {
        // リロード中は繋がらないが、以前繋がっていたなら待ち続ける。
        expect(nextCompileWaitPhase({ ...base, unreachableMs: 5_000 }, false, false)).toBe("waiting");
    });

    it("gives up once the reload budget is spent", () => {
        expect(nextCompileWaitPhase({ ...base, unreachableMs: 90_000 }, false, false)).toBe("unreachable");
    });

    it("gives up immediately when Unity was never reachable", () => {
        expect(nextCompileWaitPhase({ ...base, everReachable: false }, false, false)).toBe("unreachable");
    });
});

describe("parseUnityctlArgs", () => {
    it("parses a bare command", () => {
        expect(parseUnityctlArgs(["status"]).command).toBe("status");
    });

    it("parses compile --wait --json", () => {
        const args = parseUnityctlArgs(["compile", "--wait", "--json"]);
        expect(args.wait).toBe(true);
        expect(args.json).toBe(true);
    });

    it("parses --bridge in host:port, bare port and host forms", () => {
        expect(splitHostPort("10.0.0.2:17779")).toEqual(["10.0.0.2", 17779]);
        expect(splitHostPort("17779")).toEqual(["127.0.0.1", 17779]);
        expect(splitHostPort("myhost")).toEqual(["myhost", null]);
    });

    it("rejects unknown commands and options", () => {
        expect(() => parseUnityctlArgs(["nope"])).toThrow(UnityctlArgError);
        expect(() => parseUnityctlArgs(["status", "--bogus"])).toThrow(UnityctlArgError);
        expect(() => parseUnityctlArgs([])).toThrow(UnityctlArgError);
    });

    it("rejects flags that are missing their value", () => {
        expect(() => parseUnityctlArgs(["log", "--since"])).toThrow(UnityctlArgError);
        expect(() => parseUnityctlArgs(["log", "--since", "--json"])).toThrow(UnityctlArgError);
        expect(() => parseUnityctlArgs(["log", "--limit", "0"])).toThrow(UnityctlArgError);
    });
});

describe("unityctl render", () => {
    const message = { file: "Assets/A.cs", line: 12, column: 3, message: "boom", assembly: "PrivateGame.Editor" };

    it("formats compile messages as file:line:column", () => {
        expect(formatCompileMessage(message)).toBe("Assets/A.cs:12:3 [PrivateGame.Editor] boom");
    });

    it("exits non-zero only when there are errors", () => {
        const base = { isCompiling: false, warningCount: 0, errors: [], warnings: [], finishedAt: "" };
        expect(compileExitCode({ ...base, errorCount: 0 })).toBe(0);
        expect(compileExitCode({ ...base, errorCount: 2, errors: [message] })).toBe(1);
    });
});
