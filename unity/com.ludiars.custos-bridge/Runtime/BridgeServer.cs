// BridgeServer.cs — HttpListener 起動/停止 + accept loop + ルーティング
//
// 責務: HTTP の受け口と各ハンドラへの振り分け。Unity API は直接触らない。
// provider / injector / streamer は interface / 具象クラスを注入して使う。
//
// 設計 (spec/unity-bridge.md §4.1):
//   - 同期 GetContext() loop (スループット要件が低い単一クライアント前提)
//   - /key は enqueue → 即 200 (fire-and-forget)
//   - /screenshot は coalescing pending + ManualResetEventSlim でブロック (timeout 7s)
//   - /stream は配信スレッドへそのまま渡す (ブロッキング)
#if UNITY_EDITOR || DEVELOPMENT_BUILD

using System;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using UnityEngine;
using Ludiars.Custos.Bridge.Capture;
using Ludiars.Custos.Bridge.Protocol;
using Ludiars.Custos.Bridge.Sinks;

namespace Ludiars.Custos.Bridge
{
    /// <summary>
    /// ergo_custos 互換 HTTP ブリッジサーバ。
    /// Unity API には触れない — provider / injector / dispatcher を注入する。
    /// </summary>
    public sealed class BridgeServer
    {
        private const int ScreenshotTimeoutMs = 7000;

        // ── 外部依存 (注入) ─────────────────────────────
        private readonly IFrameProvider          _provider;
        private readonly FrameStreamer           _streamer;
        private readonly BridgeConfig            _config;

        // ── HTTP ────────────────────────────────────────
        private HttpListener _listener;
        private Thread       _listenerThread;
        private volatile bool _isRunning;

        // ── screenshot coalescing ────────────────────────
        private PendingScreenshot _pending;
        private readonly object   _pendingLock = new object();

        // ── インジェクタコールバック ──────────────────────
        // BridgeServer は Input System に依存しない。key inject は callback で外に委譲。
        private readonly Action<int, bool, Action<bool>> _onKey;
        private readonly Func<PublishCaptureRequest, Task<PublishCaptureResult>> _onPublishCapture;

        // ── コンストラクタ ───────────────────────────────

        /// <param name="provider">フレームプロバイダ (main thread で動く)</param>
        /// <param name="streamer">ストリーマ</param>
        /// <param name="config">設定</param>
        /// <param name="onKey">キー注入コールバック (hidCode, down, result(success)) — main thread dispatcher 経由で呼ばれる</param>
        public BridgeServer(
            IFrameProvider provider,
            FrameStreamer   streamer,
            BridgeConfig    config,
            Action<int, bool, Action<bool>> onKey,
            Func<PublishCaptureRequest, Task<PublishCaptureResult>> onPublishCapture)
        {
            _provider = provider;
            _streamer  = streamer;
            _config   = config;
            _onKey    = onKey;
            _onPublishCapture = onPublishCapture;
        }

        // ── 公開 API ─────────────────────────────────────

        public bool IsRunning => _isRunning;

        public void Start()
        {
            if (_isRunning) return;
            try
            {
                _listener = new HttpListener();
                // loopback only (spec §4.3)
                _listener.Prefixes.Add($"http://127.0.0.1:{_config.Port}/");
                _listener.Start();
                _isRunning = true;
                _listenerThread = new Thread(Loop)
                {
                    IsBackground = true,
                    Name = "CustosBridgeListener"
                };
                _listenerThread.Start();
                Debug.Log($"[CustosBridge] Server started on port {_config.Port}");
            }
            catch (Exception e)
            {
                Debug.LogError($"[CustosBridge] Server start failed: {e.Message}");
                _isRunning = false;
            }
        }

        public void Stop()
        {
            _isRunning = false;
            try { _listener?.Stop(); _listener?.Close(); } catch { }
            _listener = null;
            try { _listenerThread?.Join(1000); } catch { }
            _listenerThread = null;
            Debug.Log("[CustosBridge] Server stopped.");
        }

        // ── accept loop ──────────────────────────────────

        private void Loop()
        {
            while (_isRunning && _listener != null)
            {
                HttpListenerContext ctx;
                try { ctx = _listener.GetContext(); }
                catch (HttpListenerException) { return; }
                catch (ObjectDisposedException) { return; }
                catch (Exception e)
                {
                    if (_isRunning) Debug.LogError($"[CustosBridge] Accept error: {e.Message}");
                    return;
                }

                try { ProcessRequest(ctx); }
                catch (Exception e)
                {
                    if (_isRunning) Debug.LogError($"[CustosBridge] Process error: {e.Message}");
                }
            }
        }

        // ── ルーティング ─────────────────────────────────

        private void ProcessRequest(HttpListenerContext ctx)
        {
            var req = ctx.Request;
            var res = ctx.Response;

            // CORS
            res.Headers.Set("Access-Control-Allow-Origin", "*");
            res.Headers.Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
            res.Headers.Set("Access-Control-Allow-Headers", "Content-Type, X-Auth-Token");
            if (req.HttpMethod == "OPTIONS") { HttpJson.WriteCorsOptions(res); return; }

            // 認証
            if (!string.IsNullOrEmpty(_config.Token))
            {
                string given = req.Headers["X-Auth-Token"];
                if (given != _config.Token)
                {
                    HttpJson.WriteJson(res, 401, "{\"error\":\"unauthorized\"}");
                    return;
                }
            }

            string path = req.Url.AbsolutePath.ToLowerInvariant().TrimEnd('/');
            switch (path)
            {
                case "/health":
                    HandleHealth(req, res);
                    break;
                case "/screenshot":
                    if (req.HttpMethod != "GET") { HttpJson.WriteJson(res, 405, "{\"error\":\"GET only\"}"); return; }
                    HandleScreenshot(res);
                    break;
                case "/key":
                    if (req.HttpMethod != "POST") { HttpJson.WriteJson(res, 405, "{\"error\":\"POST only\"}"); return; }
                    HandleKey(req, res);
                    break;
                case "/stream":
                    if (req.HttpMethod != "GET") { HttpJson.WriteJson(res, 405, "{\"error\":\"GET only\"}"); return; }
                    HandleStream(ctx);
                    break;
                case "/editor/publish-capture":
                    if (req.HttpMethod != "POST") { HttpJson.WriteJson(res, 405, "{\"error\":\"POST only\"}"); return; }
                    HandlePublishCapture(req, res);
                    break;
                default:
                    HttpJson.WriteJson(res, 404, "{\"error\":\"unknown endpoint\"}");
                    break;
            }
        }

        // ── /health ──────────────────────────────────────

        private void HandleHealth(HttpListenerRequest req, HttpListenerResponse res)
        {
            // isPlaying は main thread でしか読めないため、
            // dispatcher 経由で取得して ManualResetEventSlim で待つ
            bool isPlaying = false;
            using var gate = new ManualResetEventSlim(false);
            MainThreadDispatcher.Enqueue(() =>
            {
                isPlaying = Application.isPlaying;
                gate.Set();
            });
            gate.Wait(500);
            HttpJson.WriteJson(res, 200,
                $"{{\"status\":\"ok\",\"isPlaying\":{(isPlaying ? "true" : "false")}}}");
        }

        // ── /screenshot ──────────────────────────────────

        private void HandleScreenshot(HttpListenerResponse res)
        {
            PendingScreenshot mine;
            lock (_pendingLock)
            {
                if (_pending != null && !_pending.Gate.IsSet)
                {
                    mine = _pending; // coalescing: 既存リクエストに便乗
                }
                else
                {
                    mine     = new PendingScreenshot();
                    _pending = mine;
                    // main thread にキャプチャ要求を enqueue
                    MainThreadDispatcher.Enqueue(() => ExecuteCapture(mine));
                }
            }

            bool done = mine.Gate.Wait(ScreenshotTimeoutMs);
            if (!done)                { HttpJson.WriteJson(res, 503, "{\"error\":\"capture timeout\"}"); return; }
            if (mine.Error != null)   { HttpJson.WriteJson(res, 503, $"{{\"error\":\"{HttpJson.Escape(mine.Error)}\"}}"); return; }
            if (mine.Png == null)     { HttpJson.WriteJson(res, 503, "{\"error\":\"empty png\"}"); return; }

            HttpJson.WriteBinary(res, 200, "image/png", mine.Png);
        }

        private void ExecuteCapture(PendingScreenshot req)
        {
            try
            {
                _provider.RequestFrame((png, err) =>
                {
                    req.Png   = png;
                    req.Error = err;
                    req.Gate.Set();
                    lock (_pendingLock) { if (_pending == req) _pending = null; }
                });
            }
            catch (Exception e)
            {
                req.Error = e.Message;
                req.Gate.Set();
            }
        }

        // ── /key ─────────────────────────────────────────

        private void HandleKey(HttpListenerRequest req, HttpListenerResponse res)
        {
            string body;
            try
            {
                using var sr = new StreamReader(req.InputStream, req.ContentEncoding ?? Encoding.UTF8);
                body = sr.ReadToEnd();
            }
            catch (Exception e)
            {
                HttpJson.WriteJson(res, 400, $"{{\"error\":\"read body: {HttpJson.Escape(e.Message)}\"}}");
                return;
            }

            KeyPayload payload;
            try { payload = JsonUtility.FromJson<KeyPayload>(body); }
            catch { HttpJson.WriteJson(res, 400, "{\"error\":\"bad json\"}"); return; }
            if (payload == null) { HttpJson.WriteJson(res, 400, "{\"error\":\"empty json\"}"); return; }

            // fire-and-forget: dispatcher に enqueue して即 200 を返す
            MainThreadDispatcher.Enqueue(() =>
            {
                _onKey?.Invoke(payload.code, payload.down, success =>
                {
                    if (!success)
                        Debug.LogWarning($"[CustosBridge] key inject failed: code={payload.code}");
                });
            });

            HttpJson.WriteJson(res, 200, "{\"ok\":true}");
        }

        // ── /stream ──────────────────────────────────────

        private void HandleStream(HttpListenerContext ctx)
        {
            // FrameStreamer がブロッキングで配信する
            _streamer.StartStream(ctx);
        }

        // P0 only. SceneView capture is explicitly deferred until the P2 provider exists.
        private void HandlePublishCapture(HttpListenerRequest req, HttpListenerResponse res)
        {
            if (_onPublishCapture == null) { HttpJson.WriteJson(res, 503, "{\"error\":\"capture publisher unavailable\"}"); return; }
            try
            {
                string body;
                using (var reader = new StreamReader(req.InputStream, req.ContentEncoding ?? Encoding.UTF8)) body = reader.ReadToEnd();
                var payload = JsonUtility.FromJson<PublishCaptureRequest>(body) ?? new PublishCaptureRequest();
                var result = _onPublishCapture(payload).GetAwaiter().GetResult();
                int status = result.StatusCode == 0 ? 503 : result.StatusCode;
                string json = "{\"ok\":" + (result.Success ? "true" : "false") +
                    ",\"error\":\"" + HttpJson.Escape(result.Error) + "\",\"png_path\":\"" + HttpJson.Escape(result.PngPath) + "\",\"candidates\":" + CandidatesJson(result) + "}";
                HttpJson.WriteJson(res, status, json);
            }
            catch (Exception e) { HttpJson.WriteJson(res, 503, "{\"error\":\"" + HttpJson.Escape(e.Message) + "\"}"); }
        }

        private static string CandidatesJson(PublishCaptureResult result)
        {
            if (result.Candidates == null) return "[]";
            var builder = new StringBuilder("[");
            for (int index = 0; index < result.Candidates.Count; index++)
            {
                if (index > 0) builder.Append(',');
                var candidate = result.Candidates[index];
                builder.Append("{\"session_id\":\"").Append(HttpJson.Escape(candidate.session_id)).Append("\",\"label\":\"").Append(HttpJson.Escape(candidate.label)).Append("\"}");
            }
            return builder.Append(']').ToString();
        }

        // ── 内部型 ───────────────────────────────────────

        private sealed class PendingScreenshot
        {
            public readonly ManualResetEventSlim Gate = new ManualResetEventSlim(false);
            public byte[]  Png;
            public string  Error;
        }
    }
}

#endif // UNITY_EDITOR || DEVELOPMENT_BUILD
