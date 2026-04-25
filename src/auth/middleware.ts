/**
 * Hono 用 Cernere 認証 middleware。
 *
 * Authorization: Bearer <token> を読み取り、CernereAuth.verify() で検証。
 * 通れば `c.set("user", VerifiedUser)`、失敗は 401。
 *
 * `CUSTOS_OPEN=1` は CernereAuth 内で素通し処理されるため、ここでも
 * その挙動をそのまま継承する。
 */

import type { Context, Next } from "hono";
import { getCernereAuth, type VerifiedUser } from "./cernere-auth.js";

export function cernereAuthMiddleware() {
    return async (c: Context, next: Next) => {
        const auth = getCernereAuth();
        const header = c.req.header("authorization") ?? c.req.header("Authorization") ?? "";
        const m = /^Bearer\s+(.+)$/i.exec(header);
        const token = m?.[1] ?? "";
        const user = await auth.verify(token);
        if (!user) {
            return c.json({ error: "unauthorized" }, 401);
        }
        c.set("user", user);
        await next();
    };
}

declare module "hono" {
    interface ContextVariableMap {
        user: VerifiedUser;
    }
}
