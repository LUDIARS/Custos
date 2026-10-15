/**
 * WS `comment` メッセージ (観戦者の感想) の境界検証と本文の整形。クライアント入力なので型だけを信用しない
 * (spec/feature/remote-play-and-play-log.md §1.5)。
 */

import { z } from "zod";
import type { ClientMessage } from "../shared/types.js";

/** 感想 1 件の最大文字数 (整形後)。 */
export const COMMENT_MAX_CHARS = 200;
/** 同じ接続から送れる間隔。連投で他の人の画面を埋めないため。 */
export const COMMENT_MIN_INTERVAL_MS = 1_000;

const commentMessageSchema = z.object({
    type:  z.literal("comment"),
    appId: z.string().min(1),
    text:  z.string(),
});

export type CommentMessage = Extract<ClientMessage, { type: "comment" }>;

export function isCommentMessage(msg: unknown): msg is CommentMessage {
    return commentMessageSchema.safeParse(msg).success;
}

/**
 * 本文を表示・保存できる形にする。改行とタブは空白にまとめ、他の制御文字は消し、前後の空白を落とす。
 * 空になるか、長すぎるときは null (送らせない)。
 */
export function normalizeCommentText(text: string): string | null {
    const cleaned = text
        .replace(/[\r\n\t]+/g, " ")
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .replace(/ {2,}/g, " ")
        .trim();
    if (cleaned.length === 0 || [...cleaned].length > COMMENT_MAX_CHARS) return null;
    return cleaned;
}

/** 前回の送信からの間隔が足りているか。初回 (lastAt=null) は常に可。 */
export function canPostComment(lastAt: number | null, now: number): boolean {
    return lastAt === null || now - lastAt >= COMMENT_MIN_INTERVAL_MS;
}
