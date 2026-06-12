# Custos Unity Bridge 設計書 — `com.ludiars.custos-bridge`

Custos (遠隔テストランナー) を Unity 環境向けに転用するための、Unity 内 HTTP ブリッジの設計。
ergo_custos (C++/Pictor アプリ用 in-app ブリッジ) と **完全に同一の protocol** を Unity 側で実装し、
Custos 本体 (TS) は一切変更せずに Unity アプリ/Editor を遠隔操作可能にする。

- 作成日: 2026-06-12
- ステータス: 設計のみ (実装は別担当)
- ターゲット実証プロジェクト: `E:/Document/Ars/PrivateGame/KzSUnity`
  (URP 17.0.4 / Unity 6 / com.unity.inputsystem 1.14.2 / activeInputHandler=2 (Both))

---

## 0. 前提: protocol (ergo_custos 互換、変更禁止)

`src/capture/ergo-custos-client.ts` が叩く 2 endpoint をそのまま実装する。

| Method | Path | Request | Response |
|--------|------|---------|----------|
| GET | `/screenshot` | - | `200 image/png` (PNG バイト列)。client は magic bytes `89 50 4E 47` を検証する |
| POST | `/key` | `{ "code": <int>, "down": <bool> }` | `200` or `204` (client は `!ok && status!==204` で throw) |

- `code` は **USB HID usage 風 int** (`KEY_TABLE` 体系、§3.2)。ergo の `include/ergo/input/types.h` `enum class KeyCode` と一致。
- client 側 timeout: screenshot 8s / key 2s (`ergo-custos-client.ts` 冒頭の定数)。bridge はこれより十分速く返すこと。
- 追加 endpoint は protocol 互換を壊さない限り可。`GET /health` (`{"status":"ok","isPlaying":bool}`) を診断用に持つ
  (KzSUnity 内の既存プロトタイプ `UnityErgoCustosBridge.cs` と同じ。Custos client は呼ばないので互換に影響しない)。
- エラー応答は `4xx/5xx + application/json {"error": "..."}`。

**Custos 側に必要な変更はゼロ。** `config/apps.json` の app entry に
`"ergoCustos": { "host": "127.0.0.1", "port": <bridge port> }` を書くだけで、
`src/input/forwarder.ts` (キー転送) と `src/capture/screenshot-stream.ts` (PNG ポーリング) /
`src/routes/rtc-routes.ts` (RTC ソース) が既存コードのまま Unity bridge を使う。

### 0.1 既存プロトタイプ (prior art / 置き換え対象)

`KzSUnity/Assets/Scripts/Editor/Musa/UnityErgoCustosBridge.cs` (port 8687、`[InitializeOnLoad]`、
HttpListener + EditorApplication.update ポンプ) が同 protocol で稼働実績あり。本設計はこれを
**UPM パッケージとして製品化し、KzSUnity 側プロトタイプを置き換える** (二重 inject / port 重複を避けるため、
パッケージ導入時に Musa 版は削除する。Play/Stop 用 `UnityCommandServer` (8686) は対象外、そのまま残す)。
プロトタイプから引き継ぐ実証済みパターン: HttpListener 同期 accept loop / key の ConcurrentQueue /
screenshot の coalescing (`pendingShot` 共有 + `ManualResetEventSlim`) / `beforeAssemblyReload` での停止。

---

## 1. アーキテクチャ概要

```
Custos (TS, 既存・無変更)
  └─ ergo-custos-client.ts ── HTTP ──> Unity 内 bridge (本パッケージ)
                                         ├─ BridgeServer (HttpListener, BG thread)
                                         │    ├─ GET /screenshot ─> IFrameProvider (差し替え可能)
                                         │    │     ├─ (A) RuntimeFrameProvider   … Player ビルド + Editor PlayMode
                                         │    │     └─ (B) EditorGameViewFrameProvider … Editor 専用 (UnityRemote 型)
                                         │    └─ POST /key ─────> VirtualKeyboardInjector (Input System)
                                         └─ MainThreadDispatcher (BG→main マーシャリング)
```

3 層に分割する (SRP):

1. **共通ブリッジ層** (`Runtime/` 配置、Editor からも参照可)
   — HTTP listen / routing / JSON / main-thread dispatch / 入力注入。view の取り方を知らない。
2. **provider 層** — `IFrameProvider` 1 interface + 実装 2 系統。
   - **(A) Runtime Camera 版**: Player ビルドおよび Editor PlayMode で動く。`ScreenCapture` + `AsyncGPUReadback`。
   - **(B) Editor Game View 版**: ビルド不要。`[InitializeOnLoad]` で Editor 常駐し、PlayMode 中の
     Game View 描画結果を取り出す (UnityRemote 型)。EditMode のプレビュー描画も可。
3. **bootstrap 層** — Runtime 自動起動 (`[RuntimeInitializeOnLoadMethod]`) と Editor 起動
   (`[InitializeOnLoad]` + メニュー toggle)。**Editor 内では Editor bootstrap が単独で listener を所有**し、
   Runtime bootstrap は `Application.isEditor` で即 return する (同一 port の二重 bind 防止)。
   Editor bootstrap は PlayMode 中は provider (A) に委譲し、EditMode では (B) を使う (§2.2)。

```
interface IFrameProvider {
    /// main thread で呼ばれる。完了時に PNG bytes か error を callback で返す (非同期可)。
    void RequestFrame(Action<byte[] /*png*/, string /*error*/> onDone);
}
```

---

## 2. ビューのフレーム取得

### 2.1 (A) Runtime Camera 版 — `RuntimeFrameProvider`

**採用: `WaitForEndOfFrame` → `ScreenCapture.CaptureScreenshotIntoRenderTexture(rt)` →
`AsyncGPUReadback.Request` → `ImageConversion.EncodeNativeArrayToPNG`。**

手順 (すべて実在 API、URP 17 / Unity 6 で利用可):

1. 常駐の hidden GameObject (`DontDestroyOnLoad`) 上の coroutine が要求を受けたら
   `yield return new WaitForEndOfFrame();`
2. `ScreenCapture.CaptureScreenshotIntoRenderTexture(stagingRt)` — **最終 backbuffer**
   (URP post-process + Screen Space Overlay の UI Canvas 込み) をステージング RT へコピー。
   テストランナー用途では HUD/メニューが映ることが必須なので、カメラ単体描画ではなくこれを採る。
3. `AsyncGPUReadback.Request(stagingRt, 0, TextureFormat.RGBA32, callback)` —
   GPU→CPU readback を非同期化し、フレームレートを止めない。callback は main thread で届く。
4. callback で `req.GetData<byte>()` (NativeArray) を managed 配列にコピーし、
   `ImageConversion.EncodeNativeArrayToPNG` / `EncodeArrayToPNG` で PNG 化。
   この 2 つは Texture オブジェクトに触らないため **スレッドセーフ** — エンコードは
   `Task.Run` でワーカースレッドに逃がし、main thread の hitch を避ける (1080p PNG encode は数十 ms 級)。
5. PNG bytes を `ScreenshotRequest.done` (ManualResetEventSlim) 経由で HTTP スレッドへ返す。

注意点 (実装担当向け):

- **上下反転**: `AsyncGPUReadback` の行順は graphics API 依存。`SystemInfo.graphicsUVStartsAtTop`
  (D3D11/12/Metal で true) のとき CPU 側で行を逆順に詰め替えるか、事前に
  `Graphics.Blit(src, dst, new Vector2(1, -1), new Vector2(0, 1))` で反転 blit する。
  **要検証**: D3D11 実機での実際の向き (KS は Windows / D3D 想定)。CPU 行逆順を既定実装とし、
  起動時 1 回の目視 (テスト画像) で確認する。
- **sRGB**: Linear color space プロジェクトでは staging RT を
  `new RenderTexture(w, h, 0, RenderTextureFormat.ARGB32, RenderTextureReadWrite.sRGB)`
  (または `GraphicsFormat.R8G8B8A8_SRGB`) で作る。Linear フォーマットのまま readback すると
  PNG が暗く/白っぽくなる。**要検証**: KzSUnity の ColorSpace 設定 (Linear 想定)。
- **解像度**: `Screen.width/height`。設定で長辺上限 (既定 1280) を持ち、超える場合は
  ダウンスケール blit を挟む — Custos の `screenshot-stream.ts` は fps ポーリングするため
  PNG サイズがそのまま帯域と encode 時間に効く。
- **main thread 制約**: `ScreenCapture` / `AsyncGPUReadback.Request` / RT 生成は main thread のみ。
  HTTP スレッドから直接呼ばず、必ず dispatcher 経由 (§4)。
- **coalescing**: 同時に複数 `/screenshot` が来ても保留要求は 1 つに束ね、同じ PNG を全 waiter に返す
  (プロトタイプの `pendingShot` パターン踏襲)。
- **非フォーカス時**: 遠隔テストでは Player が背面のことが多い。`Application.runInBackground = true`
  を bridge 起動時に強制する (設定で opt-out 可)。

代替案 (不採用):

- `RenderPipelineManager.endCameraRendering` で base camera の出力を blit — overlay UI が映らない。
  URP の `endFrameRendering` は obsolete (→ `endContextRendering`) であり、いずれにせよ UI 欠落問題が残る。
- 専用ミラーカメラ + `targetTexture` — カメラ複製の維持コスト (cull mask / stack / post 設定追従) が高く、
  KzSUnity は camera stack 未使用 (シーン上 `m_Cameras: []` 確認済) なので利点がない。

### 2.2 (B) Editor Game View 版 — `EditorGameViewFrameProvider`

候補比較:

| 候補 | 評価 |
|------|------|
| **PlayMode 中: (A) と同じ `ScreenCapture` end-of-frame 経路** | Editor では `Screen` = Game View backbuffer。Game View の最終絵 (UI 込み) がそのまま取れる。internal API 不使用。**採用** |
| EditMode 中: `RenderPipeline.SubmitRenderRequest` + `UniversalRenderPipeline.SingleCameraRequest` で `Camera.main` をステージング RT に描画 | URP が公式サポートする単発カメラ描画 (旧 `Camera.Render()` の SRP 正規代替)。overlay UI は映らないが EditMode プレビュー用途では許容。**採用 (EditMode のみ)** |
| Game View ウィンドウへの reflection (`UnityEditor.GameView` の内部 RT を取得) | internal API でバージョン間の脆弱性が高い (Unity 6 で member 名変更実績多数)。不採用 |
| 隠しキャプチャカメラで Main を複製 + `Camera.Render()` | `Camera.Render()` は SRP では非サポート経路 (プロトタイプで「動いて見える」が URP の正規描画と異なる懸念)。不採用 |
| `RenderTexture.active` を任意タイミングで読む | active RT が Game View のものである保証がなく、タイミング依存。不採用 |
| Win32 `PrintWindow` (プロトタイプの `captureMode: "window"`) | Editor ウィンドウ全体 (Scene/Inspector 込み) が映る + Windows 限定。**最終フォールバックとしてのみ温存** (config `captureMode: "window"`) |

**決定**: PlayMode 必須要件は (A) の経路がそのまま Editor で満たす (Game View にレンダリングされた
backbuffer を `ScreenCapture` が拾う) ため、(B) は「EditMode では `SingleCameraRequest`、
PlayMode では provider (A) へ委譲、緊急時 `PrintWindow`」という **薄い切替器** とする。
理由: internal reflection を持ち込まずに「再生中の Game View の絵」を安定して取れる唯一の組合せであり、
プロトタイプ実績 (camera/window/auto 3 モード) とも連続性がある。

- 解像度取得: PlayMode は `Screen.width/height`、EditMode は
  `UnityEditor.PlayModeWindow.GetRenderingResolution(out uint w, out uint h)` (プロトタイプ実証済)。
- **要検証**: Game View が一度も開かれていない/最小化されている Editor で `ScreenCapture` が
  何を返すか (空 RT の可能性)。失敗時は 503 + error を返し、`auto` モードで `SingleCameraRequest` →
  `PrintWindow` の順にフォールバックする。

---

## 3. 入力注入 (最重要)

### 3.1 KzSUnity の入力読み出し実態 (調査結果)

| 経路 | 使用箇所 | bridge からの到達性 |
|------|---------|------------------|
| **新 Input System / InputActionAsset** (`Assets/Settings/PlayerInputActions.inputactions`、`<Keyboard>/...` binding 多数: w/a/s/d, space, 1-3, arrows, enter, escape, q/e/l/r/g/f, numpad1-6, j/k/u/i/o, shift, pause) | ゲームプレイ本線。`PlayerController.cs` が `InputActionAsset.FindActionMap("KuzuPlayer")` で取得 (`PlayerInput` コンポーネントは不使用、生成 wrapper `@PlayerInputActions` も実行時未使用) | ◎ `QueueStateEvent` で到達 |
| **`Keyboard.current` 直読み** | `PlayerController.TryKeyboardFallback()` (digit1-3 等) | ◎ 同上 (仮想デバイスが `.current` になる、§3.3) |
| **legacy `Input.*`** | 3 箇所のみ: `Outgame/Option/LRButtonBase.cs` (`Input.GetAxisRaw("Horizontal")`)、`System/Debug/GCAllocTestSpawner.cs` (マウス、debug)、`System/ErrorReport/ErrorReporterUpdater.cs` (`Input.GetKeyDown(KeyCode.Space)`、`#if UNITY_EDITOR \|\| DEVELOPMENT_BUILD` 限定) | ✗ 新 Input System への注入は届かない → §3.4 |

ゲームプレイの操作はすべて新 Input System 経由なので、**主注入経路は Input System 一本で成立する**。

### 3.2 HID usage int → `UnityEngine.InputSystem.Key` 対応表

Custos `KEY_TABLE` (`ergo-custos-client.ts` 末尾) との逆引き突き合わせ。`HidKeyMap.cs` に静的実装する。

| HID code | KEY_TABLE 名 | `Key` enum |
|----------|-------------|-----------|
| 4 – 29 | `A` – `Z` | `Key.A + (hid - 4)` (`Key.A`..`Key.Z` は連番) |
| 30 – 38 | `1` – `9` / `Num1`–`Num9` | `Key.Digit1 + (hid - 30)` (`Digit1`..`Digit9` 連番) |
| 39 | `0` / `Num0` | `Key.Digit0` (enum 上 `Digit9` の次) |
| 40 | `Enter` / `Return` | `Key.Enter` |
| 41 | `Escape` / `Esc` | `Key.Escape` |
| 42 | `Backspace` | `Key.Backspace` |
| 43 | `Tab` | `Key.Tab` |
| 44 | `Space` | `Key.Space` |
| 58 – 69 | `F1` – `F12` | `Key.F1 + (hid - 58)` |
| 79 | `Right` | `Key.RightArrow` |
| 80 | `Left` | `Key.LeftArrow` |
| 81 | `Down` | `Key.DownArrow` |
| 82 | `Up` | `Key.UpArrow` |
| 224 | `LCtrl` / `Ctrl` | `Key.LeftCtrl` |
| 225 | `LShift` / `Shift` | `Key.LeftShift` |
| 226 | `LAlt` / `Alt` | `Key.LeftAlt` |
| 227 | `LSuper` | `Key.LeftMeta` |

- KEY_TABLE は HID usage page 0x07 のサブセットなので、bridge 側は **上記を保証範囲** としつつ、
  標準 HID 0x07 の残り (45=`-`, 46=`=`, 47=`[`, 54=`,`, 89–98=Numpad1–0 等) も `Key` に対応が
  ある限り拡張実装してよい (将来 ergo 側 KeyCode 追加への前方互換)。
- 未対応 code は **`400 {"error":"unknown code <n>"}`** を返す (Custos forwarder が warn ログを出し、
  サイレント握り潰しを避ける)。
- KEY_TABLE 改訂時はこの表 + `HidKeyMap.cs` + ergo `types.h` の 3 点同期が必要 (非自明な依存。
  各ファイル先頭コメントに相互参照を書くこと)。

### 3.3 注入方式 — 専用仮想 Keyboard デバイス + `KeyboardState` 蓄積 + `QueueStateEvent`

**採用 API** (Input System 1.14 実在):

```
// 起動時 (main thread):
virtualKeyboard = InputSystem.AddDevice<Keyboard>("CustosBridge Keyboard");

// /key 受信ごと (main thread dispatcher 経由):
pressedState.Set(key, down);                       // KeyboardState (struct) を保持し続け、押下状態を蓄積
InputSystem.QueueStateEvent(virtualKeyboard, pressedState);

// 停止時:
InputSystem.RemoveDevice(virtualKeyboard);
```

設計の要点:

- **state 蓄積**: `KeyboardState` はフルステート (全キーのビットフィールド)。bridge は自前の
  `KeyboardState pressedState` フィールドを唯一の真実として保持し、`Set(Key, bool)` で更新してから
  毎回フルステートを queue する。これにより「W 押しっぱなし + Space 連打」のような同時押しが正しく表現され、
  down/up の取りこぼしがあっても次のイベントで自己修復する。差分だけ送りたい場合は
  `QueueDeltaStateEvent(control, value)` も使えるが、フルステート方式の方が同期ズレに強いので既定はこちら。
- **専用デバイスにする理由**: 既存プロトタイプは `StateEvent.From(Keyboard.current)` で
  **物理キーボードのデバイス state を複製・改変**して queue する。この方式は物理キー入力と
  注入が同一デバイス上で競合し、物理側のイベントが注入済み押下状態を上書きして「押しっぱなしが勝手に離れる」
  事故が起きうる。専用デバイスなら物理キーボードと state が独立する。
- **`Keyboard.current` への到達**: Input System はイベントを受信したデバイスを `MakeCurrent()` するため、
  注入直後から `Keyboard.current` は仮想デバイスを指す → `TryKeyboardFallback()` にも届く。
  `<Keyboard>/w` 等の binding はデバイス個体ではなく layout にマッチするので、InputActionAsset 経路は
  仮想/物理どちらのイベントにも反応する。**要検証**: 物理キーボードに触れた直後に `current` が
  物理側へ戻り、仮想デバイスの押しっぱなし state が `current` 経由の直読みから見えなくなるケース
  (遠隔テスト中はホスト無操作なので実害は限定的だが、ドキュメントに既知制約として明記する)。
- **スレッド**: `InputSystem.AddDevice` / `QueueStateEvent` は main thread から呼ぶ
  (`QueueStateEvent` はスレッドセーフと文書化されているが、AddDevice/RemoveDevice との順序保証を
  単純化するため dispatcher 経由に統一する。**要検証**: 1.14 での thread-safety 記述)。
- queue されたイベントは次の `InputSystem.Update()` (既定: dynamic update) で反映される。
  反映レイテンシは最大 1 フレームで、テストランナー用途では十分。
- **Editor 固有**: PlayMode で Game View が非フォーカスだと入力が処理されない設定がある。
  bridge 有効時は `InputEditorUserSettings.lockInputToGameView = true` を推奨設定として
  ドキュメント化する (自動変更はしない — ユーザ設定を黙って書き換えない)。
  Player ビルドでは `InputSystem.settings.backgroundBehavior` を
  `IgnoreFocus` にする (`runInBackground` とセット。**要検証**: enum 名は
  `InputSettings.BackgroundBehavior.IgnoreFocus`)。

不採用案: `InputSystem.QueueTextEvent` (テキスト入力専用で press/release 表現不可)、
`InputTestFixture` / `Press()`/`Release()` (`com.unity.inputsystem` の test assembly 依存で
ランタイム持ち込み不可)、Win32 `SendInput` (focus 依存 — それを排除するのが本 bridge の目的)。

### 3.4 legacy `Input.GetKey` への対策 (必読)

新 Input System への `QueueStateEvent` は **legacy Input Manager (`UnityEngine.Input`) には一切届かない**。
`UnityEngine.Input` をコードから駆動する公開 API は存在しない (内部 native state のため shim 不可)。
選択肢と決定:

| 案 | 内容 | 評価 |
|----|------|------|
| **(a) ゲーム側を新 system 読みに寄せる (採用)** | KzSUnity の legacy 読み出しは 3 箇所のみ (§3.1)。`ErrorReporterUpdater` → `Keyboard.current.spaceKey.wasPressedThisFrame`、`LRButtonBase.GetAxisRaw("Horizontal")` → `Keyboard.current.leftArrowKey/rightArrowKey` (または既存 `OutGameInput.inputactions` の action 参照)、`GCAllocTestSpawner` → `Mouse.current` | 差分が小さく根治。`activeInputHandler=Both` のままで可。KzSUnity 側 1 PR |
| (b) bridge が両系統を駆動 (Win32 `SendInput` 併用 shim) | `/key` 受信時に Input System へ queue しつつ `SendInput` も発行 | focus 必須 (Custos が nut-js で既にやっており、それを捨てるのが本 bridge の目的)。二重入力の打ち消し制御も複雑。不採用 |
| (c) `CustosInput.GetKey()` ラッパを全ゲームコードに強制 | 全 call site 書き換え + 規約強制 | 侵襲が (a) より大きく利点なし。不採用 |

**決定: (a)。** bridge パッケージは Input System 専用と割り切り、README/導入ガイドに
「legacy `Input.*` 読みには届かない。`grep -rn "Input\.Get" Assets/` で洗い出して移行せよ」を明記する。
KzSUnity への導入タスクに上記 3 箇所の移行を含める (実装担当への引き継ぎ事項)。
他プロジェクトで legacy が本線の場合も同方針 (移行が前提条件、bridge 側では救済しない)。

---

## 4. スレッド / ライフサイクル

### 4.1 スレッドモデル

```
[HTTP listener thread (BG)]                [Unity main thread]
HttpListener.GetContext() loop
  ├─ /key:  payload parse → dispatcher.Enqueue(InjectKey) ── pump ──> VirtualKeyboardInjector
  │         即 200 を返す (注入は次フレーム反映)
  └─ /screenshot: ScreenshotRequest を登録し
        done.Wait(timeout 7s) で block ◀──────────────── provider が PNG を Set
                                            (encode は Task.Run のワーカーに逃がしてよい)
```

- **`MainThreadDispatcher`**: `ConcurrentQueue<Action>` 1 本。pump は
  Runtime = hidden GameObject の `Update()`、Editor = `EditorApplication.update`。
  Unity API (InputSystem / ScreenCapture / RT / Texture2D) は必ずこのキュー経由で main thread 実行。
- listener は同期 `GetContext()` ループ (プロトタイプ実証済)。同時接続は Custos 1 クライアント前提で
  スループット要件が低いため、async 化はしない (SRP: 複雑化に見合う要件がない)。
- screenshot は coalescing (§2.1)。`/key` は enqueue 即応答 — ergo_custos C++ 側と同じ
  fire-and-forget セマンティクスで、client timeout 2s に確実に収まる。

### 4.2 起動 / 停止

- **Runtime (Player ビルド)**: `[RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]`
  で `Application.isEditor == false` のときのみ自動起動。hidden GameObject
  (`HideFlags.HideAndDontSave` + `DontDestroyOnLoad`) を生成して pump / coroutine をホスト。
  `Application.quitting` で listener 停止 + 仮想デバイス除去。
- **Editor**: `[InitializeOnLoad]` 静的コンストラクタで設定を読み、有効なら起動。
  メニュー `LUDIARS/Custos Bridge/Enabled` (checked toggle、状態は `EditorPrefs`) で随時 ON/OFF。
  `AssemblyReloadEvents.beforeAssemblyReload` と `EditorApplication.quitting` で必ず停止
  (domain reload 後に `[InitializeOnLoad]` が再起動する — プロトタイプ実証済)。
  PlayMode 遷移 (`playModeStateChanged`) では listener を維持し、provider だけ切り替える。
- **二重 bind 防止**: Editor 内では Editor bootstrap のみが listener を持つ (§1)。
- **リリースビルド除外**: Runtime asmdef に `defineConstraints: ["UNITY_EDITOR || DEVELOPMENT_BUILD"]`
  を設定し、非 development の Player ビルドからコードごと除外する (テスト機能を本番に同梱しない)。
  **要検証**: defineConstraints の `||` 記法サポート (2020.1+ で可のはず)。不可なら
  `#if DEVELOPMENT_BUILD || UNITY_EDITOR` でファイル単位ガード。

### 4.3 設定と既定ポート

設定の優先順位: 環境変数 > 設定ファイル > 既定値 (LUDIARS 規約「設定はファイル管理」準拠。secret は扱わない)。

| 項目 | 既定 | 上書き |
|------|------|--------|
| port | **17778** | env `CUSTOS_UNITY_BRIDGE_PORT` / `<unity project root>/custos-bridge.json` の `port` |
| enabled (Editor) | false (明示 opt-in) | メニュー toggle / env `CUSTOS_UNITY_BRIDGE_ENABLED` |
| token | なし | json `token` (設定時は `X-Auth-Token` ヘッダ一致を要求 — プロトタイプ互換) |
| captureMode | `auto` | json `captureMode`: `runtime` / `camera` / `window` / `auto` |
| maxLongEdge | 1280 | json `maxLongEdge` (0 = 無制限) |

**ポート選定根拠** (`infra/PORT-MAP.md` 確認済):

- ergo_custos (C++) は 5198。課題文の例 5199 は **PORT-MAP 原則 4 の Vite dev レンジ (5170-5199) 内**で
  衝突リスクがあるため不採用。
- PORT-MAP 原則 6「17000-17999 = ローカル loopback only (個人 PC アプリ向け)」が本 bridge の性質に合致。
  Custos backend が 17777 なので、**隣接の 17778 を既定** とする (空き確認済)。
- listener prefix は `http://127.0.0.1:{port}/` 固定 (loopback only、外部 bind しない —
  `HttpListener` の `localhost` prefix は環境により全 interface 解釈の余地があるため `127.0.0.1` 明記)。
- 採用後、`infra/PORT-MAP.md` への追記 PR を実装タスクに含める (旧プロトタイプの 8687 と
  UnityCommandServer 8686 は備考として記載)。

---

## 5. マウス / タッチ (拡張点、MVP 範囲外)

protocol 自体に pointer endpoint が無い (ergo_custos C++ も `/key` のみ) ため、MVP では実装しない。
拡張時の設計だけ固定しておく:

- endpoint 案: `POST /pointer` `{ "x": <float 0-1 正規化>, "y": <float 0-1>, "button": <int>, "down": <bool> }`。
  正規化座標にするのは bridge とホストで解像度が一致しない前提のため。
- 注入: 仮想 `Mouse` デバイス (`InputSystem.AddDevice<Mouse>()`) + `MouseState` を §3.3 と同型の
  蓄積方式で `QueueStateEvent`。タッチは `Touchscreen` + `TouchState` (`touchId` 管理が必要)。
- uGUI クリックは `Mouse` 注入で `InputSystemUIInputModule` 経由で動くはず (**要検証**)。
- **ergo_custos C++ / `ergo-custos-client.ts` / 本 bridge の 3 点同時拡張が必須** (protocol 正本は ergo 側)。
  Custos `apps.json` の `input.allowMouse` は既にあるので UI 側変更は最小。

---

## 6. UPM パッケージ構成 — `com.ludiars.custos-bridge`

配置: **`E:/Document/Ars/Custos-uvb/unity/com.ludiars.custos-bridge/`** (Custos リポ内。
protocol の対向実装を同一リポで管理し、KEY_TABLE 改訂時に同一 PR で同期できるようにする)。

```
unity/com.ludiars.custos-bridge/
├── package.json                  # name: com.ludiars.custos-bridge, version: 0.1.0,
│                                 # unity: "6000.0", dependencies: { "com.unity.inputsystem": "1.14.2" }
├── README.md                     # 導入手順 / legacy Input 制約 / port 一覧
├── Runtime/
│   ├── Ludiars.Custos.Bridge.Runtime.asmdef
│   │       # references: ["Unity.InputSystem"],
│   │       # defineConstraints: ["UNITY_EDITOR || DEVELOPMENT_BUILD"]
│   ├── BridgeServer.cs           # HttpListener 起動/停止 + accept loop + routing のみ (副作用の集約)
│   ├── BridgeConfig.cs           # env/json/既定値の解決。I/O はここだけ
│   ├── MainThreadDispatcher.cs   # ConcurrentQueue<Action> + pump 登録 interface
│   ├── BridgeRuntimeBootstrap.cs # [RuntimeInitializeOnLoadMethod] + hidden GameObject
│   ├── Protocol/
│   │   ├── KeyPayload.cs         # {code,down} DTO (JsonUtility)
│   │   └── HttpJson.cs           # JSON 応答/エラー整形 helper
│   ├── Input/
│   │   ├── HidKeyMap.cs          # §3.2 の表のみ (純関数、テスト容易)
│   │   └── VirtualKeyboardInjector.cs  # AddDevice / KeyboardState 蓄積 / QueueStateEvent / RemoveDevice
│   └── Capture/
│       ├── IFrameProvider.cs
│       ├── RuntimeFrameProvider.cs     # §2.1 (ScreenCapture + AsyncGPUReadback)
│       └── PngEncoder.cs               # flip + sRGB 注意点 + EncodeNativeArrayToPNG (Task offload)
├── Editor/
│   ├── Ludiars.Custos.Bridge.Editor.asmdef
│   │       # references: Runtime asmdef, includePlatforms: ["Editor"]
│   ├── BridgeEditorBootstrap.cs        # [InitializeOnLoad] + メニュー toggle + playModeStateChanged
│   ├── EditorGameViewFrameProvider.cs  # §2.2 (PlayMode 委譲 / EditMode SingleCameraRequest)
│   └── EditorWindowCaptureProvider.cs  # PrintWindow fallback (UNITY_EDITOR_WIN、プロトタイプ移植)
└── Tests/ (任意, EditMode)
    └── HidKeyMapTests.cs               # KEY_TABLE 全 code の往復テスト
```

- SRP: HTTP / 設定 / dispatch / 入力 / capture / bootstrap を全部別ファイル。`BridgeServer` は
  provider と injector を interface で受け取り、Unity API を直接触らない。
- KzSUnity からの参照: `KzSUnity/Packages/manifest.json` に
  `"com.ludiars.custos-bridge": "file:../../../Custos/unity/com.ludiars.custos-bridge"`
  (local path、開発中) → 安定後は git URL
  `"https://github.com/LUDIARS/Custos.git?path=unity/com.ludiars.custos-bridge#<tag>"` に切替可。

### 6.1 KzSUnity 導入チェックリスト (実装担当向け)

1. manifest.json に local path 参照を追加。
2. `Assets/Scripts/Editor/Musa/UnityErgoCustosBridge.cs` を削除 (port/inject 二重化防止)。
   `musa/terpsichore/ergo_custos_bridge.json` を `custos-bridge.json` (port 17778) に移行。
3. legacy `Input.*` 3 箇所を新 Input System 読みへ移行 (§3.4 (a) の対応表どおり)。
4. Custos `config/apps.json` の `PrivateGame-editor` / Standalone entry に
   `"ergoCustos": { "host": "127.0.0.1", "port": 17778 }` を追加。
5. `infra/PORT-MAP.md` に 17778 を追記する PR。

### 6.2 受け入れ確認 (実装後)

```
curl http://127.0.0.1:17778/health                       # {"status":"ok","isPlaying":true}
curl -o shot.png http://127.0.0.1:17778/screenshot       # PNG magic + Game View の絵 (UI 込み・正立・正色)
curl -X POST http://127.0.0.1:17778/key -H "content-type: application/json" -d '{"code":26,"down":true}'   # W down
curl -X POST http://127.0.0.1:17778/key -d '{"code":26,"down":false}'                                      # W up
```

- Custos web UI のバーチャルキーで KzSUnity の Player が移動し (W/A/S/D = HID 26/4/22/7)、
  screenshot ストリームに反映されること。
- 押しっぱなし (down→数秒→up) で移動が継続すること (state 蓄積の検証)。
- Editor 非フォーカス状態で上記が動くこと。

---

## 7. 要検証一覧 (まとめ)

| # | 項目 | 推奨/既定 | 参照 |
|---|------|----------|------|
| 1 | AsyncGPUReadback の行順 (D3D11) | `graphicsUVStartsAtTop` で CPU 行逆順 | §2.1 |
| 2 | KzSUnity の ColorSpace と staging RT の sRGB 指定 | `RenderTextureReadWrite.sRGB` | §2.1 |
| 3 | Game View 非表示/最小化時の ScreenCapture 挙動 | 503 + auto フォールバック | §2.2 |
| 4 | `SubmitRenderRequest` + `SingleCameraRequest` の EditMode 動作 (URP 17) | 採用、失敗時 PrintWindow | §2.2 |
| 5 | 物理キーボード操作時の `Keyboard.current` 切替と仮想押下 state の可視性 | 既知制約として文書化 | §3.3 |
| 6 | `QueueStateEvent` の thread-safety (1.14) | dispatcher 経由に統一 | §3.3 |
| 7 | `InputSettings.BackgroundBehavior.IgnoreFocus` の正確な enum 名と効果 | runInBackground とセット | §3.3 |
| 8 | asmdef defineConstraints の `\|\|` 記法 | 不可なら #if ガード | §4.2 |
| 9 | uGUI への仮想 Mouse 注入 (拡張時) | MVP 対象外 | §5 |
