/**
 * Annex-B H.264 ストリームを NAL unit へ切り出すパーサ。
 *
 * ffmpeg は連続バイト列で吐くので、3-byte (0x00 00 01) または 4-byte
 * (0x00 00 00 01) start code を境に切り分ける。チャンク跨ぎを許容する
 * ためバッファを保持しておく。
 *
 * NAL unit には先頭バイトの `nal_unit_type` (5 bit) があるので、
 * このパーサ自体は type に依らず raw bytes を返す。受け手が SPS/PPS/IDR/
 * P-slice を識別する想定。
 */

export interface NalUnit {
    /** start code を含まない NAL bytes (forbidden_zero_bit + type byte 始まり)。 */
    data: Buffer;
    /** 5-bit `nal_unit_type` (RFC 6184)。 */
    type: number;
}

export class H264NalParser {
    private buf: Buffer = Buffer.alloc(0);

    push(chunk: Buffer): NalUnit[] {
        this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
        const positions: number[] = [];
        let i = 0;
        while (i + 3 <= this.buf.length) {
            if (this.buf[i] === 0 && this.buf[i + 1] === 0 && this.buf[i + 2] === 1) {
                positions.push(i + 3);
                i += 3;
            } else if (
                i + 4 <= this.buf.length &&
                this.buf[i] === 0 && this.buf[i + 1] === 0 && this.buf[i + 2] === 0 && this.buf[i + 3] === 1
            ) {
                positions.push(i + 4);
                i += 4;
            } else {
                i++;
            }
        }
        if (positions.length === 0) return [];

        const out: NalUnit[] = [];
        for (let p = 0; p < positions.length - 1; ++p) {
            const start = positions[p]!;
            const next  = positions[p + 1]!;
            // 後段 start code 直前の 3 or 4 byte を除いた範囲が NAL 本体。
            const scLen = (this.buf[next - 4] === 0) ? 4 : 3;
            const end = next - scLen;
            const data = this.buf.subarray(start, end);
            if (data.length > 0) out.push({ data, type: data[0]! & 0x1f });
        }

        // 最後の start code 以降は次回チャンクで完結する可能性があるので残す。
        const lastStart = positions[positions.length - 1]!;
        // 直前の start code (3 or 4 byte) を再度含めて保持。
        const carryFrom = lastStart - (this.buf[lastStart - 4] === 0 ? 4 : 3);
        this.buf = this.buf.subarray(carryFrom);
        return out;
    }

    /** 内部バッファを破棄 (stream end など)。 */
    flush(): NalUnit[] {
        if (this.buf.length === 0) return [];
        const out: NalUnit[] = [];
        // 残骸が start code で始まる場合のみ NAL として返す。
        let start = 0;
        if (this.buf[0] === 0 && this.buf[1] === 0 && this.buf[2] === 1) start = 3;
        else if (this.buf[0] === 0 && this.buf[1] === 0 && this.buf[2] === 0 && this.buf[3] === 1) start = 4;
        if (start > 0 && this.buf.length > start) {
            const data = this.buf.subarray(start);
            out.push({ data, type: data[0]! & 0x1f });
        }
        this.buf = Buffer.alloc(0);
        return out;
    }
}
