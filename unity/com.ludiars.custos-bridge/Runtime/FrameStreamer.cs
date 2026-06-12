// FrameStreamer.cs — /stream エンドポイントの BGRA raw フレームストリーム配信
//
// 仕様 (spec/unity-bridge.md §0 および課題文):
//   - レスポンス 200、ヘッダ X-Frame-Width/Height/Pixfmt/Fps
//   - 本体は W*H*4 bytes の raw BGRA8 フレームが連続 (ヘッダなし)
//   - 最新フレーム 1 枠バッファ、古いものは捨てる
//   - 接続が切れたら配信停止
//   - Custos 側: ffmpeg -f rawvideo -pix_fmt bgra -s WxH -r F -i pipe:0
//
// スレッド設計:
//   - UpdateFrame() … main thread から呼ばれる (provider の AsyncGPUReadback callback)
//   - StreamLoop() … 配信スレッド (HttpListener の BG スレッドから spawn)
//   - 最新フレームの受け渡しは lock + byte[] 交換 (GC を避けるためバッファを 2 枚交互使用)
#if UNITY_EDITOR || DEVELOPMENT_BUILD

using System;
using System.IO;
using System.Net;
using System.Threading;
using UnityEngine;

namespace Ludiars.Custos.Bridge
{
    /// <summary>
    /// HTTP ストリームに raw BGRA フレームを配信する。
    /// <see cref="IFrameStreamer.UpdateFrame"/> は main thread から呼ぶ。
    /// <see cref="StartStream"/> は HTTP 受信スレッドから呼ぶ (ブロッキング)。
    /// </summary>
    public sealed class FrameStreamer : Capture.IFrameStreamer
    {
        // ── フレームバッファ ──────────────────────────────
        // double buffering: main thread が書く side と配信スレッドが読む side を交互
        private byte[]   _buf0;
        private byte[]   _buf1;
        private byte[]   _latestFrame; // 最新 (main thread が swap する)
        private int      _latestW;
        private int      _latestH;
        private readonly object _frameLock = new object();

        // ── アクティブストリーム管理 ─────────────────────
        private volatile bool _hasActiveStream;
        private readonly object _streamLock = new object();

        // ── IFrameStreamer ───────────────────────────────

        /// <summary>
        /// main thread から呼ばれる。最新フレームバッファを更新する。
        /// bgraData は BGRA8 top-down。
        /// </summary>
        public void UpdateFrame(byte[] bgraData, int width, int height)
        {
            if (bgraData == null || bgraData.Length != width * height * 4) return;
            lock (_frameLock)
            {
                _latestFrame = bgraData;
                _latestW     = width;
                _latestH     = height;
            }
        }

        // ── ストリーム有無クエリ ─────────────────────────

        /// <summary>アクティブなストリーム接続があるかどうか。</summary>
        public bool HasActiveStream => _hasActiveStream;

        // ── /stream ハンドラ ─────────────────────────────

        /// <summary>
        /// /stream リクエストを受けたら BG スレッドからこのメソッドを呼ぶ。
        /// fps パラメータを受け取り、接続が切れるまでフレームを送り続ける。
        /// </summary>
        public void StartStream(HttpListenerContext ctx)
        {
            var req = ctx.Request;
            var res = ctx.Response;

            // fps パラメータ解析
            int fps = 30;
            string fpsParam = req.QueryString["fps"];
            if (!string.IsNullOrEmpty(fpsParam) && int.TryParse(fpsParam, out int parsedFps))
                fps = Mathf.Clamp(parsedFps, 1, 120);

            // 先に現在のフレームサイズを確定 (ヘッダに書くため)
            int w, h;
            lock (_frameLock)
            {
                w = _latestW;
                h = _latestH;
            }
            if (w <= 0 || h <= 0)
            {
                // まだフレームが来ていない — 少し待つ
                for (int retry = 0; retry < 50 && (w <= 0 || h <= 0); retry++)
                {
                    Thread.Sleep(20);
                    lock (_frameLock) { w = _latestW; h = _latestH; }
                }
                if (w <= 0 || h <= 0)
                {
                    Protocol.HttpJson.WriteJson(res, 503,
                        "{\"error\":\"no frame available yet. Is the game running?\"}");
                    return;
                }
            }

            // ── ヘッダを先に送信 ──
            try
            {
                res.StatusCode   = 200;
                res.ContentType  = "application/octet-stream";
                res.SendChunked  = true;
                res.Headers.Set("Access-Control-Allow-Origin", "*");
                res.Headers.Set("X-Frame-Width",  w.ToString());
                res.Headers.Set("X-Frame-Height", h.ToString());
                res.Headers.Set("X-Frame-Pixfmt", "bgra");
                res.Headers.Set("X-Frame-Fps",    fps.ToString());
                // ContentLength64 は設定しない (ストリーム長不定)
            }
            catch (Exception e)
            {
                Debug.LogWarning($"[CustosBridge] /stream header send failed: {e.Message}");
                Protocol.HttpJson.SafeClose(res);
                return;
            }

            // ── アクティブフラグ ON ──
            lock (_streamLock) { _hasActiveStream = true; }

            int intervalMs = Mathf.Max(1, 1000 / fps);
            var stream     = res.OutputStream;
            byte[] lastSent = null;

            Debug.Log($"[CustosBridge] /stream started: {w}x{h} @ {fps}fps");

            try
            {
                while (true)
                {
                    byte[] frame;
                    int    fw, fh;
                    lock (_frameLock)
                    {
                        frame = _latestFrame;
                        fw    = _latestW;
                        fh    = _latestH;
                    }

                    // フレームがある かつ 前回と異なる場合だけ送信 (CPU 節約)
                    if (frame != null && !ReferenceEquals(frame, lastSent)
                        && fw > 0 && fh > 0 && frame.Length == fw * fh * 4)
                    {
                        stream.Write(frame, 0, frame.Length);
                        stream.Flush();
                        lastSent = frame;
                    }

                    Thread.Sleep(intervalMs);
                }
            }
            catch (Exception)
            {
                // クライアント切断 or ストリーム停止
                Debug.Log("[CustosBridge] /stream client disconnected.");
            }
            finally
            {
                lock (_streamLock) { _hasActiveStream = false; }
                Protocol.HttpJson.SafeClose(res);
                Debug.Log("[CustosBridge] /stream stopped.");
            }
        }
    }
}

#endif // UNITY_EDITOR || DEVELOPMENT_BUILD
