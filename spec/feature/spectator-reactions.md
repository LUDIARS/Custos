# 観戦メッセージ・スタンプ

人間の依頼: neco、2026-10-17。対象: Custos の VIEW と WebSocket broker。

## 受入条件

- 既存の操作権判定による観戦モードで、メッセージ（最大280文字）および
  Good 👍 / Bad 👎 / ハート ❤️ / 拍手 👏 / クラッカー 🎉 / 悲しい 😢 / 笑い 😂 を送れる。
- 同じアプリを購読するプレイ側・観戦側の全員へ、送信者自身を含め配信する。
- メッセージは Custos 操作 UI とゲーム表示を避けた周辺の表示帯に約5秒重ねて表示して消える。
  スタンプは映像上の下端から上へ移動して約5秒で消える。オーバーレイは入力を奪わない。
- 両側の「観戦ログ」から専用ウインドウを開き、時刻・投稿者・メッセージ／スタンプを読み返せる。
- 履歴はアプリ別に直近200件をサーバープロセスのメモリに保持する。再起動で消える。
  後からログを開いても、再接続しても履歴を取得できる。過去履歴の取得では画面演出を再生しない。
- 接続が切れたときは送信不可と明示する。アプリ切替時は旧購読と旧演出を解除する。

## 配信契約

| 方向 | type | 内容 |
|---|---|---|
| client → server | `subscribe` | 既存の映像／実行ログ購読。同じ appId の観戦購読と履歴も追加する |
| client → server | `audience-subscribe` | appId の観戦履歴／投稿だけを購読。ログウインドウでは映像取得や入力を開始しない |
| client → server | `audience-send` | appId と `kind:message,text` または `kind:stamp,stamp` |
| server → client | `audience-history` | appId, events（時系列、最大200件） |
| server → client | `audience-event` | appId, event（id, appId, ts, sender と本文／stamp） |

認証は既存の Cernere WS 検証を再利用。サーバーは登録済みアプリの購読を必須とし、
zod で形式・文字数・スタンプを検証する。投稿者・時刻・ID はサーバーが付与し、
生のアカウント ID を配信しない。1接続につき750ms以内の連投を拒否する。
クライアントは textContent のみで投稿を描画し、HTML として解釈しない。
履歴と投稿の配信元はプロセス内で1つを共有し、2つの待受ポートをまたいでも同じ内容を見られる。
既存 `comment` 投稿も同じ履歴へ取り込み、従来の行動ログ記録を維持する。

## 実装対応

- `src/audience/room.ts`: 投稿契約とアプリ別履歴。
- `src/ws/handler.ts`: 認証済み購読・投稿検証・同一アプリへの配信。
- `public/js/audience-panel.js`: 観戦送信 UI とログ起動。
- `public/js/audience-overlay.js`: 上限付き一時表示とタイマー解放。
- `public/js/audience-log.js`: 独立した観戦専用接続と履歴表示。
- `public/css/audience.css`: 画面周囲の専用帯、上昇／消去、狭い画面と動きを抑える設定。

## 調査・検証の範囲

当初の基点はローカル main `3d27a2c`。最新取得後、GitHub main `c5c7b62` の21コミットを
作業ブランチに統合し、新しいフローティング画面・操作権・観戦パネルへ配線を合わせた。
既存仕様 `remote-play-and-play-log.md` と `src/ws/handler.ts` / `public/js/play-input.js` /
`public/index.html` を照合。既存の行動ログの列や Unity ブリッジ契約は変更しない。
Anatomia 登録名は `custos`。context で既存 `capture-evidence` / `http-api` /
`identity-access` ドメインと `onAppChange` / `wsSend` の実装箇所を確認した。
この機能は映像の観戦を支える支援機能であり、既存アプリ実行管理の責務を変更しない。
Praeforma の Custos (`01M3FVMFAGZXJ6BBC8QQP7NE1T`, UX goal revision 1) は確認できたが、
spec 一覧は0件だったため、承認済み仕様IDは未登録。上記のユーザー依頼とリポジトリ内仕様を用いた。
ビルド結果は提出記録で明示する。
テストコードは審査用に追加し、このセッションでは人間から実行指示を受けていないため実行しない。
