// H264Streamer.cs — GET /stream?codec=h264 の配信 (H264StreamEncoder の出力を接続ごとに送る)
//
// 本体の形 (Custos src/capture/bridge-h264-frames.ts と固定合意):
//   1 フレーム = [u32 BE 長さ][i64 BE 時刻 µs][u8 フラグ (bit0=キーフレーム)] + H.264 Annex-B
//   長さ 0 のフレームは keepalive (1 秒ごと。来ない間も切断に気づくため)
// ヘッダ: X-Frame-Codec: h264, X-Frame-Width/Height (配信の上限の枠), X-Frame-Fps
// クエリ: fps, width / height (上限の枠、既定 1280x720), bitrate (bps)
//
// 接続の始めと、送りが詰まって捨てたときはキーフレームを要求し、次のキーフレームまで差分は送らない
// (欠けた差分を送るとブラウザ側で崩れる)。
#if UNITY_EDITOR || DEVELOPMENT_BUILD

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Threading;
using UnityEngine;
using Ludiars.Custos.Bridge.VideoEncoding;

namespace Ludiars.Custos.Bridge
{
    public sealed class H264Streamer : Capture.IH264FrameTarget
    {
        private const int KeepaliveMs = 1000;
        private const int QueueCapacity = 30;

        private readonly H264StreamEncoder _encoder;
        private readonly List<Connection> _connections = new List<Connection>();
        private readonly object _lock = new object();
        private int _maxWidth = 1280;
        private int _maxHeight = 720;

        private sealed class Connection
        {
            public readonly BlockingCollection<H264StreamEncoder.Frame> Queue =
                new BlockingCollection<H264StreamEncoder.Frame>(QueueCapacity);
            public volatile bool WaitingForKeyframe = true;
        }

        public H264Streamer(H264StreamEncoder encoder)
        {
            _encoder = encoder;
            _encoder.FrameEncoded += Broadcast;
        }

        public bool IsAvailable => _encoder.Available;
        public string UnavailableReason => _encoder.UnavailableReason;

        public bool HasActiveStream
        {
            get { lock (_lock) return _connections.Count > 0; }
        }

        public void GetTargetSize(int screenWidth, int screenHeight, out int width, out int height)
        {
            int mw, mh;
            lock (_lock) { mw = _maxWidth; mh = _maxHeight; }
            StreamResolution.Fit(screenWidth, screenHeight, mw, mh, out width, out height);
        }

        public void SubmitNv12(byte[] nv12, int width, int height) => _encoder.SubmitNv12(nv12, width, height);

        public void RequestKeyFrame() => _encoder.RequestKeyFrame();

        public void SetBitrate(int bitrateBps) => _encoder.SetBitrate(bitrateBps);

        /// <summary>接続が続く間ブロックして配信する (専用スレッドから呼ぶ)。</summary>
        public void StartStream(HttpListenerContext ctx)
        {
            var req = ctx.Request;
            var res = ctx.Response;
            int fps = ParseInt(req.QueryString["fps"], 30, 1, 120);
            int width = ParseInt(req.QueryString["width"], 1280, 64, 3840);
            int height = ParseInt(req.QueryString["height"], 720, 64, 2160);
            int bitrate = ParseInt(req.QueryString["bitrate"], 3_000_000, 100_000, 50_000_000);

            var conn = new Connection();
            lock (_lock)
            {
                _maxWidth = width;
                _maxHeight = height;
                _connections.Add(conn);
            }
            _encoder.Configure(fps, bitrate);
            _encoder.RequestKeyFrame();
            try
            {
                res.StatusCode = 200;
                res.ContentType = "application/octet-stream";
                res.SendChunked = true;
                res.Headers.Set("X-Frame-Codec", "h264");
                res.Headers.Set("X-Frame-Width", width.ToString());
                res.Headers.Set("X-Frame-Height", height.ToString());
                res.Headers.Set("X-Frame-Fps", fps.ToString());
                Debug.Log($"[CustosBridge] /stream (h264) started: max {width}x{height} @ {fps}fps {bitrate / 1000}kbps");
                Serve(conn, res.OutputStream);
            }
            catch (Exception)
            {
                Debug.Log("[CustosBridge] /stream (h264) client disconnected.");
            }
            finally
            {
                lock (_lock) _connections.Remove(conn);
                conn.Queue.Dispose();
                Protocol.HttpJson.SafeClose(res);
                Debug.Log("[CustosBridge] /stream (h264) stopped.");
            }
        }

        private void Serve(Connection conn, Stream stream)
        {
            var header = new byte[13];
            for (;;)
            {
                if (conn.Queue.TryTake(out var frame, KeepaliveMs))
                {
                    WriteHeader(header, frame.Data.Length, frame.TimestampUs, frame.Keyframe);
                    stream.Write(header, 0, header.Length);
                    stream.Write(frame.Data, 0, frame.Data.Length);
                }
                else
                {
                    WriteHeader(header, 0, 0, false);   // keepalive
                    stream.Write(header, 0, header.Length);
                }
                stream.Flush();
            }
        }

        private void Broadcast(H264StreamEncoder.Frame frame)
        {
            Connection[] targets;
            lock (_lock) targets = _connections.ToArray();
            foreach (var conn in targets)
            {
                if (conn.WaitingForKeyframe && !frame.Keyframe) continue;
                conn.WaitingForKeyframe = false;
                bool added;
                try { added = conn.Queue.TryAdd(frame); }
                catch (ObjectDisposedException) { continue; }
                if (!added)
                {
                    // 送りが追いつかない: 次のキーフレームまで止めて、キーフレームを要求する。
                    conn.WaitingForKeyframe = true;
                    _encoder.RequestKeyFrame();
                }
            }
        }

        private static void WriteHeader(byte[] h, int length, long timestampUs, bool keyframe)
        {
            h[0] = (byte)(length >> 24); h[1] = (byte)(length >> 16); h[2] = (byte)(length >> 8); h[3] = (byte)length;
            for (int i = 0; i < 8; i++) h[4 + i] = (byte)(timestampUs >> (56 - 8 * i));
            h[12] = (byte)(keyframe ? 1 : 0);
        }

        private static int ParseInt(string s, int fallback, int min, int max)
        {
            return int.TryParse(s, out int v) ? Mathf.Clamp(v, min, max) : fallback;
        }
    }
}

#endif // UNITY_EDITOR || DEVELOPMENT_BUILD
