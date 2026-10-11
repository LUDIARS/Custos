// PointerCoordinates.cs — /pointer の正規化座標 → Input System のスクリーン座標 (純関数)
//
// Custos は配信映像の左上原点 0..1 を送る。Input System の Mouse.position は
// 左下原点のピクセルなので y を反転して画面サイズを掛ける。
#if UNITY_EDITOR || DEVELOPMENT_BUILD

using UnityEngine;

namespace Ludiars.Custos.Bridge.Input
{
    public static class PointerCoordinates
    {
        /// <summary>正規化座標 (左上原点) → スクリーン座標 (左下原点、ピクセル)。範囲外は clamp。</summary>
        public static Vector2 ToScreen(float x01, float y01, int screenWidth, int screenHeight)
        {
            float x = Mathf.Clamp01(float.IsNaN(x01) ? 0f : x01);
            float y = Mathf.Clamp01(float.IsNaN(y01) ? 0f : y01);
            return new Vector2(x * screenWidth, (1f - y) * screenHeight);
        }

        /// <summary>"down" / "up" / "move" 以外は null。</summary>
        public static bool? PhaseToPressed(string phase)
        {
            switch (phase)
            {
                case "down": return true;
                case "up":   return false;
                default:     return null;
            }
        }

        public static bool IsKnownPhase(string phase)
            => phase == "down" || phase == "up" || phase == "move";
    }
}

#endif // UNITY_EDITOR || DEVELOPMENT_BUILD
