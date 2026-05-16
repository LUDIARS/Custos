/**
 * scalePngBuffer のパススルー条件 (subprocess を起こさないケース) を確認。
 * 実 ffmpeg を起こすケースは環境依存なのでスキップ。
 */
import { describe, expect, test } from "vitest";
import { readPngWidth, scalePngBuffer } from "../src/capture/scale.js";

const MAGIC = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

/** PNG IHDR (width=W, height=H, depth=8, color=RGBA) を捏造。
 *  CRC は Custos の readPngWidth が触らないので 0 で良い。 */
function fakePng(width: number, height = 100): Buffer {
    const ihdrLen = Buffer.alloc(4); ihdrLen.writeUInt32BE(13);
    const ihdrTyp = Buffer.from("IHDR");
    const ihdr    = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8]  = 8;
    ihdr[9]  = 6;
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;
    const crc = Buffer.alloc(4);
    return Buffer.concat([MAGIC, ihdrLen, ihdrTyp, ihdr, crc]);
}

describe("readPngWidth", () => {
    test("parses IHDR width", () => {
        expect(readPngWidth(fakePng(1234))).toBe(1234);
    });
    test("returns undefined on non-PNG", () => {
        expect(readPngWidth(Buffer.from("not a png"))).toBeUndefined();
    });
});

describe("scalePngBuffer", () => {
    test("passthrough when maxWidth is undefined", async () => {
        const png = fakePng(800);
        const out = await scalePngBuffer(png, undefined);
        expect(out).toBe(png);
    });

    test("passthrough when maxWidth is 0", async () => {
        const png = fakePng(800);
        const out = await scalePngBuffer(png, 0);
        expect(out).toBe(png);
    });

    test("passthrough when input width <= maxWidth", async () => {
        const png = fakePng(640);
        const out = await scalePngBuffer(png, 1280);
        expect(out).toBe(png);
    });
});
