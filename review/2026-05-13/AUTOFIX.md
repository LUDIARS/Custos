# AUTOFIX — Custos (2026-05-13)

ソースコード修正は **行わない** (このレビューは列挙のみ、 `autofix_count = 0`)。

以下は次回 autofix セッションで安全に取り組める候補リスト。 高 → 低の優先度順。

## A. セキュリティ既定値の反転 (高、 docs + .env.example)

1. `.env.example:7` の `CUSTOS_HOST=0.0.0.0` を `CUSTOS_HOST=127.0.0.1` に変更し、 LAN 公開を opt-in 化。
2. `.env.example:14` の `CUSTOS_OPEN=1` を `# CUSTOS_OPEN=1` にコメントアウトし、 既定値を auth required に。
3. README.md §クイックスタート と §環境変数 で「LAN 公開には明示的な `CUSTOS_HOST=0.0.0.0` が必要」を強調。

## B. 仕様文書の現状追従 (中、 docs)

4. README.md §機能 (MVP) のチェックリストを `[x] / [~] (scaffold) / [ ] (未着手)` の三段に書き換え、 Cernere middleware と Android adb の現状を反映。

## C. zod refine の追加 (中、 src 修正だが副作用なし、 次セッション対象)

5. `src/config/apps-config.ts:101-104` の `ergoCustosSchema.host` を loopback ホワイトリスト (`127.0.0.1` / `localhost` / `::1`) に絞る zod refine。
6. `src/routes/rtc-routes.ts:67-83` の `body.sdp` に長さ上限 (例 64KB) 検証。

## D. 観測性 (中、 src 修正)

7. `src/apps/runner.ts:194-197` の spawn error / exit log に `cfg.cmd` 解決後の絶対パスとハッシュを含める (V4 対策の足がかり)。
8. Cernere verify 通過した user id を `c.set("user", ...)` 経由で runner / forwarder の log line にも乗せる (audit log 強化)。

## E. テスト追加 (低、 リスクなし)

9. `src/auth/cernere-auth.ts` の `verify()` 経路を `undici MockAgent` でモックする unit test。
10. `src/input/forwarder.ts` の動的 import 分岐 (ergoCustos / nut-js / android) を mock した unit test。
11. `src/capture/ffmpeg-pipeline.ts:38-65` の `probeEncoder` を `spawnSync` モックでテスト (auto fallback の挙動)。

## F. その他クリーンアップ (低)

12. `src/capture/webrtc-broker.ts:217-239` の event 購読二重化整理 (`pc.on` か `subscribe(connectionStateChange)` のどちらか一方に)。
13. `src/main.ts:96` の `console.log` バナーを `logger.info` に統一。
14. `src/apps/runner.ts:162-167` の timeout SIGKILL を Windows では taskkill /T /F に揃える (子孫プロセスの掃除)。

## 実施しない理由 (今回)

レビュー指示の「AUTOFIX は列挙のみ (autofix_count=0)」 + ソース修正禁止に従う。 次セッションで上記 A〜D を順次取り込む想定。
