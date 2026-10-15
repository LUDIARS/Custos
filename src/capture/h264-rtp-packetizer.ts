/**
 * H.264 アクセスユニット (Annex-B) を RTP パケットに分ける (RFC 6184、packetization-mode=1)。
 *
 * ffmpeg の rtp muxer の代わり。werift には H.264 の packetizer が無いので自前で持つ
 * (webrtc-broker.ts 冒頭)。codec 契約: PT 96 / packetization-mode=1 / 1 パケット 1200 バイト以下
 * (CLAUDE.md、game-web と同じ)。
 *
 * - NAL が収まれば Single NAL Unit パケット、収まらなければ FU-A に分ける。
 * - アクセスユニットの最後のパケットに marker bit を立てる。
 * - 時刻は 90kHz。
 */

import { randomInt } from "node:crypto";

export const RTP_MTU = 1200;
const RTP_HEADER_BYTES = 12;
const FU_A_TYPE = 28;

/** Annex-B の start code で区切った NAL (start code を除く)。 */
export function splitAnnexB(data: Buffer): Buffer[] {
    const nals: Buffer[] = [];
    let start = -1;
    let i = 0;
    while (i + 2 < data.length) {
        let codeLength = 0;
        if (data[i] === 0 && data[i + 1] === 0) {
            if (data[i + 2] === 1) codeLength = 3;
            else if (i + 3 < data.length && data[i + 2] === 0 && data[i + 3] === 1) codeLength = 4;
        }
        if (codeLength > 0) {
            if (start >= 0) pushNal(nals, data, start, i);
            start = i + codeLength;
            i += codeLength;
        } else {
            i++;
        }
    }
    if (start >= 0) pushNal(nals, data, start, data.length);
    return nals;
}

function pushNal(nals: Buffer[], data: Buffer, start: number, end: number): void {
    // NAL の終わりは 0 にならない (rbsp_trailing_bits) ので、末尾の 0 は次の start code の一部。
    let e = end;
    while (e > start && data[e - 1] === 0) e--;
    if (e > start) nals.push(data.subarray(start, e));
}

export class H264RtpPacketizer {
    private sequence: number;
    private readonly ssrc: number;

    constructor(
        private readonly payloadType = 96,
        private readonly mtu = RTP_MTU,
        options: { initialSequence?: number; ssrc?: number } = {},
    ) {
        this.sequence = options.initialSequence ?? randomInt(0, 0x10000);
        this.ssrc = options.ssrc ?? randomInt(1, 0x7fffffff);
    }

    /** 1 アクセスユニットを RTP パケットの列にする。timestampUs はマイクロ秒。 */
    packetize(accessUnit: Buffer, timestampUs: bigint): Buffer[] {
        const timestamp = Number((timestampUs * 90n / 1000n) & 0xffffffffn);
        const payloadMax = this.mtu - RTP_HEADER_BYTES;
        const packets: Buffer[] = [];
        for (const nal of splitAnnexB(accessUnit)) {
            if (nal.length <= payloadMax) {
                packets.push(this.packet(timestamp, nal));
                continue;
            }
            // FU-A: 先頭バイト (F/NRI/type) を FU indicator と FU header に分けて運ぶ。
            const indicator = (nal[0]! & 0xe0) | FU_A_TYPE;
            const type = nal[0]! & 0x1f;
            const chunk = payloadMax - 2;
            for (let offset = 1; offset < nal.length; offset += chunk) {
                const end = Math.min(nal.length, offset + chunk);
                const header = (offset === 1 ? 0x80 : 0) | (end === nal.length ? 0x40 : 0) | type;
                packets.push(this.packet(timestamp, Buffer.concat([Buffer.from([indicator, header]), nal.subarray(offset, end)])));
            }
        }
        const last = packets[packets.length - 1];
        if (last) last[1] = last[1]! | 0x80;   // marker: アクセスユニットの終わり
        return packets;
    }

    private packet(timestamp: number, payload: Buffer): Buffer {
        const header = Buffer.alloc(RTP_HEADER_BYTES);
        header[0] = 0x80;                       // V=2
        header[1] = this.payloadType & 0x7f;
        header.writeUInt16BE(this.sequence, 2);
        header.writeUInt32BE(timestamp >>> 0, 4);
        header.writeUInt32BE(this.ssrc >>> 0, 8);
        this.sequence = (this.sequence + 1) & 0xffff;
        return Buffer.concat([header, payload]);
    }
}
