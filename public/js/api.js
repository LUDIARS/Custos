/**
 * Custos backend への HTTP 呼び出しと WS の接続先。
 *
 * **同 origin 運用**: backend と frontend は同じ Hono に乗っているので、API も WS も
 * 相対 URL でよい。WS で受け取った clientId を `x-custos-client` に付け、操作系の
 * REST (Unity の Play/Stop など) を観戦中の接続から区別できるようにする。
 */

const API = "/api";
const TOKEN_KEY = "custos.token";
const CLIENT_ID_HEADER = "x-custos-client";

let clientId = null;
/** @type {(entry: {kind:string, stream:string, text:string}) => void} */
let logApi = () => {};

/**
 * token ダイアログは出さない運用。Cernere 認証を有効にしたい場合のみ
 * `sessionStorage.setItem("custos.token", "<jwt>")` を DevTools から直接セットする。
 */
export function getToken() {
    try {
        return sessionStorage.getItem(TOKEN_KEY) ?? "";
    } catch {
        return "";   // ストレージが使えない環境 (プライベートモード等) は token 無しとして扱う
    }
}

/** WS の welcome で受け取った自分の接続 ID。 */
export function setClientId(id) {
    clientId = id;
}

/** API 呼び出しの記録先 (LOG ウインドウ)。 */
export function setApiLogger(logger) {
    logApi = logger;
}

export async function apiFetch(path, opts = {}) {
    const headers = { "content-type": "application/json", ...(opts.headers ?? {}) };
    const token = getToken();
    if (token) headers["authorization"] = `Bearer ${token}`;
    if (clientId) headers[CLIENT_ID_HEADER] = clientId;
    const method = (opts.method ?? "GET").toUpperCase();
    const t0 = performance.now();
    logApi({ kind: "api", stream: "stdout", text: `→ ${method} ${path}` });
    try {
        const res = await fetch(API + path, { ...opts, headers });
        const ms = (performance.now() - t0).toFixed(0);
        logApi({ kind: "api", stream: res.ok ? "stdout" : "stderr", text: `← ${res.status} ${method} ${path} (${ms}ms)` });
        return res;
    } catch (err) {
        const ms = (performance.now() - t0).toFixed(0);
        logApi({ kind: "api", stream: "stderr", text: `✗ ${method} ${path} (${ms}ms) ${err.message ?? err}` });
        throw err;
    }
}

/** WebSocket 用の base URL (`ws://...` / `wss://...`)。同 origin。 */
export function wsBase() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}`;
}
