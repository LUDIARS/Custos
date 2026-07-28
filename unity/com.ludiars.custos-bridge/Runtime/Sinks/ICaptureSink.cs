#if UNITY_EDITOR || DEVELOPMENT_BUILD

using System.Threading;
using System.Threading.Tasks;

namespace Ludiars.Custos.Bridge.Sinks
{
    public interface ICaptureSink
    {
        string Id { get; }
        string DisplayName { get; }
        Task<SinkResult> SendAsync(CaptureEnvelope envelope, CancellationToken ct);
    }
}

#endif
