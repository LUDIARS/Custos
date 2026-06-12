// KeyPayload.cs — /key エンドポイントのリクエスト DTO
// ergo-custos-client.ts の POST /key body と一致させること。
#if UNITY_EDITOR || DEVELOPMENT_BUILD

using System;
using UnityEngine;

namespace Ludiars.Custos.Bridge.Protocol
{
    /// <summary>
    /// POST /key のリクエスト JSON DTO。
    /// { "code": &lt;HID usage int&gt;, "down": &lt;bool&gt; }
    /// </summary>
    [Serializable]
    public class KeyPayload
    {
        public int  code;
        public bool down;
    }
}

#endif // UNITY_EDITOR || DEVELOPMENT_BUILD
