import { historyRow, HISTORY_LIMIT } from "/js/audience-content.js";

const appId = new URLSearchParams(location.search).get("appId");
const list = document.getElementById("audienceLog");
const status = document.getElementById("audienceLogStatus");
document.getElementById("audienceLogApp").textContent = appId ?? "アプリ未選択";
let ws = null;
let retry = null;
let closed = false;
const seen = new Set();

function append(event) {
    if (event.appId !== appId || seen.has(event.id)) return;
    const atBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 80;
    seen.add(event.id);
    const row = historyRow(event);
    row.dataset.id = event.id;
    list.appendChild(row);
    while (list.children.length > HISTORY_LIMIT) {
        seen.delete(list.firstElementChild.dataset.id);
        list.firstElementChild.remove();
    }
    if (atBottom) row.scrollIntoView({ block: "end" });
}

function connect() {
    if (closed || !appId) return;
    const token = sessionStorage.getItem("custos.token") ?? "";
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${location.host}/ws${token ? `?token=${encodeURIComponent(token)}` : ""}`);
    ws.addEventListener("open", () => {
        status.textContent = "履歴を読み込んでいます…";
        ws.send(JSON.stringify({ type: "audience-subscribe", appId }));
    });
    ws.addEventListener("message", ({ data }) => {
        let msg;
        try { msg = JSON.parse(data); } catch { return; }
        if (msg.type === "error") { status.textContent = msg.message; return; }
        if (msg.appId !== appId) return;
        if (msg.type === "audience-history") {
            seen.clear();
            list.replaceChildren();
            for (const event of msg.events) append(event);
            status.textContent = msg.events.length ? "接続中 · 新しい投稿を自動表示します。" : "接続中 · まだ投稿はありません。";
        }
        if (msg.type === "audience-event") {
            append(msg.event);
            status.textContent = "接続中 · 新しい投稿を自動表示します。";
        }
    });
    ws.addEventListener("close", (event) => {
        if (closed) return;
        if (event.code === 4401) { status.textContent = "認証できません。Custos本体でログイン後、ログを開き直してください。"; return; }
        status.textContent = "接続が切れました。再接続しています…";
        retry = setTimeout(connect, 1500);
    });
    ws.addEventListener("error", () => { /* close owns reconnect and visible feedback. */ });
}

window.addEventListener("pagehide", () => { closed = true; clearTimeout(retry); ws?.close(); });
if (appId) connect();
else status.textContent = "Custos本体でアプリを選んでからログを開いてください。";
