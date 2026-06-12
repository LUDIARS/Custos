// RuntimeCameraViewProvider.cs — Player / Editor PlayMode 用フレーム取得
//
// 採用方式 (spec/unity-bridge.md §2.1):
//   ScreenCapture.CaptureScreenshotIntoRenderTexture(stagingRt)
//   → AsyncGPUReadback.Request → EncodeNativeArrayToPNG
//
// この方式で URP post-process + Screen Space Overlay UI を含む最終 backbuffer が取れる。
// ScreenCapture / AsyncGPUReadback は WaitForEndOfFrame コルーチン内で発行する。
//
// 要検証 (spec/unity-bridge.md §7 #1 #2):
//   - D3D11 での AsyncGPUReadback 行順 (graphicsUVStartsAtTop)
//   - Linear ColorSpace での staging RT sRGB 指定
#if UNITY_EDITOR || DEVELOPMENT_BUILD

using System;
using System.Collections;
using UnityEngine;
using UnityEngine.Rendering;
using Ludiars.Custos.Bridge.Capture;

namespace Ludiars.Custos.Bridge.Capture
{
    /// <summary>
    /// Player ビルドおよび Editor PlayMode で動作するフレームプロバイダ。
    /// MonoBehaviour (hidden GameObject) 上で動く。
    /// </summary>
    public sealed class RuntimeCameraViewProvider : MonoBehaviour, IFrameProvider
    {
        private RenderTexture _stagingRt;
        private int           _width;
        private int           _height;
        private int           _maxLongEdge = 1280;

        // screenshot 要求の coalescing (プロトタイプ由来)
        private ScreenshotRequest _pendingShot;
        private readonly object   _shotLock = new object();

        // stream 用最新フレームバッファ (IFrameStreamer 経由で更新)
        private IFrameStreamer    _streamer;
        private bool              _streamPumpRequested;

        // ── 初期化 ───────────────────────────────────────────

        public void Initialize(int maxLongEdge, IFrameStreamer streamer)
        {
            _maxLongEdge = maxLongEdge > 0 ? maxLongEdge : 1280;
            _streamer    = streamer;
        }

        private void EnsureRenderTexture(int w, int h)
        {
            if (_stagingRt != null && _stagingRt.width == w && _stagingRt.height == h)
                return;

            if (_stagingRt != null)
            {
                _stagingRt.Release();
                Destroy(_stagingRt);
            }

            // TODO(要検証 #2): Linear ColorSpace では RenderTextureReadWrite.sRGB を指定すること。
            //   KzSUnity の PlayerSettings.colorSpace を確認して下記を調整する。
            _stagingRt = new RenderTexture(w, h, 0,
                RenderTextureFormat.ARGB32, RenderTextureReadWrite.sRGB);
            _stagingRt.hideFlags = HideFlags.HideAndDontSave;
        }

        // ── IFrameProvider ──────────────────────────────────

        public void GetFrameSize(out int width, out int height)
        {
            width  = Mathf.Max(1, Screen.width);
            height = Mathf.Max(1, Screen.height);
        }

        public void RequestFrame(Action<byte[], string> onDone)
        {
            ScreenshotRequest mine;
            lock (_shotLock)
            {
                if (_pendingShot != null && !_pendingShot.IsSet)
                {
                    // 既に保留中 → 同じリクエストに便乗 (coalescing)
                    mine = _pendingShot;
                }
                else
                {
                    mine       = new ScreenshotRequest();
                    _pendingShot = mine;
                }
            }
            mine.AddCallback(onDone);
            // コルーチンは既に動いているか、なければ開始
            // (ScreenshotRequest が新規の場合のみ StartCoroutine を呼ぶ)
            if (mine.IsNew)
                StartCoroutine(CaptureCoroutine(mine));
        }

        public void PumpStream(IFrameStreamer streamer)
        {
            // ストリームリクエストがあれば毎フレームコルーチンを起動
            if (!_streamPumpRequested) return;
            _streamPumpRequested = false;
            StartCoroutine(StreamCaptureCoroutine());
        }

        // ── キャプチャコルーチン ──────────────────────────

        private IEnumerator CaptureCoroutine(ScreenshotRequest req)
        {
            yield return new WaitForEndOfFrame();

            GetFrameSize(out int rawW, out int rawH);
            ComputeDownscaled(rawW, rawH, _maxLongEdge, out int w, out int h);
            EnsureRenderTexture(w, h);

            ScreenCapture.CaptureScreenshotIntoRenderTexture(_stagingRt);

            // TODO(要検証 #1): graphicsUVStartsAtTop == true (D3D11) では
            //   CaptureScreenshotIntoRenderTexture の出力が top-down か bottom-up かを確認。
            //   問題があれば Graphics.Blit(src, dst, new Vector2(1,-1), new Vector2(0,1)) で反転。
            AsyncGPUReadback.Request(_stagingRt, 0, TextureFormat.RGBA32, request =>
            {
                if (request.hasError)
                {
                    req.Fail("AsyncGPUReadback error");
                    return;
                }
                var data = request.GetData<byte>();
                bool needFlip = SystemInfo.graphicsUVStartsAtTop; // TODO(要検証 #1)
                int capturedW = w, capturedH = h;
                _ = PngEncoder.EncodeNativeArrayToPngAsync(data, capturedW, capturedH, needFlip)
                    .ContinueWith(t =>
                    {
                        if (t.IsFaulted)
                            req.Fail(t.Exception?.Message ?? "encode error");
                        else
                            req.Succeed(t.Result);
                    });
            });
        }

        private IEnumerator StreamCaptureCoroutine()
        {
            yield return new WaitForEndOfFrame();

            GetFrameSize(out int rawW, out int rawH);
            ComputeDownscaled(rawW, rawH, _maxLongEdge, out int w, out int h);
            EnsureRenderTexture(w, h);

            ScreenCapture.CaptureScreenshotIntoRenderTexture(_stagingRt);

            int capturedW = w, capturedH = h;
            AsyncGPUReadback.Request(_stagingRt, 0, TextureFormat.RGBA32, request =>
            {
                if (request.hasError || _streamer == null) return;
                var data = request.GetData<byte>().ToArray();
                // AsyncGPUReadback は RGBA32 で読み返すため、
                // /stream プロトコルの BGRA に合わせて R↔B を入れ替える。
                // (PngEncoder.BgraToRgba は BGRA→RGBA だが変換方向は同一の R↔B スワップ)
                PngEncoder.BgraToRgba(data); // RGBA → BGRA 変換
                // TODO(要検証 #1): flip が必要なら PngEncoder.FlipRows も呼ぶ
                _streamer.UpdateFrame(data, capturedW, capturedH);
            });
        }

        // ── ストリームポンプ要求 ──────────────────────────

        public void RequestStreamPump()
        {
            _streamPumpRequested = true;
        }

        // ── ユーティリティ ───────────────────────────────

        private static void ComputeDownscaled(int w, int h, int maxLong, out int outW, out int outH)
        {
            if (maxLong <= 0 || (w <= maxLong && h <= maxLong))
            {
                outW = Mathf.Max(1, w);
                outH = Mathf.Max(1, h);
                return;
            }
            float scale = (float)maxLong / Mathf.Max(w, h);
            outW = Mathf.Max(1, Mathf.RoundToInt(w * scale));
            outH = Mathf.Max(1, Mathf.RoundToInt(h * scale));
        }

        private void OnDestroy()
        {
            if (_stagingRt != null)
            {
                _stagingRt.Release();
                Destroy(_stagingRt);
                _stagingRt = null;
            }
        }

        // ── 内部リクエスト型 ─────────────────────────────

        private sealed class ScreenshotRequest
        {
            private readonly System.Collections.Generic.List<Action<byte[], string>> _callbacks
                = new System.Collections.Generic.List<Action<byte[], string>>();
            private readonly object _lock = new object();
            private bool _done;

            public bool IsSet => _done;
            public bool IsNew { get; private set; } = true;

            public void AddCallback(Action<byte[], string> cb)
            {
                lock (_lock)
                {
                    if (_done) return; // 遅れた便乗は捨てる
                    _callbacks.Add(cb);
                    IsNew = _callbacks.Count == 1;
                }
            }

            public void Succeed(byte[] png)
            {
                lock (_lock)
                {
                    _done = true;
                    foreach (var cb in _callbacks) TryInvoke(cb, png, null);
                    _callbacks.Clear();
                }
            }

            public void Fail(string error)
            {
                lock (_lock)
                {
                    _done = true;
                    foreach (var cb in _callbacks) TryInvoke(cb, null, error);
                    _callbacks.Clear();
                }
            }

            private static void TryInvoke(Action<byte[], string> cb, byte[] png, string err)
            {
                try { cb(png, err); } catch { }
            }
        }
    }
}

#endif // UNITY_EDITOR || DEVELOPMENT_BUILD
