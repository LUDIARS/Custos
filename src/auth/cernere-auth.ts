/**
 * Cernere トークン検証クライアント (最小実装)。
 *
 * Custos はサービス間 (project_token) よりも個別ユーザー (accessToken) の検証が
 * 主用途。`@ludiars/cernere-service-adapter` を引き込まずに、`/api/auth/verify`
 * への HTTP fetch + 5 分キャッシュだけを持つ薄いラッパとして実装する。将来
 * service-adapter を追加する場合はこのモジュールを差し替える。
 *
 * 環境変数:
 *   CERNERE_URL — base URL (例: http://localhost:8080)
 *   CUSTOS_OPEN — "1" のとき認証を完全スキップ (dev 用)
 */

import { childLogger } from "../shared/logger.js";

const log = childLogger("cernere-auth");

const TTL_MS = 300_000;        // 5 分キャッシュ (RULE.md 推奨)

export interface VerifiedUser {
    id:    string;
    name:  string;
    email: string;
    role:  "admin" | "general" | "restricted" | string;
}

interface CacheEntry { user: VerifiedUser; expiresAt: number; }

export class CernereAuth {
    private readonly cernereUrl: string;
    private readonly cache = new Map<string, CacheEntry>();

    constructor(cernereUrl?: string) {
        this.cernereUrl = (cernereUrl ?? process.env.CERNERE_URL ?? "").replace(/\/$/, "");
    }

    /** Cernere 連携が有効かどうか。CERNERE_URL 未設定なら false。 */
    get enabled(): boolean { return Boolean(this.cernereUrl); }

    /**
     * トークンを Cernere で検証し VerifiedUser を返す。失敗時は null。
     * `CUSTOS_OPEN=1` のときは検証をスキップして anonymous user を返す。
     */
    async verify(token: string): Promise<VerifiedUser | null> {
        if (process.env.CUSTOS_OPEN === "1") {
            return { id: "dev-anon", name: "dev", email: "dev@local", role: "general" };
        }
        if (!token) return null;
        if (!this.enabled) {
            // CERNERE_URL 未設定: トークン非空なら通す stub (Phase 1 互換動作)。
            return token.length > 0
                ? { id: "stub", name: "stub", email: "stub@local", role: "general" }
                : null;
        }

        const cached = this.cache.get(token);
        if (cached && cached.expiresAt > Date.now()) return cached.user;

        try {
            const res = await fetch(`${this.cernereUrl}/api/auth/verify`, {
                method:  "POST",
                headers: { "content-type": "application/json", "authorization": `Bearer ${token}` },
                body:    JSON.stringify({ token }),
            });
            if (!res.ok) {
                log.warn({ status: res.status }, "verify rejected");
                return null;
            }
            const json = await res.json() as { user?: Partial<VerifiedUser> };
            const u = json.user;
            if (!u?.id) return null;
            const verified: VerifiedUser = {
                id:    String(u.id),
                name:  String(u.name ?? ""),
                email: String(u.email ?? ""),
                role:  String(u.role ?? "general"),
            };
            this.cache.set(token, { user: verified, expiresAt: Date.now() + TTL_MS });
            return verified;
        } catch (err) {
            log.warn({ err }, "verify failed");
            return null;
        }
    }

    /** 強制キャッシュ破棄 (logout 等)。 */
    invalidate(token: string): void { this.cache.delete(token); }
}

/** プロセス共有のシングルトン。`createCernereAuth()` で初期化、その後どこからでも参照。 */
let _instance: CernereAuth | null = null;
export function getCernereAuth(): CernereAuth {
    if (!_instance) _instance = new CernereAuth();
    return _instance;
}
export function setCernereAuth(auth: CernereAuth): void { _instance = auth; }
