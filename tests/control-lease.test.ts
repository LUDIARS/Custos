/**
 * ControlLease (遠隔プレイの操作権) と、それを REST に掛ける requireControl。
 */
import { describe, expect, test } from "vitest";
import { Hono } from "hono";
import { ControlLease } from "../src/input/control-lease.js";
import { CLIENT_ID_HEADER, requireControl } from "../src/routes/control-guard.js";

describe("ControlLease", () => {
    test("最初に取った接続が player、他は spectator", () => {
        const lease = new ControlLease();
        expect(lease.roleOf("app", "a")).toBe("free");

        expect(lease.acquire("app", "a")).toBe(true);
        expect(lease.acquire("app", "b")).toBe(false);
        expect(lease.acquire("app", "a")).toBe(true);

        expect(lease.roleOf("app", "a")).toBe("player");
        expect(lease.roleOf("app", "b")).toBe("spectator");
        expect(lease.holder("app")).toBe("a");
    });

    test("操作権は app ごとに独立", () => {
        const lease = new ControlLease();
        lease.acquire("one", "a");
        expect(lease.acquire("two", "b")).toBe(true);
    });

    test("player 以外の release は無視し、player の release で free に戻る", () => {
        const lease = new ControlLease();
        lease.acquire("app", "a");
        lease.release("app", "b");
        expect(lease.holder("app")).toBe("a");

        lease.release("app", "a");
        expect(lease.roleOf("app", "b")).toBe("free");
        expect(lease.acquire("app", "b")).toBe(true);
    });

    test("切断 (releaseAll) でその接続の操作権をすべて手放す", () => {
        const lease = new ControlLease();
        lease.acquire("one", "a");
        lease.acquire("two", "a");
        lease.acquire("three", "b");

        lease.releaseAll("a");

        expect(lease.holder("one")).toBeNull();
        expect(lease.holder("two")).toBeNull();
        expect(lease.holder("three")).toBe("b");
    });

    test("持ち主が変わったときだけ changed を通知する", () => {
        const lease = new ControlLease();
        const events: [string, string | null][] = [];
        lease.on("changed", (appId: string, holder: string | null) => events.push([appId, holder]));

        lease.acquire("app", "a");
        lease.acquire("app", "a");
        lease.acquire("app", "b");
        lease.release("app", "b");
        lease.release("app", "a");

        expect(events).toEqual([["app", "a"], ["app", null]]);
    });

    test("mayOperate: free なら誰でも、player がいれば player だけ", () => {
        const lease = new ControlLease();
        expect(lease.mayOperate("app", null)).toBe(true);
        lease.acquire("app", "a");
        expect(lease.mayOperate("app", "a")).toBe(true);
        expect(lease.mayOperate("app", "b")).toBe(false);
        expect(lease.mayOperate("app", null)).toBe(false);
    });
});

describe("requireControl", () => {
    function guardedApp(lease: ControlLease): Hono {
        const app = new Hono();
        app.post("/:appId/play", requireControl(lease, (c) => c.req.param("appId") ?? ""), (c) => c.json({ ok: true }));
        return app;
    }

    test("観戦中の接続からの操作は 409", async () => {
        const lease = new ControlLease();
        lease.acquire("game", "player");
        const res = await guardedApp(lease).request("/game/play", {
            method: "POST",
            headers: { [CLIENT_ID_HEADER]: "watcher" },
        });
        expect(res.status).toBe(409);
    });

    test("player の操作と、誰もプレイしていないときの操作は通す", async () => {
        const lease = new ControlLease();
        const app = guardedApp(lease);
        expect((await app.request("/game/play", { method: "POST" })).status).toBe(200);

        lease.acquire("game", "player");
        const res = await app.request("/game/play", {
            method: "POST",
            headers: { [CLIENT_ID_HEADER]: "player" },
        });
        expect(res.status).toBe(200);
    });
});
