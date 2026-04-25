/**
 * resolveBareExe: cmd.exe が cwd を見ない件の修正ロジック。
 */
import { describe, expect, test } from "vitest";
import { resolveBareExe } from "../src/apps/runner.js";

describe("resolveBareExe", () => {
    test("bare adventurecube.exe → cwd-absolute", () => {
        const r = resolveBareExe("adventurecube.exe", "E:/Document/Ars/AdventureCube/build/Debug");
        expect(r.endsWith("adventurecube.exe")).toBe(true);
        expect(r.includes("Debug")).toBe(true);
        expect(/^[A-Z]:|^\//.test(r)).toBe(true);
    });

    test("relative ./foo.exe stays as-is (already disambiguated)", () => {
        expect(resolveBareExe("./adventurecube.exe", "/x")).toBe("./adventurecube.exe");
        expect(resolveBareExe("bin/adventurecube.exe", "/x")).toBe("bin/adventurecube.exe");
    });

    test("absolute path stays absolute", () => {
        expect(resolveBareExe("/usr/bin/foo", "/whatever")).toBe("/usr/bin/foo");
        expect(resolveBareExe("C:/tools/foo.exe", "/x")).toBe("C:/tools/foo.exe");
    });

    test("PATH-resolved commands (cmake / npm / git) — no extension stays bare", () => {
        expect(resolveBareExe("cmake", "/x")).toBe("cmake");
        expect(resolveBareExe("npm", "/x")).toBe("npm");
    });

    test(".bat / .cmd / .com も同様に昇格", () => {
        const r = resolveBareExe("run.bat", "/tmp/x");
        expect(r.endsWith("run.bat")).toBe(true);
        expect(r).not.toBe("run.bat");
    });
});
