# Custos

LUDIARS の **遠隔テストランナー**。事前設定したアプリをブラウザから
build / run / kill し、ログとテスト結果を見ながらバーチャルキーで操作する。
将来は WebRTC で画面ストリーミング、Cernere 認証、Android emulator 連携も
入れる予定。

## クイックスタート

```bash
npm install
npm run serve            # http://localhost:5180/
# もしくは Electron で開く
npm run start
```

設定ファイル: `config/apps.json` (`CUSTOS_APPS_FILE` で上書き可)。
サンプルとして Pictor mobile demo と Ergo bench_curve が登録済み。

開発時に認証を外したい場合は `CUSTOS_OPEN=1` を環境変数で設定。

## 機能 (MVP)

- [x] アプリ事前設定 (apps.json) と zod 検証
- [x] REST: build / run / test / kill / status
- [x] WS: ログ・状態変化のストリーミング、仮想キー入力受信
- [x] Frontend: アプリ選択、Logs/Tests タブ、**広めのバーチャルキー領域**、
      オーバーレイ表示トグル
- [x] Electron wrapper (npm run start)
- [ ] **WebRTC 画面キャプチャ** (Phase 2、ffmpeg + werift)
- [ ] **Cernere 認証** (Phase 2、`@ludiars/cernere-service-adapter`)
- [ ] **Android emulator** (`target: "android"`、adb input keyevent)

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
| `CUSTOS_PORT`       | 5180 | HTTP listen |
| `CUSTOS_HOST`       | 0.0.0.0 | bind |
| `CUSTOS_APPS_FILE`  | config/apps.json | 設定パス |
| `CUSTOS_OPEN`       | (off) | "1" で WS 認証スキップ |
| `CORS_ORIGIN`       | *    | CORS allow |

## ライセンス

未定 (LUDIARS internal、private)。
