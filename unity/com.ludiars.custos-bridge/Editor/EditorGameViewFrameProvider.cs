// EditorGameViewFrameProvider.cs — Editor 向けフレームプロバイダ
//
// 設計 (spec/unity-bridge.md §2.2):
//   - PlayMode: RuntimeCameraViewProvider (ScreenCapture + AsyncGPUReadback) に委譲
//   - EditMode: RenderPipeline.SubmitRenderRequest + SingleCameraRequest で Camera.main を描画
//   - auto フォールバック: camera 失敗 → PrintWindow
//
// 要検証 (spec §7 #3 #4):
//   - Game View 非表示/最小化時の ScreenCapture 挙動 (空 RT の可能性)
//   - SubmitRenderRequest + SingleCameraRequest の EditMode 動作 (URP 17)
using UnityEngine;
using UnityEditor;
using UnityEngine.Rendering;
using System;
using Ludiars.Custos.Bridge.Capture;

namespace Ludiars.Custos.Bridge.Editor
{
    /// <summary>
    /// Editor 専用フレームプロバイダ。
    /// PlayMode 中は Runtime 版 (<see cref="RuntimeCameraViewProvider"/>) に委譲し、
    /// EditMode では <see cref="UniversalRenderPipeline.SingleCameraRequest"/> で描画する。
    /// captureMode="window" の場合は <see cref="Win32WindowCapture"/> を使う。
    /// </summary>
    public sealed class EditorGameViewFrameProvider : IFrameProvider
    {
        private readonly string                        _captureMode;
        private readonly int                           _maxLongEdge;
        private readonly RuntimeCameraViewProvider     _runtimeProvider; // PlayMode に委譲
        private readonly IFrameStreamer                _streamer;

        public EditorGameViewFrameProvider(
            string captureMode,
            int    maxLongEdge,
            RuntimeCameraViewProvider runtimeProvider,
            IFrameStreamer streamer)
        {
            _captureMode     = captureMode;
            _maxLongEdge     = maxLongEdge;
            _runtimeProvider = runtimeProvider;
            _streamer        = streamer;
        }

        // ── IFrameProvider ──────────────────────────────

        public void GetFrameSize(out int width, out int height)
        {
            if (Application.isPlaying)
            {
                width  = Mathf.Max(1, Screen.width);
                height = Mathf.Max(1, Screen.height);
                return;
            }
            // EditMode: PlayModeWindow API (プロトタイプ実証済)
            try
            {
                PlayModeWindow.GetRenderingResolution(out uint uw, out uint uh);
                width  = Mathf.Max(1, (int)uw);
                height = Mathf.Max(1, (int)uh);
                return;
            }
            catch { /* fallback */ }
            width = 1280; height = 720;
        }

        public void RequestFrame(Action<byte[], string> onDone)
        {
            switch (_captureMode)
            {
                case "window":
                    CaptureWindow(onDone);
                    break;
                case "auto":
                    CaptureAuto(onDone);
                    break;
                case "runtime":
                case "camera":
                default:
                    CaptureCamera(onDone);
                    break;
            }
        }

        public void PumpStream(IFrameStreamer streamer)
        {
            if (!Application.isPlaying) return; // EditMode ストリームは未対応
            _runtimeProvider?.RequestStreamPump();
            _runtimeProvider?.PumpStream(streamer);
        }

        // ── キャプチャ実装 ───────────────────────────────

        private void CaptureCamera(Action<byte[], string> onDone)
        {
            if (Application.isPlaying && _runtimeProvider != null)
            {
                // PlayMode は Runtime 版に委譲 (ScreenCapture + AsyncGPUReadback)
                _runtimeProvider.RequestFrame(onDone);
                return;
            }

            // EditMode: SubmitRenderRequest + SingleCameraRequest
            CaptureEditModeCamera(onDone);
        }

        private void CaptureWindow(Action<byte[], string> onDone)
        {
            var png = Win32WindowCapture.CapturePng(out string err);
            onDone(png, err);
        }

        private void CaptureAuto(Action<byte[], string> onDone)
        {
            if (Application.isPlaying && _runtimeProvider != null)
            {
                _runtimeProvider.RequestFrame((png, err) =>
                {
                    if (png != null) { onDone(png, null); return; }
                    // フォールバック: PrintWindow
                    var w2 = Win32WindowCapture.CapturePng(out string winErr);
                    onDone(w2, w2 != null ? null : $"camera: {err}; window: {winErr}");
                });
                return;
            }

            // EditMode: SingleCameraRequest → PrintWindow
            CaptureEditModeCamera((png, err) =>
            {
                if (png != null) { onDone(png, null); return; }
                var w2 = Win32WindowCapture.CapturePng(out string winErr);
                onDone(w2, w2 != null ? null : $"camera: {err}; window: {winErr}");
            });
        }

        // ── EditMode キャプチャ ───────────────────────────

        /// <summary>
        /// EditMode での Camera キャプチャ。
        /// URP 正規 API: RenderPipeline.SubmitRenderRequest + UniversalRenderPipeline.SingleCameraRequest。
        ///
        /// TODO(要検証 #4): URP 17 + Unity 6 での実動作確認が必要。
        ///   SubmitRenderRequest は 2022.2+ で追加された public API で URP17 では利用可能なはず。
        ///   失敗時は Camera.Render() フォールバック (SRP 下では非サポートだが動作する場合がある)。
        /// </summary>
        private void CaptureEditModeCamera(Action<byte[], string> onDone)
        {
            var cam = Camera.main ?? UnityEngine.Object.FindAnyObjectByType<Camera>();
            if (cam == null) { onDone(null, "no Camera in scene"); return; }

            GetFrameSize(out int w, out int h);
            DownscaleIfNeeded(ref w, ref h, _maxLongEdge);

            var rt = RenderTexture.GetTemporary(w, h, 24,
                RenderTextureFormat.ARGB32, RenderTextureReadWrite.sRGB);
            var prevActive = RenderTexture.active;
            Texture2D tex  = null;

            try
            {
                // TODO(要検証 #4): SubmitRenderRequest / SingleCameraRequest
                // 以下は URP 17 の型名。実際の namespace/型は com.unity.render-pipelines.universal のバージョン依存。
                // コンパイルエラーが出る場合は #if UNITY_2022_2_OR_NEWER 等でガードし
                // Camera.Render() フォールバックに切り替えること。
#if CUSTOS_URP_SINGLE_CAMERA_REQUEST
                // URP SingleCameraRequest 経路 (要 com.unity.render-pipelines.universal)
                var req    = new UnityEngine.Rendering.Universal.UniversalRenderPipeline.SingleCameraRequest();
                req.destination = rt;
                if (RenderPipeline.SupportsRenderRequest(cam, req))
                {
                    RenderPipeline.SubmitRenderRequest(cam, req);
                }
                else
                {
                    // SRP が SubmitRenderRequest を未サポート → Camera.Render フォールバック
                    FallbackCameraRender(cam, rt);
                }
#else
                // デフォルト: Camera.Render フォールバック
                // TODO(要検証 #4): SRP 下の Camera.Render() は非公式経路。
                //   URP 17 では動作する場合があるが保証外。SingleCameraRequest が確認できたら
                //   #define CUSTOS_URP_SINGLE_CAMERA_REQUEST を追加して上の経路に切り替える。
                FallbackCameraRender(cam, rt);
#endif

                RenderTexture.active = rt;
                tex = new Texture2D(w, h, TextureFormat.RGBA32, false);
                tex.ReadPixels(new Rect(0, 0, w, h), 0, 0);
                tex.Apply();
                onDone(tex.EncodeToPNG(), null);
            }
            catch (Exception e)
            {
                onDone(null, $"EditMode capture failed: {e.Message}");
            }
            finally
            {
                RenderTexture.active = prevActive;
                RenderTexture.ReleaseTemporary(rt);
                if (tex != null) UnityEngine.Object.DestroyImmediate(tex);
            }
        }

        private static void FallbackCameraRender(Camera cam, RenderTexture rt)
        {
            var prevTarget = cam.targetTexture;
            try
            {
                cam.targetTexture = rt;
                cam.Render();
            }
            finally
            {
                cam.targetTexture = prevTarget;
            }
        }

        private static void DownscaleIfNeeded(ref int w, ref int h, int maxLong)
        {
            if (maxLong <= 0) return;
            int longest = Mathf.Max(w, h);
            if (longest <= maxLong) return;
            float scale = (float)maxLong / longest;
            w = Mathf.Max(1, Mathf.RoundToInt(w * scale));
            h = Mathf.Max(1, Mathf.RoundToInt(h * scale));
        }
    }
}
