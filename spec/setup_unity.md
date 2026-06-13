# setup_unity.md — Unity プロジェクトに Custos Unity Bridge を導入するための設定

**用途**: 任意の Unity プロジェクトに `unity/com.ludiars.custos-bridge` (UPM パッケージ)
を組み込み、Custos (遠隔テストランナー) から **画面を WebRTC 配信 + 入力注入** できる
状態にする。UnityRemote 型。

このファイルは **AI エージェントが読んで自動実行できる runbook** として書いてある。
各手順はファイル編集 / ファイル生成 / シェル検証だけで完結する。値は全て実装由来で、
出典 (`file:line`) を併記してある。設計の正本は [`spec/unity-bridge.md`](./unity-bridge.md)。

---

## 0. 前提条件 (AI: 最初に確認)

| 条件 | 確認方法 | 不足時 |
|------|----------|--------|
| Unity 6000.0 (Unity 6) 以上 | `<Project>/ProjectSettings/ProjectVersion.txt` | パッケージ `package.json` の `"unity": "6000.0"` 未満は非対応 |
| Input System 1.14.2 導入済 | `<Project>/Packages/manifest.json` に `com.unity.inputsystem` | パッケージ依存で自動解決されるが、`Active Input Handling` 要設定 (§4) |
| Custos 本体がホストで起動可能 | `Custos/` で `npm run build` が通る | 配信側は Custos が担う |
| ffmpeg がホスト PATH に在る | `ffmpeg -version` | WebRTC 動画化に必須 (`CUSTOS_FFMPEG` で上書き可) |

> パッケージのコードは `#if UNITY_EDITOR || DEVELOPMENT_BUILD` でガードされている
> (`Runtime/BridgeServer.cs:11` 他)。**製品 (Release) ビルドには一切含まれない**ので、
> 導入してもリリース成果物には影響しない。

---

## 1. パッケージ参照を追加 (manifest.json)

`<Project>/Packages/manifest.json` の `"dependencies"` に 1 行追加する。
パスは **`Packages/` ディレクトリからの相対**。

### ローカルパス (開発時・推奨)

```jsonc
{
  "dependencies": {
    "com.ludiars.custos-bridge": "file:<Packages から Custos/unity/com.ludiars.custos-bridge への相対パス>"
    // ... 既存の依存はそのまま
  }
}
```

- **KzSUnity の具体例** (`E:/Document/Ars/PrivateGame/KzSUnity`):
  `Packages` → `KzSUnity` → `PrivateGame` → `Ars` と 3 つ上がって `Custos/...` なので

  ```json
  "com.ludiars.custos-bridge": "file:../../../Custos/unity/com.ludiars.custos-bridge"
  ```

- 絶対パスも可: `"file:E:/Document/Ars/Custos/unity/com.ludiars.custos-bridge"`
  (リポを跨ぐので移植性は落ちる)。

### Git URL (安定版・他マシン)

```json
"com.ludiars.custos-bridge": "https://github.com/LUDIARS/Custos.git?path=unity/com.ludiars.custos-bridge#v0.1.0"
```

> 追加後、Unity がパッケージを再解決する必要がある。Editor を開けば自動。ヘッドレスなら
> `Unity -batchmode -quit -projectPath <Project> -logFile -` を 1 度走らせる。

---

## 2. `custos_bridge.json` を作成

ブリッジは設定ファイルが**存在する時のみ**有効化対象になる
(`Runtime/BridgeConfig.cs:47-56`)。次のいずれかに置く (上から優先):

1. `<Project>/custos_bridge.json` ← **推奨 (プロジェクトルート = Assets の 1 つ上)**
2. `<Project>/custos/custos_bridge.json`
3. `<Project>/musa/terpsichore/custos_bridge.json`

出典: 探索ディレクトリ `BridgeConfig.cs:114-119`、ルート判定 `BridgeConfig.cs:104-109`
(`Path.GetDirectoryName(Application.dataPath)`)。旧名 `ergo_custos_bridge.json` も後方互換で読む
(`BridgeConfig.cs:21,120`)。

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

### キー一覧 (出典: `Runtime/BridgeConfig.cs`)

| キー | 既定 | 意味 | 出典 |
|------|------|------|------|
| `port` | `17778` | ブリッジの listen ポート (loopback `127.0.0.1` のみ) | `BridgeConfig.cs:19`, bind `BridgeServer.cs:79` |
| `enabled` | `true` | 有効化フラグ。**Editor では別途トグルも必要** (§3) | `BridgeConfig.cs:36,73` |
| `token` | `""` | 空 = 認証なし。非空なら `X-Auth-Token` ヘッダ必須 | `BridgeServer.cs:145-153` |
| `captureMode` | `"auto"` | `auto` / `camera` / `window`。`auto` は camera→失敗時 window | `BridgeConfig.cs:75`, EditMode 経路 `EditorGameViewFrameProvider.cs` |
| `maxLongEdge` | `1280` | 長辺の最大画素 (ダウンスケール上限) | `BridgeConfig.cs:28` |
| `runInBackground` | `true` | `Application.runInBackground=true` を立てる (非フォーカスでも回す) | `BridgeConfig.cs:29`, 適用 `*Bootstrap.cs` |

### 環境変数オーバーライド (出典: `BridgeConfig.cs:91-100`)

- `CUSTOS_UNITY_BRIDGE_PORT` — `port` を上書き
- `CUSTOS_UNITY_BRIDGE_ENABLED` — `enabled` を上書き (`false`/`0` 以外で true)

> **注意**: env は `enabled` (= config 値) を上書きするだけで、**Editor のトグル門
> (§3) は超えない**。Editor で env だけ立てても自動起動しない。

---

## 3. 有効化 — Editor 経路 と Player 経路

ブリッジの起動条件は配置先で異なる。**自動化したい目的によって経路を選ぶ。**

### 3-A. Player (Development Build) 経路 ← AI 完全自動化向き

`Runtime/CustosBridgeRuntime.cs:30-35` の `[RuntimeInitializeOnLoadMethod(AfterSceneLoad)]`
が、**`enabled:true` だけで自動起動**する (EditorPrefs 不要)。製品ビルドには入らない
ガード (`DEVELOPMENT_BUILD`) なので、**Development Build で吐く**こと。

ヘッドレス手順例:
```sh
# Development Build を有効にしてビルド (BuildOptions.Development) → 起動
# → 起動済み player の 127.0.0.1:17778 にブリッジが立つ
```
- BuildPlayer 時に `BuildOptions.Development` (= "Development Build" チェック) が必須。
- 起動後、§5 の検証 curl が通れば成功。

### 3-B. Editor PlayMode 経路 (UnityRemote 型) ← 一部 手動 or 補助スクリプト

`Editor/CustosBridgeEditorBootstrap.cs:31-45` の `[InitializeOnLoad]` は、起動を
**`config.enabled == true` かつ EditorPrefs `Ludiars.CustosBridge.Enabled == true`** の
両方が真の時だけ行う。EditorPrefs はファイルから設定できないため、次のどちらか:

- **手動 (確実)**: Unity メニュー **`LUDIARS/Custos Bridge/Enabled`** をチェック
  (`CustosBridgeEditorBootstrap.cs:56`)。状態は `LUDIARS/Custos Bridge/Status` で確認。
- **AI 自動化 (補助スクリプト)**: 対象プロジェクトに次の Editor スクリプトを 1 つ置くと、
  プロジェクト読み込み時に EditorPrefs を立てて門を通す。**手動トグルを上書きする**ので、
  常時自動起動させたい検証マシン専用と割り切ること。

  `<Project>/Assets/Editor/CustosBridgeAutoEnable.cs`:
  ```csharp
  #if UNITY_EDITOR
  using UnityEditor;
  internal static class CustosBridgeAutoEnable
  {
      [InitializeOnLoadMethod]
      private static void Enable()
      {
          // CustosBridgeEditorBootstrap が参照する EditorPrefs キー
          EditorPrefs.SetBool("Ludiars.CustosBridge.Enabled", true);
      }
  }
  #endif
  ```
  (キー名の出典: `CustosBridgeEditorBootstrap.cs:23`。)

> EditMode (再生していない) では `/stream` は配信されない (PlayMode 限定)。
> `/screenshot` は EditMode でも SingleCameraRequest 経路で静止画を返す。

---

## 4. Input System の前提を満たす

`/key` 注入は **新 Input System 専用** (`ENABLE_INPUT_SYSTEM` ガード、
専用仮想 Keyboard + `QueueStateEvent`)。`UnityEngine.Input.GetKey/GetAxis` 等
**legacy 読み出しには一切届かない**。

1. **Active Input Handling**: `ProjectSettings/ProjectSettings.asset` の
   `activeInputHandler` が `1` (Input System) か `2` (Both) であること。
   KzSUnity は `2` (Both) で確認済。
2. **legacy 読み出しの洗い出し** (注入が効かない箇所を特定):
   ```sh
   grep -rn "Input\.GetKey\|Input\.GetAxis\|Input\.GetButton\|Input\.GetMouse" <Project>/Assets
   ```
   ヒットしたゲームプレイ入力は新 Input System (`Keyboard.current[Key.X]` /
   InputActions) へ移行する。KzSUnity は 3 箇所 (debug/option UI) のみ。
3. **非フォーカス時の入力** (リモート操作では Editor/Player が非アクティブになりがち):
   `Edit > Project Settings > Input System Package > Background Behavior` を
   `Ignore Focus` にする (ブリッジは自動変更しない)。

---

## 5. Custos 側 `apps.json` に登録

Custos が当該 Unity を遠隔操作するエントリを `Custos/config/apps.json` の `apps[]`
に追加 (zod schema: `src/config/apps-config.ts`)。**`inAppBridge` を書くと WebRTC 動画源が
gdigrab ではなくブリッジの `/stream` になる** (`src/capture/webrtc-broker.ts`)。

```jsonc
{
  "id": "my-unity-game",
  "name": "My Unity Game (Editor PlayMode)",
  "inAppBridge": {
    "kind": "unity",       // unity = 既定 port 17778 / ergo = 5198
    "host": "127.0.0.1",
    "port": 17778,
    "fps": 24              // /stream の要求 fps
  },
  "input": {
    "buttons": [
      { "label": "W", "key": "W" },
      { "label": "Space", "key": "Space" },
      { "label": "Quit", "action": "kill" }
    ],
    "allowKeyboard": true
  },
  "logs": { "stdout": true, "stderr": true, "files": [] }
}
```

- `build` / `run` は用途次第。Editor PlayMode を駆動するなら別途 UnityCommandServer
  (port 8686) の `/api/recompile` `/api/play-start` を叩く PowerShell を入れる
  (既存 `PrivateGame-editor` エントリ参照)。Player を直接起動するなら `run.cmd` に
  exe を指定。
- 旧 `ergoCustos: {host,port}` 形式も後方互換で受理されるが、Unity では
  `inAppBridge` の `kind:"unity"` が正 (`/stream` WebRTC は `inAppBridge` がある時のみ)。

---

## 6. 動作確認 (AI: ここまで来たら検証)

ブリッジ単体 (Custos を介さず直接):

```sh
# 1) 生存確認 (PlayMode 中なら isPlaying:true)
curl http://127.0.0.1:17778/health

# 2) スナップショット (PNG が落ちれば View 取得 OK)
curl -o shot.png http://127.0.0.1:17778/screenshot

# 3) キー注入 (W 押下→解放。HID usage code: W=26)
curl -X POST http://127.0.0.1:17778/key -H "content-type: application/json" -d '{"code":26,"down":true}'
curl -X POST http://127.0.0.1:17778/key -H "content-type: application/json" -d '{"code":26,"down":false}'

# 4) 動画ストリームのヘッダ確認 (X-Frame-* が返れば /stream OK。本体は raw BGRA なので -I で頭だけ)
curl -I "http://127.0.0.1:17778/stream?fps=24"
```

- `token` を設定した場合は全リクエストに `-H "X-Auth-Token: <token>"` を付ける。
- HID usage code 表は `Custos/src/capture/ergo-custos-client.ts` の `KEY_TABLE`、
  Unity 側逆引きは `unity/com.ludiars.custos-bridge/Runtime/Input/HidKeyMap.cs`。
  (A-Z=4-29, 1-0=30-39, Enter/Esc/BS/Tab/Space=40-44, F1-F12=58-69, 矢印=79-82,
  L 修飾子=224-227)

Custos 経由の WebRTC:
```sh
# Custos backend 起動後、ブラウザ UI でアプリを選び映像が出れば成功。
# 診断は GET /api/apps/_/rtc/diagnostic (直近 10 セッションの RTP 受信数等)。
```

---

## 7. トラブルシュート / 既知の制約

| 症状 | 原因 / 対処 |
|------|-------------|
| Editor で起動しない | §3-B: config `enabled:true` だけでは不十分。メニュー `LUDIARS/Custos Bridge/Enabled` を ON にするか補助スクリプトを置く |
| `/key` が効かない | §4: legacy `Input.Get*` で読んでいる。新 Input System へ移行。または `activeInputHandler` が `0` (legacy only) |
| Player で起動しない | Development Build (`BuildOptions.Development`) でビルドしているか。Release は `DEVELOPMENT_BUILD` 未定義でコードごと無効 |
| ポート衝突 | 旧プロトタイプ `KzSUnity/Assets/Scripts/Editor/Musa/UnityErgoCustosBridge.cs` (port 8687) が残っていると役割重複。削除推奨 |
| `/stream` が空 | EditMode では配信されない (PlayMode 限定)。再生中か確認 |
| 画面が上下反転 / 色が変 | ColorSpace=Linear や D3D11 の readback 行順。`spec/unity-bridge.md` §7 の要検証項目 |
| 401 unauthorized | `token` 設定時は `X-Auth-Token` ヘッダ必須 (`BridgeServer.cs:147`) |

---

## 参照

- 設計の正本: [`spec/unity-bridge.md`](./unity-bridge.md)
- パッケージ README: `unity/com.ludiars.custos-bridge/README.md`
- protocol / HID code: `src/capture/ergo-custos-client.ts`
- Custos 側 WebRTC 配線: `src/capture/{webrtc-broker,ffmpeg-pipeline,bridge-stream}.ts`
