/**
 * 選択中の app に対する、この接続の操作権 (player / spectator / free) を保持して表示する。
 *
 * 操作権はサーバーが決める (src/input/control-lease.ts)。ここはサーバーから届いた
 * `control` メッセージを反映するだけで、自分で判定はしない。観戦中は入力欄・パッド・
 * Unity 操作を止めるため、変化を onChange で配る。
 */

const ROLE_LABEL = {
    player: "▶ プレイ中",
    spectator: "👁 観戦中",
};

export function createControlState({ badge, banner, onChange }) {
    let appId = null;
    let role = "free";

    function setApp(nextAppId) {
        appId = nextAppId;
        apply("free");
    }

    /** サーバーの `control` メッセージ。選択中の app 以外のものは捨てる。 */
    function handleMessage(msg) {
        if (msg.appId !== appId) return;
        apply(msg.role);
    }

    function apply(nextRole) {
        const changed = nextRole !== role;
        role = nextRole;
        document.body.dataset.role = role;
        badge.hidden = role === "free";
        badge.dataset.role = role;
        badge.textContent = ROLE_LABEL[role] ?? "";
        banner.hidden = role !== "spectator";
        if (changed) onChange(role);
    }

    return {
        setApp,
        handleMessage,
        role: () => role,
        /** 観戦中でなければ操作してよい (free なら最初の操作で player になる)。 */
        canOperate: () => role !== "spectator",
    };
}
