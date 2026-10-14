/**
 * app ごとの操作権 (遠隔プレイ中のユーザ) を 1 接続に限定する。
 *
 * Custos は複数人が同時に操作することを想定しない。最初に操作した接続を player とし、
 * 操作権を持つ接続がいる間、他の接続は spectator (観戦) として入力と Unity 操作を
 * 受け付けない。操作権は player が手放すか切断したときに解放され、次に操作した接続が
 * 新しい player になる (spec/feature/remote-play-and-play-log.md §1.4)。
 */

import { EventEmitter } from "node:events";
import type { ControlRole } from "../shared/types.js";

export type { ControlRole };

export interface ControlLeaseEvents {
    /** app の操作権の持ち主が変わった。holder は新しい持ち主 (解放なら null)。 */
    changed: (appId: string, holder: string | null) => void;
}

export class ControlLease extends EventEmitter {
    private readonly holders = new Map<string, string>();

    /**
     * 操作権を取る。誰も持っていないか自分が持っていれば true。
     * 他の接続が持っていれば false (その接続は spectator)。
     */
    acquire(appId: string, clientId: string): boolean {
        const holder = this.holders.get(appId);
        if (holder === clientId) return true;
        if (holder !== undefined) return false;
        this.holders.set(appId, clientId);
        this.emit("changed", appId, clientId);
        return true;
    }

    /** 自分が持っている操作権だけを手放す。 */
    release(appId: string, clientId: string): void {
        if (this.holders.get(appId) !== clientId) return;
        this.holders.delete(appId);
        this.emit("changed", appId, null);
    }

    /** 切断時: その接続が持つ操作権をすべて手放す。 */
    releaseAll(clientId: string): void {
        for (const [appId, holder] of [...this.holders]) {
            if (holder === clientId) this.release(appId, clientId);
        }
    }

    holder(appId: string): string | null {
        return this.holders.get(appId) ?? null;
    }

    roleOf(appId: string, clientId: string): ControlRole {
        const holder = this.holders.get(appId);
        if (holder === undefined) return "free";
        return holder === clientId ? "player" : "spectator";
    }

    /**
     * 操作 (Unity の Play/Stop など、操作権を取らない操作) をしてよいか。
     * 誰も操作していないか、自分が player なら許可する。clientId が無い呼び出し元は
     * 誰も操作していないときだけ許可する。
     */
    mayOperate(appId: string, clientId: string | null): boolean {
        const holder = this.holders.get(appId);
        return holder === undefined || holder === clientId;
    }
}
