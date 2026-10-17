import { randomUUID } from "node:crypto";
import { z } from "zod";

export const Stamp = z.enum(["good", "bad", "heart", "clap", "party", "sad", "laugh"]);
const Envelope = z.object({ type: z.literal("audience-send"), appId: z.string().min(1).max(200) });
export const AudienceSubmission = z.discriminatedUnion("kind", [
    Envelope.extend({ kind: z.literal("message"), text: z.string().trim().min(1).max(280) }).strict(),
    Envelope.extend({ kind: z.literal("stamp"), stamp: Stamp }).strict(),
]);
export type AudienceSubmission = z.infer<typeof AudienceSubmission>;
export type AudienceEvent = {
    id: string; appId: string; ts: number; sender: string;
} & ({ kind: "message"; text: string } | { kind: "stamp"; stamp: z.infer<typeof Stamp> });

export const AUDIENCE_HISTORY_LIMIT = 200;
/** App-scoped, bounded history for the lifetime of one broker. No account identifiers are exposed. */
export class AudienceRoom {
    private readonly events = new Map<string, AudienceEvent[]>();
    private readonly listeners = new Set<(event: AudienceEvent) => void>();

    constructor(private readonly now: () => number = Date.now, private readonly id: () => string = randomUUID) {}

    history(appId: string): AudienceEvent[] { return [...(this.events.get(appId) ?? [])]; }

    subscribe(listener: (event: AudienceEvent) => void): () => void {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }

    append(submission: AudienceSubmission, sender: string): AudienceEvent {
        const common = { id: this.id(), appId: submission.appId, ts: this.now(), sender: sender.slice(0, 60) };
        const event: AudienceEvent = submission.kind === "message"
            ? { ...common, kind: "message", text: submission.text }
            : { ...common, kind: "stamp", stamp: submission.stamp };
        const history = [...this.history(event.appId), event].slice(-AUDIENCE_HISTORY_LIMIT);
        this.events.set(event.appId, history);
        for (const listener of this.listeners) listener(event);
        return event;
    }
}
