/**
 * H264NalParser: Annex-B start-code splitting の正確性。
 */
import { describe, expect, test } from "vitest";
import { H264NalParser } from "../src/capture/h264.js";

function bytes(...arr: number[]): Buffer { return Buffer.from(arr); }

describe("H264NalParser", () => {
    test("splits two NALs with 4-byte start codes in single chunk", () => {
        // SC NAL_A SC NAL_B  → expect [NAL_A]; NAL_B は最後の SC 以降扱いで保留
        const chunk = Buffer.concat([
            bytes(0, 0, 0, 1, 0x67, 0x42),       // SPS-ish
            bytes(0, 0, 0, 1, 0x68, 0xCE, 0x06), // PPS-ish
        ]);
        const p = new H264NalParser();
        const out = p.push(chunk);
        expect(out).toHaveLength(1);
        expect(out[0]?.data.equals(bytes(0x67, 0x42))).toBe(true);
        expect(out[0]?.type).toBe(0x67 & 0x1f);
    });

    test("flush returns the trailing NAL", () => {
        const p = new H264NalParser();
        p.push(Buffer.concat([
            bytes(0, 0, 0, 1, 0x67, 0x42),
            bytes(0, 0, 0, 1, 0x68, 0xCE, 0x06),
        ]));
        const tail = p.flush();
        expect(tail).toHaveLength(1);
        expect(tail[0]?.data.equals(bytes(0x68, 0xCE, 0x06))).toBe(true);
    });

    test("handles 3-byte start codes", () => {
        const p = new H264NalParser();
        const out = p.push(Buffer.concat([
            bytes(0, 0, 1, 0x67, 0x42),
            bytes(0, 0, 1, 0x68, 0xCE),
        ]));
        expect(out).toHaveLength(1);
        expect(out[0]?.data.equals(bytes(0x67, 0x42))).toBe(true);
    });

    test("handles chunk boundaries (NAL split across two pushes)", () => {
        const p = new H264NalParser();
        // 1st chunk: SC + partial NAL_A
        const a = p.push(bytes(0, 0, 0, 1, 0x67, 0x42, 0x01));
        expect(a).toHaveLength(0);
        // 2nd chunk: rest of NAL_A + SC + NAL_B
        const b = p.push(bytes(0x02, 0x03, 0, 0, 0, 1, 0x68, 0xCE));
        expect(b).toHaveLength(1);
        expect(b[0]?.data.equals(bytes(0x67, 0x42, 0x01, 0x02, 0x03))).toBe(true);
    });
});
