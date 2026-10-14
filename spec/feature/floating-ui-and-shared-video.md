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

### 1.3 スマホの操作メニュー

スマホ表示では、ヘッダのステータス (IDLE / RUNNING など) を押すとフローティングの操作メニューが開く (`public/js/status-menu.js`)。

- 中身: BOOT / Run / Test / Kill と、Unity の状態 (bridge・版・モード・シーン) と Play / Stop / Recompile / Refresh / Send to Session。
  PC ではヘッダと VIEW にある同じ要素を、スマホ表示のときだけメニューへ移す (配線は 1 つ)。
- 開始時と、ゲームが動いていない間は開いた状態にする。ゲームが動き出したら閉じる。「動いている」は、Unity ブリッジの app では
  Play 中、それ以外は run が running。動いている間に開け閉めしたのは、次に状態が変わるまでそのまま。

### 1.4 パッドの定義 (input.pad)

apps.json の `input.pad` に、ゲームが使う操作部品だけを書く。書いた部品だけを並べ、空き枠は出さない。
`pad` が無い app は、従来どおり `input.buttons` から位置を推測して同じ形にする (`padDefinition`、`public/js/virtual-pad-logic.js`)。

```json
"pad": {
  "leftStick":  { "up": "W", "down": "S", "left": "A", "right": "D", "press": "LShift" },
  "rightStick": { "up": "I", "down": "K", "left": "J", "right": "L", "press": "Tab" },
  "dpad":       { "up": "Up", "down": "Down", "left": "Left", "right": "Right" },
  "face":       { "a": "Space", "b": "Escape", "x": "Z", "y": "X" },
  "shoulders":  { "lb": "Q", "rb": "E", "lt": "1", "rt": "3" },
  "menu":       [{ "label": "Pause", "key": "P" }, { "label": "📷", "action": "screenshot" }]
}
```

- 並び: 上段 LT・LB / menu / RB・RT、中段 左スティック (無ければ十字キー) / ABXY、下段 十字キー / 右スティック。
- スティックは傾きを 8 方向に分けて方向キーの押下 / 解放にする。300ms 以内のダブルタップで `press` (L3 / R3) をタップで送る。

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
- ffmpeg を起動できない (未インストール・`CUSTOS_FFMPEG` の誤り) ときは、映像の来ない session を作らず、
  `/rtc/offer` をその理由で失敗させる (起動の成否を spawn / error で待つ)。起動後に error を出したら全 session を閉じる。
- ブリッジの映像 (Game View) は奇数サイズになりうる (例 603x319)。H.264 (yuv420p) は偶数しか受け付けないので、
  エンコード前に `crop=trunc(iw/2)*2:trunc(ih/2)*2` で偶数に切り詰める。
- ブリッジの映像はフレームが届いた時刻をそのまま使い (`-use_wallclock_as_timestamps 1`)、実時間で 1 秒ごとに keyframe を出す
  (`-force_key_frames expr:gte(t,n_forced*1)`)。Edit mode・一時停止の間はフレームが 1 秒に 1 枚しか来ないので、フレーム数基準の
  GOP では keyframe が 24 秒に 1 回になり、途中から来たブラウザが何も描けなかった。
- Unity ブリッジは要求を受け付けるだけで、処理は ThreadPool で並行に行う。1 本で順に処理すると、main thread を待つ要求
  (`/screenshot` 最大 7 秒、`/editor/*`) の後ろに Play / status / key が並び、VIEW を開いている間は数秒単位で詰まった。
- Unity ブリッジの `/stream` は、最初のフレームを待つ間から「接続中」として数える (`FrameStreamer`)。Editor / Player の
  フレーム取り込みは接続中のときだけ動くため、フレームが届いてから数えると最初のフレームが作られず必ず 503 になっていた。

### 3.1 音声 (process-loopback)

app に `audio: { "source": "process-loopback" }` を書くと、映像と同じ WebRTC 接続に Opus の音声トラックを載せる。

- 取り込み: Windows 10 2004 以降の Application Loopback で、対象プロセス (と子プロセス) が鳴らす音だけを取る
  (`src/capture/process-loopback/ProcessLoopback.cs`)。CRI ADX のように Unity の AudioListener を通らない音も取れ、
  他のアプリの音や通知音は入らない。C# のソースを Windows 標準の csc.exe で初回にビルドし、OS の一時ディレクトリに
  ソースのハッシュ付きで置く (`src/capture/process-loopback.ts`)。
- 対象の PID: inAppBridge の `/health` が返す `pid` (Excubitor が起動した Unity Editor でも取れる)。ブリッジが無い app は
  Custos が起動した run の PID (`src/capture/audio-target.ts`)。取れなければ理由付きで失敗する。
- 配信: PCM (s16le / 48kHz / 2ch) → ffmpeg (libopus 96kbps、20ms) → RTP (pt 111)。映像と同じく app ごとに 1 本を共有する
  (`createAudioSourcePool`)。対象が鳴らしていない間は API がパケットを出さないので、実時間に合わせて無音を埋める。
- 音声が取れなくても映像は流す。理由は `/rtc/offer` の `audioError` と RTC 診断に残し、ブラウザが LOG に出す。
- ブラウザは音声の受信枠を `hasAudio` の app でだけ出す。自動再生の制限があるので消音で始め、VIEW の 🔇 / 🔊 で切り替える。

### 3.2 外部からの接続 (STUN / TURN)

画面・操作は Cloudflare Tunnel (HTTP / WebSocket) を通るが、WebRTC の映像と音声は Tunnel を通らず UDP で直接つながる。
同じ LAN 以外からも届くよう、サーバー (werift) とブラウザの両方に同じ ICE サーバーを渡す (`src/capture/ice-servers.ts`、
ブラウザは `GET /api/apps/_/rtc/ice-servers` で受け取る)。

- STUN: 既定は Cloudflare の無料 STUN (`stun:stun.cloudflare.com:3478`)。`CUSTOS_STUN_URLS` (カンマ区切り) で変えられ、空文字で無効。
  NAT の外側のアドレス (srflx) を候補に出し、多くの家庭・オフィスのルーターでは外からも直接つながる。
- TURN: `CUSTOS_TURN_KEY_ID` と `CUSTOS_TURN_KEY_API_TOKEN` (Cloudflare Realtime の TURN キー、Excubitor の Vault で custos に渡す)
  があるときだけ使う。直接つながらない回線 (携帯の CGNAT など) で中継する。認証情報は Cloudflare の API で 24 時間の期限付きで
  発行し、期限の 1 時間前まで使い回す。片方だけの設定は起動時に止める。発行に失敗したら STUN だけで続け、理由をログに出す。
  ブラウザが拒否する port 53 の TURN は除く。werift には UDP の TURN だけを渡す。
- 料金の目安 (2026-08 時点): STUN は無料・無制限。TURN は毎月 1,000GB まで無料 (SFU と共通の枠)、以降 $0.05/GB (Cloudflare → 端末の分)。

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
| `src/capture/shared-rtp-source.ts` | app ごとの映像源 / 音声源の共有 |
| `src/capture/ice-servers.ts` | STUN / TURN の設定と TURN 認証情報の発行 |
| `src/capture/audio-pipeline.ts` / `audio-source.ts` / `audio-target.ts` / `process-loopback.ts` | 音声の取り込み・変換・対象 PID・取り込みプログラムのビルド |
| `src/input/control-lease.ts` / `src/routes/control-guard.ts` | 操作権 / REST の観戦ガード |

## 5. 受け入れ条件

- `npm run build` / `npm test` が通る。
- PC でウインドウを移動・リサイズ・最小化・閉じる・再表示でき、再読み込み後も配置が戻る。
- スマホ幅で ヘッダ / 映像 / パッド の縦 3 段になり、LOG などはシートで開く。
- 映像源のある app を選ぶと WebRTC の映像が自動で出る。2 つ目のブラウザでつないでも ffmpeg は 1 本のまま。
- 2 つ目のブラウザは、1 つ目が操作している間は「観戦中」になり、入力と Unity の操作が効かない。1 つ目が遠隔プレイを OFF にするか
  閉じると操作できるようになる。
- スマホで映像をタップすると左クリック、長押しで右クリック、ドラッグで押したまま移動になる。パッドのスティックで 8 方向に動く。
