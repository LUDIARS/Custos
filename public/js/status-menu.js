/**
 * スマホの操作メニュー。ステータス (IDLE / RUNNING など) を押すとフローティングで開く。
 *
 * 中身は PC ではヘッダと VIEW にある部品をそのまま移して使う (同じ要素なので操作の配線は 1 つ):
 *   - BOOT / Run / Test / Kill (#headerActions)
 *   - Unity の状態 (bridge・版・モード・シーン) と Play / Stop / Recompile / Refresh / Send (#unityStrip)
 * スマホ表示のときだけメニューへ移し、PC 表示に戻ったら元の場所へ戻す。
 *
 * 開始時と、ゲームが動いていない間は開いた状態にする。ゲームが動き出したら閉じる
 * (動いている間に開け閉めしたのは、次に状態が変わるまでそのまま)。
 */

export function createStatusMenu({ pill, menu, actionsSlot, unitySlot, headerActions, unityStrip }) {
    const homes = [headerActions, unityStrip].map((el) => ({ el, parent: el.parentNode, next: el.nextSibling }));
    let mobile = false;
    let open = true;
    let gameRunning = null;

    pill.addEventListener("click", () => {
        if (!mobile) return;
        setOpen(!open);
    });

    /** layout-mode から呼ぶ。スマホならメニューへ移し、PC なら元へ戻す。 */
    function setMobile(isMobile) {
        mobile = isMobile;
        if (mobile) {
            actionsSlot.appendChild(headerActions);
            unitySlot.appendChild(unityStrip);
        } else {
            for (const { el, parent, next } of homes) parent.insertBefore(el, next);
        }
        render();
    }

    /** ゲームが動いているか。変わったときだけ開閉を決め直す (動いていなければ開く)。 */
    function setGameRunning(running) {
        if (running === gameRunning) return;
        gameRunning = running;
        setOpen(!running);
    }

    function setOpen(next) {
        open = next;
        render();
    }

    function render() {
        menu.hidden = !(mobile && open);
        pill.setAttribute("aria-expanded", String(mobile && open));
        pill.classList.toggle("menu-open", mobile && open);
    }

    return { setMobile, setGameRunning };
}
