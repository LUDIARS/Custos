/**
 * WebRTC の ICE サーバー (STUN / TURN) の設定。サーバー (werift) とブラウザの両方が同じものを使う。
 *
 * - STUN: 既定は Cloudflare の無料 STUN (stun.cloudflare.com:3478)。PC と スマホがそれぞれ NAT の
 *   外側のアドレスを知り、同じ LAN にいなくても UDP で直接つながれるようにする。
 *   `CUSTOS_STUN_URLS` (カンマ区切り) で変えられ、空文字で無効にできる。
 * - TURN: `CUSTOS_TURN_KEY_ID` と `CUSTOS_TURN_KEY_API_TOKEN` (Cloudflare Realtime の TURN キー) が
 *   あるときだけ使う。直接つながらない回線 (携帯の CGNAT など) で映像を中継する。認証情報は
 *   Cloudflare の API で期限付きのものを発行し、期限の手前まで使い回す。
 */

import { childLogger } from "../shared/logger.js";

const log = childLogger("ice-servers");

export const DEFAULT_STUN_URL = "stun:stun.cloudflare.com:3478";
const TURN_API = "https://rtc.live.cloudflare.com/v1/turn/keys";
/** 発行する TURN 認証情報の有効期間 (秒)。 */
const TURN_TTL_SEC = 86_400;
/** 期限のこれだけ手前で作り直す (接続中に切れないように)。 */
const TURN_REFRESH_MARGIN_MS = 60 * 60 * 1000;

export interface IceServer {
    urls: string[];
    username?: string;
    credential?: string;
}

export interface IceServerEnv {
    CUSTOS_STUN_URLS?: string | undefined;
    CUSTOS_TURN_KEY_ID?: string | undefined;
    CUSTOS_TURN_KEY_API_TOKEN?: string | undefined;
}

export function stunServersFromEnv(env: IceServerEnv): IceServer[] {
    const raw = env.CUSTOS_STUN_URLS ?? DEFAULT_STUN_URL;
    const urls = raw.split(",").map((url) => url.trim()).filter(Boolean);
    return urls.length > 0 ? [{ urls }] : [];
}

/**
 * Cloudflare の応答から TURN サーバーを取り出す。ブラウザは port 53 の TURN を拒否することがある
 * (Cloudflare の案内どおり除く)。
 */
export function parseTurnResponse(body: unknown): IceServer[] {
    const list = (body as { iceServers?: unknown })?.iceServers;
    const entries = Array.isArray(list) ? list : list ? [list] : [];
    const servers: IceServer[] = [];
    for (const entry of entries as Array<{ urls?: unknown; username?: unknown; credential?: unknown }>) {
        const urls = (Array.isArray(entry.urls) ? entry.urls : [entry.urls])
            .filter((url): url is string => typeof url === "string" && url.startsWith("turn"))
            .filter((url) => !/:53(\?|$)/.test(url));
        if (urls.length === 0) continue;
        if (typeof entry.username !== "string" || typeof entry.credential !== "string") continue;
        servers.push({ urls, username: entry.username, credential: entry.credential });
    }
    return servers;
}

export class IceServerProvider {
    private readonly stun: IceServer[];
    private readonly turnKeyId: string | null;
    private readonly turnToken: string | null;
    private turn: { servers: IceServer[]; expiresAt: number } | null = null;
    private pending: Promise<IceServer[]> | null = null;

    constructor(
        env: IceServerEnv = process.env,
        private readonly fetchImpl: typeof fetch = fetch,
        private readonly now: () => number = Date.now,
    ) {
        this.stun = stunServersFromEnv(env);
        const keyId = env.CUSTOS_TURN_KEY_ID?.trim() || null;
        const token = env.CUSTOS_TURN_KEY_API_TOKEN?.trim() || null;
        // 片方だけは設定の誤り。黙って TURN 無しで動かさず、起動時に止める。
        if (Boolean(keyId) !== Boolean(token)) {
            throw new Error("CUSTOS_TURN_KEY_ID と CUSTOS_TURN_KEY_API_TOKEN は両方そろえて設定してください");
        }
        this.turnKeyId = keyId;
        this.turnToken = token;
        log.info({ stun: this.stun.flatMap((s) => s.urls), turn: Boolean(keyId) }, "ICE servers configured");
        if (!keyId) log.info("TURN is not configured — peers behind strict NAT (e.g. mobile CGNAT) may not receive video");
    }

    get hasTurn(): boolean {
        return this.turnKeyId !== null;
    }

    /** STUN と (設定があれば) TURN。TURN の発行に失敗したときは STUN だけを返し、理由をログに出す。 */
    async get(): Promise<IceServer[]> {
        if (!this.turnKeyId) return this.stun;
        try {
            return [...this.stun, ...(await this.turnServers())];
        } catch (err) {
            log.warn({ err: err instanceof Error ? err.message : String(err) }, "TURN credentials unavailable — using STUN only");
            return this.stun;
        }
    }

    private turnServers(): Promise<IceServer[]> {
        if (this.turn && this.turn.expiresAt - TURN_REFRESH_MARGIN_MS > this.now()) {
            return Promise.resolve(this.turn.servers);
        }
        this.pending ??= this.issueTurn().finally(() => { this.pending = null; });
        return this.pending;
    }

    private async issueTurn(): Promise<IceServer[]> {
        const res = await this.fetchImpl(
            `${TURN_API}/${encodeURIComponent(this.turnKeyId ?? "")}/credentials/generate-ice-servers`,
            {
                method: "POST",
                headers: { "authorization": `Bearer ${this.turnToken}`, "content-type": "application/json" },
                body: JSON.stringify({ ttl: TURN_TTL_SEC }),
                signal: AbortSignal.timeout(10_000),
            },
        );
        if (!res.ok) throw new Error(`Cloudflare TURN API returned HTTP ${res.status}`);
        const servers = parseTurnResponse(await res.json());
        if (servers.length === 0) throw new Error("Cloudflare TURN API returned no TURN servers");
        this.turn = { servers, expiresAt: this.now() + TURN_TTL_SEC * 1000 };
        return servers;
    }
}

/** werift は 1 エントリ 1 URL の形を受け取る。UDP で使える stun / turn だけを渡す。 */
export function toWeriftIceServers(servers: IceServer[]): Array<{ urls: string; username?: string; credential?: string }> {
    return servers.flatMap((server) => server.urls
        .filter((url) => url.startsWith("stun:") || (url.startsWith("turn:") && !url.includes("transport=tcp")))
        .map((urls) => ({
            urls,
            ...(server.username ? { username: server.username } : {}),
            ...(server.credential ? { credential: server.credential } : {}),
        })));
}
