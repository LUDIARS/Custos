// StreamResolution.cs — 配信解像度の決定 (純ロジック、EditMode テスト対象)
//
// 映像の大きさを Game View の窓の大きさに任せず、上限 (例 1280x720) に収まるよう縦横比を保って
// 拡大・縮小し、幅・高さを 16 の倍数にそろえる (H.264 のマクロブロック。spec/feature/webrtc-efficiency.md §5)。
#if UNITY_EDITOR || DEVELOPMENT_BUILD

using System;

namespace Ludiars.Custos.Bridge.VideoEncoding
{
    public static class StreamResolution
    {
        public const int Align = 16;
        public const int MinSize = 64;

        /// <summary>
        /// src (画面の大きさ) を max の枠に縦横比を保って収め、16 の倍数に丸めた大きさを返す。
        /// 小さい画面は枠まで拡大する (窓の大きさで解像度が変わらないように)。
        /// </summary>
        public static void Fit(int srcWidth, int srcHeight, int maxWidth, int maxHeight, out int width, out int height)
        {
            if (srcWidth <= 0 || srcHeight <= 0) { srcWidth = maxWidth; srcHeight = maxHeight; }
            maxWidth = Math.Max(MinSize, maxWidth);
            maxHeight = Math.Max(MinSize, maxHeight);
            double scale = Math.Min((double)maxWidth / srcWidth, (double)maxHeight / srcHeight);
            width = AlignDown(Math.Max(MinSize, (int)Math.Round(srcWidth * scale)), maxWidth);
            height = AlignDown(Math.Max(MinSize, (int)Math.Round(srcHeight * scale)), maxHeight);
        }

        /// <summary>16 の倍数に切り捨てる (ただし上限 limit も 16 の倍数に切り捨てた値を超えない)。</summary>
        private static int AlignDown(int value, int limit)
        {
            int capped = Math.Min(value, limit);
            int aligned = capped / Align * Align;
            return Math.Max(Align, aligned);
        }
    }
}

#endif // UNITY_EDITOR || DEVELOPMENT_BUILD
