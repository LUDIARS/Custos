// KeyHoldScheduler.cs — 押してからすぐ離したキーの「離し」を遅らせる判定 (純ロジック、EditMode テスト対象)
//
// 遠隔のタップは押下 / 解放の HTTP がほぼ同時に届くため、同じフレームで両方を反映すると
// 「押されているか」を毎フレーム見るゲーム (Keyboard.current[key].isPressed) が押下を見逃す。
// 押してから MinHoldFrames フレーム経つまでは離しを保留し、経ってから反映する。
// Edit モードなどフレームが進まない状況で押しっぱなしにならないよう、実時間の上限でも反映する。
#if UNITY_EDITOR || DEVELOPMENT_BUILD

using System.Collections.Generic;

namespace Ludiars.Custos.Bridge.Input
{
    public sealed class KeyHoldScheduler
    {
        /// <summary>押下をゲームに見せる最小フレーム数。</summary>
        public const int MinHoldFrames = 2;
        /// <summary>フレームが進まなくても、押してからこの秒数で離しを反映する。</summary>
        public const float MaxHoldSeconds = 0.25f;

        private readonly Dictionary<int, (int frame, float time)> _pressedAt = new Dictionary<int, (int, float)>();
        private readonly HashSet<int> _pendingRelease = new HashSet<int>();

        /// <summary>押下。保留中の離しがあれば取り消す (押し続けとして扱う)。</summary>
        public void OnDown(int key, int frame, float time)
        {
            _pressedAt[key] = (frame, time);
            _pendingRelease.Remove(key);
        }

        /// <summary>離し。今すぐ反映してよければ true、保留したら false。</summary>
        public bool OnUp(int key, int frame, float time)
        {
            if (!_pressedAt.TryGetValue(key, out var at) || IsHeldLongEnough(at, frame, time))
            {
                _pressedAt.Remove(key);
                return true;
            }
            _pendingRelease.Add(key);
            return false;
        }

        /// <summary>保留中の離しのうち、今反映すべきものを取り出す (毎フレーム呼ぶ)。</summary>
        public List<int> TakeDueReleases(int frame, float time)
        {
            var due = new List<int>();
            foreach (var key in _pendingRelease)
            {
                if (!_pressedAt.TryGetValue(key, out var at) || IsHeldLongEnough(at, frame, time)) due.Add(key);
            }
            foreach (var key in due)
            {
                _pendingRelease.Remove(key);
                _pressedAt.Remove(key);
            }
            return due;
        }

        public bool HasPending => _pendingRelease.Count > 0;

        private static bool IsHeldLongEnough((int frame, float time) at, int frame, float time)
        {
            return frame - at.frame >= MinHoldFrames || time - at.time >= MaxHoldSeconds;
        }
    }
}

#endif // UNITY_EDITOR || DEVELOPMENT_BUILD
