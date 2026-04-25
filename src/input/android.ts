/**
 * Android adb input フォワーダ。
 *
 * `adb shell input keyevent <code>` / `input tap <x> <y>` を spawn する。
 * adb がインストールされていない / 接続中の device が無い場合は warn
 * を出して noop。
 *
 * 入力 key 名は nut-js の "W"/"Space" 形式を Android keycode 番号に
 * マップする。よく使うキーは網羅、未対応のキーは warn。
 *
 * Android 画面キャプチャ (`adb exec-out screenrecord ...`) は別モジュール
 * (Phase 2.3) で実装する。
 */

import { spawn } from "node:child_process";
import { childLogger } from "../shared/logger.js";

const log = childLogger("android-input");

function adbBinary(): string {
    return process.env.CUSTOS_ADB ?? "adb";
}

interface RunOpts {
    serial?: string;
}

async function runAdb(args: string[], opts: RunOpts = {}): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number | null }> {
    const adb = adbBinary();
    const full = opts.serial ? ["-s", opts.serial, ...args] : args;
    return await new Promise((resolveOuter) => {
        const proc = spawn(adb, full, { shell: false });
        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", (b: Buffer) => { stdout += b.toString("utf8"); });
        proc.stderr.on("data", (b: Buffer) => { stderr += b.toString("utf8"); });
        proc.on("error", (err) => {
            log.warn({ err: err.message }, "adb spawn failed");
            resolveOuter({ ok: false, stdout, stderr: err.message, exitCode: null });
        });
        proc.on("exit", (code) => {
            resolveOuter({ ok: code === 0, stdout, stderr, exitCode: code });
        });
    });
}

/**
 * nut-js 風の key 名 → Android KeyEvent コード。
 * 完全網羅は意図せず、よくあるゲームコントロール + メディアキーをカバー。
 * https://developer.android.com/reference/android/view/KeyEvent
 */
const KEY_TO_ANDROID: Record<string, number> = {
    // alphanumerics
    "A": 29, "B": 30, "C": 31, "D": 32, "E": 33, "F": 34, "G": 35, "H": 36,
    "I": 37, "J": 38, "K": 39, "L": 40, "M": 41, "N": 42, "O": 43, "P": 44,
    "Q": 45, "R": 46, "S": 47, "T": 48, "U": 49, "V": 50, "W": 51, "X": 52,
    "Y": 53, "Z": 54,
    "0": 7, "1": 8, "2": 9, "3": 10, "4": 11, "5": 12, "6": 13, "7": 14, "8": 15, "9": 16,

    // navigation
    "Up":     19, "Down":  20, "Left":  21, "Right": 22,
    "DPadUp": 19, "DPadDown": 20, "DPadLeft": 21, "DPadRight": 22,
    "Enter":  66, "Tab":  61, "Space": 62, "Backspace": 67, "Escape": 111,

    // android-specific
    "Back":   4,  "Home":   3,  "Menu": 82,
    "VolumeUp": 24, "VolumeDown": 25,
    "Power":   26, "Camera": 27,
    "MediaPlay": 126, "MediaPause": 127, "MediaPlayPause": 85, "MediaNext": 87, "MediaPrev": 88,
};

function resolveKeycode(name: string): number | null {
    const norm = name.length === 1 ? name.toUpperCase() : name;
    return KEY_TO_ANDROID[norm] ?? null;
}

export async function androidSendKey(key: string, opts: RunOpts = {}): Promise<void> {
    const code = resolveKeycode(key);
    if (code == null) {
        log.warn({ key }, "no Android keycode mapping");
        return;
    }
    const r = await runAdb(["shell", "input", "keyevent", String(code)], opts);
    if (!r.ok) log.warn({ key, code, stderr: r.stderr }, "adb keyevent failed");
}

export async function androidSendTap(x: number, y: number, opts: RunOpts = {}): Promise<void> {
    const r = await runAdb(["shell", "input", "tap", String(Math.round(x)), String(Math.round(y))], opts);
    if (!r.ok) log.warn({ x, y, stderr: r.stderr }, "adb tap failed");
}

export async function androidIsAvailable(serial?: string): Promise<boolean> {
    const r = await runAdb(["shell", "echo", "ok"], serial ? { serial } : {});
    return r.ok && r.stdout.trim() === "ok";
}
