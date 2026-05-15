# REVIEW_IMPLEMENTATION — Custos (2026-05-13)

## 評価: B

## 1. 良い実装

- **Windows プロセス kill** (`src/apps/runner.ts:77-99`) — `taskkill /T /F` で子孫プロセス含めて殺すパスを優先、 失敗時 `proc.kill("SIGKILL")` にフォールバック。 `active.killed` flag で signal 不在の Windows でも "killed" / "crashed" を区別。
- **bare exe の cwd 解決** (`src/apps/runner.ts:236-241`) — `adventurecube.exe` のような bare filename + cwd 構成を shell に頼らず spawn:false でも動かす resolver。 git log の `f4ef018 fix(runner): direct exe spawn` の修正点が綺麗にユニット化されており、 `tests/runner-resolve.test.ts` でカバー。
- **ffmpeg encoder auto-probe** (`src/capture/ffmpeg-pipeline.ts:38-102`) — `-encoders` listing だけでなく **実 encode を試して通った encoder を採用**。 NVIDIA driver の API mismatch 等を検出できる設計判断は良い。
- **werift RTP 経路** (`src/capture/webrtc-broker.ts` 全体) — Annex-B 直接書き込みを諦め、 ffmpeg `-f rtp` + UDP listener + `track.writeRtp` の三段で werift 0.22 packetizer の不在を回避。 feedback_werift_h264_rtp.md のメモがそのまま実装に反映されている。
- **uncaughtException safety net** (`src/main.ts:33-46`) — `started` flag で起動前は fail-fast、 起動後は継続。 Windows + npm script 想定で実用的。
- **subprocess の stdout line splitter** (`src/apps/runner.ts:204-215`) — partial buffer を持って `\r?\n` 跨ぎを救う。 ffmpeg 系の長行に強い。

## 2. 気になる実装

- **werift 型回避** (`src/capture/webrtc-broker.ts:48-79`) — `WeriftLike` / `PCLike` / `RTCRtpCodecParametersLike` を自前 interface で書き、 `unknown as XLike` で cast する。 CLAUDE.md の TS ルール「`any` 禁止 / `unknown` か具体型」に名目上は従うが、 実質的には型なし。 werift の type 安定性が低い時期はやむを得ないが、 上流 0.23 以降を見て見直したい。
- **PeerConnection event 購読の二重化** (`src/capture/webrtc-broker.ts:217-239`) — `pc.on("connectionstatechange", ...)` と `subscribe("connectionStateChange", ...)` の両方が走り、 同じ遷移が `pcStates` に二度入る (cf. line 209-210 と 235-238)。 診断 noise が出る。 どちらか一方に統一推奨。
- **`waitForIceGatheringComplete` の polling** (`src/capture/webrtc-broker.ts:356-375`) — 50ms tick で SDP に `a=end-of-candidates` が含まれるかをポーリング。 werift にイベントがある場合は subscribe で書き換える方が綺麗。 5000ms timeout はあるので fail-safe は OK。
- **token を `?token=` で受ける** (`src/ws/handler.ts:206-211`) — クエリ string は server log / browser history に乗りやすく、 leak リスクが高い。 既存実装の理由 (`note: ブラウザ WS が Authorization ヘッダを付けにくい`) は妥当だが、 sec-websocket-protocol header subprotocol に乗せる方が今風。
- **stream-prefs の Hot-reload で `setInterval` 貼り替え** (`src/capture/screenshot-stream.ts:64-76`) — 全 app の timer を一斉に reset。 同時に走っている inflight tick は continue するため、 古い interval で残発火することは無いが、 race condition で frame の二重発火が極短時間起きる可能性は残る。 実害は無い。
- **electron 子プロセスの環境変数継承** (`electron/main.cjs:30-39`) — `shell: process.platform === "win32"` の判断は AppData の `npx` 解決のためだが、 V4 と組合せて将来 `cmd` を編集できる仕組みが入ると shell injection 経路になる。 今は npx 固定なので問題なし。

## 3. パフォーマンス / 安定性

- **ScreenshotStreamer** (`src/capture/screenshot-stream.ts:156-178`) — inflight guard で overlap 防止、 失敗は debug log で timer 継続。 1 fps スナップショット運用は十分実用的。 ただし WS の `screenshot` メッセージは base64 PNG を毎フレーム流すので、 接続 N 件 × FPS × frame size の帯域消費が線形に増える。 binary frame 直送 (WS の opcode binary) に移行する余地。
- **timeout は SIGKILL 直撃** (`src/apps/runner.ts:162-167`) — 子孫まで kill しない。 Windows の build timeout で残骸が残る潜在。 `kill()` メソッドと統一して taskkill /T /F を通すべき。
- **ffmpeg pipeline の `stderr` matcher** (`src/capture/ffmpeg-pipeline.ts:204-211`) — `/error|Error|failed|Could not/i` は false positive を多く生む (gdigrab は info で "Could not open ..." を吐くことがある)。 起動初期 5 秒は emit を抑える等の hysteresis があってもよい。

## 4. デバッグ / 観測

- WebRTC 診断は `diagHistory` で過去 10 セッション保持 (`src/capture/webrtc-broker.ts:41-46`)、 `/api/apps/_/rtc/diagnostic` で読める。 復旧時に便利。
- ScreenshotStreamer の `snapshot()` も用意済 (`src/capture/screenshot-stream.ts:147-154`)。
- pino-pretty が dependencies に入っているが、 `src/shared/logger.ts` 経由でしか使わない設計は妥当。
