# com.ludiars.custos-bridge

Unity 内 HTTP ブリッジ。Custos (遠隔テストランナー) が Unity Editor / Player を
ergo_custos 互換プロトコルで遠隔操作できるようにする UPM パッケージ。

port 既定: **17778** (loopback only)

## エンドポイント

| Method | Path | 説明 |
|--------|------|------|
| GET | `/health` | `{"status":"ok","isPlaying":bool}` |
| GET | `/screenshot` | PNG スナップショット |
| POST | `/key` | `{"code":<HID int>,"down":<bool>}` — 入力注入 |
| GET | `/stream?fps=<F>` | 連続 raw BGRA8 フレームストリーム (詳細後述) |
| POST | `/pointer` | `{"x":0..1,"y":0..1,"button":0\|1\|2,"phase":"down"\|"up"\|"move"}` — 仮想 Mouse へ注入 (左上原点の正規化座標) |
| GET | `/state` | `{"isPlaying":bool,"state":<object\|null>}` — ゲームが登録した状態 (行動ログ用) |
| GET | `/stream?codec=h264&fps=&width=&height=&bitrate=` | ブリッジ内のハードウェア H.264 (長さ付きフレーム、使えなければ 415) |
| POST | `/stream/keyframe` | 次のフレームを IDR に |
| POST | `/stream/bitrate` | `{"bps":<int>}` — H.264 のビットレートを変える |

### H.264 配信とネイティブプラグイン

`/stream?codec=h264` は `Runtime/Plugins/x86_64/custos_h264.dll` (Windows、Media Foundation のハードウェア
H.264) を使う。DLL はリポの `native/custos-h264/build.cmd` で作る (Visual Studio 2022 Build Tools)。DLL が無い・
エンコーダが作れない環境では 415 を返し、Custos は従来の BGRA (`/stream`) + ffmpeg に戻す。
設計は Custos の `spec/feature/webrtc-efficiency.md` §7。

### Editor 専用エンドポイント (`/editor/*`)

Editor で動かしたときだけ有効。Custos の Unity パネルと `unityctl` が使う (契約: `src/unity/bridge-contract.ts`)。

| Method | Path | 説明 |
|--------|------|------|
| GET | `/editor/status` | Unity バージョン・PlayMode・コンパイル中か・アクティブシーン・未保存シーン |
| GET | `/editor/compile-status` | 直近のコンパイル結果 (エラー/警告の件数と一覧) |
| POST | `/editor/compile` | スクリプト再コンパイルを要求 |
| POST | `/editor/refresh` | `AssetDatabase.Refresh` (asmdef・新規アセットの取り込み) |
| GET | `/editor/log?since=<seq>&limit=<n>&level=<error\|warn\|log>` | Console ログ (seq はドメインリロードを跨いで続く) |
| POST | `/editor/play` / `/editor/stop` | PlayMode の開始 / 終了 |
| GET | `/editor/scene` | 読み込み済みシーンの一覧 |
| GET | `/editor/hierarchy?depth=<n>&root=<id>` | ヒエラルキー (1 回 500 ノードまで、超えたら `truncated`) |
| POST | `/editor/publish-capture` | キャプチャを Concordia セッションへ投稿 |

### ゲーム状態を行動ログに載せる (`CustosPlayState`)

Custos の行動ログ (`playLog`) は `/state` を周期取得し、返った JSON の各キーを
`state.<key>` 列に入れる。オートプレイヤー (Commentarii) が人間プレイとして取り込むには
少なくともステージ (`stage`) を入れる。位置は `[x, y, z]` の配列で入れる。

```csharp
#if UNITY_EDITOR || DEVELOPMENT_BUILD
Ludiars.Custos.Bridge.CustosPlayState.Register(() =>
    JsonUtility.ToJson(new PlayStateDto { stage = currentStageId, hp = player.Hp / player.MaxHp }));
#endif
```

本パッケージは Editor と Development Build でしか compile されないので、呼び出しも同じ `#if` で囲む。
プレイヤー名・メールなど個人を特定する値は入れない。詳細は `spec/feature/remote-play-and-play-log.md`。

### `/stream` ヘッダ仕様

```
X-Frame-Width:  <W>
X-Frame-Height: <H>
X-Frame-Pixfmt: bgra
X-Frame-Fps:    <F>
```

本体は `W * H * 4` bytes の raw BGRA8 フレームが上から下順で連続する。
Custos 側は以下で消費する:

```
ffmpeg -f rawvideo -pix_fmt bgra -s WxH -r F -i pipe:0 ...
```

## インストール

### GameUnity / ローカル開発 (local path)

`Packages/manifest.json` に追加:

```json
"com.ludiars.custos-bridge": "file:../../../Custos/unity/com.ludiars.custos-bridge"
```

### Git URL (安定版)

```json
"com.ludiars.custos-bridge": "https://github.com/LUDIARS/Custos.git?path=unity/com.ludiars.custos-bridge#v0.1.0"
```

## セットアップ

1. Unity プロジェクトルート (または `custos/` サブフォルダ) に `custos_bridge.json` を置く:

```json
{
  "port": 17778,
  "enabled": true,
  "token": "",
  "captureMode": "auto",
  "maxLongEdge": 1280,
  "runInBackground": true
}
```

旧称 `ergo_custos_bridge.json` も後方互換で読む。

2. **Editor** の場合: 設定ファイルの `enabled: true` だけで起動する。止めたいときはメニュー
   `LUDIARS/Custos Bridge/Enabled` を OFF にする (その Editor では以後起動しない)
   (設定ファイルが存在すれば `[InitializeOnLoad]` で自動起動も試みる)。

3. **Player ビルド** の場合: `DEVELOPMENT_BUILD` が有効であれば自動起動する。
   本番ビルドにはコードごと含まれない (`defineConstraints`)。

4. Custos `config/apps.json` の当該エントリに追記:

```json
"inAppBridge": { "kind": "unity", "host": "127.0.0.1", "port": 17778, "fps": 24 }
```

(旧 `ergoCustos: { host, port }` 形式も後方互換で受理されるが、Unity ブリッジ
では `inAppBridge` の `kind: "unity"` を使うのが正。`/stream` を使った WebRTC
動画配信はこのフィールドがある時のみ有効になる。)

## 動作確認

```sh
curl http://127.0.0.1:17778/health
curl -o shot.png http://127.0.0.1:17778/screenshot
curl -X POST http://127.0.0.1:17778/key \
  -H "content-type: application/json" \
  -d '{"code":26,"down":true}'   # W キー押下
curl -X POST http://127.0.0.1:17778/key \
  -d '{"code":26,"down":false}'  # W キー離す
```

## 制約・注意事項

### legacy Input Manager (`UnityEngine.Input`) には届かない

`/key` の注入は新 Input System (`com.unity.inputsystem`) 専用。
`Input.GetKey` / `Input.GetAxis` 等の旧 API には一切届かない。
プロジェクト内の legacy 読み出し箇所を洗い出して移行すること:

```sh
grep -rn "Input\.Get\|Input\.GetAxis\|Input\.GetButton" Assets/
```

### Editor 非フォーカス時の入力

非フォーカスで入力が処理されない設定の場合は、
`Edit > Project Settings > Input System Package > Background Behavior` を
`Ignore Focus` に変更する (bridge は自動変更しない)。

### KEY_TABLE (HID usage コード対応)

`src/capture/ergo-custos-client.ts` の `KEY_TABLE`、
`Runtime/Input/HidKeyMap.cs`、`ergo include/ergo/input/types.h` の 3 点は同期が必要。
改訂時は必ず 3 点を同一 PR で更新すること。

## 既知の TODO (要検証)

設計書 `spec/unity-bridge.md` §7 の要検証一覧を参照。
主要項目:

- AsyncGPUReadback の行順 (D3D11 環境での上下反転)
- ColorSpace = Linear プロジェクトでの sRGB staging RT
- Game View 最小化時の ScreenCapture 挙動
- `QueueStateEvent` の thread-safety (InputSystem 1.14)
- asmdef defineConstraints の `||` 記法サポート
