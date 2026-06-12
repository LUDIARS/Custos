// Win32WindowCapture.cs — PrintWindow P/Invoke (Windows Editor 限定フォールバック)
//
// プロトタイプ (KzSUnity/Assets/Scripts/Editor/Musa/UnityErgoCustosBridge.cs) の
// CaptureWindowPng + 関連 P/Invoke をそのまま移植。
//
// 用途: captureMode = "window" または "auto" でのフォールバック。
//       Editor ウィンドウ全体 (Scene/Inspector 込み) が映る。Game View だけではない。
//       Windows Editor 専用 (#if UNITY_EDITOR_WIN)。
using UnityEngine;
using UnityEditor;
using System;
using System.Runtime.InteropServices;

namespace Ludiars.Custos.Bridge.Editor
{
    /// <summary>
    /// Win32 PrintWindow (PW_RENDERFULLCONTENT) を使って Unity Editor ウィンドウを
    /// PNG バイト列として返す。Windows Editor 専用。
    /// </summary>
    public static class Win32WindowCapture
    {
        /// <summary>
        /// Unity Editor の MainWindowHandle を PrintWindow でキャプチャし PNG を返す。
        /// 失敗時は null + error メッセージ。Windows Editor 以外では即 null。
        /// </summary>
        public static byte[] CapturePng(out string error)
        {
            error = null;
#if UNITY_EDITOR_WIN
            var proc = System.Diagnostics.Process.GetCurrentProcess();
            IntPtr hwnd = proc.MainWindowHandle;
            if (hwnd == IntPtr.Zero)
            {
                error = "Process.MainWindowHandle is zero";
                return null;
            }

            if (!GetWindowRect(hwnd, out var rect))
            {
                error = $"GetWindowRect failed (err={Marshal.GetLastWin32Error()})";
                return null;
            }

            int w = rect.Right  - rect.Left;
            int h = rect.Bottom - rect.Top;
            if (w <= 0 || h <= 0)
            {
                error = $"invalid window rect: {w}x{h}";
                return null;
            }

            IntPtr hdcSrc  = GetDC(hwnd);
            IntPtr hdcDest = CreateCompatibleDC(hdcSrc);
            IntPtr hBmp    = CreateCompatibleBitmap(hdcSrc, w, h);
            IntPtr hOld    = SelectObject(hdcDest, hBmp);
            Texture2D tex  = null;

            try
            {
                // PW_RENDERFULLCONTENT (=2): D3D/Vulkan swapchain 描画も含む (Win 8.1+)
                if (!PrintWindow(hwnd, hdcDest, 2u))
                {
                    error = $"PrintWindow failed (err={Marshal.GetLastWin32Error()})";
                    return null;
                }

                var bmi = new BITMAPINFO();
                bmi.bmiHeader.biSize        = (uint)Marshal.SizeOf<BITMAPINFOHEADER>();
                bmi.bmiHeader.biWidth       = w;
                bmi.bmiHeader.biHeight      = -h;  // 負値 = top-down DIB
                bmi.bmiHeader.biPlanes      = 1;
                bmi.bmiHeader.biBitCount    = 32;
                bmi.bmiHeader.biCompression = 0; // BI_RGB

                var bytes = new byte[w * h * 4];
                int copied = GetDIBits(hdcDest, hBmp, 0, (uint)h, bytes, ref bmi, 0u);
                if (copied == 0)
                {
                    error = $"GetDIBits failed (err={Marshal.GetLastWin32Error()})";
                    return null;
                }

                // GDI は BGRA → Unity Texture2D RGBA32 に入れ替え + alpha 不透明固定
                for (int i = 0; i + 3 < bytes.Length; i += 4)
                {
                    byte b = bytes[i];
                    bytes[i]     = bytes[i + 2];
                    bytes[i + 2] = b;
                    bytes[i + 3] = 255;
                }

                tex = new Texture2D(w, h, TextureFormat.RGBA32, false);
                tex.LoadRawTextureData(bytes);
                tex.Apply(false, false);
                return tex.EncodeToPNG();
            }
            finally
            {
                if (hOld   != IntPtr.Zero) SelectObject(hdcDest, hOld);
                if (hBmp   != IntPtr.Zero) DeleteObject(hBmp);
                if (hdcDest != IntPtr.Zero) DeleteDC(hdcDest);
                if (hdcSrc != IntPtr.Zero) ReleaseDC(hwnd, hdcSrc);
                if (tex    != null) UnityEngine.Object.DestroyImmediate(tex);
            }
#else
            error = "Win32WindowCapture: only supported on Windows Editor (UNITY_EDITOR_WIN).";
            return null;
#endif
        }

        // ── P/Invoke ────────────────────────────────────────────────────────────
#if UNITY_EDITOR_WIN
        [StructLayout(LayoutKind.Sequential)]
        private struct RECT { public int Left, Top, Right, Bottom; }

        [StructLayout(LayoutKind.Sequential)]
        private struct BITMAPINFOHEADER
        {
            public uint   biSize;
            public int    biWidth;
            public int    biHeight;
            public ushort biPlanes;
            public ushort biBitCount;
            public uint   biCompression;
            public uint   biSizeImage;
            public int    biXPelsPerMeter;
            public int    biYPelsPerMeter;
            public uint   biClrUsed;
            public uint   biClrImportant;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct BITMAPINFO
        {
            public BITMAPINFOHEADER bmiHeader;
            public uint bmiColors; // BI_RGB + 32bpp では color table 不要だが 1 entry 確保
        }

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

        [DllImport("user32.dll")]
        private static extern IntPtr GetDC(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);

        [DllImport("gdi32.dll")]
        private static extern IntPtr CreateCompatibleDC(IntPtr hdc);

        [DllImport("gdi32.dll")]
        private static extern IntPtr CreateCompatibleBitmap(IntPtr hdc, int width, int height);

        [DllImport("gdi32.dll")]
        private static extern IntPtr SelectObject(IntPtr hdc, IntPtr hgdiobj);

        [DllImport("gdi32.dll")]
        private static extern bool DeleteDC(IntPtr hdc);

        [DllImport("gdi32.dll")]
        private static extern bool DeleteObject(IntPtr hObject);

        [DllImport("gdi32.dll")]
        private static extern int GetDIBits(
            IntPtr hdc, IntPtr hbm, uint start, uint cLines,
            byte[] lpvBits, ref BITMAPINFO lpbi, uint usage);
#endif // UNITY_EDITOR_WIN
    }
}
