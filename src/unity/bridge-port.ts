/**
 * ブリッジの実ポート解決。
 *
 * Unity 側は 17778 が塞がっていると 17779.. へ退避し、実際に使ったポートを
 * `<unityProject>/custos/bridge-port` に書き出す。既定値を決め打ちすると
 * 「二台目の Unity を開いた瞬間に繋がらない」ので、必ずこのファイルを見る。
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_BRIDGE_PORT } from "./bridge-contract.js";

/** ポートファイルの中身をポート番号に変換する。壊れていれば null。 */
export function parseBridgePortFile(contents: string | null | undefined): number | null {
    if (!contents) {
        return null;
    }
    const port = Number(contents.trim());
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        return null;
    }
    return port;
}

/**
 * `CUSTOS_UNITY_PROJECT` (無ければ cwd) の `custos/bridge-port` を読む。
 * 読めなければ既定ポート。
 */
export function resolveBridgePort(projectRoot?: string): number {
    const root = projectRoot ?? process.env.CUSTOS_UNITY_PROJECT ?? process.cwd();
    const portFile = resolve(root, "custos", "bridge-port");
    if (!existsSync(portFile)) {
        return DEFAULT_BRIDGE_PORT;
    }
    try {
        return parseBridgePortFile(readFileSync(portFile, "utf8")) ?? DEFAULT_BRIDGE_PORT;
    } catch {
        return DEFAULT_BRIDGE_PORT;
    }
}
