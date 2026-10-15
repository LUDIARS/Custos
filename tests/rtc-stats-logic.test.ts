import { describe, expect, it } from "vitest";
import { formatVideoStats, pickVideoStats, summarizeVideoStats } from "../public/js/rtc-stats-logic.js";

function report(entries: Record<string, unknown>[]): Map<string, Record<string, unknown>> {
    return new Map(entries.map((e, i) => [String(i), e]));
}

describe("rtc-stats-logic", () => {
    it("picks the video inbound-rtp and the selected candidate pair", () => {
        const s = pickVideoStats(report([
            { type: "inbound-rtp", kind: "audio", bytesReceived: 1 },
            { type: "inbound-rtp", kind: "video", timestamp: 1000, bytesReceived: 500, framesDecoded: 10, packetsReceived: 100, packetsLost: 1, frameWidth: 1280, frameHeight: 720 },
            { type: "candidate-pair", nominated: true, state: "succeeded", currentRoundTripTime: 0.045 },
        ]));
        expect(s).toMatchObject({ bytesReceived: 500, framesDecoded: 10, width: 1280, height: 720 });
        expect(s?.rttMs).toBeCloseTo(45);
        expect(pickVideoStats(report([{ type: "inbound-rtp", kind: "audio" }]))).toBeNull();
    });

    it("turns cumulative counters into per-second rates and loss", () => {
        const prev = { timestamp: 0, bytesReceived: 0, framesDecoded: 0, packetsReceived: 0, packetsLost: 0, width: 0, height: 0, rttMs: null };
        const cur = { timestamp: 2000, bytesReceived: 500_000, framesDecoded: 60, packetsReceived: 990, packetsLost: 10, width: 1280, height: 672, rttMs: 30 };
        const sum = summarizeVideoStats(prev, cur);
        expect(sum?.kbps).toBeCloseTo(2000);
        expect(sum?.fps).toBeCloseTo(30);
        expect(sum?.lossPct).toBeCloseTo(1);
        expect(formatVideoStats(sum)).toBe("2.0 Mbps · 30fps · loss 1.0% · rtt 30ms · 1280x672");
        expect(summarizeVideoStats(null, cur)).toBeNull();
        expect(summarizeVideoStats(cur, cur)).toBeNull();
    });
});
