/** Host-scoped credentials are separate from user identities and never serialized. */
import { createHash, timingSafeEqual } from "node:crypto";
import type { FarmConfig } from "./schema.js";

const digest = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();

export class FarmHostAuth {
    private readonly tokens = new Map<string, Buffer>();

    constructor(hosts: FarmConfig["hosts"], env: NodeJS.ProcessEnv) {
        const seen = new Set<string>();
        for (const host of hosts) {
            const token = env[host.tokenEnv];
            if (!token || token.trim() !== token || token.length < 32 || token.length > 512 || /\s/.test(token)) {
                throw new Error(`missing or invalid credential for farm host ${host.id}`);
            }
            const hash = digest(token);
            const fingerprint = hash.toString("hex");
            if (seen.has(fingerprint)) throw new Error("farm hosts must have distinct credentials");
            seen.add(fingerprint);
            this.tokens.set(host.id, hash);
        }
    }

    verify(hostId: string, authorization: string): boolean {
        const match = /^Bearer ([^\s]{32,512})$/.exec(authorization);
        const expected = this.tokens.get(hostId);
        return Boolean(match?.[1] && expected && timingSafeEqual(expected, digest(match[1])));
    }
}
