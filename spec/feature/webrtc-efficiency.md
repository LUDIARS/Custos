# WebRTC 転送効率の最適化 (設計案)

- 作成日: 2026-10-15 (neco 指示「今すぐじゃなくて良いんだけど、WebRTC の転送効率が悪いので最適化案を設計する」)
- 状態: **設計案**。実装は人間の開始指示を受けてから。段 0 (計測) を最初に入れ、数字を見て段 1 以降の採否を決める。
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
| E | **静止画面でも固定 fps で同じフレームを送る** | `FrameStreamer.cs` の送出ループは最新フレームを fps ペースで送り続ける | 変化の無い間もエンコード・転送が走る (P フレームは小さいが、CPU と RTP ヘッダ分は常に払う) |
| F | **ブリッジ→ffmpeg が生 BGRA (4 B/px)**、色変換が CPU | `-pix_fmt bgra` 入力 + `-pix_fmt yuv420p` | ハードエンコーダでも swscale が CPU で走る。ループバックで数十 MB/s |
| G | **奇数の解像度** (例 603×319) | `/stream started: 603x319` (Editor.log)。長辺上限で縮めた結果 | yuv420p は偶数が要る。エンコーダ側の端処理・パディングで無駄、環境によっては失敗 |
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
- **1-c 静止画面では送らない (E)**: ブリッジは Unity のフレームが更新されたときだけ送る (同じフレームは送らない)。ffmpeg は `-use_wallclock_as_timestamps 1` + `-fps_mode passthrough` で可変 fps にする。最低 1 fps (または 2 秒に 1 回) は送り、途中参加・損失からの回復を保つ。
- 評価: 学習量 中 / 作業 中 (サーバー TS + ブリッジ C# 少し) / 達成度 高 / 一致度 高。

### 段 2: キーフレームと損失への強さ

- **2-a GOP を伸ばし、IDR の山をなくす (C)**: x264 は `-intra-refresh 1`、NVENC は `-intra-refresh 1` (対応版) で、I ブロックを数フレームに散らす。GOP は 2〜4 秒、IDR は段の起動時と下の 2-b だけ。
- **2-b PLI で IDR を出す (D)**: CLI では外から IDR を要求できないので、PLI が来たら「その段の ffmpeg の次の出力から IDR を強制する」手段が要る。候補: (1) ffmpeg の `-force_key_frames` を短い間隔にし、PLI が無ければその IDR を捨てる…は RTP 上で捨てられないので不可。(2) 段ごとに ffmpeg を再起動する…は数百 ms 途切れる。(3) プロセス内エンコーダにする。→ **実用的なのは 2-a の intra-refresh で「待てば必ず戻る」状態にし、PLI 対応は段 4 と一緒に入れる**。
- **2-c 送出のペーシング (H)**: `writeRtp` の手前に、段のビットレートの 1.5〜2 倍で流す leaky bucket を置き、キーフレームのパケットを数十 ms に均す。
- **2-d 再送履歴 (I)**: werift の `RTP_HISTORY_SIZE` は定数なので、足りなければ sender の前に自前の履歴 (1〜2 秒分) を持って NACK に応える。段 0 の `nackCount` と損失の数字を見てから決める。
- 評価: 学習量 中〜大 (エンコーダ別の intra-refresh の挙動) / 作業 中 / 達成度 中〜高 (モバイル) / 一致度 高。

### 段 3: ブリッジとエンコーダの CPU / メモリ

- **3-a 偶数の解像度 (G)**: ブリッジで幅・高さを偶数 (できれば 16 の倍数) に丸める。小さく安い変更なので段 1 と一緒に入れてよい。
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

## 4. 決めてほしいこと

- 品質の段の数と目安 (例: 高 720p 3 Mbps / 低 480p 800 kbps)。主に使う端末と回線。
- 静止画面の最低送出間隔 (1 秒 / 2 秒)。
- 計測値をサーバー側のログに残してよいか (残すのは通信の統計だけで、映像・入力の中身は含めない)。
