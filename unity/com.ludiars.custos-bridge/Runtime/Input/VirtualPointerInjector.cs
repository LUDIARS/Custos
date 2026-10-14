// VirtualPointerInjector.cs — 専用仮想 Mouse デバイスへのポインタ注入
//
// 方針は VirtualKeyboardInjector と同じ (spec/feature/remote-play-and-play-log.md §1.1):
//   - InputSystem.AddDevice<Mouse> で専用仮想デバイスを作る
//   - MouseState (位置 + ボタン) を自前で持ち、毎回フルステートを QueueStateEvent する
//   - 注入のたびに MakeCurrent して Mouse.current / Pointer.current を仮想デバイスに向ける
//     (uGUI の InputSystemUIInputModule とゲームの Pointer 参照の両方に届く)
#if UNITY_EDITOR || DEVELOPMENT_BUILD

#if ENABLE_INPUT_SYSTEM
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.InputSystem.LowLevel;

namespace Ludiars.Custos.Bridge.Input
{
    /// <summary>
    /// 専用仮想 Mouse デバイスを使ったポインタ注入。
    /// すべてのメソッドは main thread (dispatcher pump) から呼ぶこと。
    /// </summary>
    public sealed class VirtualPointerInjector
    {
        private Mouse      _virtualMouse;
        private MouseState _state;
        private Vector2    _lastPosition;
        private bool       _initialized;

        public void Initialize()
        {
            if (_initialized) return;
            _virtualMouse = InputSystem.AddDevice<Mouse>("CustosBridge Mouse");
            _state        = new MouseState();
            _initialized  = true;
            Debug.Log("[CustosBridge] VirtualPointerInjector: virtual mouse device added.");
        }

        public void Shutdown()
        {
            if (!_initialized) return;
            if (_virtualMouse != null && _virtualMouse.added)
                InputSystem.RemoveDevice(_virtualMouse);
            _virtualMouse = null;
            _initialized  = false;
        }

        /// <param name="x01">左上原点の正規化 x</param>
        /// <param name="y01">左上原点の正規化 y</param>
        /// <param name="button">0=left 1=right 2=middle</param>
        /// <param name="phase">"down" / "up" / "move"</param>
        public bool InjectPointer(float x01, float y01, int button, string phase)
        {
            if (!_initialized || _virtualMouse == null)
            {
                Debug.LogWarning("[CustosBridge] InjectPointer called before Initialize.");
                return false;
            }
            if (!PointerCoordinates.IsKnownPhase(phase)) return false;

            Vector2 position = PointerCoordinates.ToScreen(x01, y01, Screen.width, Screen.height);
            _state.position = position;
            _state.delta    = position - _lastPosition;
            _lastPosition   = position;

            bool? pressed = PointerCoordinates.PhaseToPressed(phase);
            if (pressed.HasValue)
                _state = _state.WithButton(ToMouseButton(button), pressed.Value);

            // フォーカスが無くても入力がゲームに届くようにする (RemoteInputFocusPolicy 参照)。
            RemoteInputFocusPolicy.Apply();
            _virtualMouse.MakeCurrent();
            InputSystem.QueueStateEvent(_virtualMouse, _state);
            return true;
        }

        private static MouseButton ToMouseButton(int button)
        {
            switch (button)
            {
                case 1:  return MouseButton.Right;
                case 2:  return MouseButton.Middle;
                default: return MouseButton.Left;
            }
        }
    }
}
#endif // ENABLE_INPUT_SYSTEM

#endif // UNITY_EDITOR || DEVELOPMENT_BUILD
