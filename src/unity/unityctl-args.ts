/**
 * `unityctl` の引数解析。純関数なのでテストから直接叩ける。
 *
 * CLI 本体 (`src/cli/unityctl.ts`) は解析結果を受け取って I/O するだけにし、
 * 「どう解釈されるか」はここだけで決まるようにしている。
 */

export const UNITYCTL_COMMANDS = [
    "status",
    "health",
    "compile",
    "errors",
    "log",
    "play",
    "stop",
    "scene",
    "hierarchy",
    "capture",
] as const;

export type UnityctlCommand = (typeof UNITYCTL_COMMANDS)[number];

export interface UnityctlArgs {
    command: UnityctlCommand;
    /** ブリッジ接続先。`--bridge host:port`。 */
    host: string;
    port: number | null;
    token: string;
    /** `--json` で機械可読出力。 */
    json: boolean;
    /** `compile --wait` — ドメインリロードを跨いで完了まで待つ。 */
    wait: boolean;
    /** `log --since` / `--level` / `--limit`。 */
    since: number;
    level: string;
    limit: number;
    /** `hierarchy --depth` / `--root`。 */
    depth: number;
    root: string;
    /** `capture --caption` / `--source`。 */
    caption: string;
    source: string;
}

export class UnityctlArgError extends Error {}

const DEFAULTS: Omit<UnityctlArgs, "command"> = {
    host: "127.0.0.1",
    port: null,
    token: "",
    json: false,
    wait: false,
    since: 0,
    level: "",
    limit: 200,
    depth: 2,
    root: "",
    caption: "",
    source: "gameview",
};

export function parseUnityctlArgs(argv: readonly string[]): UnityctlArgs {
    const [rawCommand, ...rest] = argv;
    if (!rawCommand) {
        throw new UnityctlArgError("command is required");
    }
    if (!isCommand(rawCommand)) {
        throw new UnityctlArgError(`unknown command: ${rawCommand}`);
    }

    const args: UnityctlArgs = { command: rawCommand, ...DEFAULTS };

    for (let i = 0; i < rest.length; i++) {
        const flag = rest[i];
        switch (flag) {
            case "--json":
                args.json = true;
                break;
            case "--wait":
                args.wait = true;
                break;
            case "--bridge": {
                const value = requireValue(rest, ++i, flag);
                const [host, port] = splitHostPort(value);
                args.host = host;
                args.port = port;
                break;
            }
            case "--token":
                args.token = requireValue(rest, ++i, flag);
                break;
            case "--since":
                args.since = requireInt(rest, ++i, flag, 0);
                break;
            case "--level":
                args.level = requireValue(rest, ++i, flag);
                break;
            case "--limit":
                args.limit = requireInt(rest, ++i, flag, 1);
                break;
            case "--depth":
                args.depth = requireInt(rest, ++i, flag, 0);
                break;
            case "--root":
                args.root = requireValue(rest, ++i, flag);
                break;
            case "--caption":
                args.caption = requireValue(rest, ++i, flag);
                break;
            case "--source":
                args.source = requireValue(rest, ++i, flag);
                break;
            default:
                throw new UnityctlArgError(`unknown option: ${flag}`);
        }
    }

    return args;
}

function isCommand(value: string): value is UnityctlCommand {
    return (UNITYCTL_COMMANDS as readonly string[]).includes(value);
}

function requireValue(rest: readonly string[], index: number, flag: string): string {
    const value = rest[index];
    if (value === undefined || value.startsWith("--")) {
        throw new UnityctlArgError(`${flag} requires a value`);
    }
    return value;
}

function requireInt(rest: readonly string[], index: number, flag: string, minimum: number): number {
    const raw = requireValue(rest, index, flag);
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < minimum) {
        throw new UnityctlArgError(`${flag} requires an integer >= ${minimum} (got ${raw})`);
    }
    return parsed;
}

/**
 * `host:port` / `port` / `host` のどれでも受ける。
 * 遠隔から使うとき「17779 だけ渡したい」が頻出するため。
 */
export function splitHostPort(value: string): [string, number | null] {
    if (/^\d+$/.test(value)) {
        return [DEFAULTS.host, Number(value)];
    }
    const index = value.lastIndexOf(":");
    if (index < 0) {
        return [value, null];
    }
    const host = value.slice(0, index);
    const port = Number(value.slice(index + 1));
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new UnityctlArgError(`invalid port in --bridge ${value}`);
    }
    return [host || DEFAULTS.host, port];
}
