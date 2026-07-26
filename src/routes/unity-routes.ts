/**
 * `/api/unity/*` — Unity ブリッジへの薄いプロキシ。
 *
 * ブラウザ (Custos WebUI) は Unity ブリッジに直接触らず必ずここを通す。理由は 2 つ:
 *   1. **接続状態の管理は backend の責務**。ドメインリロード中の接続断を
 *      UI 側が解釈しなくて済むよう `{bridge:"up"|"down"|"busy"}` に正規化する
 *   2. ブリッジは loopback 固定なので、遠隔からは backend を経由するしかない
 *
 * 設計: `PrivateGame/spec/remote-unity-dev-design.md` §4-C.1
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { BridgeClient, BridgeHttpError, BridgeUnreachableError } from "../unity/bridge-client.js";
import { resolveBridgeTarget, type BridgeCapableAppConfig, type BridgeTarget } from "../unity/bridge-target.js";

export interface UnityRoutesDeps {
    /** apps.json の登録一覧を返す。テストでは配列を直接渡せる。 */
    listConfigs: () => readonly BridgeCapableAppConfig[];
    /** テスト差し替え用。既定は実 HTTP クライアント。 */
    createClient?: (target: BridgeTarget) => BridgeClient;
}

/** UI が状態表示に使う正規化済みレスポンス。 */
interface ProxyResult {
    status: number;
    body: Record<string, unknown>;
}

export function createUnityRoutes(deps: UnityRoutesDeps): Hono {
    const createClient = deps.createClient
        ?? ((target: BridgeTarget) => new BridgeClient({ host: target.host, port: target.port }));

    /**
     * ブリッジ呼び出しを 1 か所で包む。
     *
     * 到達不能を 502 ではなく **200 + bridge:"down"** で返すのは、UI が
     * 「エラー」ではなく「Unity がリロード中」として描けるようにするため。
     * ドメインリロードは通常運転であって障害ではない。
     */
    async function proxy(
        appId: string | undefined,
        call: (client: BridgeClient) => Promise<unknown>,
    ): Promise<ProxyResult> {
        const target = resolveBridgeTarget(deps.listConfigs(), appId);
        if (!target) {
            return {
                status: 404,
                body: { error: "unknown app or no unity bridge configured", appId: appId ?? null },
            };
        }

        try {
            const data = await call(createClient(target));
            return { status: 200, body: { bridge: "up", data } };
        } catch (error) {
            if (error instanceof BridgeUnreachableError) {
                return { status: 200, body: { bridge: "down", error: error.message } };
            }
            if (error instanceof BridgeHttpError) {
                // 504 はメインスレッド待ち。ブリッジ自体は生きているので busy と伝える。
                return {
                    status: error.status,
                    body: { bridge: error.status === 504 ? "busy" : "up", error: error.body },
                };
            }
            throw error;
        }
    }

    const send = (c: Context, result: ProxyResult) => c.json(result.body, result.status as 200);
    const appId = (c: Context) => c.req.param("appId");

    const app = new Hono();

    app.get("/:appId/health", async (c) => send(c, await proxy(appId(c), (b) => b.health())));
    app.get("/:appId/status", async (c) => send(c, await proxy(appId(c), (b) => b.status())));
    app.get("/:appId/compile-status", async (c) => send(c, await proxy(appId(c), (b) => b.compileStatus())));
    app.get("/:appId/scene", async (c) => send(c, await proxy(appId(c), (b) => b.scene())));

    app.get("/:appId/hierarchy", async (c) => {
        const depth = Number(c.req.query("depth") ?? "2");
        const root = c.req.query("root");
        return send(c, await proxy(appId(c), (b) => b.hierarchy(Number.isFinite(depth) ? depth : 2, root)));
    });

    app.get("/:appId/log", async (c) => {
        const since = Number(c.req.query("since") ?? "0");
        const limit = Number(c.req.query("limit") ?? "200");
        const level = c.req.query("level");
        return send(c, await proxy(appId(c), (b) => b.log(
            Number.isFinite(since) ? since : 0,
            level && level.length > 0 ? level : undefined,
            Number.isFinite(limit) ? limit : 200,
        )));
    });

    app.post("/:appId/compile", async (c) => send(c, await proxy(appId(c), async (b) => {
        await b.requestCompile();
        return { requested: true };
    })));

    app.post("/:appId/refresh", async (c) => send(c, await proxy(appId(c), async (b) => {
        // asmdef / 新規アセットの取り込み。遠隔ではウィンドウをフォーカスできないので
        // これが無いと .asmdef の変更が永久に反映されない。
        await b.refresh();
        return { refreshed: true };
    })));

    app.post("/:appId/play", async (c) => send(c, await proxy(appId(c), (b) => b.play())));
    app.post("/:appId/stop", async (c) => send(c, await proxy(appId(c), (b) => b.stop())));

    app.post("/:appId/publish-capture", async (c) => {
        const body = await c.req.json().catch(() => null) as { caption?: string; source?: string } | null;
        return send(c, await proxy(appId(c), (b) => b.publishCapture(
            body?.caption ?? "",
            body?.source ?? "gameview",
        )));
    });

    return app;
}
