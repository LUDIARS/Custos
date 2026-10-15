// VirtualKeyboardInjector.cs — 専用仮想 Keyboard デバイスへの入力注入
//
// 設計方針 (spec/unity-bridge.md §3.3):
//   - InputSystem.AddDevice<Keyboard> で専用仮想デバイスを作る
//   - KeyboardState を自前で蓄積し、毎回フルステートを QueueStateEvent する
//   - 物理キーボードとデバイスが独立するため state 競合が起きない
//
// 要検証 (TODO):
//   - QueueStateEvent のスレッド安全性 (1.14 公式ドキュメントでは safe とされるが
//     AddDevice/RemoveDevice との順序保証のため dispatcher 経由に統一している)
//   - Keyboard.current が物理キーに戻った後の仮想押下 state 可視性 (§3.3 既知制約)
#if UNITY_EDITOR || DEVELOPMENT_BUILD

#if ENABLE_INPUT_SYSTEM
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.InputSystem.LowLevel;

namespace Ludiars.Custos.Bridge.Input
{
    /// <summary>
    /// 専用仮想 Keyboard デバイスを使った入力注入。
    /// <see cref="Initialize"/> と <see cref="Shutdown"/> は main thread から呼ぶこと。
    /// <see cref="InjectKey"/> は <see cref="MainThreadDispatcher"/> 経由で main thread から呼ぶ。
    /// </summary>
    public sealed class VirtualKeyboardInjector
    {
        private Keyboard      _virtualKeyboard;
        private KeyboardState _pressedState;
        private bool          _initialized;
        // 押してすぐ離したキーの離しを、ゲームが押下を見られるまで保留する (KeyHoldScheduler 参照)。
        private readonly KeyHoldScheduler _hold = new KeyHoldScheduler();

        // ── ライフサイクル ────────────────────────────────

        /// <summary>仮想デバイスを作成する (main thread)。</summary>
        public void Initialize()
        {
            if (_initialized) return;
            _virtualKeyboard = InputSystem.AddDevice<Keyboard>("CustosBridge Keyboard");
            _pressedState    = new KeyboardState();
            _initialized     = true;
            MainThreadDispatcher.AfterPump += FlushDueReleases;
            Debug.Log("[CustosBridge] VirtualKeyboardInjector: virtual keyboard device added.");
        }

        /// <summary>仮想デバイスを破棄する (main thread)。</summary>
        public void Shutdown()
        {
            if (!_initialized) return;
            MainThreadDispatcher.AfterPump -= FlushDueReleases;
            if (_virtualKeyboard != null && _virtualKeyboard.added)
            {
                InputSystem.RemoveDevice(_virtualKeyboard);
                Debug.Log("[CustosBridge] VirtualKeyboardInjector: virtual keyboard device removed.");
            }
            _virtualKeyboard = null;
            _initialized     = false;
        }

        // ── 注入 ─────────────────────────────────────────

        /// <summary>
        /// HID code に対応するキーを押下/離す。
        /// main thread (dispatcher pump) から呼ぶこと。
        /// 未対応 code は 400 相当のログを出して無視する。
        /// </summary>
        public bool InjectKey(int hidCode, bool down)
        {
            if (!_initialized || _virtualKeyboard == null)
            {
                Debug.LogWarning("[CustosBridge] InjectKey called before Initialize.");
                return false;
            }

            var key = HidKeyMap.ToKey(hidCode);
            if (key == Key.None)
            {
                Debug.LogWarning($"[CustosBridge] InjectKey: unknown HID code {hidCode}");
                return false;
            }

            // フルステート蓄積方式:
            // KeyboardState.Set(Key, bool) でビットを立て/倒し、
            // フルステートを毎回 queue する。
            // これにより同時押し (W + Space 等) が正しく表現され、
            // タイミングのズレがあっても次イベントで自己修復する。
            // フォーカスが無くても入力がゲームに届くようにする (RemoteInputFocusPolicy 参照)。
            RemoteInputFocusPolicy.Apply();
            if (down)
            {
                _hold.OnDown((int)key, Time.frameCount, Time.realtimeSinceStartup);
            }
            else if (!_hold.OnUp((int)key, Time.frameCount, Time.realtimeSinceStartup))
            {
                return true;   // 離しは保留。FlushDueReleases が後のフレームで反映する
            }
            Apply(key, down);
            return true;
        }

        /// <summary>保留していた離しのうち、押下がゲームに見えたものを反映する (Pump の後に毎回呼ばれる)。</summary>
        private void FlushDueReleases()
        {
            if (!_initialized || _virtualKeyboard == null || !_hold.HasPending) return;
            foreach (var key in _hold.TakeDueReleases(Time.frameCount, Time.realtimeSinceStartup))
            {
                Apply((Key)key, false);
            }
        }

        private void Apply(Key key, bool down)
        {
            _pressedState.Set(key, down);
            // ゲームが Keyboard.current を読む場合に備えて、仮想キーボードを current にする
            // (物理キーボードが current のままだと注入した入力が見られない)。
            _virtualKeyboard.MakeCurrent();
            InputSystem.QueueStateEvent(_virtualKeyboard, _pressedState);
        }
    }
}
#endif // ENABLE_INPUT_SYSTEM

#endif // UNITY_EDITOR || DEVELOPMENT_BUILD
