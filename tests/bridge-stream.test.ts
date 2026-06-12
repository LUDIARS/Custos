/**
 * bridge-stream: ヘッダ解析 + config 正規化 + ffmpeg 引数生成 の単体テスト。
 *
 * 実際の ffmpeg spawn / HTTP 接続は行わない (引数生成・パースロジックのみ)。
 */
import { describe, expect, test } from "vitest";
import { parseFrameHeaders } from "../src/capture/bridge-stream.js";
import { buildBridgeStreamFfmpegArgs } from "../src/capture/ffmpeg-pipeline.js";
import { appsRootSchema } from "../src/config/apps-config.js";
import type { BridgeStreamMeta } from "../src/capture/bridge-stream.js";
import type { IncomingHttpHeaders } from "node:http";

// ─── parseFrameHeaders ─────────────────────────────────────────────────────

describe("parseFrameHeaders", () => {
    function headers(
        width: string,
        height: string,
        pixfmt: string,
        fps: string,
    ): IncomingHttpHeaders {
        return {
            "x-frame-width":  width,
            "x-frame-height": height,
            "x-frame-pixfmt": pixfmt,
            "x-frame-fps":    fps,
        };
    }

    test("normal BGRA headers parse correctly", () => {
        const meta = parseFrameHeaders(headers("1920", "1080", "bgra", "30"), 24);
        expect(meta).not.toBeNull();
        expect(meta?.width).toBe(1920);
        expect(meta?.height).toBe(1080);
        expect(meta?.pixfmt).toBe("bgra");
        expect(meta?.fps).toBe(30);
    });

    test("uses fallbackFps when X-Frame-Fps is absent", () => {
        const h: IncomingHttpHeaders = {
            "x-frame-width":  "1280",
            "x-frame-height": "720",
            "x-frame-pixfmt": "bgra",
            // fps header absent
        };
        const meta = parseFrameHeaders(h, 24);
        expect(meta).not.toBeNull();
        expect(meta?.fps).toBe(24);
    });

    test("uses fallbackFps when X-Frame-Fps is zero", () => {
        const meta = parseFrameHeaders(headers("640", "480", "bgra", "0"), 15);
        expect(meta?.fps).toBe(15);
    });

    test("returns null when X-Frame-Width is missing", () => {
        const h: IncomingHttpHeaders = {
            "x-frame-height": "720",
            "x-frame-pixfmt": "bgra",
            "x-frame-fps":    "24",
        };
        expect(parseFrameHeaders(h, 24)).toBeNull();
    });

    test("returns null when X-Frame-Height is missing", () => {
        const h: IncomingHttpHeaders = {
            "x-frame-width":  "1280",
            "x-frame-pixfmt": "bgra",
            "x-frame-fps":    "24",
        };
        expect(parseFrameHeaders(h, 24)).toBeNull();
    });

    test("returns null when X-Frame-Pixfmt is missing", () => {
        const h: IncomingHttpHeaders = {
            "x-frame-width":  "1280",
            "x-frame-height": "720",
            "x-frame-fps":    "24",
        };
        expect(parseFrameHeaders(h, 24)).toBeNull();
    });

    test("returns null when width is non-positive", () => {
        expect(parseFrameHeaders(headers("0", "720", "bgra", "24"), 24)).toBeNull();
        expect(parseFrameHeaders(headers("-1", "720", "bgra", "24"), 24)).toBeNull();
    });

    test("returns null when height is non-positive", () => {
        expect(parseFrameHeaders(headers("1280", "0", "bgra", "24"), 24)).toBeNull();
    });

    test("array header values are handled (first element used)", () => {
        const h: IncomingHttpHeaders = {
            "x-frame-width":  ["1280", "ignored"],
            "x-frame-height": ["720"],
            "x-frame-pixfmt": ["bgra"],
            "x-frame-fps":    ["24"],
        };
        const meta = parseFrameHeaders(h, 0);
        expect(meta?.width).toBe(1280);
        expect(meta?.height).toBe(720);
    });

    test("pixfmt value is trimmed of whitespace", () => {
        const h: IncomingHttpHeaders = {
            "x-frame-width":  "1280",
            "x-frame-height": "720",
            "x-frame-pixfmt": "  bgra  ",
            "x-frame-fps":    "24",
        };
        const meta = parseFrameHeaders(h, 24);
        expect(meta?.pixfmt).toBe("bgra");
    });
});

// ─── buildBridgeStreamFfmpegArgs ───────────────────────────────────────────

describe("buildBridgeStreamFfmpegArgs", () => {
    const baseMeta: BridgeStreamMeta = {
        width:  1920,
        height: 1080,
        pixfmt: "bgra",
        fps:    30,
    };

    test("contains rawvideo input stage with correct size and fps", () => {
        const args = buildBridgeStreamFfmpegArgs(baseMeta, "x264", 4_000_000, 5004, "127.0.0.1", 96);
        expect(args).toContain("-f");
        expect(args).toContain("rawvideo");
        expect(args).toContain("-pix_fmt");
        expect(args).toContain("bgra");
        expect(args).toContain("-s");
        expect(args).toContain("1920x1080");
        expect(args).toContain("-r");
        expect(args).toContain("30");
        expect(args).toContain("-i");
        expect(args).toContain("pipe:0");
    });

    test("contains RTP output with correct port and pkt_size=1200", () => {
        const args = buildBridgeStreamFfmpegArgs(baseMeta, "x264", 4_000_000, 5004, "127.0.0.1", 96);
        expect(args).toContain("-f");
        expect(args).toContain("rtp");
        const rtpUrl = args.find((a) => a.startsWith("rtp://"));
        expect(rtpUrl).toBeDefined();
        expect(rtpUrl).toContain("5004");
        expect(rtpUrl).toContain("pkt_size=1200");
    });

    test("contains payload_type 96", () => {
        const args = buildBridgeStreamFfmpegArgs(baseMeta, "x264", 4_000_000, 5004, "127.0.0.1", 96);
        const ptIdx = args.indexOf("-payload_type");
        expect(ptIdx).toBeGreaterThan(-1);
        expect(args[ptIdx + 1]).toBe("96");
    });

    test("uses x264 codec when encoder=x264", () => {
        const args = buildBridgeStreamFfmpegArgs(baseMeta, "x264", 4_000_000, 5004, "127.0.0.1", 96);
        expect(args).toContain("libx264");
    });

    test("uses nvenc codec when encoder=nvenc", () => {
        const args = buildBridgeStreamFfmpegArgs(baseMeta, "nvenc", 4_000_000, 5004, "127.0.0.1", 96);
        expect(args).toContain("h264_nvenc");
    });

    test("custom rtpHost is reflected in RTP URL", () => {
        const args = buildBridgeStreamFfmpegArgs(baseMeta, "x264", 4_000_000, 9000, "192.168.1.1", 96);
        const rtpUrl = args.find((a) => a.startsWith("rtp://"));
        expect(rtpUrl).toContain("192.168.1.1:9000");
    });

    test("does not contain -re flag (bridge throttles fps itself)", () => {
        const args = buildBridgeStreamFfmpegArgs(baseMeta, "x264", 4_000_000, 5004, "127.0.0.1", 96);
        expect(args).not.toContain("-re");
    });

    test("no audio flag -an is present", () => {
        const args = buildBridgeStreamFfmpegArgs(baseMeta, "x264", 4_000_000, 5004, "127.0.0.1", 96);
        expect(args).toContain("-an");
    });

    test("pipe:0 appears before RTP output (input before output)", () => {
        const args = buildBridgeStreamFfmpegArgs(baseMeta, "x264", 4_000_000, 5004, "127.0.0.1", 96);
        const pipeIdx = args.indexOf("pipe:0");
        const rtpIdx  = args.findIndex((a) => a.startsWith("rtp://"));
        expect(pipeIdx).toBeGreaterThan(-1);
        expect(rtpIdx).toBeGreaterThan(pipeIdx);
    });
});

// ─── inAppBridge config: port 既定・fps フィールド ─────────────────────────

describe("inAppBridge schema — unity default port and fps field", () => {
    function minimalApp(extra: Record<string, unknown> = {}): Record<string, unknown> {
        return { id: "demo", name: "Demo", run: { cwd: ".", cmd: "x" }, ...extra };
    }

    test("unity kind defaults to port 17778 (not 5199)", () => {
        const v = appsRootSchema.parse({ apps: [minimalApp({ inAppBridge: { kind: "unity" } })] });
        expect(v.apps[0]?.inAppBridge?.port).toBe(17778);
    });

    test("ergo kind still defaults to port 5198", () => {
        const v = appsRootSchema.parse({ apps: [minimalApp({ inAppBridge: { kind: "ergo" } })] });
        expect(v.apps[0]?.inAppBridge?.port).toBe(5198);
    });

    test("explicit port overrides the kind default", () => {
        const v = appsRootSchema.parse({ apps: [minimalApp({ inAppBridge: { kind: "unity", port: 9999 } })] });
        expect(v.apps[0]?.inAppBridge?.port).toBe(9999);
    });

    test("fps defaults to 24", () => {
        const v = appsRootSchema.parse({ apps: [minimalApp({ inAppBridge: { kind: "unity" } })] });
        expect(v.apps[0]?.inAppBridge?.fps).toBe(24);
    });

    test("explicit fps is preserved", () => {
        const v = appsRootSchema.parse({ apps: [minimalApp({ inAppBridge: { kind: "unity", fps: 60 } })] });
        expect(v.apps[0]?.inAppBridge?.fps).toBe(60);
    });

    test("fps is rejected when out of range", () => {
        expect(() => appsRootSchema.parse({
            apps: [minimalApp({ inAppBridge: { kind: "unity", fps: 0 } })],
        })).toThrow();
        expect(() => appsRootSchema.parse({
            apps: [minimalApp({ inAppBridge: { kind: "unity", fps: 121 } })],
        })).toThrow();
    });

    test("ergo kind also gets fps field", () => {
        const v = appsRootSchema.parse({ apps: [minimalApp({ inAppBridge: { kind: "ergo", fps: 30 } })] });
        expect(v.apps[0]?.inAppBridge?.fps).toBe(30);
    });

    test("legacy ergoCustos normalization still works with new fps default", () => {
        const v = appsRootSchema.parse({ apps: [minimalApp({ ergoCustos: { port: 5198 } })] });
        expect(v.apps[0]?.inAppBridge?.port).toBe(5198);
        expect(v.apps[0]?.inAppBridge?.fps).toBe(24);
    });
});
