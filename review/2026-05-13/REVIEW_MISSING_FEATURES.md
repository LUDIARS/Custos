# REVIEW_MISSING_FEATURES — Custos (2026-05-13)

## 評価: B

README / CLAUDE.md が「Phase 2」として宣言している項目に対する達成度を整理する。

## 1. Cernere 認証 (部分実装、要強化)

- 状況: `src/auth/cernere-auth.ts` で `/api/auth/verify` を叩く path はあり、 cache (5分) も実装済 (`cernere-auth.ts:69-91`)。 frontend は token を `sessionStorage` から読む scaffold (`public/js/app.js:28-30`)。
- 未実装:
  - **`/api/auth/cernere/login` 経由 popup ログイン** (CLAUDE.md §認証 にある言及) — フロントに entry point 無し。
  - **project_token (service-to-service)** — CLAUDE.md §認証で「将来サポート」と書かれているが、 実装は無い。 LUDIARS memory の `feedback_secret_per_user_memory_only.md` に従うなら、 `/api/auth/project-token` 連携も入れる前提。
  - **role gate** — V3 で指摘した通り、 verify した user の `role` を REST/WS で参照する分岐が無い。 admin/general/restricted を意味のあるアクション分離に使うべき。

## 2. Android target (scaffold のみ)

- 状況: `src/input/android.ts` で `adb shell input keyevent` ラッパは完成 (95 lines、 keycode 表あり)。
- 未実装:
  - **画面 capture** — `adb exec-out screenrecord --output-format=h264-stream` を parse → werift に流す経路。 CLAUDE.md §Phase 2-3 で言及されているが file 自体無し。
  - **`target: "android"` の build/run/test** — 現状 runner は `spawn(cfg.cmd)` で desktop と分岐なし。 Android の場合 `adb install` / `am start` を分岐させる必要がある。
  - **device picker UI** — `androidSerial` を apps.json で指定する仕様だが、 frontend に device 一覧 UI 無し。

## 3. apps.json hot reload (意図的に無し)

- CLAUDE.md §5 で「設定は起動時 1 回ロード」と明記。 これは仕様。 ただし運用上 apps を増減するたびに再起動が必要で、 設定タブ拡張の方向性とも整合させる必要がある (今は intervalSec / maxWidth しか runtime override できない)。

## 4. WS button の "kill" 経路 (仕様で意図的 noop)

- `src/ws/handler.ts:178-184` で `btn.action === "kill"` 時に error を返して終わる。 frontend に `POST /api/apps/:id/kill` への redirect を期待する暗黙仕様。
- 対応案: button id を WS で受け、 server 側で runner.kill を直接叩く方が UX 一貫。 frontend の責任を減らせる。

## 5. PWA / installable 要素無し

- README に "ブラウザから" とあるが、 manifest / service worker は無い。 Memoria 系の WebPush 通知 (`feedback_pwa_webpush_pattern.md`) のような非同期通知も無し。 Electron wrapper があるので必須ではないが、 Android スマホからの遠隔テストには PWA 化が便利。

## 6. テスト未投入の領域

- `src/ws/handler.ts` — ws-mock を用意した unit test 無し。
- `src/capture/webrtc-broker.ts` — werift モックなし、 結合テスト無し。
- `src/input/forwarder.ts` — 動的 import パスの分岐が untested。
- `src/input/android.ts` — adb 非接続パスを mock した unit test 無し。
- `src/capture/ffmpeg-pipeline.ts` — encoder probe の正常系/異常系 unit test 無し。
- `src/auth/cernere-auth.ts` — `tests/auth.test.ts` は存在するが verify の HTTP fetch 経路は未モック。

## 7. 監査ログ / 操作履歴

- 全 spawn / kill / key inject は pino で出るが、 **行為者 user id を log 行に含める仕組みが無い**。 Cernere 認証が本実装に入ったら、 `c.get("user")` を runner / forwarder まで渡して "who" 情報を保つ必要がある。 LUDIARS のセキュリティ要件 (Cernere 単一情報源、 個人データ Cernere) を考えると、 user-id だけは伝搬してほしい。

## 8. ドキュメント (整合性)

- README.md は MVP 章 (line 32-42) で `[ ]` のままだが、 実際の git log を見ると Phase 2 の WebRTC / Cernere middleware / Android adb は **`9273abb feat(phase-2)`** で部分実装済。 README のチェックボックスを `[x] (基本実装)` / `[~] (scaffold のみ)` の二段にすると現状把握が早い。
