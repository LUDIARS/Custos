// EditorControlRoutes.cs — /editor/* の受け口 (Editor 専用)
//
// BridgeServer (Runtime) の追加エンドポイントとして登録する。listener スレッドで呼ばれるので、
// Unity API を触る処理は MainThreadCall で main thread へ回す。ログだけはスレッドセーフな
// バッファを直接読む (コンパイル中・リロード直後でも返せるように)。
// 契約: Custos src/unity/bridge-contract.ts / bridge-client.ts。
using System;
using UnityEditor;
using UnityEditor.Compilation;
using Ludiars.Custos.Bridge.Protocol;

namespace Ludiars.Custos.Bridge.Editor.Control
{
    internal sealed class EditorControlRoutes : IBridgeRouteHandler
    {
        private const int MainThreadTimeoutMs = 2000;
        private const int DefaultLogLimit = 200;
        private const int MaxLogLimit = 1000;

        public bool Handles(string path) => path != null && path.StartsWith("/editor/", StringComparison.Ordinal);

        public BridgeRouteResponse Handle(BridgeRouteRequest request)
        {
            switch (request.Path)
            {
                case "/editor/status":         return Get(request, EditorSnapshots.StatusJson);
                case "/editor/compile-status": return Get(request, CompileStatusTracker.StatusJson);
                case "/editor/scene":          return Get(request, EditorSnapshots.SceneJson);
                case "/editor/hierarchy":      return Hierarchy(request);
                case "/editor/log":            return Log(request);
                case "/editor/play":           return Post(request, () => { EditorApplication.isPlaying = true; });
                case "/editor/stop":           return Post(request, () => { EditorApplication.isPlaying = false; });
                case "/editor/compile":        return Post(request, () => CompilationPipeline.RequestScriptCompilation());
                case "/editor/refresh":        return Post(request, () => AssetDatabase.Refresh());
                default:                       return new BridgeRouteResponse(404, "{\"error\":\"unknown endpoint\"}");
            }
        }

        private static BridgeRouteResponse Get(BridgeRouteRequest request, Func<string> snapshot)
        {
            if (request.Method != "GET") return MethodNotAllowed("GET");
            return OnMainThread(snapshot);
        }

        private static BridgeRouteResponse Post(BridgeRouteRequest request, Action action)
        {
            if (request.Method != "POST") return MethodNotAllowed("POST");
            // 操作は待ち切れなくてもキューに残って後で実行されるので、失敗ではなく受付 (202) と返す。
            if (MainThreadCall.TryRun(() => { action(); return true; }, MainThreadTimeoutMs, out _, out string error, out bool timedOut))
                return new BridgeRouteResponse(200, "{\"ok\":true}");
            if (timedOut)
                return new BridgeRouteResponse(202, "{\"ok\":true,\"queued\":true}");
            return new BridgeRouteResponse(500, $"{{\"error\":\"{HttpJson.Escape(error)}\"}}");
        }

        private static BridgeRouteResponse Hierarchy(BridgeRouteRequest request)
        {
            if (request.Method != "GET") return MethodNotAllowed("GET");
            int depth = ParseInt(request.Query["depth"], 2, 1, 10);
            string root = request.Query["root"];
            var response = OnMainThread(() => EditorSnapshots.HierarchyJson(depth, root) ?? string.Empty);
            if (response.Status == 200 && response.Json.Length == 0)
                return new BridgeRouteResponse(404, "{\"error\":\"root not found\"}");
            return response;
        }

        private static BridgeRouteResponse Log(BridgeRouteRequest request)
        {
            if (request.Method != "GET") return MethodNotAllowed("GET");
            long since = long.TryParse(request.Query["since"], out long s) && s > 0 ? s : 0;
            int limit = ParseInt(request.Query["limit"], DefaultLogLimit, 1, MaxLogLimit);
            return new BridgeRouteResponse(200, EditorLogBuffer.PageJson(since, request.Query["level"], limit));
        }

        private static BridgeRouteResponse OnMainThread(Func<string> work)
        {
            if (MainThreadCall.TryRun(work, MainThreadTimeoutMs, out string json, out string error, out bool timedOut))
                return new BridgeRouteResponse(200, json);
            return new BridgeRouteResponse(timedOut ? 503 : 500, $"{{\"error\":\"{HttpJson.Escape(error)}\"}}");
        }

        private static BridgeRouteResponse MethodNotAllowed(string method)
            => new BridgeRouteResponse(405, $"{{\"error\":\"{method} only\"}}");

        private static int ParseInt(string raw, int fallback, int min, int max)
        {
            if (!int.TryParse(raw, out int value)) return fallback;
            return Math.Min(max, Math.Max(min, value));
        }
    }
}
