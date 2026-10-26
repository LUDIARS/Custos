// CustosAudioFeed.cs — 音が AudioListener を通らないゲームが、自分のミックスを GET /audio へ渡す入口
//
// 独自の音声エンジン (ミドルウェア) で鳴らすゲームでは、AudioListener のタップに音が来ない。
// そういうゲームは Use(レート) で「自分で渡す」と宣言し、IsListening の間だけ Push で PCM を渡す。
// 宣言している間ブリッジはタップを使わず、/audio のレートは宣言の値になる。Release で元に戻す。
// ブリッジが動いていない (起動前・無効) ときは、どの呼び出しも何もしない。
#if UNITY_EDITOR || DEVELOPMENT_BUILD

namespace Ludiars.Custos.Bridge
{
    public static class CustosAudioFeed
    {
        private static AudioStreamer Target;

        /// <summary>起動処理 (Editor / Player の bootstrap) が、動いている /audio の配信をつなぐ (止めるときは null)。</summary>
        public static void Bind(AudioStreamer streamer) => Target = streamer;

        /// <summary>いま /audio を受け取っている接続があるか (無い間は Push しなくてよい)。</summary>
        public static bool IsListening => Target != null && Target.HasActiveStream;

        /// <summary>自分のミックスを渡すと宣言する。sampleRate は Push する音のレート (Hz)。</summary>
        public static void Use(int sampleRate) => Target?.UseExternal(sampleRate);

        /// <summary>宣言を取り下げ、AudioListener のタップに戻す。</summary>
        public static void Release() => Target?.UseExternal(0);

        /// <summary>
        /// PCM を渡す (-1〜1 の float、チャンネル交互、先頭 length 個)。どのスレッドから呼んでもよい。
        /// 宣言していない・受け取る接続が無いときは捨てる。
        /// </summary>
        public static void Push(float[] interleaved, int length, int channels) => Target?.PushExternal(interleaved, length, channels);
    }
}

#endif // UNITY_EDITOR || DEVELOPMENT_BUILD
