/** Shared presentation contract for the live overlay and detached history. */
export const STAMPS = Object.freeze({
    good: { emoji: "👍", label: "Good" },
    bad: { emoji: "👎", label: "Bad" },
    heart: { emoji: "❤️", label: "ハート" },
    clap: { emoji: "👏", label: "拍手" },
    party: { emoji: "🎉", label: "クラッカー" },
    sad: { emoji: "😢", label: "悲しい" },
    laugh: { emoji: "😂", label: "笑い" },
});
export const OVERLAY_MS = 5000;
export const HISTORY_LIMIT = 200;

export function eventText(event) {
    return event.kind === "stamp" ? `${STAMPS[event.stamp]?.emoji ?? ""} ${STAMPS[event.stamp]?.label ?? ""}` : event.text;
}

export function historyRow(event, doc = document) {
    const row = doc.createElement("li");
    const time = new Date(event.ts).toLocaleTimeString();
    row.textContent = `${time}　${event.sender}　${eventText(event)}`;
    return row;
}
