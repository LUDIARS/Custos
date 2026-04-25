/**
 * CernereAuth: dev / open / stub / cache 挙動。
 *
 * 実 fetch は呼ばないので CERNERE_URL は空にしておく。
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { CernereAuth } from "../src/auth/cernere-auth.js";

describe("CernereAuth", () => {
    const ENV_BACKUP = { ...process.env };
    beforeEach(() => {
        delete process.env.CERNERE_URL;
        delete process.env.CUSTOS_OPEN;
        delete process.env.CUSTOS_AUTH_REQUIRED;
    });
    afterEach(() => { process.env = { ...ENV_BACKUP }; });

    test("CUSTOS_OPEN=1 → returns dev anon for any token", async () => {
        process.env.CUSTOS_OPEN = "1";
        const a = new CernereAuth();
        const u = await a.verify("");
        expect(u?.id).toBe("dev-anon");
    });

    test("no CERNERE_URL → anonymous (open) mode by default", async () => {
        const a = new CernereAuth();
        const u1 = await a.verify("");
        const u2 = await a.verify("anything");
        expect(u1?.id).toBe("anon");
        expect(u2?.id).toBe("anon");
    });

    test("CUSTOS_AUTH_REQUIRED=1 + no CERNERE_URL → stub-token-required", async () => {
        process.env.CUSTOS_AUTH_REQUIRED = "1";
        const a = new CernereAuth();
        expect(await a.verify("")).toBeNull();
        const u = await a.verify("anything");
        expect(u?.id).toBe("stub");
    });

    test("enabled is true only when CERNERE_URL is set", () => {
        expect(new CernereAuth().enabled).toBe(false);
        expect(new CernereAuth("http://localhost:8080").enabled).toBe(true);
    });
});
