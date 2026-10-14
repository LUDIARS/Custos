# フローティングウインドウ UI と WebRTC 常時接続

- 作成日: 2026-10-14 (neco 指示「Custos のタブをやめて全部フローティングウインドウにする。スマホはヘッダ・メイン・操作部分の縦画面。
  Unity Editor を選んだら View を Unity パネルにする。View は最初から WebRTC。複数人ログインは想定せず、プレイ中のユーザがいれば観戦」
  「スマホ操作を前提とするので View はタップでマウス操作に反応する。バーチャルパッドを用意する」)
- 関連: `spec/feature/remote-play-and-play-log.md` §1.3 (タッチ・パッド) / §1.4 (操作権と観戦)、`spec/feature/unity-bridge.md`

## 1. 画面構成

### 1.1 PC: フローティングウインドウ

タブ (VIEW / LOG / TEST / UNITY / SETTINGS) を廃止し、VIEW / PAD / LOG / TEST / SETTINGS をそれぞれウインドウにする。

- タイトルバーで移動、右下の角で大きさ変更、押したウインドウを前面へ、最小化 (–)、閉じる (×)。
- ヘッダのボタン (VIEW / PAD / LOG / TEST / SETTINGS) で出し入れ。⟲ で既定配置に戻す。
- 既定配置は画面サイズに対する割合 (VIEW が左 62%、右に PAD と LOG)。TEST と SETTINGS は閉じた状態で始まる。
- 配置は `localStorage` (`custos.windows.v1`) に保存し、次回戻す。読めない・壊れた値は既定配置で始める。
- タイトルバーが画面外に出て掴めなくならないよう、位置と大きさを画面内に収める (`public/js/window-layout-logic.js`、vitest 対象)。

### 1.2 スマホ: 縦 3 段

幅 820px 以下、またはタッチ主体の縦画面ではスマホ表示にする (`public/js/layout-mode.js`)。

- 上から **ヘッダ / 映像 (VIEW) / 操作部分 (PAD)**。映像は残りの高さを全部使い、PAD は 46vh まで。
- LOG / TEST / SETTINGS は下からせり出すシート。開くのは 1 枚だけ。
- Unity の Hierarchy / Console はスマホでは畳む (映像と操作を優先する)。

## 2. VIEW

### 2.1 Unity Editor を選んだとき

Unity ブリッジ (`inAppBridge.kind = "unity"`、`/api/apps` の `hasUnityBridge`) の app を選ぶと、VIEW を Unity パネルにする
(`body.unity-mode`)。上に状態と Play / Stop / Recompile / Refresh / Send to Session、左に Hierarchy、中央に映像、下に Console。
観戦中は操作ボタンを押せない (サーバーも 409 で拒否する)。

### 2.2 映像は最初から WebRTC

- 映像源 (`capture` または `inAppBridge`、`/api/apps` の `hasVideo`) のある app を選んだ時点で WebRTC につなぐ。
  Snapshot / WebRTC の切り替えと開始ボタンは廃止した。
- 切断・失敗したら 2 秒から倍々 (最大 30 秒) でつなぎ直す。app が起動し直したら (`running` になったら) 待たずにつなぐ。
- 映像が届くまでは、サーバーの auto-stream (静止画、SETTINGS で間隔を変えられる) を代わりに映す。
- 📷 は今の画面の PNG を 1 枚保存する (映像は止めない)。

## 3. 映像源の共有 (サーバー)

観戦者が増えるたびに ffmpeg を起動すると、同じ画面を何本もエンコードすることになる (bridge-stream ではアプリ側の `/stream`
接続も増える)。`SharedRtpSourcePool` (`src/capture/shared-rtp-source.ts`) が app ごとに映像源 (UDP listener + ffmpeg) を 1 本だけ持ち、
RTP datagram を購読中の全 WebRTC session に配る。

- 最初の購読で起動し、最後の購読解除で止める (refcount)。起動中に購読が 0 になったら、起動の決着を待ってから止める
  (stop の後で ffmpeg が spawn されて取り残されるのを防ぐ)。
- ffmpeg が終了したら全 session に通知して閉じる。クライアントは再接続で新しい映像源につながる。
- ffmpeg は 1 秒 GOP なので、途中参加の session も 1 秒以内に keyframe を受け取れる。

## 4. 構成 (SRP)

| ファイル | 責務 |
|---|---|
| `public/js/app.js` | 部品の組み立てと配線、app 選択、BOOT / Run / Test / Kill |
| `public/js/api.js` | REST 呼び出し (token・clientId ヘッダ) と WS の接続先 |
| `public/js/ws-client.js` | /ws の接続・再接続・送信 |
| `public/js/log-view.js` | LOG / TEST への出力 |
| `public/js/layout-mode.js` | PC / スマホの判定 |
| `public/js/window-manager.js` (+ `window-layout-logic.js`) | ウインドウの表示・移動・大きさ・保存 |
| `public/js/stream-view.js` | 映像の自動接続・再接続・静止画・📷 |
| `public/js/control-state.js` | 操作権 (player / spectator / free) の保持と表示 |
| `public/js/virtual-pad.js` (+ `virtual-pad-logic.js`) | バーチャルパッド |
| `public/js/play-input.js` (+ `play-input-logic.js`) | 映像上のマウス / タッチ / キーボード |
| `public/js/unity-panel.js` | Unity パネル |
| `public/js/settings-panel.js` | SETTINGS |
| `src/capture/shared-rtp-source.ts` | app ごとの映像源の共有 |
| `src/input/control-lease.ts` / `src/routes/control-guard.ts` | 操作権 / REST の観戦ガード |

## 5. 受け入れ条件

- `npm run build` / `npm test` が通る。
- PC でウインドウを移動・リサイズ・最小化・閉じる・再表示でき、再読み込み後も配置が戻る。
- スマホ幅で ヘッダ / 映像 / パッド の縦 3 段になり、LOG などはシートで開く。
- 映像源のある app を選ぶと WebRTC の映像が自動で出る。2 つ目のブラウザでつないでも ffmpeg は 1 本のまま。
- 2 つ目のブラウザは、1 つ目が操作している間は「観戦中」になり、入力と Unity の操作が効かない。1 つ目が遠隔プレイを OFF にするか
  閉じると操作できるようになる。
- スマホで映像をタップすると左クリック、長押しで右クリック、ドラッグで押したまま移動になる。パッドのスティックで 8 方向に動く。
