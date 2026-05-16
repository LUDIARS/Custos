/**
 * RuntimeStreamPrefs — Custos セッション中の screenshot 配信オプションを
 * 上書きする in-memory シングルトン。
 *
 * 起動時は **空** (= apps.json の `capture.intervalSec` がそのまま効く)。
 * 設定タブから `PUT /api/settings/stream` で値を入れると、ScreenshotStreamer
 * が `change` イベントを購読してその場で反映する。
 *
 * ここが永続化していないのは意図的:
 *   - 「セッション中の運用ノブ」と「アプリの恒久設定 (apps.json)」を
 *     混ぜたくない (再起動でデフォルトに戻る予測可能性)
 *   - 複数オペレータが同時に触る運用ではないので per-process で十分
 */

import { EventEmitter } from "node:events";
import { z } from "zod";

/// 公開スキーマ。REST 入力もここで検証する。値はすべて optional —
/// 未指定フィールドは「上書きしない」を意味する。
export const streamPrefsSchema = z.object({
    /** 配信間隔 (秒)。0 で auto-stream を無効化。`undefined` は apps.json の値を使う。 */
    intervalSec: z.number().min(0).max(60).optional(),
    /** 横ピクセルの上限。0/未指定 = 元解像度のまま。 */
    maxWidth:    z.number().int().min(0).max(7680).optional(),
});
export type StreamPrefs = z.infer<typeof streamPrefsSchema>;

/// 現在値 + 「フィールドをクリアしたい」場合の null も受ける。`null` は
/// 「元の apps.json デフォルトに戻す」明示的指示。
export const streamPrefsPatchSchema = z.object({
    intervalSec: z.number().min(0).max(60).nullable().optional(),
    maxWidth:    z.number().int().min(0).max(7680).nullable().optional(),
});
export type StreamPrefsPatch = z.infer<typeof streamPrefsPatchSchema>;

export class RuntimeStreamPrefs extends EventEmitter {
    private state: StreamPrefs = {};

    /** 読み取り (immutable コピー)。 */
    get(): StreamPrefs { return { ...this.state }; }

    /**
     * patch を適用して `change` を emit。
     *  - 値あり → 上書き
     *  - 値 null → クリア (apps.json デフォルトに戻る)
     *  - 値 undefined → そのフィールドは触らない
     */
    apply(patch: StreamPrefsPatch): StreamPrefs {
        const next: StreamPrefs = { ...this.state };
        if (patch.intervalSec !== undefined) {
            if (patch.intervalSec === null) delete next.intervalSec;
            else                            next.intervalSec = patch.intervalSec;
        }
        if (patch.maxWidth !== undefined) {
            if (patch.maxWidth === null) delete next.maxWidth;
            else                          next.maxWidth = patch.maxWidth;
        }
        const changed =
            next.intervalSec !== this.state.intervalSec ||
            next.maxWidth    !== this.state.maxWidth;
        this.state = next;
        if (changed) this.emit("change", this.get());
        return this.get();
    }

    /** テスト用に完全クリア。 */
    reset(): void {
        const had = this.state.intervalSec !== undefined || this.state.maxWidth !== undefined;
        this.state = {};
        if (had) this.emit("change", this.get());
    }
}
