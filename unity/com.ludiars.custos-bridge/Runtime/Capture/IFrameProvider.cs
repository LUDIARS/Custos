// IFrameProvider.cs — スクリーンショット / フレーム取得の provider interface
#if UNITY_EDITOR || DEVELOPMENT_BUILD

using System;

namespace Ludiars.Custos.Bridge.Capture
{
    /// <summary>
    /// フレームを取得するプロバイダの共通 interface。
    /// BridgeServer は具体的な取り方を知らない。
    /// </summary>
    public interface IFrameProvider
    {
        /// <summary>
        /// main thread から呼ばれる。
        /// 完了時に PNG バイト列 (成功) か error 文字列 (失敗) を返す。
        /// 非同期実装でよい (callback は main thread / worker どちらでも可だが
        /// Unity API を触る場合は main thread 限定)。
        /// </summary>
        void RequestFrame(Action<byte[] /* png */, string /* error */> onDone);

        /// <summary>フレーム幅と高さをピクセルで返す。不明の場合は 0。</summary>
        void GetFrameSize(out int width, out int height);

        /// <summary>
        /// BGRA raw フレームを非同期で readback し、最新 1 枠として <see cref="IFrameStreamer"/> に供給する。
        /// ストリームが不要な場合はこのメソッドを空実装してよい。
        /// main thread から毎フレーム呼ばれる (pump)。
        /// </summary>
        void PumpStream(IFrameStreamer streamer);
    }

    /// <summary>
    /// <see cref="IFrameProvider"/> からフレームデータを受け取り、
    /// HTTP ストリームに配信する <see cref="FrameStreamer"/> との結合 interface。
    /// </summary>
    public interface IFrameStreamer
    {
        /// <summary>最新 BGRA フレームを更新する (main thread から呼ぶ)。</summary>
        void UpdateFrame(byte[] bgraData, int width, int height);

        /// <summary>BGRA の /stream に接続中か (接続が無ければ BGRA の読み戻しを省く)。</summary>
        bool HasActiveStream { get; }
    }

    /// <summary>
    /// H.264 配信 (/stream?codec=h264) の受け口。接続中だけ、プロバイダが画面を NV12 にして渡す。
    /// </summary>
    public interface IH264FrameTarget
    {
        bool HasActiveStream { get; }
        bool IsAvailable { get; }

        /// <summary>画面の大きさから、配信する大きさ (16 の倍数) を決める。</summary>
        void GetTargetSize(int screenWidth, int screenHeight, out int width, out int height);

        /// <summary>NV12 (Y 面 + UV 面、詰めて並べる) を 1 枚渡す。main thread から呼ぶ。</summary>
        void SubmitNv12(byte[] nv12, int width, int height);
    }
}

#endif // UNITY_EDITOR || DEVELOPMENT_BUILD
