import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { WebSocket, type WebSocketServer } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppsRegistry } from "../src/apps/registry.js";
import { AppsRunner } from "../src/apps/runner.js";
import { ScreenshotStreamer } from "../src/capture/screenshot-stream.js";
import { attachWebSocketBroker } from "../src/ws/handler.js";
import { CernereAuth, setCernereAuth } from "../src/auth/cernere-auth.js";
import type { ServerMessage } from "../src/shared/types.js";
import { appConfigSchema } from "../src/config/apps-config.js";
import { ControlLease } from "../src/input/control-lease.js";

function next(ws: WebSocket, type: ServerMessage["type"]): Promise<ServerMessage> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { ws.off("message", listener); reject(new Error(`no ${type}`)); }, 2000);
        function listener(data: Buffer): void {
            const msg = JSON.parse(String(data)) as ServerMessage;
            if (msg.type !== type) return;
            clearTimeout(timer);
            ws.off("message", listener);
            resolve(msg);
        }
        ws.on("message", listener);
    });
}

describe("audience WS routing", () => {
    let server: Server;
    let broker: WebSocketServer;
    let streamer: ScreenshotStreamer;
    let port: number;
    let now: number;
    const sockets: WebSocket[] = [];

    beforeEach(async () => {
        const auth = new CernereAuth();
        vi.spyOn(auth, "verify").mockResolvedValue({ id: "anon", name: "anon", email: "", role: "general" });
        setCernereAuth(auth);
        const registry = new AppsRegistry(["demo", "other"].map((id) => appConfigSchema.parse({
            id, name: id, target: "desktop" as const,
            run: { cwd: ".", workingDir: ".", cmd: "unused", args: [], env: {} },
            input: { buttons: [], allowKeyboard: true, allowMouse: false },
            logs: { stdout: true, stderr: true, files: [] },
        })));
        streamer = new ScreenshotStreamer(registry);
        server = createServer();
        now = 0;
        broker = attachWebSocketBroker(server, { registry, runner: new AppsRunner(registry), streamer, control: new ControlLease(), audienceNow: () => now });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("no address");
        port = address.port;
    });

    afterEach(async () => {
        for (const socket of sockets.splice(0)) socket.terminate();
        for (const socket of broker.clients) socket.terminate();
        await new Promise<void>((resolve) => broker.close(() => resolve()));
        await new Promise<void>((resolve) => server.close(() => resolve()));
        vi.restoreAllMocks();
        setCernereAuth(new CernereAuth());
    });

    async function connect(appId: string, historyOnly = false): Promise<WebSocket> {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
        sockets.push(ws);
        await once(ws, "open");
        const history = next(ws, "audience-history");
        ws.send(JSON.stringify({ type: historyOnly ? "audience-subscribe" : "subscribe", appId }));
        await history;
        return ws;
    }

    it("fans out to player, spectator and log window, isolates apps, and replays history without capture", async () => {
        const player = await connect("demo");
        const spectator = await connect("demo");
        const acquire = vi.spyOn(streamer, "acquire");
        const logWindow = await connect("demo", true);
        expect(acquire).not.toHaveBeenCalled();
        const other = await connect("other", true);
        const otherEvents: ServerMessage[] = [];
        other.on("message", (data) => otherEvents.push(JSON.parse(String(data)) as ServerMessage));
        const received = [player, spectator, logWindow].map((ws) => next(ws, "audience-event"));
        spectator.send(JSON.stringify({ type: "audience-send", appId: "demo", kind: "stamp", stamp: "heart" }));
        const events = await Promise.all(received);
        expect(events[0]).toMatchObject({ type: "audience-event", event: { kind: "stamp", stamp: "heart", ts: 0 } });
        expect(events[1]).toEqual(events[0]);
        expect(events[2]).toEqual(events[0]);
        const barrier = next(other, "audience-history");
        other.send(JSON.stringify({ type: "audience-subscribe", appId: "other" }));
        await barrier;
        expect(otherEvents.some((msg) => msg.type === "audience-event")).toBe(false);
        const replay = next(logWindow, "audience-history");
        logWindow.send(JSON.stringify({ type: "audience-subscribe", appId: "demo" }));
        expect(await replay).toMatchObject({ events: [expect.objectContaining({ stamp: "heart" })] });
    });

    it("rejects unjoined rooms, malformed submissions and bursts, then permits the next message", async () => {
        const spectator = await connect("demo");
        let error = next(spectator, "error");
        spectator.send(JSON.stringify({ type: "audience-send", appId: "other", kind: "message", text: "not joined" }));
        await error;
        error = next(spectator, "error");
        spectator.send(JSON.stringify({ type: "audience-send", appId: "demo", kind: "stamp", stamp: "forged" }));
        await error;
        let received = next(spectator, "audience-event");
        spectator.send(JSON.stringify({ type: "audience-send", appId: "demo", kind: "message", text: " hello " }));
        expect(await received).toMatchObject({ event: { text: "hello" } });
        error = next(spectator, "error");
        spectator.send(JSON.stringify({ type: "audience-send", appId: "demo", kind: "message", text: "burst" }));
        await error;
        now = 750;
        received = next(spectator, "audience-event");
        spectator.send(JSON.stringify({ type: "audience-send", appId: "demo", kind: "message", text: "next" }));
        expect(await received).toMatchObject({ event: { text: "next", ts: 750 } });
    });
});
