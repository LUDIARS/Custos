/**
 * REST の操作系エンドポイントを、観戦中の接続から守る Hono middleware。
 *
 * ブラウザは WS 接続時に受け取った clientId を `x-custos-client` ヘッダで付けて叩く。
 * 他の接続が遠隔プレイ中 (操作権を持っている) なら 409 で拒否する。
 */

import type { Context, MiddlewareHandler } from "hono";
import type { ControlLease } from "../input/control-lease.js";

export const CLIENT_ID_HEADER = "x-custos-client";

export function requireControl(lease: ControlLease, appIdOf: (c: Context) => string): MiddlewareHandler {
    return async (c, next) => {
        const clientId = c.req.header(CLIENT_ID_HEADER) ?? null;
        if (!lease.mayOperate(appIdOf(c), clientId)) {
            return c.json({ ok: false, error: "spectating: another user is playing this app" }, 409);
        }
        await next();
    };
}
