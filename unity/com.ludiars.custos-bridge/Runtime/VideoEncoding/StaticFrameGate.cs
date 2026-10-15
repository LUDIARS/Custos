// StaticFrameGate.cs — 画面が変わらない間はエンコードしない判定 (純ロジック、EditMode テスト対象)
//
// 変わらないフレームを送らなければ、エンコード・転送・CPU がほぼゼロになる。ただし途中から見始めた
// ブラウザと損失からの回復のため、変わらなくても MinIntervalMs ごとに 1 枚は通す
// (spec/feature/webrtc-efficiency.md §6.1)。キーフレーム要求があるときは必ず通す。
#if UNITY_EDITOR || DEVELOPMENT_BUILD

using System;

namespace Ludiars.Custos.Bridge.VideoEncoding
{
    public sealed class StaticFrameGate
    {
        public const long MinIntervalMs = 1000;

        private long _lastPassedMs = long.MinValue;

        /// <summary>このフレームをエンコードするか。通したら時刻を覚える。</summary>
        public bool ShouldEncode(bool changed, bool keyframeRequested, long nowMs)
        {
            bool pass = changed || keyframeRequested || _lastPassedMs == long.MinValue || nowMs - _lastPassedMs >= MinIntervalMs;
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
