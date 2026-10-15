# WebRTC 転送効率の最適化 (設計案)

- 作成日: 2026-10-15 (neco 指示「今すぐじゃなくて良いんだけど、WebRTC の転送効率が悪いので最適化案を設計する」)
- 状態: **§7 の方式 (Unity 側でハードウェア H.264) で実装済み** (2026-10-15)。§1〜§6 は検討の経緯。
  ffmpeg の経路は、デスクトップキャプチャと H.264 を出せないブリッジのために残す。
- 関連: [floating-ui-and-shared-video.md](floating-ui-and-shared-video.md) §3 (映像源の共有)、[unity-bridge.md](unity-bridge.md) §2 (フレーム取得)

## 0. 今の経路

```
Unity (AsyncGPUReadback, BGRA8)
  └─ GET /stream?fps=24 : 生 BGRA を固定 fps で連続送出 (FrameStreamer.cs)
       └─ Custos bridge-stream.ts → ffmpeg stdin (-f rawvideo -pix_fmt bgra)
            └─ swscale BGRA→yuv420p (CPU) → H.264 baseline (NVENC/AMF/QSV, 無ければ x264)
                 └─ -f rtp pkt_size=1200 → UDP → shared-rtp-source (app ごとに 1 本、refcount)
                      └─ werift track.writeRtp → 各ブラウザ (sendonly)
```

## 1. 非効率の原因 (コード上の根拠)

| # | 事象 | 根拠 | 影響 |
|---|---|---|---|
| A | **ビットレート固定 4 Mbps**。回線に合わせて下げない | `ffmpeg-pipeline.ts` `CUSTOS_VIDEO_BITRATE ?? 4_000_000`、`-maxrate` 1.5 倍 | モバイル回線で帯域を超え、損失・遅延が積もる。良い回線でも静止画面に 4 Mbps 近く使う |
| B | **REMB / TWCC を読んでいない** | `webrtc-broker.ts` で `goog-remb` を宣言するだけ。werift の `onRtcp` を購読していない | ブラウザの推定帯域が送信側に届かない |
| C | **1 秒ごとの IDR** (`-g = fps`) | `encoderArgs` の `gop = fps`。途中参加の session のため (`shared-rtp-source.ts` 冒頭) | 毎秒キーフレームの山 (P フレームの数倍) が出て、帯域とモバイルの損失耐性を食う |
| D | **PLI を ffmpeg へ伝えられない** | werift は `onPictureLossIndication` を出すが未購読。ffmpeg CLI は外から IDR を要求できない | 損失から戻るのを次の 1 秒 IDR まで待つ。C を短くできない理由 |
| E | **画素が同じでも、新しい readback ごとに送る** | `FrameStreamer.cs` は「前回と別の配列か」(参照) で判定する。Play 中は毎フレーム新しい readback が来るので、画面が止まっていても毎回送る (Edit モード等で更新が無い間は 1 秒ごとに再送) | 変化の無い間もエンコード・転送が走る (P フレームは小さいが、CPU と RTP ヘッダ分は常に払う) |
| F | **ブリッジ→ffmpeg が生 BGRA (4 B/px)**、色変換が CPU | `-pix_fmt bgra` 入力 + `-pix_fmt yuv420p` | ハードエンコーダでも swscale が CPU で走る。ループバックで数十 MB/s |
| G | **解像度が Game View の窓の大きさ次第で、奇数にもなる** (例 603×319) | `RuntimeCameraViewProvider.cs` は `Screen.width/height` (Editor では Game View の窓) をそのまま使い、長辺 1280 を超えたときだけ縮める (拡大しない、偶数に丸めない)。`/stream started: 603x319` (Editor.log) | 窓が小さいと映像も小さく粗い。窓を動かすと解像度が変わり ffmpeg が作り直しになる。yuv420p は偶数が要り、端処理で無駄・環境によっては失敗 (§5) |
| H | **キーフレームのパケットを一度に吐く** (ペーシング無し) | ffmpeg の rtp muxer の出力をそのまま `writeRtp` | 数十パケットが瞬間に出て、モバイルの浅いバッファで落ちる → NACK → 再送の山 |
| I | **再送の履歴が浅い** | werift `RTP_HISTORY_SIZE = 128` (4 Mbps・1200 B なら約 0.3 秒分) | RTT が大きい回線で、キーフレームの再送要求に応えられない |
| J | **baseline プロファイル** | `profile-level-id=42e01f`、`-profile:v baseline` | CABAC 等が使えず、同じ画質で high より 1〜2 割大きい |

## 2. 改善案 (段階)

評価は [decision-metrics] の 4 軸 (AI 学習量 / 作業コスト / 目的達成度 / 主目的との一致度) で付ける。主目的は「スマホ (モバイル回線) でも詰まらず遠隔プレイできること」。

### 段 0: 計測を入れる (最初にやる)

数字が無いまま変えると、効いたか分からない。

- **ブラウザ**: `RTCPeerConnection.getStats()` を 2 秒ごとに取り、`inbound-rtp` の `bytesReceived` 差分 (実効 kbps)・`framesPerSecond`・`framesDropped`・`packetsLost`・`nackCount`・`pliCount`・`jitter`・`totalDecodeTime`、`candidate-pair` の `currentRoundTripTime`・`availableIncomingBitrate` を VIEW の診断 (`rtcStatus` の詳細) に出し、WS でサーバーへ送って app ごとにログへ残す。
- **サーバー**: ffmpeg の `-progress pipe:2` で出力 fps / bitrate / dup / drop、ブリッジから実際に届いた fps、各 session の REMB 値 (段 1 で読む) を診断 API (`/api/apps/:id/rtc/diag`) に足す。
- **受け入れ**: 同じ場面で「PC 有線 / スマホ Wi-Fi / スマホ モバイル回線」の 3 条件の数字が取れる。
- 評価: 学習量 小 / 作業 小 / 達成度 (直接は改善しない) / 一致度 高 (以降の判断の前提)。

### 段 1: 帯域に合わせる (効果が最も大きい見込み)

- **1-a REMB/TWCC を読む (B)**: 各 session の sender で `onRtcp` を購読し、REMB の推定値 (TWCC を使うなら werift の送信側推定) を session ごとに持つ。
- **1-b 品質の段を 2〜3 本にする (A)**: エンコーダは 1 本の CLI では途中でビットレートを変えられないので、app ごとに「高 (例 720p 3 Mbps) / 低 (例 480p 800 kbps)」の段を必要なときだけ起動し (今の refcount をそのまま段ごとに使う)、各 session を推定帯域で段に割り当てる。段の切り替えは次のキーフレームから。観戦者が増えても段の数しかエンコードしない。
  - 代案: ffmpeg CLI をやめ、プロセス内エンコーダ (libav バインディング等) にして実行中にビットレートを変える。柔軟だが依存と保守が重い → 段 4 で再検討。
- **1-c 静止画面では送らない (E)**: ブリッジは画素が変わったときだけ送る (判定は §6.1)。ffmpeg は `-use_wallclock_as_timestamps 1` + `-fps_mode passthrough` で可変 fps にする。最低 1 fps (または 2 秒に 1 回) は送り、途中参加・損失からの回復を保つ。
- 評価: 学習量 中 / 作業 中 (サーバー TS + ブリッジ C# 少し) / 達成度 高 / 一致度 高。

### 段 2: キーフレームと損失への強さ

- **2-a GOP を伸ばし、IDR の山をなくす (C)**: x264 は `-intra-refresh 1`、NVENC は `-intra-refresh 1` (対応版) で、I ブロックを数フレームに散らす。GOP は 2〜4 秒、IDR は段の起動時と下の 2-b だけ。
- **2-b PLI で IDR を出す (D)**: CLI では外から IDR を要求できないので、PLI が来たら「その段の ffmpeg の次の出力から IDR を強制する」手段が要る。候補: (1) ffmpeg の `-force_key_frames` を短い間隔にし、PLI が無ければその IDR を捨てる…は RTP 上で捨てられないので不可。(2) 段ごとに ffmpeg を再起動する…は数百 ms 途切れる。(3) プロセス内エンコーダにする。→ **実用的なのは 2-a の intra-refresh で「待てば必ず戻る」状態にし、PLI 対応は段 4 と一緒に入れる**。
- **2-c 送出のペーシング (H)**: `writeRtp` の手前に、段のビットレートの 1.5〜2 倍で流す leaky bucket を置き、キーフレームのパケットを数十 ms に均す。
- **2-d 再送履歴 (I)**: werift の `RTP_HISTORY_SIZE` は定数なので、足りなければ sender の前に自前の履歴 (1〜2 秒分) を持って NACK に応える。段 0 の `nackCount` と損失の数字を見てから決める。
- 評価: 学習量 中〜大 (エンコーダ別の intra-refresh の挙動) / 作業 中 / 達成度 中〜高 (モバイル) / 一致度 高。

### 段 3: ブリッジとエンコーダの CPU / メモリ

- **3-a 解像度 (G)**: §5 の「解像度の設定」。偶数への丸めは小さく安い変更なので段 1 と一緒に入れてよい。
- **3-b GPU で NV12 にして送る (F)**: Unity 側で compute shader により BGRA→NV12 (1.5 B/px) に変換してから readback する。転送量が 6 割減り、ffmpeg の swscale が不要になる (`-pix_fmt nv12` 入力)。ブリッジの protocol (`/stream`) に形式の指定を足す (`?format=nv12`、既定は今の BGRA で後方互換)。
- **3-c プロファイル (J)**: ブラウザの offer に high (`640c1f` 等) があれば high を選ぶ。無ければ今の baseline。ハードエンコーダの high 対応と Safari の decode を段 0 の環境で確認してから。
  **注意**: codec の契約 (H.264 baseline / pt96 / packetization-mode=1 / MTU1200) は game-web (`tools/game-web/src/plugins/rtc`) と一致させる決まり (CLAUDE.md)。high を選ぶ交渉を入れるなら game-web 側も同じ変更単位で合わせる。
- 評価: 学習量 中 (Unity の compute / readback の Graphics API 差) / 作業 中 / 達成度 中 (主に CPU と安定性) / 一致度 中。

### 段 4: エンコーダを Custos のプロセス内に持つ (大きな変更、必要なら)

ffmpeg CLI の制約 (実行中にビットレートを変えられない、外から IDR を要求できない) が段 1〜2 で問題になったときだけ検討する。libav / NVENC SDK のバインディングを Node に入れ、段ごとのエンコーダに「ビットレート変更」「IDR 要求」を出せるようにする。依存が重く、Windows / Linux / macOS のビルドを保つ費用が大きい。

## 3. 進め方 (推奨)

1. 段 0 (計測) を入れて、3 条件の数字を取る。
2. 段 1 (1-a / 1-b / 1-c) と 3-a を 1 PR で入れる。数字で効果を確認する。
3. モバイルの損失が残るなら段 2 (2-a / 2-c、必要なら 2-d)。
4. CPU が問題なら段 3 (3-b / 3-c)。段 4 は段 1〜2 で限界が見えたときだけ。

解像度の設定 (§5) は段 1 と同じ PR に入れる (品質の段が解像度を選ぶため)。差分アプローチ (§6) は、フレーム単位のスキップ (§6.1) だけを段 1 の 1-c として採り、領域単位の差分 (§6.2 / §6.3) は採らない。

## 4. 決めてほしいこと

- 品質の段の数と目安 (例: 高 720p 3 Mbps / 低 480p 800 kbps)。主に使う端末と回線。
- 静止画面の最低送出間隔 (1 秒 / 2 秒)。
- 計測値をサーバー側のログに残してよいか (残すのは通信の統計だけで、映像・入力の中身は含めない)。
- 解像度の既定値 (720p 固定 / 窓に合わせる) と、見る側で選べる段 (§5.3)。

## 5. 解像度の設定 (2026-10-15 追記)

### 5.1 今の決まり方と問題

- 映像の大きさは **Unity の画面の大きさ** で決まる (`Screen.width/height`、Editor では Game View の窓)。上限 `maxLongEdge` (ブリッジ設定、既定 1280) を超えたときだけ縮め、小さいときはそのまま。
- そのため Editor の窓が小さいと 603×319 のような小さく奇数の映像になり、窓を動かすたびに解像度が変わる (ffmpeg は解像度が変わると作り直しになり、映像が一瞬途切れる)。
- Custos 側 (apps.json / 画面) からは解像度を指定できない。

### 5.2 案

| 案 | 内容 | 長所 | 短所 |
|---|---|---|---|
| **A. 描画解像度を固定する (推奨)** | Editor では Game View を「Custos 1280×720」などの固定解像度にする (Game View のサイズ一覧に足して選ぶ。Editor 内部 API をリフレクションで使う)。Player では `Screen.SetResolution`。ゲームは窓の大きさに関係なくその解像度で描く | 映像と UI の配置が見る側の画面と一致する。窓を動かしても変わらない | Editor 内部 API に依存する (Unity の版で壊れうる → 失敗したら今の挙動に戻す)。ブリッジが Game View の設定を変えるので、人の作業中の見た目も変わる (有効化は設定で明示) |
| B. キャプチャ側で拡大・縮小する | 描画はそのまま、readback の前に GPU で目標の大きさへ拡大縮小する | ゲームに触らない | 窓が小さいと拡大しても粗い (情報が無い)。UI の縦横比も窓次第 |
| C. ffmpeg で拡大・縮小する | `-vf scale` で目標の大きさにする | 実装が最小 | CPU が増える。小さい元は拡大しても粗い。ブリッジ→ffmpeg の転送量は減らない |

- **推奨は A**。A が使えない環境 (内部 API が無い版・Player で窓を変えられない) では B に戻す。C は使わない。
- どの案でも、幅・高さは **16 の倍数** (少なくとも偶数) に丸め、縦横比は保つ (余りは黒帯ではなく丸めで吸収)。

### 5.3 設定の持ち方

- **apps.json (app ごと)**: `video: { resolution: "1280x720", fixedRender: true }`。`resolution` は描画 (案 A) と送出の上限。`fixedRender: false` なら案 B (窓はそのまま、送出だけ揃える)。
- **品質の段 (段 1-b)**: 段ごとに解像度を持つ (例: 高 = app の `resolution`、低 = その 2/3)。縮小はブリッジの readback 前 (GPU) で行い、ffmpeg では行わない。ブリッジの `/stream` に `?maxLongEdge=<px>` を足す (既定は今のブリッジ設定。後方互換)。
- **見る側**: SETTINGS に「画質: 自動 / 高 / 低」を置き、自動は推定帯域 (段 1-a) で選ぶ。選択はブラウザに保存する (端末ごと)。
- 解像度が変わったら ffmpeg を作り直すので、変更は段の切り替え時だけにする (窓の大きさの変化では変えない = 案 A の効果)。

## 6. 差分アプローチの検討 (2026-10-15 追記)

「変わったところだけ送る」を、どの単位でやるかで 3 つに分けて検討した。

### 6.1 フレーム単位: 画面が変わらない間は送らない — **採る**

- 判定はブリッジで行う。毎フレーム全画素を比べるのは重い (1280×720×4 = 3.6 MB) ので、readback の前に GPU で縮小した小さな画像 (例 64×36) を作り、前回と比べて変わっていなければ送らない (フル解像度の readback 自体も省ける)。
  縮小画像では小さな変化 (カーソルの点滅、数字 1 桁) を見落としうるので、しきい値は「1 画素でも違えば変化」とし、加えて **最低 1 秒に 1 回は送る** (途中参加と損失からの回復のため)。
- ffmpeg は可変 fps (`-use_wallclock_as_timestamps 1` + `-fps_mode passthrough`) にする。H.264 は元々「前のフレームとの差分 (P フレーム)」で送るので、変わっていないフレームを送らないことで、エンコード・転送・CPU がほぼゼロになる。
- 効果が大きいのは メニュー・一時停止・待機画面・Edit モード。動き続けるゲーム画面では効果なし。段 0 の計測で「画素が同じだったフレームの割合」を数えて効果を見積もる。

### 6.2 領域単位 (ブリッジ → Custos のローカル転送だけ差分にする) — **採らない**

- 変わったタイルだけをブリッジから Custos へ送り、Custos で全体を組み立てて ffmpeg へ渡す方式。
- 減るのは同じ PC 内の転送 (ループバック) だけで、ネットワークに出る量は変わらない (エンコーダは結局全体を受け取る)。ローカル転送を減らすなら §段 3-b の NV12 化 (6 割減、常に効く) の方が単純で効果が確実。

### 6.3 領域単位 (映像コーデックの代わりに、変わったタイルを画像で送る: VNC 方式) — **採らない**

- 画面をタイルに分け、変わったタイルだけを PNG / WebP で DataChannel に流し、ブラウザで貼り合わせる方式。
- 文字やメニューなど **静止が多く、変化が一部の画面** には強い (くっきり、帯域も小さい)。
- 一方で 3D のゲーム画面は、カメラが少し動くだけでほぼ全タイルが変わる。動きの予測 (動き補償) が無いため、H.264 より何倍も帯域を使い、フレームも揃わない (タイルごとに届く時刻がずれる)。遠隔プレイの主な場面に合わない。
- 「静止したら高画質のタイルで上書きする」ハイブリッドも考えられるが、二つの経路の同期・表示の切り替えの費用に見合わない。テキスト主体の画面を高精細に見たい用途が出てきたら、別機能 (静止画の高解像度スナップショット、今の 📷 の延長) として扱う。

### 6.4 エンコーダへの差分ヒント — **今は採らない**

- 変わった領域をエンコーダに伝える (ROI / 強調マップ) と、その領域に多くビットを回せる。NVENC は対応するが ffmpeg CLI からはフレームごとに渡せない。段 4 (プロセス内エンコーダ) を入れる場合に一緒に検討する。

## 7. 採用した方式: Unity 側でハードウェア H.264 (2026-10-15 neco 指示「エンコードだけ Unity」「同じやつ自作して」)

「ffmpeg は要るのか、フレームバッファ直転送の方が良いのでは」に対する結論。生のフレームはネットワークに載らない
(1280x720 BGRA 30fps で約 880 Mbps) のでエンコードは必須。無駄は ffmpeg の手前 (GPU→CPU 読み戻し・生 BGRA の HTTP 転送・
CPU の色変換・ffmpeg プロセス) にあったので、エンコードを Unity の中 (GPU のそば) に移した。
`com.unity.webrtc` は非推奨 (deprecated、Unity 6000.4 で動かない報告) なので使わず、必要な部分 (ハードウェア H.264) を自作した。

### 7.1 経路

```
Unity: ScreenCapture → RenderTexture (画面の大きさ)
  └─ compute shader (Resources/CustosRgbToNv12): 配信解像度へ拡大縮小 + BT.601 NV12 (Nv12Converter.cs)
       └─ AsyncGPUReadback (NV12 = 1.5 B/px、BGRA の 6 割減)
            └─ H264StreamEncoder.cs (作業スレッド) → custos_h264.dll (native/custos-h264、Media Foundation の
               ハードウェア H.264 MFT。NVIDIA / AMD / Intel、無ければソフトウェア)
                 └─ GET /stream?codec=h264 (H264Streamer.cs): [u32 長さ][i64 時刻µs][u8 フラグ] + Annex-B
Custos: bridge-h264-stream.ts → bridge-h264-frames.ts (切り分け) → h264-rtp-packetizer.ts (RFC 6184、FU-A)
  └─ UDP → SharedRtpSourcePool (今までどおり app ごとに 1 本、全員に配る) → werift → ブラウザ
```

- ffmpeg は使わない。ブリッジが `codec=h264` を出せなければ (415: DLL が無い・エンコーダが作れない・古いブリッジ)、
  `VideoPipelineSelector` が従来の生 BGRA + ffmpeg に切り替える (`inAppBridge.video.codec: "auto"`)。
- グラフィックス API に依存しない (D3D11 / D3D12 / Vulkan で同じ経路)。GPU のテクスチャをエンコーダへ直接渡す
  (読み戻しも無くす) のは次の段 (D3D12 と D3D11 の共有が要る。ICE は Windows で D3D12 が先頭)。

### 7.2 エンコーダ (native/custos-h264)

- C API (`include/custos_h264.h`): create / encode / pop / set_bitrate / request_keyframe / destroy。
- 低遅延 (`CODECAPI_AVLowLatencyMode`)・CBR・B フレーム無し・baseline (codec 契約 `profile-level-id=42e01f`) ・
  GOP 10 秒。IDR は最初と要求時だけ (`CODECAPI_AVEncVideoForceKeyFrame`)。ビットレートは実行中に変える
  (`CODECAPI_AVEncCommonMeanBitRate`)。キーフレームには SPS/PPS を必ず付ける (途中から受けたブラウザが復号できる)。
- ハードウェア MFT は非同期 (イベント駆動)。入力はプラグインが持つ D3D11 デバイス (エンコーダと同じアダプタ) の
  NV12 テクスチャ (4 枚を巡回)。取り出しが追いつかず出力を捨てたら次を IDR にする。
- ビルド: `native/custos-h264/build.cmd` (Visual Studio 2022 Build Tools)。DLL は静的 CRT で
  `unity/com.ludiars.custos-bridge/Runtime/Plugins/x86_64/custos_h264.dll` に置く。
- 試験: `build/Release/custos_h264_test.exe` (合成フレーム 90 枚。最初が SPS/PPS/IDR のキーフレーム、要求時だけ
  キーフレーム、ビットレート変更が通る)。2026-10-15 に RTX 2070 (NVIDIA H.264 Encoder MFT) で PASS。

### 7.3 帯域とキーフレーム (段 1・段 2 の代わり)

- ブラウザの REMB (werift の `sender.receiverEstimatedMaxBitrate`) を 1 秒ごとに読み、見ている全員の最小値を
  `minBitrate`〜`maxBitrate` に収めてブリッジへ `POST /stream/bitrate` (下げはすぐ、上げは 4 秒続いてから、15% 未満は変えない。
  `video-feedback-policy.ts`)。
- ブラウザの PLI と途中参加で `POST /stream/keyframe` (500ms に 1 回まで)。GOP が長いので、途中参加は必ず要求する。
- 画面が変わらない間はエンコードしない (`StaticFrameGate`、最低 1 秒に 1 枚)。§6.1 の採用分。

### 7.4 解像度 (§5 の採用分)

- 配信解像度は `inAppBridge.video.width/height` (既定 1280x720) の枠に縦横比を保って収め、16 の倍数にそろえる
  (`StreamResolution`)。Game View の窓が小さくても拡大するので、窓の大きさで解像度が変わらない。
- 描画解像度そのものを固定する案 A (Game View のサイズ変更) は入れていない (Editor 内部 API への依存を避けた)。

### 7.5 設定 (apps.json `inAppBridge.video`)

| 項目 | 既定 | 意味 |
|---|---|---|
| `codec` | `auto` | `auto` = H.264 を試し、だめなら BGRA + ffmpeg。`h264` = H.264 だけ。`rawvideo` = 従来どおり |
| `width` / `height` | 1280 / 720 | 配信解像度の上限の枠 |
| `bitrate` | 3,000,000 | 開始のビットレート |
| `minBitrate` / `maxBitrate` | 300,000 / 6,000,000 | 帯域推定で動かす範囲 |

### 7.6 計測 (段 0 の採用分)

- ブラウザの `getStats()` を 2 秒ごとに読み、VIEW の状態表示に `video: live · 2.1 Mbps · 30fps · loss 0.2% · rtt 45ms · 1280x672`
  を出す (`public/js/rtc-stats-logic.js`)。サーバー側にログは残さない。

### 7.7 未確認・次の段

- Unity での実動作 (Editor の Play 中の配信、D3D12 での compute shader と readback、色と上下の向き) は未確認。
  Unity の EditMode テスト (`StreamResolutionTests` / `StaticFrameGateTests`) はコンパイルまで確認済みで未実行。
- Edit モード中の配信は今までどおり未対応 (Play 中だけ)。
- 次の段: GPU テクスチャを直接エンコーダへ (読み戻し無し)、品質の段 (simulcast 的に 2 本)、描画解像度の固定 (案 A)。
