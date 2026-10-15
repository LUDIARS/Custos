// StaticFrameGate.cs — 画面が変わらない間はエンコードしない判定 (純ロジック、EditMode テスト対象)
//
// 変わらないフレームを送らなければ、エンコード・転送・CPU がほぼゼロになる。ただし途中から見始めた
// ブラウザと損失からの回復のため、変わらなくても MinIntervalMs ごとに 1 枚は通す
// (spec/feature/webrtc-efficiency.md §6.1)。キーフレーム要求があるときは必ず通す。
//
// また配信の fps を超えては通さない (FrameIntervalMs)。エンコーダのレート制御は「ビットレート ÷ fps」を
// 1 枚の予算にするので、Editor の更新ごと (fps より速い) に渡すとビットレートを超える。
#if UNITY_EDITOR || DEVELOPMENT_BUILD

using System;

namespace Ludiars.Custos.Bridge.VideoEncoding
{
    public sealed class StaticFrameGate
    {
        public const long MinIntervalMs = 1000;

        private long _lastPassedMs = long.MinValue;

        /// <summary>配信 fps から決まる 1 枚の最短間隔 (ms)。0 なら間引かない。</summary>
        public long FrameIntervalMs { get; set; }

        /// <summary>このフレームをエンコードするか。通したら時刻を覚える。</summary>
        public bool ShouldEncode(bool changed, bool keyframeRequested, long nowMs)
        {
            bool first = _lastPassedMs == long.MinValue;
            long since = first ? long.MaxValue : nowMs - _lastPassedMs;
            // fps を超える分は捨てる (キーフレーム要求は待たせない)。1 割の余裕は時刻の揺れの分。
            if (!keyframeRequested && since < FrameIntervalMs * 9 / 10) return false;
            bool pass = changed || keyframeRequested || first || since >= MinIntervalMs;
            if (pass) _lastPassedMs = nowMs;
            return pass;
        }

        /// <summary>2 枚の NV12 が同じか (長さが違えば変わったとみなす)。</summary>
        public static bool SameFrame(byte[] a, byte[] b)
        {
            if (a == null || b == null || a.Length != b.Length) return false;
            return a.AsSpan().SequenceEqual(b);
        }
    }
}

#endif // UNITY_EDITOR || DEVELOPMENT_BUILD
