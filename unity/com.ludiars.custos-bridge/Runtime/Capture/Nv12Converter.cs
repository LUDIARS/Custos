// Nv12Converter.cs — 画面の RenderTexture を GPU で NV12 にして読み戻す
//
// compute shader (Resources/CustosRgbToNv12) で拡大縮小と色変換を GPU で済ませ、読み戻すのは
// NV12 (1 画素 1.5 バイト) だけにする。生の BGRA (4 バイト) を読み戻して CPU で変換するより
// 転送量が 6 割少なく、CPU の色変換も要らない。D3D11 / D3D12 / Vulkan どれでも同じ経路。
#if UNITY_EDITOR || DEVELOPMENT_BUILD

using System;
using UnityEngine;
using UnityEngine.Rendering;

namespace Ludiars.Custos.Bridge.Capture
{
    public sealed class Nv12Converter : IDisposable
    {
        /// <summary>同時に読み戻し中にしてよい数。超えたらそのフレームは飛ばす (遅延を積まない)。</summary>
        private const int MaxInFlight = 2;

        private ComputeShader _shader;
        private int _kernel = -1;
        private ComputeBuffer _buffer;
        private int _bufW, _bufH;
        private int _inFlight;
        private bool _loadFailed;

        public bool IsSupported => SystemInfo.supportsComputeShaders && SystemInfo.supportsAsyncGPUReadback && Load();

        /// <summary>
        /// source を width x height (16 の倍数) の NV12 にして、読み戻せたら onDone を main thread で呼ぶ。
        /// 読み戻し待ちが多いときは何もしない (false)。
        /// </summary>
        public bool Convert(Texture source, int width, int height, Action<byte[], int, int> onDone)
        {
            if (!IsSupported || _inFlight >= MaxInFlight) return false;
            // 読み戻し中のバッファは解放できないので、大きさが変わるときは読み戻しが終わるまで待つ。
            if (_buffer != null && (_bufW != width || _bufH != height) && _inFlight > 0) return false;
            EnsureBuffer(width, height);

            _shader.SetTexture(_kernel, "_Source", source);
            _shader.SetBuffer(_kernel, "_Output", _buffer);
            _shader.SetInt("_Width", width);
            _shader.SetInt("_Height", height);
            // D3D 系は読み戻しの先頭行が画面の上。GL 系は下なので上下を返す。
            _shader.SetInt("_FlipY", SystemInfo.graphicsUVStartsAtTop ? 0 : 1);
            // Linear の色空間では sRGB の RT を読むと線形の値になるので、ガンマに戻してから YUV にする。
            _shader.SetInt("_ToGamma", QualitySettings.activeColorSpace == ColorSpace.Linear ? 1 : 0);
            _shader.Dispatch(_kernel, (width / 4 + 7) / 8, (height / 2 + 7) / 8, 1);

            _inFlight++;
            int w = width, h = height;
            AsyncGPUReadback.Request(_buffer, request =>
            {
                _inFlight--;
                if (request.hasError) return;
                onDone(request.GetData<byte>().ToArray(), w, h);
            });
            return true;
        }

        public void Dispose()
        {
            _buffer?.Release();
            _buffer = null;
        }

        private bool Load()
        {
            if (_kernel >= 0) return true;
            if (_loadFailed) return false;
            _shader = Resources.Load<ComputeShader>("CustosRgbToNv12");
            if (_shader == null)
            {
                _loadFailed = true;
                Debug.LogWarning("[CustosBridge] compute shader CustosRgbToNv12 not found — H.264 stream disabled");
                return false;
            }
            _kernel = _shader.FindKernel("RgbToNv12");
            return true;
        }

        private void EnsureBuffer(int width, int height)
        {
            if (_buffer != null && _bufW == width && _bufH == height) return;
            _buffer?.Release();
            // NV12 は width*height*3/2 バイト。4 バイト単位の構造化バッファとして確保する。
            _buffer = new ComputeBuffer(width * height * 3 / 8, 4, ComputeBufferType.Raw);
            _bufW = width;
            _bufH = height;
        }
    }
}

#endif // UNITY_EDITOR || DEVELOPMENT_BUILD
