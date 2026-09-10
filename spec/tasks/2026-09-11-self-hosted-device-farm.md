---
task: self-hosted-device-farm
project: Cs
kind: 実装
created: 2026-09-11
memory_links: []
---

# 自前の実機デバイスファーム

neco の依頼: Custos から所有する Android / iOS 実機をプールとして共有し、遠隔テストを割り当てる。外部クラウドサービスの利用は今回の対象に含めない。

## 最初の実装単位

端末と接続ホストの設定、認証されたホスト報告、永続化された期限付き排他リース、所有者による更新・解放、後片付け確認を提供する。仕様は `spec/feature/device-farm.md`。

受け入れ条件:

- 同一実機の二重登録と二重確保を拒否する。
- Android / iOS の端末を同じ API から機種・OS・ホスト別に確認できる。
- 端末切断、報告途絶、期限切れ、利用者による解放の後は、古い入力を停止して後片付けしたというホストの世代付き確認があるまで貸し出さない。
- 再起動後もリースが保持される。破損した永続状態を空の状態へ置き換えない。
- 他利用者の更新・解放と、他ホストの端末報告を拒否する。
- 永続化失敗時に成功応答を返さない。

## 後続の実装単位

1. Windows / Mac のホストワーカー: 端末検出、定期報告、世代と期限の検証、実入力・プロセス停止、後片付け。Android は serial、iOS は UDID で対象を固定する。
2. テストジョブ: 成果物の投入、端末条件の指定、待ち行列、並列割当、キャンセル、実行単位の成否保存。
3. 遠隔手動操作: ジョブと共通のリースを利用する画面表示・タッチ入力。既存の直接入力 API とファーム端末を二重管理しない。
4. 証跡: 実行・端末・ビルドに紐づく動画、スクリーンショット、ログ、保存期間。
5. 実機受け入れ: 所有する Android / iOS 各 1 台で投入から回収・後片付けまでを通す。ホスト所在、機種、認証情報は運用環境で設定する。

## 調査根拠

- ベース revision: Custos `d33b6b334da9c816a5c4d624e50b6f0cc55214c4`。
- `src/config/apps-config.ts` は desktop/android、`src/input/android.ts` は ADB 入力を扱う。端末プール・リース・iOS 実行は既存コードにない。
- Anatomia `plan --project custos --no-llm` は既存の対応ドメインを決定できず、`context --project custos` は app-orchestration / identity-access / http-api などを返した。現行ソースと照合し、新しい device-farm ドメインで分離する。
- Praeforma の `/api/projects` には Custos 登録なし。既存の Pf 仕様 ID は取得できないため、この仕様をリポジトリ内正本とする。
- Cc taskflow 一覧と repo 内検索では本件の既存 task を確認できなかった。Memoria への独自重複登録は行わず、taskflow reconciler の登録経路を使う。
- Genius CLI は設定を解決できなかったため、現行のコード規約と永続状態・排他の要件から設計する。
