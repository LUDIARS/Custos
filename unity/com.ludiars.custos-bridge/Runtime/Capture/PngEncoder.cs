// PngEncoder.cs — BGRA/RGBA raw byte[] → PNG エンコード
//
// 要検証 (spec/unity-bridge.md §7 #1 #2):
//   1. AsyncGPUReadback の行順は Graphics API 依存。
//      D3D11 (Windows / KzSUnity 想定) では SystemInfo.graphicsUVStartsAtTop == true となり
//      top-down データが返るので通常反転不要だが、テクスチャ座標系とのズレが生じた場合は
//      FlipRows() でフリップする。
//   2. Linear color space プロジェクトでは staging RT を sRGB フォーマットで作ること
//      (BridgeServer / provider 側の責務)。ここでは raw bytes をそのまま EncodeToPNG に渡す。
#if UNITY_EDITOR || DEVELOPMENT_BUILD

using System;
using System.Threading.Tasks;
using Unity.Collections;
using UnityEngine;

namespace Ludiars.Custos.Bridge.Capture
{
    /// <summary>
    /// raw RGBA/BGRA byte 列から PNG を生成するユーティリティ。
    /// PNG エンコードは重い (1080p で数十 ms 級) ので Task.Run でワーカーに逃がす。
    /// </summary>
    public static class PngEncoder
    {
        /// <summary>
        /// NativeArray&lt;byte&gt; (AsyncGPUReadback 出力) → PNG バイト列 (非同期)。
        /// format は RGBA32 または BGRA32。
        /// TODO(要検証): BGRA の場合は EncodeToPNG 前に R↔B 入れ替えが必要か確認。
        ///               AsyncGPUReadback を TextureFormat.RGBA32 で要求すれば入れ替え不要。
        /// </summary>
        public static Task<byte[]> EncodeNativeArrayToPngAsync(
            NativeArray<byte> data,
            int width, int height,
            bool flipRows = false)
        {
            // NativeArray は main thread スコープを越えられないのでコピーを先に取る
            var copy = data.ToArray();
            return Task.Run(() => EncodeRawToPng(copy, width, height, flipRows));
        }

        /// <summary>managed byte[] → PNG バイト列 (同期、ワーカー内から呼ぶ想定)。</summary>
        public static byte[] EncodeRawToPng(byte[] rawRgba, int width, int height, bool flipRows)
        {
            if (flipRows)
                FlipRows(rawRgba, width, height);

            // TODO(要検証): ImageConversion.EncodeNativeArrayToPNG が使えれば
            //               Texture2D を生成せずにエンコードできるが、
            //               Unity 2022+ でのみ保証。Unity 6 では使用可能なはず。
            //               下記は Texture2D 経由の保守的実装。
            var tex = new Texture2D(width, height, TextureFormat.RGBA32, false);
            tex.LoadRawTextureData(rawRgba);
            tex.Apply(false, false);
            byte[] png = tex.EncodeToPNG();
            UnityEngine.Object.DestroyImmediate(tex);
            return png;
        }

        /// <summary>上下反転 (行単位)。CPU 上で実施する。</summary>
        public static void FlipRows(byte[] data, int width, int height)
        {
            int stride = width * 4;
            var rowBuf = new byte[stride];
            for (int y = 0; y < height / 2; y++)
            {
                int top    = y * stride;
                int bottom = (height - 1 - y) * stride;
                Buffer.BlockCopy(data, top,    rowBuf, 0,      stride);
                Buffer.BlockCopy(data, bottom, data,   top,    stride);
                Buffer.BlockCopy(rowBuf, 0,    data,   bottom, stride);
            }
        }

        /// <summary>
        /// BGRA → RGBA 変換 (インプレース)。
        /// AsyncGPUReadback を TextureFormat.RGBA32 で要求した場合は呼ばなくてよい。
        /// </summary>
        public static void BgraToRgba(byte[] data)
        {
            for (int i = 0; i + 3 < data.Length; i += 4)
            {
                byte b = data[i];
                data[i]     = data[i + 2]; // R
                data[i + 2] = b;           // B
                data[i + 3] = 255;         // A を不透明固定
            }
        }
    }
}

#endif // UNITY_EDITOR || DEVELOPMENT_BUILD
