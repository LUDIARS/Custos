# Custos

LUDIARS の **遠隔テストランナー**。事前設定したアプリをブラウザから
build / run / kill し、ログとテスト結果を見ながらバーチャルキーで操作する。
画面は WebRTC でリアルタイムストリーミングする (ffmpeg gdigrab か、アプリ内
ブリッジの `/stream` を入力源にできる)。将来は Cernere 認証、Android emulator
連携も入れる予定。

## クイックスタート

```bash
npm install
npm run serve     # frontend http://localhost:4649/  backend http://localhost:7676/
# もしくは Electron で開く
npm run start
```

**`CERNERE_URL` 未設定 = 認証不要モード** が既定。Cernere を使う場合は
`CERNERE_URL=http://localhost:8080` を立ててから起動 (token プロンプトが
401 受信時に出る)。Cernere 不使用環境で「token 入力を強制する」運用なら
`CUSTOS_AUTH_REQUIRED=1` を併設。

- **Frontend**: http://localhost:4649/ (静的 + `/config.js` で backend URL を注入)
- **Backend**:  http://localhost:7676/ (API + WS)

ポート上書きは `CUSTOS_PORT` (backend) / `CUSTOS_FRONTEND_PORT` (frontend) で。

設定ファイル: `config/apps.json` (`CUSTOS_APPS_FILE` で上書き可)。
サンプルとして AdventureCube (Debug) と Pictor mobile demo が登録済み。

開発時に認証を外したい場合は `CUSTOS_OPEN=1` を環境変数で設定。

## 機能 (MVP)

- [x] アプリ事前設定 (apps.json) と zod 検証
- [x] REST: build / run / test / kill / status
- [x] WS: ログ・状態変化のストリーミング、仮想キー入力受信
- [x] Frontend: アプリ選択、Logs/Tests タブ、**広めのバーチャルキー領域**、
      オーバーレイ表示トグル
- [x] Electron wrapper (npm run start)
- [x] **WebRTC 画面ストリーミング** (ffmpeg + werift。動画源は `capture`
      gdigrab か、`inAppBridge` の `/stream` の 2 系統)
- [x] **アプリ内 HTTP ブリッジ** (`inAppBridge`、ergo_custos / Unity 互換。
      `/screenshot` + `/key` + `/stream` を in-app readback + 入力注入で提供)
- [x] **Unity ブリッジ** (`unity/com.ludiars.custos-bridge` UPM。Editor Game
      View / Runtime Camera をフックし `/stream` で WebRTC 動画、`/key` で
      InputSystem 注入。UnityRemote 型、port 17778)
- [ ] **Cernere 認証** (Phase 2、`@ludiars/cernere-service-adapter`)
- [ ] **Android emulator** (`target: "android"`、adb input keyevent)

## アプリ内ブリッジ (`inAppBridge`) と Unity

対象アプリが「アプリ内 HTTP ブリッジ」を持つ場合、ホスト側 ffmpeg gdigrab /
nut-js を経由せず、アプリ内で直接 readback / 入力注入できる。プロトコルは
ergo_custos と Unity ブリッジで共通:

| Method | Path | 用途 |
|--------|------|------|
| GET  | `/screenshot`     | PNG スナップショット |
| POST | `/key`            | `{code, down}` (code = USB HID usage) で入力注入 |
| GET  | `/stream?fps=<F>` | raw BGRA8 連続フレーム (WebRTC 動画源) |

`inAppBridge` を設定すると、`POST /api/apps/:id/rtc/offer` の WebRTC 動画源が
gdigrab ではなくブリッジの `/stream` になる。`/stream` のレスポンスヘッダ
(`X-Frame-Width/Height/Pixfmt/Fps`) から寸法を読み、`ffmpeg -f rawvideo
-pix_fmt bgra -s WxH -r F -i pipe:0 → -f rtp` で H.264 化して werift に流す
(KZS-Web の visus 経路と同型)。

```jsonc
"inAppBridge": {
  "kind": "unity",     // "ergo" (既定, port 5198) | "unity" (port 17778)
  "host": "127.0.0.1",
  "port": 17778,
  "fps":  24           // /stream の要求 fps (既定 24)
}
```

旧 `ergoCustos: { host, port }` は後方互換で `inAppBridge {kind:"ergo"}` に
正規化される。

**Unity 対応** は `unity/com.ludiars.custos-bridge` (UPM パッケージ) を Unity
プロジェクトに導入する。Editor Game View (UnityRemote 型、ビルド不要) と
Runtime Camera (Player ビルド) の両方をフックでき、`/stream` で WebRTC、`/key`
で新 Input System に注入する。詳細はパッケージ README と `spec/unity-bridge.md`。

## 設定スキーマ

```jsonc
{
  "version": 1,
  "apps": [{
    "id": "demo",                    // a-z0-9-
    "name": "Demo",
    "target": "desktop",             // "desktop" | "android"

    "build": { "cwd": ".", "cmd": "...", "args": [...], "timeoutSec": 600 },
    "run":   { "cwd": ".", "cmd": "...", "args": [...] },
    "test":  { "cwd": ".", "cmd": "ctest", "args": [...] },

    "capture": { "type": "window", "windowTitle": "Demo", "fps": 30 },

    "input": {
      "buttons": [
        { "label": "Pause", "key": "Space" },     // key 押下
        { "label": "Quit",  "action": "kill" }    // 名前付き action
      ],
      "allowKeyboard": true,
      "allowMouse": false
    }
  }]
}
```

ボタンは **必ず `key` or `action` のいずれか 1 つ** を持つ (zod refine)。

## API 概要

| Method | Path                       | 説明 |
|--------|----------------------------|------|
| GET    | `/api/health`              | 健全性 |
| GET    | `/api/apps`                | 一覧 + 状態 |
| GET    | `/api/apps/:id/status`     | 単一状態 |
| POST   | `/api/apps/:id/build`      | build 開始 → buildId |
| POST   | `/api/apps/:id/run`        | run 開始 → runId, pid |
| POST   | `/api/apps/:id/test`       | test 開始 → testId |
| POST   | `/api/apps/:id/kill`       | run を SIGKILL |
| WS     | `/ws?token=…`              | log / status / exit、key/click/button |

WS protocol は `src/shared/types.ts` の `ClientMessage` / `ServerMessage` 参照。

## 入力フォワード

`@nut-tree-fork/nut-js` を **optional dependency** で動的 import している。
インストール済みなら実機 SendInput / X11 / macOS Quartz で送信、未導入なら
ログのみ (dev mode) で動作。Android target は MVP では未対応。

## ディレクトリ

```
src/
  main.ts                # entry
  app.ts                 # Hono app
  config/apps-config.ts  # zod
  apps/{registry,runner}.ts
  input/forwarder.ts     # nut-js wrapper
  routes/apps-routes.ts
  ws/handler.ts
public/{index.html, css/, js/}
electron/main.cjs
config/apps.json
tests/
```

## 環境変数

| key | 既定 | 用途 |
|-----|------|------|
| `CUSTOS_PORT`            | 7676 | backend (API + WS) listen |
| `CUSTOS_FRONTEND_PORT`   | 4649 | frontend (静的) listen |
| `CUSTOS_BACKEND_URL`     | (auto) | ブラウザに注入される backend URL |
| `CUSTOS_HOST`            | 0.0.0.0 | bind |
| `CUSTOS_APPS_FILE`       | config/apps.json | 設定パス |
| `CUSTOS_OPEN`            | (off) | "1" で REST + WS 認証完全スキップ (anonymous user) |
| `CUSTOS_AUTH_REQUIRED`   | (off) | CERNERE_URL 未設定でも token 非空チェックを要求 |
| `CORS_ORIGIN`            | *    | CORS allow (frontend と backend が別 origin) |
| `CUSTOS_FFMPEG`          | "ffmpeg" | キャプチャ用 ffmpeg 実行ファイル |
| `CUSTOS_ADB`             | "adb" | Android 入力用 adb 実行ファイル |

## ライセンス

未定 (LUDIARS internal、private)。
