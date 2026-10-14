// ProcessLoopback.cs — 指定プロセス (とその子) が鳴らしている音だけを取り出し、PCM を stdout に流す。
//
// 使い方: ProcessLoopback.exe <pid>
//   stdout: s16le / 48000 Hz / 2ch の生 PCM (ヘッダ無し)。ffmpeg に `-f s16le -ar 48000 -ac 2` で渡す。
//   stderr: 診断メッセージだけ (stdout はデータ専用。ログを混ぜない)。
//
// Windows 10 2004 以降の Application Loopback (ActivateAudioInterfaceAsync + VAD\Process_Loopback) を使う。
// CRI ADX のように Unity の AudioListener を通らずに鳴る音も、プロセスの出力として取れる。
// 対象が無音の間は API がパケットを出さないため、実時間に合わせて無音を埋める (受け側の時刻がずれないように)。
//
// Custos (src/capture/process-loopback.ts) が初回に csc.exe でビルドして使う。
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

internal static class ProcessLoopback
{
    private const int SampleRate = 48000;
    private const int Channels = 2;
    private const int BytesPerFrame = Channels * 2;   // s16le
    /// 無音を埋める判定の遊び。これより遅れたら足りない分を無音で書く。
    private const int MaxLagMs = 40;

    [MTAThread]
    private static int Main(string[] args)
    {
        int pid;
        if (args.Length != 1 || !int.TryParse(args[0], out pid) || pid <= 0)
        {
            Console.Error.WriteLine("usage: ProcessLoopback.exe <pid>");
            return 2;
        }
        try
        {
            Run(pid);
            return 0;
        }
        catch (IOException)
        {
            return 0;   // 読み手 (ffmpeg) が終わった。正常終了として扱う
        }
        catch (Exception e)
        {
            Console.Error.WriteLine("process loopback failed: " + e.Message);
            return 1;
        }
    }

    private static void Run(int pid)
    {
        IAudioClient client = Activate(pid);
        var format = new WaveFormatEx
        {
            wFormatTag = 1,   // WAVE_FORMAT_PCM
            nChannels = Channels,
            nSamplesPerSec = SampleRate,
            wBitsPerSample = 16,
            nBlockAlign = BytesPerFrame,
            nAvgBytesPerSec = SampleRate * BytesPerFrame,
            cbSize = 0,
        };
        const int Loopback = 0x00020000, EventCallback = 0x00040000, AutoConvertPcm = unchecked((int)0x80000000), SrcDefaultQuality = 0x08000000;
        client.Initialize(0, Loopback | EventCallback | AutoConvertPcm | SrcDefaultQuality, 200000 /* 20ms */, 0, ref format, IntPtr.Zero);

        using (var ready = new AutoResetEvent(false))
        {
            client.SetEventHandle(ready.SafeWaitHandle.DangerousGetHandle());
            object service;
            Guid captureId = typeof(IAudioCaptureClient).GUID;
            client.GetService(ref captureId, out service);
            var capture = (IAudioCaptureClient)service;
            Stream stdout = Console.OpenStandardOutput();
            client.Start();
            Console.Error.WriteLine("process loopback started: pid=" + pid);

            var clock = System.Diagnostics.Stopwatch.StartNew();
            long framesWritten = 0;
            byte[] buffer = new byte[SampleRate * BytesPerFrame];   // 1 秒分
            while (true)
            {
                ready.WaitOne(20);
                uint packet;
                capture.GetNextPacketSize(out packet);
                while (packet > 0)
                {
                    IntPtr data; uint frames; uint flags; ulong devicePosition; ulong qpcPosition;
                    capture.GetBuffer(out data, out frames, out flags, out devicePosition, out qpcPosition);
                    int bytes = (int)frames * BytesPerFrame;
                    if (bytes > buffer.Length) buffer = new byte[bytes];
                    const uint Silent = 0x2;
                    if ((flags & Silent) != 0) Array.Clear(buffer, 0, bytes);
                    else Marshal.Copy(data, buffer, 0, bytes);
                    capture.ReleaseBuffer(frames);
                    stdout.Write(buffer, 0, bytes);
                    framesWritten += frames;
                    capture.GetNextPacketSize(out packet);
                }
                // 対象が鳴らしていない間はパケットが来ない。実時間に追いつくまで無音を書く。
                long expected = clock.ElapsedMilliseconds * SampleRate / 1000;
                long lag = expected - framesWritten;
                if (lag > SampleRate * MaxLagMs / 1000)
                {
                    int bytes = (int)Math.Min(lag * BytesPerFrame, buffer.Length);
                    Array.Clear(buffer, 0, bytes);
                    stdout.Write(buffer, 0, bytes);
                    framesWritten += bytes / BytesPerFrame;
                }
                stdout.Flush();
            }
        }
    }

    /// Application Loopback 用の IAudioClient を非同期 activation で取る。
    private static IAudioClient Activate(int pid)
    {
        var activation = new AudioClientActivationParams
        {
            ActivationType = 1,          // AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK
            TargetProcessId = pid,
            ProcessLoopbackMode = 0,     // PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE
        };
        IntPtr blob = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(AudioClientActivationParams)));
        try
        {
            Marshal.StructureToPtr(activation, blob, false);
            var variant = new PropVariantBlob
            {
                vt = 65,   // VT_BLOB
                cbSize = (uint)Marshal.SizeOf(typeof(AudioClientActivationParams)),
                pBlobData = blob,
            };
            var handler = new CompletionHandler();
            IActivateAudioInterfaceAsyncOperation operation;
            ActivateAudioInterfaceAsync("VAD\\Process_Loopback", typeof(IAudioClient).GUID, ref variant, handler, out operation);
            if (!handler.Done.WaitOne(5000)) throw new TimeoutException("audio interface activation timed out");
            int hr;
            object result;
            operation.GetActivateResult(out hr, out result);
            if (hr != 0) Marshal.ThrowExceptionForHR(hr);
            return (IAudioClient)result;
        }
        finally
        {
            Marshal.FreeHGlobal(blob);
        }
    }

    [DllImport("Mmdevapi.dll", ExactSpelling = true, PreserveSig = false)]
    private static extern void ActivateAudioInterfaceAsync(
        [MarshalAs(UnmanagedType.LPWStr)] string deviceInterfacePath,
        [MarshalAs(UnmanagedType.LPStruct)] Guid riid,
        ref PropVariantBlob activationParams,
        IActivateAudioInterfaceCompletionHandler completionHandler,
        out IActivateAudioInterfaceAsyncOperation activationOperation);

    [StructLayout(LayoutKind.Sequential)]
    private struct AudioClientActivationParams
    {
        public int ActivationType;
        public int TargetProcessId;
        public int ProcessLoopbackMode;
    }

    /// PROPVARIANT のうち VT_BLOB として使う部分 (vt + 予約 3 つ + BLOB)。
    [StructLayout(LayoutKind.Sequential)]
    private struct PropVariantBlob
    {
        public ushort vt;
        public ushort reserved1;
        public ushort reserved2;
        public ushort reserved3;
        public uint cbSize;
        public IntPtr pBlobData;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 2)]
    private struct WaveFormatEx
    {
        public ushort wFormatTag;
        public ushort nChannels;
        public uint nSamplesPerSec;
        public uint nAvgBytesPerSec;
        public ushort nBlockAlign;
        public ushort wBitsPerSample;
        public ushort cbSize;
    }

    /// activation 完了の通知を受ける。COM から MTA で呼ばれるので IAgileObject を名乗る。
    [ClassInterface(ClassInterfaceType.None)]
    private sealed class CompletionHandler : IActivateAudioInterfaceCompletionHandler, IAgileObject
    {
        public readonly ManualResetEvent Done = new ManualResetEvent(false);
        public void ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation) { Done.Set(); }
    }

    [ComImport, Guid("94ea2b94-e9cc-49e0-c0ff-ee64ca8f5b90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAgileObject { }

    [ComImport, Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IActivateAudioInterfaceCompletionHandler
    {
        void ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation);
    }

    [ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IActivateAudioInterfaceAsyncOperation
    {
        void GetActivateResult(out int activateResult, [MarshalAs(UnmanagedType.IUnknown)] out object activatedInterface);
    }

    [ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioClient
    {
        void Initialize(int shareMode, int streamFlags, long bufferDuration, long periodicity, ref WaveFormatEx format, IntPtr audioSessionGuid);
        void GetBufferSize(out uint bufferFrames);
        void GetStreamLatency(out long latency);
        void GetCurrentPadding(out uint padding);
        void IsFormatSupported(int shareMode, IntPtr format, out IntPtr closestMatch);
        void GetMixFormat(out IntPtr format);
        void GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
        void Start();
        void Stop();
        void Reset();
        void SetEventHandle(IntPtr eventHandle);
        void GetService(ref Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }

    [ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioCaptureClient
    {
        void GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong qpcPosition);
        void ReleaseBuffer(uint frames);
        void GetNextPacketSize(out uint frames);
    }
}
