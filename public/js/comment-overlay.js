/**
 * 感想を映像の上に数秒だけ出す。プレイ中の人も観戦者も同じものを見る
 * (spec/feature/remote-play-and-play-log.md §1.5)。操作の邪魔をしないよう、押しても下へ通す。
 */

const SHOW_MS = 6_000;
const MAX_VISIBLE = 3;

export function createCommentOverlay({ root }) {
    function show(text) {
        const item = document.createElement("div");
        item.className = "comment-bubble";
        item.textContent = `💬 ${text}`;
        root.append(item);
        while (root.children.length > MAX_VISIBLE) root.firstElementChild.remove();
        window.setTimeout(() => item.remove(), SHOW_MS);
    }

    function clear() {
        root.replaceChildren();
    }

    return { show, clear };
}
