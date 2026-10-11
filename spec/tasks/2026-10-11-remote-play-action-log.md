---
task: remote-play-action-log
project: Cs
kind: feature
created: 2026-10-11
memory_links: []
---

# Unity 遠隔プレイと行動ログ

neco 指示 (2026-10-11): Custos の需要が出てきたのでメンテする。Unity のゲームを遠隔プレイできるようにし、
ついでに行動ログを保存してオートプレイヤー (Commentarii) の行動の参考にする。

設計: `spec/feature/remote-play-and-play-log.md`

- [x] Unity ブリッジ: `/pointer` (仮想 Mouse 注入) と `/state` (`CustosPlayState`)
- [x] Custos: WS `pointer` メッセージ、forwarder `sendPointer`、ブリッジ client
- [x] フロント: 遠隔プレイトグル、映像上のポインタ、物理キーボード
- [x] 行動ログ: recorder / writer / state poller / player hash、app 設定 `playLog`
- [x] 行動ログ API: 一覧と取得
- [x] テスト (vitest 実行済み)、README / CLAUDE.md 更新
- [ ] Unity EditMode テスト (`Tests/PointerAndPlayStateTests.cs`) の実行と、実ゲームでの遠隔プレイ確認 (Custos で人が確認)
