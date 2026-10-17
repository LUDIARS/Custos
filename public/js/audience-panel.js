import { STAMPS } from "/js/audience-content.js";
import { createAudienceOverlay } from "/js/audience-overlay.js";

/** Spectator composer, connection feedback and detached history launcher. */
export function createAudiencePanel({ getAppId, send }) {
    const form = document.getElementById("audienceForm");
    const input = document.getElementById("audienceText");
    const palette = document.getElementById("audienceStamps");
    const status = document.getElementById("audienceStatus");
    const history = document.getElementById("audienceHistory");
    const overlay = createAudienceOverlay(document.getElementById("audienceMessages"), document.getElementById("audienceStampsOverlay"));
    let connected = false;
    let ready = false;
    let cooldown = null;
    let role = "free";
    const panel = document.getElementById("spectatorPanel");

    for (const [stamp, { emoji, label }] of Object.entries(STAMPS)) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = emoji;
        button.title = label;
        button.setAttribute("aria-label", label);
        button.addEventListener("click", () => submit({ kind: "stamp", stamp }));
        palette.appendChild(button);
    }

    function refresh() {
        const canSend = connected && ready && Boolean(getAppId()) && role === "spectator" && cooldown === null;
        for (const control of form.elements) control.disabled = !canSend;
        history.disabled = !getAppId();
        status.textContent = !getAppId() ? "アプリを選ぶと観戦できます。"
            : !connected ? "再接続中です。送信できません。"
            : !ready ? "観戦に接続しています…"
            : role !== "spectator" ? "プレイ中もスタンプとメッセージを受信します。送信は観戦中にできます。"
            : "観戦中 · メッセージは約5秒で消えます。履歴はログから読めます。";
    }

    function submit(content) {
        if (!connected || !ready || !getAppId() || role !== "spectator" || cooldown !== null) return;
        if (!send({ type: "audience-send", appId: getAppId(), ...content })) {
            status.textContent = "送信できませんでした。接続を確認してください。";
            return;
        }
        if (content.kind === "message") input.value = "";
        cooldown = setTimeout(() => { cooldown = null; refresh(); }, 800);
        refresh();
    }

    form.addEventListener("submit", (event) => {
        event.preventDefault();
        const text = input.value.trim();
        if (text) submit({ kind: "message", text });
    });
    history.addEventListener("click", () => {
        if (!getAppId()) return;
        const url = `/audience-log.html?appId=${encodeURIComponent(getAppId())}`;
        const popup = window.open(url, "custos-audience-log", "popup,width=520,height=650");
        if (popup) popup.focus();
        else status.textContent = "ログを開くには、このサイトのポップアップを許可してください。";
    });
    window.addEventListener("pagehide", () => { overlay.clear(); clearTimeout(cooldown); cooldown = null; });
    refresh();
    return {
        setRole(value) { role = value; panel.hidden = role !== "spectator"; refresh(); },
        onAppChanged() {
            overlay.clear();
            input.value = "";
            ready = false;
            refresh();
        },
        setConnected(value) { connected = value; ready = false; refresh(); },
        receive(msg) {
            if (msg.appId !== getAppId()) return;
            if (msg.type === "audience-history") { ready = true; refresh(); }
            // History establishes readiness but is never replayed as a live overlay.
            if (msg.type === "audience-event") overlay.show(msg.event);
        },
    };
}
