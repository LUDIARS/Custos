/**
 * In-memory アプリレジストリ。
 *
 * apps.json を起動時に読み込んで AppConfig を保持。同時に各 app の lifecycle
 * 状態 (AppStatus) を持ち、API/WS から参照される。runner はここを介して
 * 状態遷移を発行し、変更は EventEmitter 経由で WS broker にも届く。
 */

import { EventEmitter } from "node:events";
import type { AppConfig } from "../config/apps-config.js";
import type { AppStatus, AppLifecycle } from "../shared/types.js";

export interface RegistryEvents {
    "status-changed": (appId: string, status: AppStatus) => void;
}

export class AppsRegistry extends EventEmitter {
    private configs = new Map<string, AppConfig>();
    private status  = new Map<string, AppStatus>();

    constructor(apps: AppConfig[]) {
        super();
        for (const app of apps) {
            this.configs.set(app.id, app);
            this.status.set(app.id, this.makeInitialStatus(app.id));
        }
    }

    private makeInitialStatus(id: string): AppStatus {
        return {
            id,
            lifecycle:    "idle",
            pid:          null,
            lastExitCode: null,
            lastChangeAt: Date.now(),
            lastBuildId:  null,
            lastRunId:    null,
            lastTestId:   null,
        };
    }

    listConfigs(): AppConfig[] {
        return [...this.configs.values()];
    }

    getConfig(id: string): AppConfig | undefined {
        return this.configs.get(id);
    }

    getStatus(id: string): AppStatus | undefined {
        return this.status.get(id);
    }

    /** 状態遷移. 既知の app id でなければ false を返す (caller がエラー化)。 */
    setLifecycle(id: string, next: AppLifecycle, patch: Partial<AppStatus> = {}): boolean {
        const cur = this.status.get(id);
        if (!cur) return false;
        const merged: AppStatus = {
            ...cur,
            ...patch,
            id,
            lifecycle: next,
            lastChangeAt: Date.now(),
        };
        this.status.set(id, merged);
        this.emit("status-changed", id, merged);
        return true;
    }
}
