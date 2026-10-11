# 遠隔プレイ (ポインタ / 物理キー) と行動ログ

- 作成日: 2026-10-11 (neco 指示「Unity のゲームを遠隔プレイできるようにする。ついでに行動ログを保存し、オートプレイヤーの参考にする」)
- 依頼文: `spec/tasks/2026-10-11-remote-play-action-log.md`
- 関連: `spec/feature/unity-bridge.md` (ブリッジ protocol)、Commentarii `spec/feature/human-plays.md` (人間プレイログ取り込み)

## 0. 現状と不足

| 既にあるもの | 不足 |
|---|---|
| Unity ブリッジ `/stream` → WebRTC で画面配信 | 配信画面の上でマウス / タッチ操作できない (ブリッジに pointer 入口が無い) |
| `/key` で仮想キーボード注入、画面下の仮想ボタン | ブラウザの物理キーボードがゲームに届かない (仮想ボタンだけ) |
| WS で key / click を受けて forwarder に渡す | 操作が記録に残らない |

## 1. 遠隔プレイ

### 1.1 ブリッジ protocol の追加 (後方互換、既存 endpoint は不変)

| Method | Path | Request | Response |
|---|---|---|---|
| POST | `/pointer` | `{ "x": 0..1, "y": 0..1, "button": 0\|1\|2, "phase": "down"\|"up"\|"move" }` | `200 {"ok":true}` (fire-and-forget) |
| GET | `/state` | - | `200 {"isPlaying": bool, "state": <object\|null>}` |

- `x` / `y` は **画面左上原点の正規化座標** (配信映像の比率)。ブリッジ側で `Screen.width/height` を掛け、Input System の左下原点に反転する。
  解像度を知らなくても送れ、配信の縮小 (`maxLongEdge`) と独立する。
- `/pointer` は専用の仮想 `Mouse` デバイス (`VirtualPointerInjector`) に `MouseState` のフルステートを queue する (キーボードと同じ方式)。
  タッチ専用 UI は Input System の Mouse→Pointer で `Pointer.current` 経由に届く。uGUI の `InputSystemUIInputModule` も Mouse を拾う。
- `/state` はゲーム側が `CustosPlayState.Register(Func<string> json)` で登録した JSON (1 オブジェクト) を main thread で取って返す。
  未登録・例外時は `state: null`。ブリッジはゲームの中身を知らない (ゲーム固有の観測はゲームが決める)。
- 対応しない ergo ブリッジは 404 を返す。Custos 側は 404 を「未対応」として黙って扱う (warn は 1 回だけ)。

### 1.2 Custos (TS)

- WS `ClientMessage` に `pointer { appId, x, y, button, phase }` を追加 (`src/shared/types.ts` と `public/js/app.js` を同時更新)。
- `sendPointer(app, …)` (`src/input/forwarder.ts`): `allowMouse` が false なら破棄。`inAppBridge` があれば `/pointer` へ。
  ブリッジ無しの desktop は `phase:"down"` のときだけ従来の nut-js click (ウィンドウ座標は不明なので未対応扱いで warn)。
- 正規化座標は 0..1 に clamp、`phase` / `button` は zod で検証してから転送。

### 1.3 フロントエンド

- 「遠隔プレイ」トグル (ストリーム表示部)。ON の間:
  - 映像 (`<video>` / snapshot `<img>`) 上の pointerdown / pointermove / pointerup を正規化座標で送る。
    `object-fit: contain` のレターボックスを除いた映像矩形で割る (`public/js/play-input.js` の純関数、vitest 対象)。
    move は押下中・非押下中とも 30Hz に間引く。contextmenu は抑止。
  - 映像にフォーカスがある間の keydown / keyup を `KeyboardEvent.code` → Custos のキー名 (`KEY_TABLE` 名) に変換して送る。
    auto-repeat は捨てる。未対応キーは送らない。フォーカスが外れたら押下中のキーを全て up で送る (押しっぱなし事故防止)。
- `allowMouse` / `allowKeyboard` が false の app はトグル時にその旨を表示し、その種別は送らない。

## 2. 行動ログ (play log)

### 2.1 目的と方針

- オートプレイヤー (Commentarii) が `guide import plays` でそのまま読める **1 行 1 イベントの JSONL** を Custos が書く。
- 列は全てトップレベルのキー (Commentarii の mapping は列名で引く)。ゲームの状態は `state.<key>` という **ドット入りのキー名** に平らに展開する
  (例: `state.stage`, `state.pos`, `state.hp`)。構造値 (位置配列・エンティティ配列) は値のまま置く。
- 生のユーザー識別子は書かない。`player` は HMAC-SHA256(Custos の salt, ユーザー ID) の先頭 16 桁。salt は `CUSTOS_PLAYLOG_SALT`、
  無ければ `<playlog dir>/.salt` を初回に乱数生成して使い回す。Commentarii は取り込み時に自分の salt でもう一度ハッシュする。

### 2.2 有効化

app 設定に任意の `playLog` を追加。無ければ記録しない。

```jsonc
"playLog": {
  "enabled": true,
  "statePollMs": 500,      // /state の取得間隔 (100..10000)。inAppBridge が無い app は state 列なし
  "idleStopSec": 300       // 入力も状態変化も無い時間がこれを超えたら記録を閉じる
}
```

### 2.3 記録の単位 (run)

- 1 run = (app, WS セッション) の連続した操作。最初の入力 (key / pointer / button) で開く。
- 閉じる契機: unsubscribe、WS 切断、`idleStopSec` 超過、app の run プロセス終了 (`exit`)、Custos 停止。
- 置き場所: `<CUSTOS_PLAYLOG_DIR (既定 logs/plays)>/<appId>/<run>.jsonl`。`run` = `YYYYMMDD-HHmmss-<6 桁乱数>`。

### 2.4 行の形

全行共通:

| 列 | 型 | 意味 |
|---|---|---|
| `run` | string | run ID |
| `player` | string | ハッシュ済みプレイヤー |
| `app` | string | appId |
| `seq` | int | run 内で 0 から狭義単調増加 (Commentarii の `tick`) |
| `t_ms` | int | run 開始からのミリ秒 (Commentarii の `t`, scale 0.001) |
| `at` | string | ISO 8601 時刻 (先頭行を `started_at` に使える) |
| `kind` | string | `start` / `input` / `state` / `end` |
| `state.<key>` | any | 直近に取得したゲーム状態 (全行に最新値を載せる。未取得なら列なし) |

`kind` ごとの追加列:

| kind | 列 |
|---|---|
| `start` | `source` (`ws`) |
| `input` | `input` (操作名、下記)、`device` (`key`/`pointer`/`button`)、`key`、`down`、`x`、`y`、`button`、`phase`、`pos` (`[x, y, 0]`、pointer のみ) |
| `state` | なし (状態が前回と変わったときだけ出す。変化検出は JSON 文字列比較) |
| `end` | `reason` (`unsubscribe`/`disconnect`/`idle`/`exit`/`shutdown`) |

`input` 列は Commentarii の `action.verbs` に書きやすい粒度にする:

- キー押下 `key:<名前>` (例 `key:Space`)。離す行は `key:<名前>:up`。
- ポインタ押下 `pointer:<left|right|middle>`、離す `pointer:<…>:up`、移動 `pointer:move` (押下中のみ記録、10Hz に間引く)。
- 仮想ボタン `button:<id>`。

### 2.5 取得 API

| Method | Path | 説明 |
|---|---|---|
| GET | `/api/playlogs?appId=` | run 一覧 (`appId`, `run`, `bytes`, `updatedAt`、新しい順) |
| GET | `/api/playlogs/:appId/:run` | JSONL 本体 (`application/x-ndjson`) |

パス要素は `^[a-z0-9-]+$` / `^\d{8}-\d{6}-[a-z0-9]{6}$` で検証し、ディレクトリ外を読まない。

### 2.6 Commentarii 側の mapping 例

```jsonc
{
  "player": { "column": "player" }, "run": { "column": "run" },
  "tick": { "column": "seq" }, "t": { "column": "t_ms", "scale": 0.001 },
  "started_at": { "column": "at" },
  "stage": { "column": "state.stage" },
  "self": { "pos": "state.pos" },
  "action": { "column": "input", "verbs": { "key:Space": { "verb": "use_skill", "operand": "…" } } }
}
```

`state.stage` はゲームが `/state` に入れない限り存在しない。入れていないゲームのログは Custos 上の操作記録としてだけ使える。

## 3. 構成 (SRP)

| ファイル | 責務 |
|---|---|
| `src/playlog/playlog-row.ts` | 行の型と組み立て (純関数) |
| `src/playlog/playlog-writer.ts` | 1 run のファイル追記 |
| `src/playlog/playlog-recorder.ts` | run の開閉・seq/t 採番・idle 判定・状態の差分 |
| `src/playlog/state-poller.ts` | `/state` の周期取得 (refcount) |
| `src/playlog/player-hash.ts` | salt 解決と HMAC |
| `src/routes/playlog-routes.ts` | 一覧 / 取得 API |
| `src/capture/ergo-custos-client.ts` | `sendPointer` / `fetchState` を追加 |
| `public/js/play-input.js` | 座標正規化・キー名変換の純関数 |
| Unity `Runtime/Input/VirtualPointerInjector.cs` | 仮想 Mouse への注入 |
| Unity `Runtime/Protocol/PointerPayload.cs` | `/pointer` DTO |
| Unity `Runtime/CustosPlayState.cs` | ゲームが状態を登録する入口 |

## 4. 受け入れ条件

1. Unity ブリッジ経由の app で、配信画面のクリック / ドラッグと物理キーがゲームに届く (ブリッジの `/pointer` `/key` に正しい値が来る)。
2. `playLog.enabled` の app を操作すると `logs/plays/<appId>/<run>.jsonl` に上記形式の行が出て、切断で `end` 行が付く。
3. 生のユーザー ID がログに出ない。
4. vitest: 座標正規化・キー名変換・行組み立て・recorder (開閉・seq・idle・状態差分)・API のパス検証。Unity: HidKeyMap と同様に pointer 座標変換を EditMode テスト。
5. `npm run build` / `npm test` が通る。
