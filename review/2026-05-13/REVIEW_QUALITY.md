# REVIEW_QUALITY — Custos (2026-05-13)

## 評価: B

## 1. テスト

- 8 本のテスト: `auth.test.ts`, `config.test.ts`, `h264.test.ts`, `registry.test.ts`, `runner-resolve.test.ts`, `scale.test.ts`, `screenshot-stream.test.ts`, `stream-prefs.test.ts`。
- 重要 path (config zod / registry lifecycle / bare exe 解決 / NAL parser / scale / stream prefs / screenshot streamer) は最低限カバー。
- 未カバー: REVIEW_MISSING §6 参照。 ws/webrtc/forwarder/android/ffmpeg は invariant の手動確認頼み。

## 2. TypeScript ルール準拠

- `any` 直接使用は無し (CLAUDE.md ルール準拠)。
- ただし `src/capture/webrtc-broker.ts:48-79` の `WeriftLike` 系自前型 + `unknown as XLike` cast は、 実質型なし。 ルールには違反していないが「型をちゃんと持つ」精神には届いていない。
- zod schema → `z.infer` の型引きは `apps-config.ts`, `stream-prefs.ts` で実施。 外部入力境界の型付け規律あり。

## 3. コーディングスタイル

- JSDoc / inline 日本語コメントが豊富で意図が追いやすい。 特に webrtc-broker.ts と ffmpeg-pipeline.ts のヘッダコメントは設計判断の理由まで書いてある (例: Annex-B 経路廃止の経緯)。
- 一方で `src/main.ts:96` の `console.log` (eslint-disable comment 付き) は意図的なバナーだが pino 経由に統一しても良い。

## 4. エラー処理

- try/catch + log warn + ignore のパターンが多い (`src/capture/webrtc-broker.ts:268-272`, `src/apps/runner.ts:88-99` 等)。 致命傷でないリソース cleanup では妥当。
- `proc.on("error")` → emit("error") + emit("log", stderr) の二段 dispatch (`src/apps/runner.ts:194-197`) は WS への通知も担保しており丁寧。

## 5. ログ / 観測性

- pino-based、 `childLogger("ws"|"runner"|...)` で分離されている (`src/shared/logger.ts`)。
- 配信 frame サイズや RTP packet 数を診断 history に保持する設計は ops に親切。
- 不足: user id (Cernere) / appId 単位のメトリクス (CPU / fps / failures) は未収集。 LUDIARS の Excubitor (`project_excubitor.md`) と連携する余地。

## 6. 依存ライブラリ

- `hono`, `ws`, `werift`, `zod`, `pino`, `@hono/node-server` — 適切。
- `@nut-tree-fork/nut-js` を **optional dep に逃がす** 構造は良い (依存解決失敗で `npm install` が壊れない)。
- `electron` は devDependency。 production deploy 想定なら別パッケージング戦略が必要。

## 7. ビルド / 配信

- `tsc -p tsconfig.json` + `tsx` dev は標準的。
- `cross-env` で Windows / *nix 両対応の npm script。 メモの `dev-process.md` に従えば `npm run dev` 既定で OK。
- TS の `noEmit` 系設定は確認していないが、 dist が `.gitignore` 管理かどうかは要確認 (`dist/` ディレクトリが git tree に居る場合は除去推奨)。

## 8. ドキュメント

- README.md は機能・API・env を網羅、 example も豊富。 親切。
- CLAUDE.md は開発ルールと Phase 計画を明示。 LUDIARS の他リポと体裁が揃っており、 メンバ参加コストが低い。
- 不足: トラブルシュート章 (ffmpeg 不在時 / nut-js が node 22 で build 失敗時 / Cernere ローカル無し時) は README に転記するとサポート工数が減る。

## 9. 累積判定

良いコメント密度・テスト基本セット・依存縮退設計で「読みやすく壊れにくい」コードベース。 ただし WebRTC / ws / forwarder の単体テストが薄く、 werift 型回避が技術的負債として残っている。 セキュリティ章 (V1〜V8) の対応が入れば全体 A 評価に届く。
