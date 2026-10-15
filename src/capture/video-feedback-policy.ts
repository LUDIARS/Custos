/**
 * 映像源 1 本を共有する複数のブラウザの、帯域推定 (REMB) とキーフレーム要求 (PLI) をまとめる (純ロジック)。
 *
 * - ビットレート: 見ている全員が受けられるよう、各 session の推定値の最小を min〜max に収めて使う。
 *   下げるのはすぐ (詰まりを早く解く)、上げるのは推定が続いてから (行ったり来たりを防ぐ)。
 *   小さな変化 (15% 未満) では変えない。
 * - キーフレーム: PLI と途中参加で要求する。連続した要求は 500ms に 1 回にまとめる。
 * (spec/feature/webrtc-efficiency.md §7)
 */

export interface BitrateLimits {
    initial: number;
    min:     number;
    max:     number;
}

const CHANGE_RATIO = 0.15;
const RAISE_HOLD_MS = 4_000;
const KEYFRAME_MIN_INTERVAL_MS = 500;

export class VideoFeedbackPolicy {
    private readonly estimates = new Map<string, number>();
    private current: number;
    private raiseSince: number | null = null;
    private lastKeyframeAt = Number.NEGATIVE_INFINITY;

    constructor(private readonly limits: BitrateLimits) {
        this.current = clamp(limits.initial, limits.min, limits.max);
    }

    get bitrate(): number {
        return this.current;
    }

    /**
     * session の推定値を更新し、ビットレートを変えるべきなら新しい値を返す (変えないなら null)。
     */
    updateEstimate(sessionId: string, bps: number, now: number): number | null {
        if (!Number.isFinite(bps) || bps <= 0) return null;
        this.estimates.set(sessionId, bps);
        return this.decide(now);
    }

    /** session が去った。残りの推定で決め直す。 */
    removeSession(sessionId: string, now: number): number | null {
        if (!this.estimates.delete(sessionId)) return null;
        return this.decide(now);
    }

    /** キーフレームを要求してよいか (直前の要求から 500ms 以上)。true なら要求した扱いにする。 */
    shouldRequestKeyframe(now: number): boolean {
        if (now - this.lastKeyframeAt < KEYFRAME_MIN_INTERVAL_MS) return false;
        this.lastKeyframeAt = now;
        return true;
    }

    private decide(now: number): number | null {
        if (this.estimates.size === 0) return null;
        const target = clamp(Math.min(...this.estimates.values()), this.limits.min, this.limits.max);
        if (Math.abs(target - this.current) < this.current * CHANGE_RATIO) {
            this.raiseSince = null;
            return null;
        }
        if (target < this.current) {
            this.raiseSince = null;
            this.current = target;
            return target;
        }
        if (this.raiseSince === null) {
            this.raiseSince = now;
            return null;
        }
        if (now - this.raiseSince < RAISE_HOLD_MS) return null;
        this.raiseSince = null;
        this.current = target;
        return target;
    }
}

function clamp(v: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, Math.round(v)));
}
