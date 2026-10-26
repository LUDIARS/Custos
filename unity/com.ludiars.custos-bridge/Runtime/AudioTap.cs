// AudioTap.cs — 有効な AudioListener に付けて、ミックス済みの音を AudioStreamer (GET /audio) へ渡す
#if UNITY_EDITOR || DEVELOPMENT_BUILD

using UnityEngine;

namespace Ludiars.Custos.Bridge
{
    /// <summary>
    /// 有効な AudioListener に付けて、ミックス済みの音を <see cref="AudioStreamer"/> へ渡す。
    /// 音は変えずに読むだけ。付け外しは <see cref="AudioStreamer.Maintain"/> が行う。
    /// </summary>
    internal sealed class AudioTap : MonoBehaviour
    {
        internal volatile AudioStreamer Target;

        private void OnAudioFilterRead(float[] data, int channels)
        {
            Target?.Push(data, channels);
        }
    }
}

#endif // UNITY_EDITOR || DEVELOPMENT_BUILD
