// AudioStreamer.cs — GET /audio の配信 (AudioListener のミックス済み音声を PCM で接続ごとに送る)
//
// 本体の形は /stream?codec=h264 と同じ 13 バイトの見出し + 中身:
//   1 レコード = [u32 BE 長さ][i64 BE 時刻 µs][u8 チャンネル数] + PCM s16le (チャンネル交互)
//   長さ 0 のレコードは keepalive (1 秒ごと。音が来ない間も切断に気づくため)
// ヘッダ: X-Audio-Format: s16le, X-Audio-Rate (Hz)
//
// 音は AudioTap (有効な AudioListener に付ける OnAudioFilterRead) から音声スレッドで届く。
// 付け外しは main thread の Maintain() が 1 秒ごとに行う: 接続があって Play 中なら有効な
// AudioListener に付け (シーン切替で listener が変われば付け直す)、接続が無くなれば外す。
// スピーカーへの出力は変えない (タップは読むだけ)。
//
// 音が AudioListener を通らないゲーム (独自の音声エンジンで鳴らすもの) は、CustosAudioFeed.Use で
// 自分のミックスを渡すと宣言し、Push で PCM を渡す。宣言している間はタップを使わず、レートも宣言の値にする。
#if UNITY_EDITOR || DEVELOPMENT_BUILD

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using UnityEngine;

namespace Ludiars.Custos.Bridge
{
    public sealed class AudioStreamer
    {
        private const int KeepaliveMs = 1000;
        /// <summary>未送信のレコードの上限 (音声スレッドの 1 回分 ≒ 20 ms なので 10 秒ほど)。超えたら古いものは送らない。</summary>
        private const int QueueCapacity = 500;
        private const float MaintainIntervalSeconds = 1f;

        private readonly List<Connection> _connections = new List<Connection>();
        private readonly object _lock = new object();
        private readonly Stopwatch _clock = Stopwatch.StartNew();
        private readonly long _epochUs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() * 1000;
        private volatile int _sampleRate;
        /// <summary>ゲームが自分で渡すと宣言した音のレート (0 = 宣言なし。タップを使う)。</summary>
        private volatile int _externalRate;
        private AudioTap _tap;
        private float _nextMaintain;

        private sealed class Connection
        {
            public readonly BlockingCollection<Chunk> Queue = new BlockingCollection<Chunk>(QueueCapacity);
        }

        private readonly struct Chunk
        {
            public readonly byte[] Pcm;
            public readonly long TimestampUs;
            public readonly int Channels;

            public Chunk(byte[] pcm, long timestampUs, int channels)
            {
                Pcm = pcm;
                TimestampUs = timestampUs;
                Channels = channels;
            }
        }

        public bool HasActiveStream
        {
            get { lock (_lock) return _connections.Count > 0; }
        }

        /// <summary>main thread から毎フレーム呼ぶ。1 秒ごとにタップの付け外しを行う。</summary>
        public void Maintain()
        {
            if (Time.realtimeSinceStartup < _nextMaintain) return;
            _nextMaintain = Time.realtimeSinceStartup + MaintainIntervalSeconds;
            _sampleRate = AudioSettings.outputSampleRate;

            if (_externalRate > 0 || !HasActiveStream || !Application.isPlaying)
            {
                Detach();
                return;
            }
            var listener = FindActiveListener();
            if (listener == null)
            {
                Detach();
                return;
            }
            if (_tap != null && _tap.gameObject == listener.gameObject) return;
            Detach();
            _tap = listener.gameObject.AddComponent<AudioTap>();
            _tap.hideFlags = HideFlags.DontSave | HideFlags.HideInInspector;
            _tap.Target = this;
        }

        /// <summary>接続が続く間ブロックして配信する (専用スレッドから呼ぶ)。</summary>
        public void StartStream(HttpListenerContext ctx)
        {
            var res = ctx.Response;
            var conn = new Connection();
            lock (_lock) _connections.Add(conn);
            try
            {
                res.StatusCode = 200;
                res.ContentType = "application/octet-stream";
                res.SendChunked = true;
                res.Headers.Set("X-Audio-Format", "s16le");
                res.Headers.Set("X-Audio-Rate", (_externalRate > 0 ? _externalRate : _sampleRate > 0 ? _sampleRate : 48000).ToString());
                UnityEngine.Debug.Log("[CustosBridge] /audio started.");
                Serve(conn, res.OutputStream);
            }
            catch (Exception)
            {
                UnityEngine.Debug.Log("[CustosBridge] /audio client disconnected.");
            }
            finally
            {
                lock (_lock) _connections.Remove(conn);
                conn.Queue.Dispose();
                Protocol.HttpJson.SafeClose(res);
                UnityEngine.Debug.Log("[CustosBridge] /audio stopped.");
            }
        }

        /// <summary>ゲームが自分の音を渡すと宣言する (以後タップは使わない)。0 以下で宣言を取り下げる。</summary>
        internal void UseExternal(int sampleRate) => _externalRate = Math.Max(0, sampleRate);

        /// <summary>宣言したゲームから呼ばれる。先頭 length 個 (チャンネル交互) を配る。宣言が無ければ捨てる。</summary>
        internal void PushExternal(float[] data, int length, int channels)
        {
            if (_externalRate > 0) Push(data, length, channels);
        }

        /// <summary>AudioTap から音声スレッドで呼ばれる。</summary>
        internal void Push(float[] data, int channels) => Push(data, data.Length, channels);

        /// <summary>先頭 length 個 (チャンネル交互) の float を s16le にして各接続へ配る。</summary>
        private void Push(float[] data, int length, int channels)
        {
            Connection[] targets;
            lock (_lock)
            {
                if (_connections.Count == 0) return;
                targets = _connections.ToArray();
            }
            length = Math.Min(length, data.Length);
            if (channels <= 0 || length <= 0 || length % channels != 0) return;
            var pcm = new byte[length * 2];
            for (int i = 0; i < length; i++)
            {
                short s = (short)(Mathf.Clamp(data[i], -1f, 1f) * short.MaxValue);
                pcm[i * 2] = (byte)s;
                pcm[i * 2 + 1] = (byte)(s >> 8);
            }
            var chunk = new Chunk(pcm, _epochUs + _clock.ElapsedTicks * 1_000_000 / Stopwatch.Frequency, channels);
            foreach (var conn in targets)
            {
                try { conn.Queue.TryAdd(chunk); }
                catch (ObjectDisposedException) { }
            }
        }

        private void Detach()
        {
            if (_tap == null) return;
            _tap.Target = null;
            UnityEngine.Object.Destroy(_tap);
            _tap = null;
        }

        private static AudioListener FindActiveListener()
        {
            foreach (var listener in UnityEngine.Object.FindObjectsByType<AudioListener>(FindObjectsSortMode.None))
                if (listener.isActiveAndEnabled) return listener;
            return null;
        }

        private static void Serve(Connection conn, Stream stream)
        {
            var header = new byte[13];
            for (;;)
            {
                if (conn.Queue.TryTake(out var chunk, KeepaliveMs))
                {
                    WriteHeader(header, chunk.Pcm.Length, chunk.TimestampUs, chunk.Channels);
                    stream.Write(header, 0, header.Length);
                    stream.Write(chunk.Pcm, 0, chunk.Pcm.Length);
                }
                else
                {
                    WriteHeader(header, 0, 0, 0);   // keepalive
                    stream.Write(header, 0, header.Length);
                }
                stream.Flush();
            }
        }

        private static void WriteHeader(byte[] h, int length, long timestampUs, int channels)
        {
            h[0] = (byte)(length >> 24); h[1] = (byte)(length >> 16); h[2] = (byte)(length >> 8); h[3] = (byte)length;
            for (int i = 0; i < 8; i++) h[4 + i] = (byte)(timestampUs >> (56 - 8 * i));
            h[12] = (byte)channels;
        }
    }
}

#endif // UNITY_EDITOR || DEVELOPMENT_BUILD
