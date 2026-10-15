import { describe, expect, it } from "vitest";
import {
    COMMENT_MAX_CHARS,
    COMMENT_MIN_INTERVAL_MS,
    canPostComment,
    isCommentMessage,
    normalizeCommentText,
} from "../src/ws/comment-message.js";

describe("isCommentMessage", () => {
    it("accepts a comment with appId and text", () => {
        expect(isCommentMessage({ type: "comment", appId: "demo", text: "nice" })).toBe(true);
    });

    it("rejects other shapes", () => {
        expect(isCommentMessage({ type: "comment", appId: "", text: "x" })).toBe(false);
        expect(isCommentMessage({ type: "comment", appId: "demo", text: 3 })).toBe(false);
        expect(isCommentMessage({ type: "key", appId: "demo", text: "x" })).toBe(false);
        expect(isCommentMessage(null)).toBe(false);
    });
});

describe("normalizeCommentText", () => {
    it("trims and folds newlines, tabs and repeated spaces into one space", () => {
        expect(normalizeCommentText("  すごい\r\n\tうまい   ね ")).toBe("すごい うまい ね");
    });

    it("drops other control characters", () => {
        expect(normalizeCommentText("a\u0000b\u001bc\u007f")).toBe("abc");
    });

    it("returns null for empty or too long text", () => {
        expect(normalizeCommentText("   \n ")).toBeNull();
        expect(normalizeCommentText("あ".repeat(COMMENT_MAX_CHARS))).toBe("あ".repeat(COMMENT_MAX_CHARS));
        expect(normalizeCommentText("あ".repeat(COMMENT_MAX_CHARS + 1))).toBeNull();
    });

    it("counts characters by code point, not UTF-16 units", () => {
        expect(normalizeCommentText("😀".repeat(COMMENT_MAX_CHARS))).not.toBeNull();
    });
});

describe("canPostComment", () => {
    it("allows the first comment and then one per interval", () => {
        expect(canPostComment(null, 0)).toBe(true);
        expect(canPostComment(1_000, 1_000 + COMMENT_MIN_INTERVAL_MS - 1)).toBe(false);
        expect(canPostComment(1_000, 1_000 + COMMENT_MIN_INTERVAL_MS)).toBe(true);
    });
});
