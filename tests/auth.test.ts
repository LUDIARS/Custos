/**
 * CernereAuth: dev / stub / cache 挙動。
 *
 * 実 fetch は呼ばないので、CERNERE_URL を空にしておく ("stub" モード)
 * か `CUSTOS_OPEN=1` を立てる。
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { CernereAuth } from "../src/auth/cernere-auth.js";

describe("CernereAuth", () => {
    const ENV_BACKUP = { ...process.env };
    beforeEach(() => {
        delete process.env.CERNERE_URL;
        delete process.env.CUSTOS_OPEN;
    });
    afterEach(() => { process.env = { ...ENV_BACKUP }; });

    test("CUSTOS_OPEN=1 → returns dev anon for any token", async () => {
        process.env.CUSTOS_OPEN = "1";
        const a = new CernereAuth();
        const u = await a.verify("");
        expect(u?.id).toBe("dev-anon");
    });

    test("no CERNERE_URL → stub returns user only when token non-empty", async () => {
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
