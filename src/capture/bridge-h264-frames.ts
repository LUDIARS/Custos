/**
 * Unity ブリッジの `GET /stream?codec=h264` の本体を、フレーム (H.264 アクセスユニット) に切り分ける。
 *
 * 形 (ブリッジ H264Streamer.cs と固定合意):
 *   1 フレーム = [u32 BE 長さ][i64 BE 時刻 µs][u8 フラグ (bit0=キーフレーム)] + H.264 Annex-B
 *   長さ 0 は keepalive (1 秒ごと) なので捨てる。
 *
 * HTTP の chunk の切れ目はフレームの切れ目と関係ないので、足りない分は次の push まで持つ。
 */

export interface BridgeH264Frame {
    /** Annex-B (start code 付き) のアクセスユニット。 */
    data:        Buffer;
    timestampUs: bigint;
    keyframe:    boolean;
}

const HEADER_BYTES = 13;
/** 1 フレームの上限。壊れた長さで巨大な確保をしないため。 */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export class BridgeH264FrameReader {
    private buffer: Buffer = Buffer.alloc(0);

    /** 受け取ったバイト列を足し、そろったフレームを返す。長さが壊れていたら throw。 */
    push(chunk: Buffer): BridgeH264Frame[] {
        this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
        const frames: BridgeH264Frame[] = [];
        let offset = 0;
        while (this.buffer.length - offset >= HEADER_BYTES) {
            const length = this.buffer.readUInt32BE(offset);
            if (length > MAX_FRAME_BYTES) throw new Error(`bridge h264 frame too large: ${length} bytes`);
            if (this.buffer.length - offset < HEADER_BYTES + length) break;
            if (length > 0) {
                const start = offset + HEADER_BYTES;
                frames.push({
                    data:        Buffer.from(this.buffer.subarray(start, start + length)),
                    timestampUs: this.buffer.readBigInt64BE(offset + 4),
                    keyframe:    (this.buffer[offset + 12]! & 1) === 1,
                });
            }
            offset += HEADER_BYTES + length;
        }
        this.buffer = offset === 0 ? this.buffer : Buffer.from(this.buffer.subarray(offset));
        return frames;
    }
}
