# 設計レビュー (Design Review)

| 項目 | 値 |
|------|-----|
| リポジトリ | LUDIARS/Custos |
| 対象ブランチ / PR | main: f1be570..f5c8364 (WebRTC + auto-stream) |
| レビュー実施日 | 2026-05-15 |
| 対象コミット範囲 | f5c8364..f1be570 |

---

## 1. 設計強度 (Design Robustness)

| 評価 | 観点 | 所見 |
|------|------|------|
| A | 障害分離 | AppsRunner / AppsRegistry の責務分離、WebRTC session ごとの独立 lifecycle 管理 |
| A | 冪等性 | `streamer.acquire(cfg, key)` の重複 acquire (同 key) は ref counting で自動吸収、`release()` も冪等 |
| A | 入力バリデーション | zod schema `streamPrefsPatchSchema` で PATCH ボディ検証、config `captureSchema` でファイルパス validate |
| A | エラーハンドリング | WS message handler try-catch + error emit、screenshot 失敗は logger.warn + timer 継続 |
| A | リトライ・タイムアウト設計 | WebRTC RTP listener timeout なし、ffmpeg spawning timeout は config で制御可 |
| A | 状態管理の明確性 | AppStatus + AppLifecycle type union、registry + runner が immutable event emit で透明化 |

---

## 2. 設計思想の一貫性 (Design Philosophy Compliance)

| 該当箇所 | 逸脱有無 | 本来の設計思想 | 実装状況 |
|----------|----------|----------|----------|
| `src/apps/runner.ts` | ✅ 一貫 | 副作用の集約 | spawn/kill は AppsRunner のみ |
| `src/capture/screenshot-stream.ts` | ✅ 一貫 | subscribe 制 WS broker パターン | acquire/release ref count 実装 |
| `src/input/forwarder.ts` | ✅ 一貫 | optional dep graceful fallback | nut-js 未導入時ログのみ mode |
| `src/ws/handler.ts` | ✅ 一貫 | 状態は registry 単一 | streamer も event emitter で broadcast |
| `src/config/apps-config.ts` | ✅ 一貫 | 起動時 1 回ロード | hotreload なし、zod refine で input validation |
| `public/js/app.js` | ✅ 一貫 | REST + WS 同期 API型 | opId-async + WS complete イベント pattern |

---

## 3. モジュール分割度 / 機能的凝集度 (Cohesion & Modularity)

| モジュール | 凝集度 | 所見 |
|-----------|--------|------|
| `src/capture/screenshot-stream.ts` | **機能的** | 単一責務: timer 駆動の PNG frame acquisition + ref counting |
| `src/capture/webrtc-broker.ts` | **機能的** | 単一責務: werift PC ↔ RTP datagram bridge、H.264 codec 固定 |
| `src/runtime/stream-prefs.ts` | **機能的** | 単一責務: runtime 上書き state (in-memory) |
| `src/config/apps-config.ts` | **機能的** | 単一責務: zod schema + ファイルロード |
| `src/ws/handler.ts` | **通信的** | やや通信的、責務分離可能 (将来) |
| `public/js/app.js` | **逐次的** | boot → loadApps → connectWs → eventListener |

---

## 総合評価

| # | レビュー観点 | 評価 | 重大指摘数 |
|---|------------|------|-----------|
| 1 | 設計強度 | A | 0 |
| 2 | 設計思想の一貫性 | A | 0 |
| 3 | モジュール分割度 | A | 0 |
