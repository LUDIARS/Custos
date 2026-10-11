// PointerPayload.cs — /pointer エンドポイントのリクエスト DTO
// ergo-custos-client.ts の sendPointerEvent の body と一致させること。
#if UNITY_EDITOR || DEVELOPMENT_BUILD

using System;

namespace Ludiars.Custos.Bridge.Protocol
{
    /// <summary>
    /// POST /pointer のリクエスト JSON DTO。
    /// { "x": 0..1, "y": 0..1, "button": 0|1|2, "phase": "down"|"up"|"move" }
    /// x / y は配信映像の左上原点の正規化座標。
    /// </summary>
    [Serializable]
    public class PointerPayload
    {
        public float  x;
        public float  y;
        public int    button;
        public string phase;
    }
}

#endif // UNITY_EDITOR || DEVELOPMENT_BUILD
