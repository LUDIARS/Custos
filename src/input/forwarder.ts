/**
 * 仮想キー入力フォワーダ。
 *
 * desktop 対象では nut-js を optional dependency として動的 import し、
 * `keyboard.pressKey` / `releaseKey` を発火する。nut-js 未インストール時は
 * `[input:dev] key=W down=true` のログだけ出すフォールバックモードで
 * 動作する (Frontend からの操作確認には十分)。
 *
 * Android (`target: "android"`) は将来 adb input keyevent 経由で送るため
 * の hook を分けてあるが、MVP では未実装で no-op + warn ログ。
 */

import { childLogger } from "../shared/logger.js";
import type { AppConfig } from "../config/apps-config.js";

const log = childLogger("input");

interface NutLike {
    keyboard: {
        pressKey:   (...keys: unknown[]) => Promise<void>;
        releaseKey: (...keys: unknown[]) => Promise<void>;
    };
    mouse: {
        setPosition: (p: { x: number; y: number }) => Promise<void>;
        leftClick:   () => Promise<void>;
        rightClick:  () => Promise<void>;
    };
    Key: Record<string, unknown>;
    Point: new (x: number, y: number) => { x: number; y: number };
}

let nutPromise: Promise<NutLike | null> | null = null;
async function getNut(): Promise<NutLike | null> {
    if (!nutPromise) {
        nutPromise = (async () => {
            try {
                // dynamic import — Optional dep。`import()` で undefined export のまま
                // 落ちる環境がある (例: nut-js が native dep ロードに失敗) ので catch する。
                const mod = (await import("@nut-tree-fork/nut-js")) as unknown as NutLike;
                if (!mod.keyboard || !mod.Key) {
                    log.warn("nut-js loaded but API not as expected — falling back to dev mode");
                    return null;
                }
                return mod;
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                log.info({ msg }, "nut-js not available — input will be logged only (dev mode)");
                return null;
            }
        })();
    }
    return nutPromise;
}

/** key 名を nut-js Key enum に解決。"W" → Key.W、"Space" → Key.Space。
 *  解決できなければ undefined。 */
function resolveKey(nut: NutLike, name: string): unknown | undefined {
    // 1 文字 → 大文字化して検索 ("w" → "W")
    const norm = name.length === 1 ? name.toUpperCase() : name;
    return nut.Key[norm];
}

// ─── public API ────────────────────────────────────────────

export async function sendKey(app: AppConfig, key: string, down: boolean): Promise<void> {
    if (app.target === "android") {
        log.warn({ appId: app.id, key }, "android key forwarding not implemented yet");
        return;
    }
    if (!app.input.allowKeyboard) {
        log.warn({ appId: app.id }, "keyboard input disabled by app config");
        return;
    }

    const nut = await getNut();
    if (!nut) {
        log.info({ appId: app.id, key, down }, "[input:dev] key event (no nut-js)");
        return;
    }
    const resolved = resolveKey(nut, key);
    if (!resolved) {
        log.warn({ key }, "unknown key name — ignored");
        return;
    }
    if (down) await nut.keyboard.pressKey(resolved);
    else      await nut.keyboard.releaseKey(resolved);
}

export async function sendClick(
    app: AppConfig,
    x: number,
    y: number,
    button: "left" | "right" | "middle" = "left",
): Promise<void> {
    if (app.target === "android") {
        log.warn({ appId: app.id }, "android tap forwarding not implemented yet");
        return;
    }
    if (!app.input.allowMouse) {
        log.warn({ appId: app.id }, "mouse input disabled by app config");
        return;
    }
    const nut = await getNut();
    if (!nut) {
        log.info({ appId: app.id, x, y, button }, "[input:dev] click (no nut-js)");
        return;
    }
    await nut.mouse.setPosition(new nut.Point(x, y));
    if (button === "right") await nut.mouse.rightClick();
    else                    await nut.mouse.leftClick();
}
