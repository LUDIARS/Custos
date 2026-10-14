/**
 * LOG / TEST ウインドウへのログ出力。test 由来は TEST、それ以外は LOG に流す。
 */

/** 1 つのログ欄に残す最大行数。長時間つなぎっぱなしでも DOM が肥大しないようにする。 */
const MAX_LINES = 2000;

export function createLogView({ logEl, testEl }) {
    function append(msg) {
        const target = msg.kind === "test" ? testEl : logEl;
        const span = document.createElement("span");
        span.classList.add(msg.stream === "stderr" ? "stderr" : "stdout");
        if (msg.kind && msg.kind !== "meta") span.classList.add(msg.kind);
        if (msg.kind === "meta") span.classList.add("meta");
        // 改行で終わっていなければ足す (api ログを 1 行ずつ揃えるため)
        span.textContent = msg.text.endsWith("\n") ? msg.text : msg.text + "\n";
        target.appendChild(span);
        while (target.childElementCount > MAX_LINES) target.firstElementChild?.remove();
        target.scrollTop = target.scrollHeight;
    }

    /** 運用メッセージ (Custos 自身のログ) を LOG に出す。 */
    function meta(text, isError = false) {
        append({ kind: "meta", stream: isError ? "stderr" : "stdout", text });
    }

    function clear(target) {
        target.textContent = "";
    }

    return { append, meta, clear };
}
