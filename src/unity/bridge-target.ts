/**
 * apps.json の登録から Unity ブリッジの接続先を決める純関数。
 *
 * `inAppBridge` は ergo / unity の 2 種類あるが、`/api/unity/*` が扱えるのは
 * **`kind: "unity"` だけ**。ergo ブリッジは `/editor/*` を持たないので、
 * 誤って繋いで 404 の山を出すより「未設定」として弾く。
 */

export interface BridgeTarget {
    host: string;
    port: number;
}

/** apps.json 由来の最小形。ここで必要なフィールドだけ見る。 */
export interface BridgeCapableAppConfig {
    id: string;
    // exactOptionalPropertyTypes が有効なので undefined を明示する。
    // apps.json 由来の型は inAppBridge を「省略可 かつ undefined になりうる」で持つ。
    inAppBridge?: {
        kind?: string | undefined;
        host?: string | undefined;
        port?: number | undefined;
        fps?: number | undefined;
    } | undefined;
}

export function resolveBridgeTarget(
    configs: readonly BridgeCapableAppConfig[],
    appId: string | undefined,
): BridgeTarget | null {
    if (!appId) {
        return null;
    }

    const config = configs.find((candidate) => candidate.id === appId);
    const bridge = config?.inAppBridge;
    if (!bridge || bridge.kind !== "unity") {
        return null;
    }
    if (!bridge.port || !Number.isInteger(bridge.port)) {
        return null;
    }

    return { host: bridge.host || "127.0.0.1", port: bridge.port };
}
