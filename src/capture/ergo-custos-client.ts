/**
 * アプリ内 HTTP ブリッジ汎用 client。
 *
 * ergo_custos (C++ / `ergo::custos::start`) と Unity アプリ内ブリッジの
 * 両方が同一プロトコルを喋る前提で実装されており、kind に関係なく同じ
 * 関数で通信できる。
 *
 * protocol:
 *   GET  /screenshot → PNG バイナリ
 *   POST /key        → body `{ code: int, down: bool }` (HID usage コード)
 *
 * 利点:
 *   - window title マッチや focus 取得の罠から解放
 *   - swapchain present 直後の in-app readback で低レイテンシ
 *   - キー inject は focus 非依存
 */

import { childLogger } from "../shared/logger.js";

const log = childLogger("in-app-bridge");

const SCREENSHOT_TIMEOUT_MS = 8_000;
const KEY_TIMEOUT_MS        = 2_000;

export interface EndpointConfig {
    host: string;
    port: number;
}

/// `GET /screenshot` を叩いて PNG Buffer を返す。
export async function fetchScreenshot(ep: EndpointConfig): Promise<Buffer> {
    const url = `http://${ep.host}:${ep.port}/screenshot`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), SCREENSHOT_TIMEOUT_MS);
    try {
        const res = await fetch(url, { signal: ctrl.signal });
        if (!res.ok) {
            const txt = await res.text().catch(() => "");
            throw new Error(`in-app bridge /screenshot ${res.status}: ${txt.slice(0, 200)}`);
        }
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 8 ||
            buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4E || buf[3] !== 0x47) {
            throw new Error("in-app bridge /screenshot did not return a PNG");
        }
        return buf;
    } finally {
        clearTimeout(t);
    }
}

/// `POST /key` `{ code: int, down: bool }` を叩く。
export async function sendKeyCode(
    ep: EndpointConfig,
    code: number,
    down: boolean,
): Promise<void> {
    const url  = `http://${ep.host}:${ep.port}/key`;
    const body = JSON.stringify({ code, down });
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), KEY_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            method:  "POST",
            headers: { "content-type": "application/json" },
            body,
            signal:  ctrl.signal,
        });
        if (!res.ok && res.status !== 204) {
            const txt = await res.text().catch(() => "");
            throw new Error(`in-app bridge /key ${res.status}: ${txt.slice(0, 200)}`);
        }
        log.debug({ code, down }, "in-app bridge key sent");
    } finally {
        clearTimeout(t);
    }
}

/// キー名 (フロントエンドのバーチャルキー定義の `key` 文字列) を HID usage 風
/// `KeyCode` (uint16_t) にマップする。ergo / Unity どちらのブリッジも
/// 同じコード体系を使う前提。
///
/// 不明なキー名は undefined。
export function keyNameToErgoCode(name: string): number | undefined {
    const norm = name.length === 1 ? name.toUpperCase() : name;
    return KEY_TABLE[norm];
}

// `include/ergo/input/types.h` の `enum class KeyCode` と一致させる。
// 変更があったらここも追従させる必要がある (非自明な依存)。
const KEY_TABLE: Record<string, number> = (() => {
    const m: Record<string, number> = {};
    // A..Z = 4..29
    for (let i = 0; i < 26; ++i) {
        m[String.fromCharCode(65 + i)] = 4 + i;
    }
    // 1..9, 0 = 30..39 (注: ergo は 1 を 30 に、0 を 39 に置く)
    for (let i = 1; i <= 9; ++i) {
        m[String(i)]      = 30 + (i - 1);
        m[`Num${i}`]      = 30 + (i - 1);
    }
    m["0"]    = 39;
    m["Num0"] = 39;
    // Enter=40, Escape=41, Backspace=42, Tab=43, Space=44
    m["Enter"]     = 40;
    m["Return"]    = 40;
    m["Escape"]    = 41;
    m["Esc"]       = 41;
    m["Backspace"] = 42;
    m["Tab"]       = 43;
    m["Space"]     = 44;
    // F1..F12 = 58..69
    for (let i = 1; i <= 12; ++i) {
        m[`F${i}`] = 58 + (i - 1);
    }
    // Arrows: Right=79, Left=80, Down=81, Up=82
    m["Right"] = 79;
    m["Left"]  = 80;
    m["Down"]  = 81;
    m["Up"]    = 82;
    // Modifiers (left): LCtrl=224, LShift=225, LAlt=226, LSuper=227
    m["LCtrl"]  = 224;
    m["LShift"] = 225;
    m["LAlt"]   = 226;
    m["LSuper"] = 227;
    m["Ctrl"]   = 224;
    m["Shift"]  = 225;
    m["Alt"]    = 226;
    return m;
})();
