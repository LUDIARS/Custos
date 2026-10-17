import { describe, expect, it } from "vitest";
import { AudienceRoom, AudienceSubmission, AUDIENCE_HISTORY_LIMIT } from "../src/audience/room.js";

describe("audience history contract", () => {
    it("validates the seven stamps and rejects empty, oversized and forged submissions", () => {
        for (const stamp of ["good", "bad", "heart", "clap", "party", "sad", "laugh"]) {
            expect(AudienceSubmission.safeParse({ type: "audience-send", appId: "demo", kind: "stamp", stamp }).success).toBe(true);
        }
        const base = { type: "audience-send", appId: "demo", kind: "message" };
        expect(AudienceSubmission.safeParse({ ...base, text: "   " }).success).toBe(false);
        expect(AudienceSubmission.safeParse({ ...base, text: "x".repeat(281) }).success).toBe(false);
        expect(AudienceSubmission.safeParse({ ...base, text: "hello", sender: "forged" }).success).toBe(false);
        expect(AudienceSubmission.safeParse({ ...base, kind: "stamp", stamp: "unknown" }).success).toBe(false);
        expect(AudienceSubmission.parse({ ...base, text: " 日本語 ❤️ " })).toMatchObject({ text: "日本語 ❤️" });
    });

    it("isolates applications and keeps only the most recent 200 ordered events", () => {
        let sequence = 0;
        const room = new AudienceRoom(() => 1000, () => String(sequence++));
        room.append({ type: "audience-send", appId: "other", kind: "stamp", stamp: "heart" }, "観戦者");
        for (let index = 0; index <= AUDIENCE_HISTORY_LIMIT; index++) {
            room.append({ type: "audience-send", appId: "demo", kind: "message", text: String(index) }, "名前");
        }
        const history = room.history("demo");
        expect(history).toHaveLength(200);
        expect(history[0]).toMatchObject({ text: "1", sender: "名前", ts: 1000 });
        expect(history.at(-1)).toMatchObject({ text: "200" });
        expect(room.history("other")).toHaveLength(1);
        expect(room.history("missing")).toEqual([]);
        history.pop();
        expect(room.history("demo")).toHaveLength(200);
    });

    it("shares live events with multiple broker listeners and releases closed brokers", () => {
        const room = new AudienceRoom(() => 0, () => "event");
        const first: string[] = [];
        const second: string[] = [];
        const release = room.subscribe((event) => first.push(event.id));
        room.subscribe((event) => second.push(event.id));
        const submission = { type: "audience-send", appId: "demo", kind: "stamp", stamp: "clap" } as const;
        room.append(submission, "観戦者");
        release();
        room.append(submission, "観戦者");
        expect(first).toEqual(["event"]);
        expect(second).toEqual(["event", "event"]);
    });
});
