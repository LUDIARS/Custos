# Custos レビュー (2026-05-13)

| 観点 | 評価 | 主要所見 |
|----|----|----|
| 設計 (DESIGN) | B | 副作用集約・state single-source・dual-port 同 origin は明快。 ergo_custos / nut-js / adb の三系統が forwarder で分岐する境界はやや太い |
| セキュリティ (VULN) | C | 既定が **anonymous + 0.0.0.0 bind + Cernere verify は stub に近い**。 LAN 越し遠隔操作前提のサービスとしては境界が緩い |
| 実装 (IMPL) | B | Hono + ws + werift の接続は手堅く、 ffmpeg encoder 自動 probe / Windows taskkill / Annex-B → RTP の落とし穴回避は熟れている |
| 未実装 (MISSING) | B | README にある「Cernere 認証 / Android target」は scaffold まで。 入力フォワーダの button kill 経路は仕様コメントで noop |
| 品質 (QUALITY) | B | 既存テスト 8 本、 zod 入口検証あり。 ただし WebRTC / forwarder / android は単体テスト未投入、 `any` 風の `unknown as XLike` cast が webrtc-broker に残る |

**weighted score: 70 / 100** (DESIGN 30%, VULN 30%, IMPL 20%, MISSING 10%, QUALITY 10%)

総合: 「単一ホストで自分用に開発機を走らせる」段階としては十分機能する MVP だが、 README に書いている "遠隔" + "Android" + "Cernere" の Phase 2 の核は **認証だけスケルトンで止まっている**。 LAN/Tailnet で公開する前に anonymous 既定を反転、 token verify を本物に差し替え、 spawn の cmd 検証を入れる必要がある。

詳細は同フォルダの REVIEW_DESIGN.md / REVIEW_VULNERABILITY.md / REVIEW_IMPLEMENTATION.md / REVIEW_MISSING_FEATURES.md / REVIEW_QUALITY.md を参照。
