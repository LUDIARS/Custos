/**
 * 観戦者の「見てるだけ」パネル。観戦中はパッドの代わりに出し、感想を送れるようにする
 * (spec/feature/remote-play-and-play-log.md §1.5)。
 *
 * 送った感想はサーバーがその app を見ている全員へ配り直す (`comment`)。届いたものは一覧に足す
 * (自分の送ったものも、サーバーから戻ってきた時点で載せる)。
 */

const MAX_ITEMS = 50;
const MAX_CHARS = 200;   // src/ws/comment-message.ts の COMMENT_MAX_CHARS と合わせる

export function createCommentPanel({ panel, list, form, input, send, getAppId }) {
    input.maxLength = MAX_CHARS;

    form.addEventListener("submit", (ev) => {
        ev.preventDefault();
        const appId = getAppId();
        const text = input.value.trim();
        if (!appId || !text) return;
        send({ type: "comment", appId, text });
        input.value = "";
    });

    /** 観戦中だけパネルを出す。 */
    function setRole(role) {
        panel.hidden = role !== "spectator";
    }

    /** app を切り替えたら前の app の感想は消す。 */
    function setApp() {
        list.replaceChildren();
    }

    function add(msg) {
        const item = document.createElement("li");
        const time = document.createElement("time");
        time.textContent = new Date(msg.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        item.append(time, document.createTextNode(` ${msg.text}`));
        list.prepend(item);
        while (list.children.length > MAX_ITEMS) list.lastElementChild.remove();
    }

    return { setRole, setApp, add };
}
