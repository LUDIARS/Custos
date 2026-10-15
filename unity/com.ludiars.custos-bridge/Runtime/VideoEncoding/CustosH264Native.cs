// CustosH264Native.cs — native/custos-h264 (custos_h264.dll) の P/Invoke 宣言
//
// DLL は Runtime/Plugins/x86_64/custos_h264.dll (native/custos-h264/build.cmd で作る)。
// Windows 以外や DLL が無い環境では呼び出しが DllNotFoundException / EntryPointNotFoundException に
// なるので、使う側 (H264StreamEncoder) が捕まえて「H.264 は使えない」として従来の BGRA 配信に戻す。
#if (UNITY_EDITOR_WIN || UNITY_STANDALONE_WIN) && (UNITY_EDITOR || DEVELOPMENT_BUILD)

using System;
using System.Runtime.InteropServices;

namespace Ludiars.Custos.Bridge.VideoEncoding
{
    internal static class CustosH264Native
    {
        private const string Dll = "custos_h264";

        public const int Ok = 0;
        public const int BufferTooSmall = -5;

        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
        public static extern int ch264_create(int width, int height, int fps, int bitrateBps, out IntPtr encoder);

        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
        public static extern IntPtr ch264_create_error();

        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
        public static extern int ch264_encode(IntPtr encoder, byte[] nv12, int size, long timestampUs, int forceKeyframe);

        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
        public static extern int ch264_pop(IntPtr encoder, byte[] buffer, int capacity, out int size, out long timestampUs, out int keyframe);

        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
        public static extern int ch264_set_bitrate(IntPtr encoder, int bitrateBps);

        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
        public static extern int ch264_request_keyframe(IntPtr encoder);

        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
        public static extern IntPtr ch264_encoder_name(IntPtr encoder);

        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
        public static extern int ch264_is_hardware(IntPtr encoder);

        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
        public static extern IntPtr ch264_last_error(IntPtr encoder);

        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
        public static extern void ch264_destroy(IntPtr encoder);

        public static string Utf8(IntPtr p) => p == IntPtr.Zero ? "" : Marshal.PtrToStringUTF8(p) ?? "";
    }
}

#endif
