/**
 * 音声 (process-loopback) を取り込む対象プロセスの PID を決める。
 *
 * - inAppBridge がある app: ブリッジの /health が返す pid (Unity Editor やゲーム本体)。
 *   Custos が起動していないプロセス (Excubitor が起動した Unity Editor など) でも取れる
 * - それ以外: Custos が起動した run の PID
 *
 * どちらも取れなければ、無音で流さずに理由付きのエラーにする。
 */

import type { AppConfig } from "../config/apps-config.js";
import { BridgeClient } from "../unity/bridge-client.js";

export interface AudioTargetDeps {
    /** Custos が起動した run の PID。走っていなければ undefined。 */
    getRunPid: (appId: string) => number | undefined;
    /** テスト差し替え用。既定は実 HTTP でブリッジの /health を読む。 */
    fetchBridgePid?: (bridge: NonNullable<AppConfig["inAppBridge"]>) => Promise<number | undefined>;
}

export async function resolveAudioPid(app: AppConfig, deps: AudioTargetDeps): Promise<number> {
    if (app.inAppBridge) {
        const fetchPid = deps.fetchBridgePid ?? fetchBridgePid;
        const pid = await fetchPid(app.inAppBridge);
        if (!pid) {
            throw new Error(`app ${app.id}: ブリッジの /health が pid を返しません (ブリッジが古い可能性があります)`);
        }
        return pid;
    }
    const pid = deps.getRunPid(app.id);
    if (!pid) throw new Error(`app ${app.id}: 音声を取る対象のプロセスが動いていません (Run してから接続してください)`);
    return pid;
}

async function fetchBridgePid(bridge: NonNullable<AppConfig["inAppBridge"]>): Promise<number | undefined> {
    const health = await new BridgeClient({ host: bridge.host, port: bridge.port, timeoutMs: 3_000 }).health();
    return typeof health.pid === "number" && health.pid > 0 ? health.pid : undefined;
}
