/**
 * 行動ログの `player` 列。生のユーザー ID は書かず HMAC にする。
 *
 * salt は `CUSTOS_PLAYLOG_SALT`、無ければ `<dir>/.salt` を初回に乱数生成して使い回す
 * (同じユーザーは run をまたいで同じ値になる)。
 */

import { createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function hashPlayer(salt: string, userId: string): string {
    return createHmac("sha256", salt).update(userId).digest("hex").slice(0, 16);
}

export function resolvePlayerSalt(dir: string, env: NodeJS.ProcessEnv = process.env): string {
    const fromEnv = env.CUSTOS_PLAYLOG_SALT;
    if (fromEnv && fromEnv.trim() !== "") return fromEnv;
    const file = join(dir, ".salt");
    if (existsSync(file)) {
        const saved = readFileSync(file, "utf8").trim();
        if (saved !== "") return saved;
    }
    mkdirSync(dir, { recursive: true });
    const salt = randomBytes(32).toString("hex");
    writeFileSync(file, salt, { encoding: "utf8", mode: 0o600 });
    return salt;
}
