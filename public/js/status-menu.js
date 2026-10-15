/**
 * スマホの操作メニュー。ステータス (IDLE / RUNNING など) を押すと、LOG などと同じく画面の下から開く。
 * × で閉じる。
 *
 * 中身は PC ではヘッダと VIEW にある部品をそのまま移して使う (同じ要素なので操作の配線は 1 つ):
 *   - BOOT / Run / Test / Kill (#headerActions)
 *   - Unity の状態 (bridge・版・モード・シーン) と Play / Stop / Recompile / Refresh / Send (#unityStrip)
 * スマホ表示のときだけメニューへ移し、PC 表示に戻ったら元の場所へ戻す。
 *
 * 開始時と、ゲームが動いていない間は開いた状態にする。ゲームが動き出したら閉じる
 * (動いている間に開け閉めしたのは、次に状態が変わるまでそのまま)。
 * × で閉じたときは閉じるを優先し、ステータスを押して開くまで自動では開かない。
 */

export function createStatusMenu({ pill, menu, closeButton, actionsSlot, unitySlot, headerActions, unityStrip }) {
    const homes = [headerActions, unityStrip].map((el) => ({ el, parent: el.parentNode, next: el.nextSibling }));
    let mobile = false;
    let open = true;
    let gameRunning = null;
    let closedByUser = false;

    pill.addEventListener("click", () => {
        if (!mobile) return;
        closedByUser = open;
        setOpen(!open);
    });
    closeButton.addEventListener("click", () => {
        closedByUser = true;
        setOpen(false);
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

    /** ゲームが動いているか。変わったときだけ開閉を決め直す (動いていなければ開く。ただし × で閉じていたら開かない)。 */
    function setGameRunning(running) {
        if (running === gameRunning) return;
        gameRunning = running;
        if (running) setOpen(false);
        else if (!closedByUser) setOpen(true);
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
