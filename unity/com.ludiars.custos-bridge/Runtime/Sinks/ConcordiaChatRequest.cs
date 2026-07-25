#if UNITY_EDITOR || DEVELOPMENT_BUILD

namespace Ludiars.Custos.Bridge.Sinks
{
    public static class ConcordiaChatRequest
    {
        public static string Build(CaptureEnvelope envelope, string authorLabel)
        {
            return "{\"channel\":\"報告\",\"session_id\":\"" + Escape(envelope.SessionId) +
                "\",\"author_label\":\"" + Escape(authorLabel) + "\",\"text\":\"" + Escape(envelope.Caption) +
                "\",\"attachment_paths\":[\"" + Escape(envelope.PngPath) + "\"]}";
        }

        private static string Escape(string value)
        {
            return (value ?? string.Empty).Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\n", "\\n").Replace("\r", "\\r");
        }
    }
}

#endif
