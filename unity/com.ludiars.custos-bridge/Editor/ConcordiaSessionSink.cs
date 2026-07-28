using System;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Ludiars.Custos.Bridge.Sinks;

namespace Ludiars.Custos.Bridge.Editor
{
    /// <summary>Concordia session chat endpoint adapter. Network I/O never runs on the Unity thread.</summary>
    public sealed class ConcordiaSessionSink : ICaptureSink
    {
        public string Id => "concordia-session";
        public string DisplayName => "Concordia Session";

        public async Task<SinkResult> SendAsync(CaptureEnvelope envelope, CancellationToken ct)
        {
            SinkResult result = await PostWithRetryAsync(envelope, ct);
            if (!result.Success)
                MainThreadDispatcher.Enqueue(() => UnityEngine.Debug.LogWarning($"[CustosBridge] Capture was saved but not sent: {envelope.PngPath} ({result.Error})"));
            return result;
        }

        private static async Task<SinkResult> PostWithRetryAsync(CaptureEnvelope envelope, CancellationToken ct)
        {
            SinkResult first = await Task.Run(() => Post(envelope, ct), ct);
            if (first.Success || ct.IsCancellationRequested) return first;
            await Task.Delay(500, ct);
            return await Task.Run(() => Post(envelope, ct), ct);
        }

        private static SinkResult Post(CaptureEnvelope envelope, CancellationToken ct)
        {
            try
            {
                ct.ThrowIfCancellationRequested();
                var request = (HttpWebRequest)WebRequest.Create($"http://127.0.0.1:{envelope.ConcordiaPort}/v1/chat");
                request.Method = "POST";
                request.ContentType = "application/json; charset=utf-8";
                request.Timeout = 5000;
                byte[] body = Encoding.UTF8.GetBytes(ConcordiaChatRequest.Build(envelope, envelope.AuthorLabel));
                using (var stream = request.GetRequestStream()) stream.Write(body, 0, body.Length);
                using (var response = (HttpWebResponse)request.GetResponse())
                    return response.StatusCode >= HttpStatusCode.OK && response.StatusCode < HttpStatusCode.MultipleChoices
                        ? SinkResult.Ok((int)response.StatusCode)
                        : SinkResult.Failed((int)response.StatusCode, response.StatusDescription);
            }
            catch (WebException exception)
            {
                var response = exception.Response as HttpWebResponse;
                return SinkResult.Failed(response == null ? 0 : (int)response.StatusCode, exception.Message);
            }
            catch (Exception exception) { return SinkResult.Failed(0, exception.Message); }
        }
    }
}
