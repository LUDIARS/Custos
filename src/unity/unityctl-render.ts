/**
 * `unityctl` の出力整形と終了コード決定。純関数。
 *
 * 終了コードを CI から使えるようにするのがこの層の主目的なので、
 * 「何を失敗と見なすか」はここだけで決める。
 */

import type {
    BridgeCompileMessage,
    BridgeCompileStatus,
    BridgeLogPage,
    BridgeStatus,
} from "./bridge-contract.js";

/** ブリッジへ到達できなかった。Unity が起動していない等。 */
export const EXIT_UNREACHABLE = 2;
/** コンパイルエラーがある。`errors` を CI で使うときの失敗コード。 */
export const EXIT_COMPILE_ERROR = 1;
export const EXIT_OK = 0;

export function compileExitCode(status: BridgeCompileStatus): number {
    return status.errorCount > 0 ? EXIT_COMPILE_ERROR : EXIT_OK;
}

export function renderStatus(status: BridgeStatus): string {
    const mode = status.isPlaying ? (status.isPaused ? "playing (paused)" : "playing") : "edit";
    const busy = [
        status.isCompiling ? "compiling" : "",
        status.isReloading ? "reloading" : "",
    ].filter(Boolean).join(", ");

    const lines = [
        `Unity     ${status.unityVersion}`,
        `project   ${status.projectPath}`,
        `mode      ${mode}${busy ? ` [${busy}]` : ""}`,
        `scene     ${status.activeScene || "(none)"}`,
    ];
    if (status.dirtyScenes.length > 0) {
        lines.push(`dirty     ${status.dirtyScenes.join(", ")}`);
    }
    return lines.join("\n");
}

export function renderCompileStatus(status: BridgeCompileStatus): string {
    if (status.isCompiling) {
        return "compiling...";
    }
    if (status.errorCount === 0 && status.warningCount === 0) {
        return "no compile errors or warnings";
    }

    const lines = [`${status.errorCount} error(s), ${status.warningCount} warning(s)`];
    for (const error of status.errors) {
        lines.push(`  ERROR ${formatCompileMessage(error)}`);
    }
    for (const warning of status.warnings) {
        lines.push(`  WARN  ${formatCompileMessage(warning)}`);
    }
    return lines.join("\n");
}

/**
 * `file:line:column` 形式。エディタ / ターミナルがクリック可能な形にする。
 */
export function formatCompileMessage(message: BridgeCompileMessage): string {
    const location = message.file
        ? `${message.file}:${message.line}:${message.column}`
        : "(unknown location)";
    const assembly = message.assembly ? ` [${message.assembly}]` : "";
    return `${location}${assembly} ${message.message}`;
}

export function renderLog(page: BridgeLogPage): string {
    if (page.entries.length === 0) {
        return `(no new entries; nextSeq=${page.nextSeq})`;
    }
    return page.entries
        .map((entry) => `${entry.seq} ${entry.ts} [${entry.level}] ${entry.message}`)
        .join("\n");
}

export function renderJson(value: unknown): string {
    return JSON.stringify(value, null, 2);
}
