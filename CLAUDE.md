# Custos 開発ルール

LUDIARS 遠隔テストランナー。Web サービス (Hono) + Electron wrapper の
両形態で動作。MVP は build/run/kill + ログ + 仮想キー、Phase 2 で
WebRTC キャプチャと Cernere 認証を入れる。

## アーキテクチャ原則

1. **副作用の集約** — subprocess の spawn / kill は `AppsRunner` のみが触る。
   ルートハンドラからは runner / registry のメソッド経由で操作する。
2. **状態は `AppsRegistry` 単一** — lifecycle 状態は registry が source of truth。
   API 応答 / WS 配信どちらもここから引く。
3. **input forwarder は optional dep** — `@nut-tree-fork/nut-js` が無くても
   build/run/log は動くこと。dev mode (ログのみ) で起動可能。
4. **WS broker は subscribe 制** — クライアントは明示的に appId を subscribe
   しないとログを受け取らない。マルチテナント前提。
5. **設定は起動時 1 回ロード** — apps.json のホットリロードはしない。

## 認証 (将来)

Cernere Composite に統合予定:
- WS 接続時 `?token=<accessToken>` を Cernere `/api/auth/verify` で検証
- frontend は `/api/auth/cernere/login` 経由で popup ログイン
- service-to-service 用に project_token も将来サポート

MVP では `CUSTOS_OPEN=1` で素通し、未設定なら token=非空 のみチェック (stub)。

## ビルド・テスト

- `npm run build` — TypeScript コンパイル (出力: `dist/`)
- `npm run dev`   — `tsx watch` でホットリロード
- `npm run serve` — 直接 tsx (Electron なし、ブラウザで開く)
- `npm run start` — Electron wrapper で開く
- `npm test`      — vitest

コード変更後は push 前に `npm run build` と `npm test` が通ることを確認。

## モジュール対応関係

| バックエンド | フロントエンド |
|----|----|
| `src/routes/apps-routes.ts` | `public/js/app.js` の `apiAction()` |
| `src/ws/handler.ts`         | `public/js/app.js` の `connectWs()` / `triggerButton()` |
| `src/shared/types.ts`       | `public/js/app.js` の `handleServerMessage()` (構造を一致させる) |

WS メッセージ型を変更したら必ず両方 (TS と JS) を同コミットで更新する。

## Phase 2 計画 (実装予定)

1. **WebRTC capture** — `src/capture/ffmpeg-pipeline.ts` (gdigrab/x11grab/avfoundation)
   と `src/capture/webrtc-broker.ts` (werift) を新設。POST /api/apps/:id/rtc/offer で SDP 交換。
2. **Cernere 認証** — `@ludiars/cernere-service-adapter` で WS / REST 両面に
   middleware を挟む。frontend に Composite ログイン画面を追加。
3. **Android target** — `src/input/android.ts` に `adb shell input keyevent`
   ラッパ。capture は `adb exec-out screenrecord --output-format=h264-stream` を
   parse して WebRTC に流し込む。

## TypeScript ルール

- `any` 禁止。`unknown` か具体型 / generic を使う
- 公開 API の引数・戻り値は明示的に型を付ける
- zod schema から `z.infer<typeof X>` で型を引いて、外部入力の境界に置く
