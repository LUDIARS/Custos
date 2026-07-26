#!/usr/bin/env node
/**
 * `unityctl` — Unity ブリッジを叩く CLI。LLM (Claude Code / Codex) と人が
 * 同じ口で Unity のコンパイル・状態・ログを扱えるようにする。
 *
 *   npm run unityctl -- status
 *   npm run unityctl -- compile --wait
 *   npm run unityctl -- errors            # エラーがあれば exit 1
 *   npm run unityctl -- log --since 0 --level error --limit 50
 *   npm run unityctl -- play / stop
 *   npm run unityctl -- scene / hierarchy --depth 3
 *   npm run unityctl -- capture --caption "ファーの見え方"
 *
 * 既定は **ブリッジ直叩き**。Custos backend が落ちていても LLM が
 * コンパイルを回せることを優先している (設計書 §4-D.1)。
 */

import { BridgeClient, BridgeUnreachableError } from "../unity/bridge-client.js";
import { parseUnityctlArgs, UnityctlArgError, type UnityctlArgs } from "../unity/unityctl-args.js";
import {
    compileExitCode,
    EXIT_OK,
    EXIT_UNREACHABLE,
    renderCompileStatus,
    renderJson,
    renderLog,
    renderStatus,
} from "../unity/unityctl-render.js";
import { resolveBridgePort } from "../unity/bridge-port.js";

async function main(): Promise<number> {
    let args: UnityctlArgs;
    try {
        args = parseUnityctlArgs(process.argv.slice(2));
    } catch (error) {
        if (error instanceof UnityctlArgError) {
            process.stderr.write(`${error.message}\n\n${usage()}\n`);
            return EXIT_UNREACHABLE;
        }
        throw error;
    }

    const port = args.port ?? resolveBridgePort();
    const client = new BridgeClient({ host: args.host, port, token: args.token });

    switch (args.command) {
        case "health": {
            const health = await client.health();
            process.stdout.write(args.json ? renderJson(health) : `bridge ok (isPlaying=${health.isPlaying})`);
            break;
        }
        case "status": {
            const status = await client.status();
            process.stdout.write(args.json ? renderJson(status) : renderStatus(status));
            break;
        }
        case "compile": {
            // --wait はドメインリロードを跨ぐ。LLM に再接続ループを書かせないための本命。
            const status = args.wait
                ? await client.compileAndWait()
                : (await client.requestCompile(), await client.compileStatus());
            process.stdout.write(args.json ? renderJson(status) : renderCompileStatus(status));
            process.stdout.write("\n");
            return args.wait ? compileExitCode(status) : EXIT_OK;
        }
        case "errors": {
            const status = await client.compileStatus();
            process.stdout.write(args.json ? renderJson(status) : renderCompileStatus(status));
            process.stdout.write("\n");
            return compileExitCode(status);
        }
        case "log": {
            const page = await client.log(args.since, args.level || undefined, args.limit);
            process.stdout.write(args.json ? renderJson(page) : renderLog(page));
            break;
        }
        case "play": {
            process.stdout.write(renderJson(await client.play()));
            break;
        }
        case "stop": {
            process.stdout.write(renderJson(await client.stop()));
            break;
        }
        case "scene": {
            process.stdout.write(renderJson(await client.scene()));
            break;
        }
        case "hierarchy": {
            process.stdout.write(renderJson(await client.hierarchy(args.depth, args.root || undefined)));
            break;
        }
        case "capture": {
            process.stdout.write(renderJson(await client.publishCapture(args.caption, args.source)));
            break;
        }
    }

    process.stdout.write("\n");
    return EXIT_OK;
}

function usage(): string {
    return [
        "usage: unityctl <command> [options]",
        "",
        "commands:",
        "  health | status | scene | hierarchy | log | play | stop",
        "  compile [--wait]     再コンパイル。--wait でリロードを跨いで完了まで待つ",
        "  errors               コンパイルエラーのみ表示 (エラーありで exit 1)",
        "  capture --caption T  キャプチャを AI セッションへ送る",
        "",
        "options:",
        "  --bridge <host:port|port>   接続先 (既定 127.0.0.1 + custos/bridge-port または 17778)",
        "  --token <token>             X-Auth-Token",
        "  --json                      機械可読出力",
        "  --since/--level/--limit     log 用",
        "  --depth/--root              hierarchy 用",
        "  --caption/--source          capture 用",
    ].join("\n");
}

main()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
        if (error instanceof BridgeUnreachableError) {
            // Unity が起動していない / リロード中。スタックを出しても読む人が困るだけ。
            process.stderr.write(`${error.message}\n`);
            process.exit(EXIT_UNREACHABLE);
        }
        process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
        process.exit(EXIT_UNREACHABLE);
    });
