/**
 * PC (フローティングウインドウ) とスマホ (縦 3 段) のどちらで表示するかを決める。
 *
 * 幅が狭いか、タッチ主体の縦画面ならスマホ表示にする。body に
 * `layout-mobile` / `layout-desktop` を付け、変化したら onChange を呼ぶ。
 */

const MOBILE_QUERY = "(max-width: 820px), (pointer: coarse) and (orientation: portrait)";

export function createLayoutMode({ onChange }) {
    const media = window.matchMedia(MOBILE_QUERY);

    function apply() {
        const mobile = media.matches;
        document.body.classList.toggle("layout-mobile", mobile);
        document.body.classList.toggle("layout-desktop", !mobile);
        onChange(mobile);
    }

    media.addEventListener("change", apply);
    apply();

    return {
        isMobile: () => media.matches,
    };
}
