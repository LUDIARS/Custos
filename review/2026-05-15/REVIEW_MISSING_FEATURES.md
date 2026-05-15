# 不足機能評価 (Missing Feature Evaluation)

| 項目 | 値 |
|------|-----|
| リポジトリ | LUDIARS/Custos |
| 対象ブランチ / PR | main: f1be570 |
| レビュー実施日 | 2026-05-15 |

---

## 1. 機能改善提案 (Feature Improvement)

| 対象機能 | 改善提案 | 期待効果 | 優先度 |
|---------|---------|---------|--------|
| ScreenshotStreamer | **JPEG 圧縮オプション** (quality <0-100>) | bandwidth 削減 30-50%、latency 低下 | High |
| WebRTC RTP pipeline | **FECN / adaptive bitrate** | 低速 network での安定性向上 | Medium |
| app.js | **API request タイムアウト UI** | UX error handling 明確化 | Medium |

---

## 2. 不足機能提案 (Missing Feature Proposal)

| 提案機能 | 必要性根拠 | 実装優先度 | 想定影響範囲 |
|---------|-----------|-----------|-----------|
| **Rate limiting (WS + REST)** | 単一ユーザー暴走防止 | High | auth.middleware / ws.handler |
| **実行ログ永続化** (SQLite / JSON Lines) | 運用ログ監査・デバッグ再現 | Medium | runner.ts / logger.ts |
| **アプリ出力フォーマット自動検出** (正規表現 filter) | "PASS: 100 / FAIL: 0" パターンで自動パース | Low | ws.handler message filter |

---

## 総合評価

| # | レビュー観点 | 指摘数 | 優先度別内訳 |
|---|------------|--------|------------|
| 1 | 機能改善 | 3 件 | High: 1 / Medium: 2 |
| 2 | 不足機能 | 3 件 | High: 1 / Medium: 1 / Low: 1 |
