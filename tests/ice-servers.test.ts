import { describe, expect, test } from "vitest";
import {
    DEFAULT_STUN_URL,
    IceServerProvider,
    parseTurnResponse,
    stunServersFromEnv,
    toWeriftIceServers,
} from "../src/capture/ice-servers.js";

describe("stunServersFromEnv", () => {
    test("既定は Cloudflare の STUN", () => {
        expect(stunServersFromEnv({})).toEqual([{ urls: [DEFAULT_STUN_URL] }]);
    });

    test("カンマ区切りで差し替えられ、空文字で無効にできる", () => {
        expect(stunServersFromEnv({ CUSTOS_STUN_URLS: "stun:a:3478, stun:b:3478" })).toEqual([{ urls: ["stun:a:3478", "stun:b:3478"] }]);
        expect(stunServersFromEnv({ CUSTOS_STUN_URLS: "" })).toEqual([]);
    });
});

describe("parseTurnResponse", () => {
    test("TURN だけを取り出し、ブラウザが拒否する port 53 を除く", () => {
        const servers = parseTurnResponse({
            iceServers: [
                { urls: ["stun:stun.cloudflare.com:3478"] },
                {
                    urls: [
                        "turn:turn.cloudflare.com:3478?transport=udp",
                        "turn:turn.cloudflare.com:53?transport=udp",
                        "turns:turn.cloudflare.com:443?transport=tcp",
                    ],
                    username: "u",
                    credential: "c",
                },
            ],
        });
        expect(servers).toEqual([{
            urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turns:turn.cloudflare.com:443?transport=tcp"],
            username: "u",
            credential: "c",
        }]);
    });

    test("認証情報の無い TURN は捨てる", () => {
        expect(parseTurnResponse({ iceServers: [{ urls: ["turn:x:3478"] }] })).toEqual([]);
    });
});

describe("IceServerProvider", () => {
    const turnBody = { iceServers: [{ urls: ["turn:t:3478?transport=udp"], username: "u", credential: "c" }] };

    test("TURN の設定が無ければ STUN だけで、API を呼ばない", async () => {
        let calls = 0;
        const provider = new IceServerProvider({}, (async () => { calls++; return new Response("{}"); }) as typeof fetch);
        expect(await provider.get()).toEqual([{ urls: [DEFAULT_STUN_URL] }]);
        expect(provider.hasTurn).toBe(false);
        expect(calls).toBe(0);
    });

    test("キー ID とトークンの片方だけは起動時に止める", () => {
        expect(() => new IceServerProvider({ CUSTOS_TURN_KEY_ID: "k" })).toThrow(/両方そろえて/);
    });

    test("TURN の認証情報を発行して期限まで使い回し、期限が近づいたら作り直す", async () => {
        let now = 0;
        const urls: string[] = [];
        const fetchImpl = (async (url: string | URL | Request) => {
            urls.push(String(url));
            return new Response(JSON.stringify(turnBody), { status: 200 });
        }) as typeof fetch;
        const provider = new IceServerProvider(
            { CUSTOS_TURN_KEY_ID: "key", CUSTOS_TURN_KEY_API_TOKEN: "token" },
            fetchImpl,
            () => now,
        );
        const first = await provider.get();
        expect(first).toEqual([{ urls: [DEFAULT_STUN_URL] }, turnBody.iceServers[0]]);
        await provider.get();
        expect(urls).toHaveLength(1);
        expect(urls[0]).toBe("https://rtc.live.cloudflare.com/v1/turn/keys/key/credentials/generate-ice-servers");

        now = 23.5 * 60 * 60 * 1000;   // 24 時間の期限まで 1 時間を切った
        await provider.get();
        expect(urls).toHaveLength(2);
    });

    test("TURN の発行に失敗したら STUN だけを返す", async () => {
        const provider = new IceServerProvider(
            { CUSTOS_TURN_KEY_ID: "key", CUSTOS_TURN_KEY_API_TOKEN: "token" },
            (async () => new Response("denied", { status: 403 })) as typeof fetch,
        );
        expect(await provider.get()).toEqual([{ urls: [DEFAULT_STUN_URL] }]);
    });
});

describe("toWeriftIceServers", () => {
    test("1 エントリ 1 URL に分け、werift が使えない TCP / TLS の TURN を除く", () => {
        expect(toWeriftIceServers([
            { urls: ["stun:s:3478"] },
            { urls: ["turn:t:3478?transport=udp", "turn:t:3478?transport=tcp", "turns:t:443?transport=tcp"], username: "u", credential: "c" },
        ])).toEqual([
            { urls: "stun:s:3478" },
            { urls: "turn:t:3478?transport=udp", username: "u", credential: "c" },
        ]);
    });
});
