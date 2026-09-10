/** Opt-in farm composition. No devices or background processes are started here. */
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { farmConfigSchema } from "./schema.js";
import { DevicePool } from "./pool.js";
import { FileFarmStore } from "./store.js";
import { FarmHostAuth } from "./host-auth.js";

export interface FarmRuntime {
    pool: DevicePool;
    hostAuth: FarmHostAuth;
}

export function loadFarmRuntime(env: NodeJS.ProcessEnv = process.env): FarmRuntime | undefined {
    const configFile = env.CUSTOS_FARM_CONFIG;
    if (configFile === undefined) return undefined;
    if (!configFile || !isAbsolute(configFile)) throw new Error("CUSTOS_FARM_CONFIG must be an absolute file path");
    const stateFile = env.CUSTOS_FARM_STATE_FILE;
    if (!stateFile || !isAbsolute(stateFile)) throw new Error("CUSTOS_FARM_STATE_FILE must be an absolute file path");
    if (resolve(configFile).toLowerCase() === resolve(stateFile).toLowerCase()) throw new Error("farm configuration and state must use separate files");
    if (env.CUSTOS_OPEN === "1" || !env.CERNERE_URL?.trim()) {
        throw new Error("device farm requires CERNERE_URL and verified user identities; open/stub mode is unsupported");
    }
    const config = farmConfigSchema.parse(JSON.parse(readFileSync(configFile, "utf8")));
    const hostAuth = new FarmHostAuth(config.hosts, env);
    const pool = new DevicePool(config, new FileFarmStore(stateFile));
    return { pool, hostAuth };
}
