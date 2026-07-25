#if UNITY_EDITOR || DEVELOPMENT_BUILD

namespace Ludiars.Custos.Bridge.Sinks
{
    public sealed class CaptureEnvelope
    {
        public string PngPath;
        public string Caption;
        public UnityContext Context;
        public string SessionId;
        public int ConcordiaPort;
        public string AuthorLabel;
    }

    public sealed class UnityContext
    {
        public string SceneName;
        public bool IsPlaying;
        public string UnityVersion;
        public int CompileErrorCount;
        public string SelectedObjectPath;
    }

    public sealed class SinkResult
    {
        public bool Success;
        public int StatusCode;
        public string Error;

        public static SinkResult Ok(int statusCode) => new SinkResult { Success = true, StatusCode = statusCode };
        public static SinkResult Failed(int statusCode, string error) => new SinkResult { Success = false, StatusCode = statusCode, Error = error };
    }
}

#endif
