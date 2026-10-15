// H264StreamEncoder.cs — NV12 のフレームをハードウェア H.264 にする作業スレッド
//
// - main thread (readback の完了) から SubmitNv12 で最新 1 枚を渡す。作業スレッドがエンコードし、
//   できたアクセスユニットを FrameEncoded で配る (作業スレッドから呼ばれる)。
// - 画面の大きさが変わったらエンコーダを作り直す (次のフレームは IDR)。
// - 画面が変わらない間はエンコードしない (StaticFrameGate、最低 1 秒に 1 枚)。
// - 使えるか (DLL があるか、エンコーダが作れるか) は起動時に小さなエンコーダを作って確かめる。
//   使えなければ Available=false で、ブリッジは従来の BGRA 配信だけを出す。
#if UNITY_EDITOR || DEVELOPMENT_BUILD

using System;
using System.Diagnostics;
using System.Threading;
using Debug = UnityEngine.Debug;

namespace Ludiars.Custos.Bridge.VideoEncoding
{
    public sealed class H264StreamEncoder : IDisposable
    {
        public struct Frame
        {
            public byte[] Data;
            public long TimestampUs;
            public bool Keyframe;
        }

        /// <summary>エンコードできたフレーム。作業スレッドから呼ばれる。</summary>
        public event Action<Frame> FrameEncoded;

        public bool Available { get; private set; }
        public string UnavailableReason { get; private set; } = "probing";
        public string EncoderName { get; private set; } = "";

        private readonly object _lock = new object();
        private readonly AutoResetEvent _signal = new AutoResetEvent(false);
        private readonly Stopwatch _clock = Stopwatch.StartNew();
        private readonly StaticFrameGate _gate = new StaticFrameGate();
        private Thread _worker;
        private volatile bool _stopping;

        private byte[] _pending;
        private int _pendingW, _pendingH;
        private volatile bool _keyRequested;
        private int _fps = 30;
        private int _bitrate = 3_000_000;
        private volatile int _bitrateChanged;

        // 作業スレッドだけが触る
        private IntPtr _encoder = IntPtr.Zero;
        private int _encW, _encH, _encFps;
        private byte[] _previous;
        private byte[] _out = new byte[1 << 20];

        public H264StreamEncoder()
        {
            _worker = new Thread(Run) { IsBackground = true, Name = "CustosH264Encoder" };
            _worker.Start();
        }

        /// <summary>fps とビットレート (接続時に Custos が指定する)。</summary>
        public void Configure(int fps, int bitrateBps)
        {
            lock (_lock)
            {
                _fps = Math.Max(1, Math.Min(120, fps));
                if (bitrateBps > 0 && bitrateBps != _bitrate)
                {
                    _bitrate = bitrateBps;
                    _bitrateChanged = 1;
                }
            }
        }

        public void SetBitrate(int bitrateBps)
        {
            if (bitrateBps <= 0) return;
            lock (_lock)
            {
                _bitrate = bitrateBps;
                _bitrateChanged = 1;
            }
            _signal.Set();
        }

        public void RequestKeyFrame()
        {
            _keyRequested = true;
            _signal.Set();
        }

        /// <summary>最新 1 枚を渡す (古いものは捨てる)。main thread から呼ぶ。</summary>
        public void SubmitNv12(byte[] nv12, int width, int height)
        {
            if (!Available || nv12 == null || nv12.Length != width * height * 3 / 2) return;
            lock (_lock)
            {
                _pending = nv12;
                _pendingW = width;
                _pendingH = height;
            }
            _signal.Set();
        }

        public void Dispose()
        {
            _stopping = true;
            _signal.Set();
            _worker?.Join(2000);
            _worker = null;
        }

        // ── 作業スレッド ─────────────────────────────────

        private void Run()
        {
#if UNITY_EDITOR_WIN || UNITY_STANDALONE_WIN
            Probe();
            while (!_stopping)
            {
                _signal.WaitOne(50);
                if (_stopping) break;
                try
                {
                    Step();
                }
                catch (Exception e)
                {
                    Debug.LogWarning($"[CustosBridge] H.264 encoder failed: {e.Message}");
                    DestroyEncoder();
                }
            }
            DestroyEncoder();
#else
            UnavailableReason = "H.264 encoding is Windows only";
#endif
        }

#if UNITY_EDITOR_WIN || UNITY_STANDALONE_WIN
        private void Probe()
        {
            try
            {
                int r = CustosH264Native.ch264_create(256, 144, 30, 500_000, out IntPtr probe);
                if (r != CustosH264Native.Ok || probe == IntPtr.Zero)
                {
                    UnavailableReason = CustosH264Native.Utf8(CustosH264Native.ch264_create_error());
                    Debug.Log($"[CustosBridge] H.264 encoder unavailable ({UnavailableReason}) — /stream stays BGRA");
                    return;
                }
                EncoderName = CustosH264Native.Utf8(CustosH264Native.ch264_encoder_name(probe));
                bool hw = CustosH264Native.ch264_is_hardware(probe) != 0;
                CustosH264Native.ch264_destroy(probe);
                Available = true;
                UnavailableReason = "";
                Debug.Log($"[CustosBridge] H.264 encoder ready: {EncoderName} (hardware={hw})");
            }
            catch (Exception e) when (e is DllNotFoundException || e is EntryPointNotFoundException || e is BadImageFormatException)
            {
                UnavailableReason = $"custos_h264 native plugin not loaded: {e.Message}";
                Debug.Log($"[CustosBridge] {UnavailableReason} — /stream stays BGRA");
            }
        }

        private void Step()
        {
            byte[] frame;
            int w, h, fps, bitrate;
            bool bitrateChanged;
            lock (_lock)
            {
                frame = _pending;
                w = _pendingW;
                h = _pendingH;
                _pending = null;
                fps = _fps;
                bitrate = _bitrate;
                bitrateChanged = Interlocked.Exchange(ref _bitrateChanged, 0) == 1;
            }

            if (frame != null)
            {
                if (_encoder == IntPtr.Zero || w != _encW || h != _encH || fps != _encFps)
                {
                    DestroyEncoder();
                    int r = CustosH264Native.ch264_create(w, h, fps, bitrate, out _encoder);
                    if (r != CustosH264Native.Ok)
                    {
                        _encoder = IntPtr.Zero;
                        Debug.LogWarning($"[CustosBridge] H.264 encoder create failed: {CustosH264Native.Utf8(CustosH264Native.ch264_create_error())}");
                        return;
                    }
                    _encW = w; _encH = h; _encFps = fps;
                    _previous = null;
                    bitrateChanged = false;
                    Debug.Log($"[CustosBridge] H.264 encoder started {w}x{h} @ {fps}fps {bitrate / 1000}kbps");
                }
                if (bitrateChanged) CustosH264Native.ch264_set_bitrate(_encoder, bitrate);

                bool key = _keyRequested;
                bool changed = !StaticFrameGate.SameFrame(frame, _previous);
                if (_gate.ShouldEncode(changed, key, _clock.ElapsedMilliseconds))
                {
                    if (key) _keyRequested = false;
                    long ts = _clock.ElapsedTicks * 1_000_000L / Stopwatch.Frequency;
                    int r = CustosH264Native.ch264_encode(_encoder, frame, frame.Length, ts, key ? 1 : 0);
                    if (r != CustosH264Native.Ok)
                        Debug.LogWarning($"[CustosBridge] H.264 encode failed: {CustosH264Native.Utf8(CustosH264Native.ch264_last_error(_encoder))}");
                    _previous = frame;
                }
            }
            else if (bitrateChanged && _encoder != IntPtr.Zero)
            {
                CustosH264Native.ch264_set_bitrate(_encoder, bitrate);
            }
            if (_encoder != IntPtr.Zero) Drain();
        }

        private void Drain()
        {
            for (;;)
            {
                int r = CustosH264Native.ch264_pop(_encoder, _out, _out.Length, out int size, out long ts, out int key);
                if (r == CustosH264Native.BufferTooSmall)
                {
                    _out = new byte[Math.Max(size, _out.Length * 2)];
                    continue;
                }
                if (r <= 0) return;
                var data = new byte[size];
                Buffer.BlockCopy(_out, 0, data, 0, size);
                FrameEncoded?.Invoke(new Frame { Data = data, TimestampUs = ts, Keyframe = key != 0 });
            }
        }

        private void DestroyEncoder()
        {
            if (_encoder == IntPtr.Zero) return;
            CustosH264Native.ch264_destroy(_encoder);
            _encoder = IntPtr.Zero;
        }
#endif
    }
}

#endif // UNITY_EDITOR || DEVELOPMENT_BUILD
