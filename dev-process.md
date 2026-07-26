# Dev process marker

このファイルがあると Excubitor / AI agent が Custos を background 起動できる。
catalog の `runtime: dev-process-md` はこのファイルを読む。無いと
`ENOENT: dev-process.md` で起動そのものが失敗する。

Custos は **単一 Hono アプリを 2 ポートで listen** する (`src/main.ts`):

- backend  `http://127.0.0.1:7676/`  (`CUSTOS_PORT`)
- frontend `http://127.0.0.1:4649/`  (`CUSTOS_FRONTEND_PORT`)

どちらを開いても同じ内容が出る。health は **`/api/health`** (`/health` ではない)。
既定は loopback bind。Custos は任意コマンド実行・キー/マウス注入・画面取得ができるため、
無認証で LAN へ晒すと第三者が全操作可能になる (CWE-668)。公開する場合は
`CUSTOS_HOST` を変える前に認証を必ず有効にすること。

`CUSTOS_OPEN=1` で認証を素通しする (開発用)。

## Custos managed processes

```concordia.processes
{
  "processes": [
    {
      "name": "custos-server",
      "command": "npm run serve",
      "auto_start": false
    }
  ]
}
```
