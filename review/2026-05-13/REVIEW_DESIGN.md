# REVIEW_DESIGN — Custos (2026-05-13)

## 評価: B

## 1. アーキテクチャ判断 (良)

- **dual-port 同 origin** (`src/main.ts:74-91`) — 単一 Hono アプリを 4649 と 7676 の両方で listen させ、 CORS / config.js 注入を構造的に排除。 git log の `b50e1ea fix: 単一 Hono で dual-port listen + 相対 URL 化 — CORS 完全排除` の判断は妥当で、 静的・REST・WS すべてが同 origin に揃う。
- **副作用集約** — `AppsRunner` だけが spawn/kill を持ち (`src/apps/runner.ts:60-99`)、 ルートハンドラは runner / registry 経由でしか操作しない。 CLAUDE.md §1 の原則と一致。
- **single source of truth** — lifecycle 状態は `AppsRegistry` で一元化 (`src/apps/registry.ts:55-67`)。 status-changed イベントで REST 応答と WS broadcast の同期が担保されている。
- **optional dep の段階的縮退** — nut-js / werift / ergo_custos が無くてもプロセスは起動する (`src/input/forwarder.ts:34-53`, `src/capture/webrtc-broker.ts:82-100`)。 dev 環境での起動容易性が高い。

## 2. 設計上の弱点

- **forwarder の分岐が太い** (`src/input/forwarder.ts:64-108`) — `target === "android"` → ergo_custos → nut-js の優先順位が if 連鎖。 3 経路目以上が来ると保守が辛い。 Strategy pattern (KeySink interface) で抽出する余地あり。
- **WS button の "kill" action が WS では実装されない** (`src/ws/handler.ts:178-184`) — frontend 側から HTTP POST にリダイレクトする想定だが、 これは "副作用集約" 原則から見れば runner に依存注入すれば WS 側で完結できる。 現状は呼び元規約に依存しており、 cfg.input.buttons 経由の "kill" を即時実装で叩く API が無いため、 UI 側 contract が暗黙的。
- **設定ファイル `host`/`port` の検証が緩い** (`src/config/apps-config.ts:101-104`) — `ergoCustos.host` が任意文字列で受理されるため、 apps.json で `host: "0.0.0.0"` や外部 IP を指定すると `fetchScreenshot` がそのままアウトバウンドする。 host は `127.0.0.1` ホワイトリストに限定するか、 zod refine で loopback only にすべき。
- **状態遷移の境界条件** (`src/apps/runner.ts:179-187`) — Windows の taskkill は signal=null + exitCode=1 を返すため `active.killed` flag で識別、 SIGKILL/SIGTERM signal とも or 条件で読む二段構え。 仕組みは妥当だが、 build が SIGKILL されたケース (timeoutSec トリガ) では `lifecycleNormal=built` が立ってしまう疑い。 build timeout は "idle" もしくは "build_killed" を別途用意したい。

## 3. 拡張点・将来設計

- **CLAUDE.md §1〜5 の原則** は単一プロセス前提で書かれており、 自己レビューと整合。 ただし Phase 2 の Android target は capture 側がまだ scaffold (input.android.ts のみ実装、 screenrecord ストリームは未実装) で、 ストリームを `WebRTCBroker` に流すパスを書き足す必要がある。
- **マルチテナント (CLAUDE.md §4)** を将来本気でやる場合、 cernere user → app subscribe の許可制が必要。 現状は session ごとに任意の appId を subscribe 可能で、 user role と appId のマトリクス管理は無い。

## 4. テスト容易性

- runner / registry / config はテスト済 (`tests/`)。
- WS broker と webrtc-broker は in-process 結合テスト無し。 werift モックなしで werift 0.22 API に追従できているかは手作業確認に頼る形。
