// BitratePayload.cs — POST /stream/bitrate の body ({"bps": 1500000})
#if UNITY_EDITOR || DEVELOPMENT_BUILD

using System;

namespace Ludiars.Custos.Bridge.Protocol
{
    [Serializable]
    public class BitratePayload
    {
        public int bps;
    }
}

#endif // UNITY_EDITOR || DEVELOPMENT_BUILD
