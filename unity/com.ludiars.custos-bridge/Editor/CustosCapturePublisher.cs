using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using Ludiars.Custos.Bridge.Capture;
using Ludiars.Custos.Bridge.Sinks;

namespace Ludiars.Custos.Bridge.Editor
{
    /// <summary>Owns the P0 capture flow: main-thread capture, background session resolution and delivery.</summary>
    public static class CustosCapturePublisher
    {
        private static IFrameProvider _provider;
        private static BridgeConfig _config;

        public static void Configure(IFrameProvider provider, BridgeConfig config) { _provider = provider; _config = config; }
        public static void Reset() { _provider = null; _config = null; }

        public static void Publish(string source, string caption)
        {
            _ = PublishAsync(new PublishCaptureRequest { source = source, caption = caption });
        }

        internal static async Task<PublishCaptureResult> PublishAsync(PublishCaptureRequest request)
        {
            if (_provider == null || _config == null)
                return Failed(503, "bridge is not enabled");
            if (string.Equals(request?.source, "sceneview", StringComparison.OrdinalIgnoreCase))
                return Failed(501, "sceneview capture is not implemented until P2");
            if (!string.IsNullOrEmpty(request?.source) && !string.Equals(request.source, "gameview", StringComparison.OrdinalIgnoreCase))
                return Failed(400, "source must be gameview or sceneview");

            CaptureEnvelope envelope;
            try { envelope = await CaptureAsync(request?.caption); }
            catch (Exception exception) { return Failed(503, exception.Message); }

            string sessionId = request?.session_id;
            List<SessionCandidate> candidates = null;
            if (string.IsNullOrEmpty(sessionId)) sessionId = _config.SessionId;
            if (string.IsNullOrEmpty(sessionId)) sessionId = ReadBoundSession();
            if (string.IsNullOrEmpty(sessionId))
            {
                var resolution = await ResolveSessionAsync();
                sessionId = resolution.SessionId;
                candidates = resolution.Candidates;
            }
            if (string.IsNullOrEmpty(sessionId))
            {
                LogWarning("[CustosBridge] No bound session. Capture retained at: " + envelope.PngPath + ". Candidates: " + CandidateLabels(candidates));
                return new PublishCaptureResult { StatusCode = 409, Error = "no bound session", PngPath = envelope.PngPath, Candidates = candidates };
            }

            envelope.SessionId = sessionId;
            var sink = CaptureSinkRegistry.Find(request?.sink);
            if (sink == null) return Failed(400, "unknown capture sink", envelope.PngPath);
            SinkResult result = await sink.SendAsync(envelope, CancellationToken.None);
            _ = Task.Run(CleanupOldCaptures);
            return new PublishCaptureResult { Success = result.Success, StatusCode = result.Success ? 200 : 503, Error = result.Error, PngPath = envelope.PngPath };
        }

        private static Task<CaptureEnvelope> CaptureAsync(string caption)
        {
            var completion = new TaskCompletionSource<CaptureEnvelope>();
            MainThreadDispatcher.Enqueue(() =>
            {
                try
                {
                    var context = CollectContext();
                    _provider.RequestFrame((png, error) =>
                    {
                        if (png == null) { completion.TrySetException(new InvalidOperationException(error ?? "empty png")); return; }
                        try
                        {
                            Directory.CreateDirectory(CaptureStorage.CaptureDirectory);
                            string path = CaptureStorage.CreatePath(DateTime.Now);
                            File.WriteAllBytes(path, png);
                            completion.TrySetResult(new CaptureEnvelope
                            {
                                PngPath = path,
                                Caption = string.IsNullOrEmpty(caption) ? DefaultCaption(context) : caption,
                                Context = context,
                                ConcordiaPort = _config.ConcordiaPort,
                                AuthorLabel = _config.AuthorLabel,
                            });
                        }
                        catch (Exception exception) { completion.TrySetException(exception); }
                    });
                }
                catch (Exception exception) { completion.TrySetException(exception); }
            });
            return completion.Task;
        }

        private static UnityContext CollectContext()
        {
            var selected = Selection.activeGameObject;
            return new UnityContext
            {
                SceneName = EditorSceneManager.GetActiveScene().name,
                IsPlaying = EditorApplication.isPlaying,
                UnityVersion = Application.unityVersion,
                CompileErrorCount = 0,
                SelectedObjectPath = selected == null ? string.Empty : AnimationUtility.CalculateTransformPath(selected.transform, null),
            };
        }

        private static string DefaultCaption(UnityContext context)
        {
            return $"Unity capture: {context.SceneName} ({(context.IsPlaying ? "Play" : "Edit")} Mode)";
        }

        private static string ReadBoundSession()
        {
            try
            {
                string path = Path.Combine(ProjectRoot, "custos", "bound-session.json");
                if (!File.Exists(path)) return null;
                return JsonUtility.FromJson<BoundSession>(File.ReadAllText(path))?.session_id;
            }
            catch (Exception exception) { LogWarning("[CustosBridge] Bound session read failed: " + exception.Message); return null; }
        }

        private static async Task<SessionResolution> ResolveSessionAsync()
        {
            var sessions = await Task.Run(GetActiveProjectSessions);
            string sessionId = SessionSelection.SelectSingleActiveProjectSession(sessions, ProjectRoot, out var candidates);
            return new SessionResolution { SessionId = sessionId, Candidates = candidates };
        }

        private static List<SessionCandidate> GetActiveProjectSessions()
        {
            try
            {
                var request = (HttpWebRequest)WebRequest.Create($"http://127.0.0.1:{_config.ConcordiaPort}/v1/sessions");
                request.Timeout = 3000;
                using (var response = (HttpWebResponse)request.GetResponse())
                using (var reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
                    return JsonUtility.FromJson<SessionsResponse>(reader.ReadToEnd())?.sessions ?? new List<SessionCandidate>();
            }
            catch (Exception exception) { LogWarning("[CustosBridge] Session lookup failed: " + exception.Message); return new List<SessionCandidate>(); }
        }

        private static void CleanupOldCaptures()
        {
            try
            {
                var directory = new DirectoryInfo(CaptureStorage.CaptureDirectory);
                if (!directory.Exists) return;
                foreach (string path in CaptureStorage.SelectCleanupPaths(directory.GetFiles("*.png"), DateTime.UtcNow)) File.Delete(path);
            }
            catch (Exception exception) { LogWarning("[CustosBridge] Capture cleanup failed: " + exception.Message); }
        }

        private static void LogWarning(string message) => MainThreadDispatcher.Enqueue(() => Debug.LogWarning(message));
        private static string CandidateLabels(IEnumerable<SessionCandidate> candidates)
        {
            if (candidates == null) return "none";
            var labels = new List<string>();
            foreach (var candidate in candidates) labels.Add(candidate.session_id);
            return labels.Count == 0 ? "none" : string.Join(", ", labels);
        }

        private static PublishCaptureResult Failed(int status, string error, string pngPath = null) => new PublishCaptureResult { StatusCode = status, Error = error, PngPath = pngPath };
        private static string ProjectRoot => Path.GetDirectoryName(Application.dataPath);

        [Serializable] private sealed class BoundSession { public string session_id; }
        [Serializable] private sealed class SessionsResponse { public List<SessionCandidate> sessions; }
        private sealed class SessionResolution { public string SessionId; public List<SessionCandidate> Candidates; }
    }
}
