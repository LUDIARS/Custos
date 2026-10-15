import { describe, expect, it } from "vitest";
import { BridgeH264FrameReader, MAX_FRAME_BYTES } from "../src/capture/bridge-h264-frames.js";
import { H264RtpPacketizer, RTP_MTU, splitAnnexB } from "../src/capture/h264-rtp-packetizer.js";
import { VideoFeedbackPolicy } from "../src/capture/video-feedback-policy.js";

function frame(payload: Buffer, ts: bigint, key: boolean): Buffer {
    const h = Buffer.alloc(13);
    h.writeUInt32BE(payload.length, 0);
    h.writeBigInt64BE(ts, 4);
    h[12] = key ? 1 : 0;
    return Buffer.concat([h, payload]);
}

const sps = Buffer.from([0x67, 0x42, 0xc0, 0x1f, 0xda]);
const pps = Buffer.from([0x68, 0xce, 0x3c, 0x80]);
const annexB = (...nals: Buffer[]) => Buffer.concat(nals.flatMap((n) => [Buffer.from([0, 0, 0, 1]), n]));

describe("BridgeH264FrameReader", () => {
    it("reassembles frames split across chunks and skips keepalives", () => {
        const reader = new BridgeH264FrameReader();
        const a = frame(Buffer.from([0, 0, 0, 1, 0x65, 1, 2, 3]), 1000n, true);
        const keepalive = frame(Buffer.alloc(0), 0n, false);
        const b = frame(Buffer.from([0, 0, 1, 0x41, 9]), 34_000n, false);
        const all = Buffer.concat([a, keepalive, b]);

        const out = [...reader.push(all.subarray(0, 5)), ...reader.push(all.subarray(5, 20)), ...reader.push(all.subarray(20))];
        expect(out).toHaveLength(2);
        expect(out[0]).toMatchObject({ timestampUs: 1000n, keyframe: true });
        expect([...out[0]!.data]).toEqual([0, 0, 0, 1, 0x65, 1, 2, 3]);
        expect(out[1]).toMatchObject({ timestampUs: 34_000n, keyframe: false });
    });

    it("rejects an absurd length instead of allocating it", () => {
        const reader = new BridgeH264FrameReader();
        const bad = Buffer.alloc(13);
        bad.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
        expect(() => reader.push(bad)).toThrow(/too large/);
    });
});

describe("splitAnnexB", () => {
    it("splits on 3- and 4-byte start codes and drops trailing zeros", () => {
        const data = Buffer.concat([Buffer.from([0, 0, 0, 1]), sps, Buffer.from([0, 0, 1]), pps, Buffer.from([0, 0, 0, 1, 0x65, 7, 0])]);
        const nals = splitAnnexB(data);
        expect(nals.map((n) => n[0]! & 0x1f)).toEqual([7, 8, 5]);
        expect([...nals[2]!]).toEqual([0x65, 7]);
    });
});

describe("H264RtpPacketizer", () => {
    it("sends small NALs as single NAL packets and marks the last one", () => {
        const p = new H264RtpPacketizer(96, RTP_MTU, { initialSequence: 65535, ssrc: 0x1234 });
        const packets = p.packetize(annexB(sps, pps, Buffer.from([0x65, 1, 2])), 1_000_000n);
        expect(packets).toHaveLength(3);
        expect(packets.map((b) => b.readUInt16BE(2))).toEqual([65535, 0, 1]);   // 16bit で一周
        expect(packets.every((b) => b.readUInt32BE(4) === 90_000)).toBe(true);    // 1 秒 = 90000
        expect(packets.map((b) => (b[1]! & 0x80) !== 0)).toEqual([false, false, true]);
        expect(packets[0]!.readUInt32BE(8)).toBe(0x1234);
        expect(packets[0]![1]! & 0x7f).toBe(96);
        expect([...packets[0]!.subarray(12)]).toEqual([...sps]);
    });

    it("fragments a large NAL into FU-A packets within the MTU and restores it", () => {
        const idr = Buffer.alloc(3000, 0xab);
        idr[0] = 0x65;
        const p = new H264RtpPacketizer(96, RTP_MTU, { initialSequence: 1, ssrc: 1 });
        const packets = p.packetize(annexB(idr), 0n);
        expect(packets.length).toBeGreaterThan(2);
        expect(packets.every((b) => b.length <= RTP_MTU)).toBe(true);
        const payloads = packets.map((b) => b.subarray(12));
        expect(payloads.every((x) => (x[0]! & 0x1f) === 28 && (x[0]! & 0x60) === (0x65 & 0x60))).toBe(true);
        expect(payloads[0]![1]! & 0x80).toBe(0x80);                         // start
        expect(payloads[payloads.length - 1]![1]! & 0x40).toBe(0x40);       // end
        expect(payloads.every((x) => (x[1]! & 0x1f) === 5)).toBe(true);
        const restored = Buffer.concat([Buffer.from([0x65]), ...payloads.map((x) => x.subarray(2))]);
        expect(restored.equals(idr)).toBe(true);
        expect((packets[packets.length - 1]![1]! & 0x80) !== 0).toBe(true);
        expect(packets.slice(0, -1).every((b) => (b[1]! & 0x80) === 0)).toBe(true);
    });
});

describe("VideoFeedbackPolicy", () => {
    const limits = { initial: 3_000_000, min: 300_000, max: 6_000_000 };

    it("follows the lowest viewer's estimate down immediately", () => {
        const p = new VideoFeedbackPolicy(limits);
        expect(p.updateEstimate("a", 5_000_000, 0)).toBeNull();     // 上げは保留
        expect(p.updateEstimate("b", 1_000_000, 10)).toBe(1_000_000);
        expect(p.bitrate).toBe(1_000_000);
    });

    it("raises only after the estimate holds, and ignores small changes", () => {
        const p = new VideoFeedbackPolicy(limits);
        expect(p.updateEstimate("a", 3_200_000, 0)).toBeNull();     // 15% 未満
        expect(p.updateEstimate("a", 5_000_000, 100)).toBeNull();
        expect(p.updateEstimate("a", 5_000_000, 2_000)).toBeNull();
        expect(p.updateEstimate("a", 5_000_000, 4_200)).toBe(5_000_000);
    });

    it("clamps to the limits and recomputes when a viewer leaves", () => {
        const p = new VideoFeedbackPolicy(limits);
        expect(p.updateEstimate("slow", 50_000, 0)).toBe(300_000);
        p.updateEstimate("fast", 9_000_000, 0);
        expect(p.removeSession("slow", 100)).toBeNull();            // 上げは保留から
        expect(p.removeSession("slow", 200)).toBeNull();            // もう居ない
        expect(p.updateEstimate("fast", 9_000_000, 5_000)).toBe(6_000_000);
    });

    it("rate-limits keyframe requests to one per 500ms", () => {
        const p = new VideoFeedbackPolicy(limits);
        expect(p.shouldRequestKeyframe(0)).toBe(true);
        expect(p.shouldRequestKeyframe(300)).toBe(false);
        expect(p.shouldRequestKeyframe(500)).toBe(true);
    });
});
