/**
 * /ws への接続。切れたら 1.5 秒後につなぎ直し、つながるたびに onOpen を呼ぶ
 * (呼び出し側が subscribe し直す)。受信した JSON は onMessage へそのまま渡す。
 */

import { getToken, wsBase } from "/js/api.js";

const RECONNECT_DELAY_MS = 1_500;

export function createWsClient({ statusEl, onOpen, onMessage }) {
    let ws = null;

    function connect() {
        // token は空でも繋ぐ。Cernere を使わない (anonymous) なら backend は何も要求しない。
        const token = getToken();
        const socket = new WebSocket(`${wsBase()}/ws${token ? `?token=${encodeURIComponent(token)}` : ""}`);
        ws = socket;
        socket.addEventListener("open", () => {
            setStatus(true, "WS connected");
            onOpen();
        });
        socket.addEventListener("message", (ev) => {
            let msg;
            try {
                msg = JSON.parse(ev.data);
            } catch {
                return;   // JSON 以外は来ない契約。壊れたフレームは捨てる
            }
            onMessage(msg);
        });
        socket.addEventListener("close", () => {
            setStatus(false, "WS disconnected — retrying");
            window.setTimeout(connect, RECONNECT_DELAY_MS);
        });
        socket.addEventListener("error", () => { /* close で再接続する */ });
    }

    function send(obj) {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify(obj));
    }

    function setStatus(connected, text) {
        statusEl.classList.toggle("connected", connected);
        statusEl.classList.toggle("disconnected", !connected);
        statusEl.textContent = text;
    }

    connect();
    return { send };
}
