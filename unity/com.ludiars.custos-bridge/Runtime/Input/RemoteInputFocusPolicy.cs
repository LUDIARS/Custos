// RemoteInputFocusPolicy.cs — 遠隔からの入力を、ゲームにフォーカスが無くても届くようにする
//
// Input System の既定では、アプリ (Editor では Game View) にフォーカスが無い間、
//   - backgroundBehavior = ResetAndDisableNonBackgroundDevices でキーボード等が無効になり
//   - editorInputBehaviorInPlayMode = PointersAndKeyboardsRespectGameViewFocus で入力が Game View に渡らない。
// Custos で遠隔プレイしている間、操作者はスマホ等にいて Unity にフォーカスは無いので、ブリッジが
// 注入した仮想キーボード / マウスの入力も捨てられていた。
//
// 最初の遠隔入力を受けた時点で、フォーカスを無視する設定の「実行時コピー」に差し替える。
// コピーはアセットではないので InputSystem.settings の setter はプロジェクト設定 (EditorBuildSettings) に
// 登録しない。Play を終えた (Editor) / アプリを閉じる時点で元の設定に戻す。
#if UNITY_EDITOR || DEVELOPMENT_BUILD
#if ENABLE_INPUT_SYSTEM

using UnityEngine;
using UnityEngine.InputSystem;

namespace Ludiars.Custos.Bridge.Input
{
    public static class RemoteInputFocusPolicy
    {
        private static InputSettings _original;
        private static InputSettings _override;

        /// <summary>遠隔入力を注入する直前に呼ぶ。main thread から呼ぶこと。2 回目以降は何もしない。</summary>
        public static void Apply()
        {
            if (_override != null && InputSystem.settings == _override) return;
            _original = InputSystem.settings;
            _override = Object.Instantiate(_original);
            _override.name = "CustosBridge Remote Input Settings (runtime)";
            _override.hideFlags = HideFlags.HideAndDontSave;
            _override.backgroundBehavior = InputSettings.BackgroundBehavior.IgnoreFocus;
#if UNITY_EDITOR
            _override.editorInputBehaviorInPlayMode = InputSettings.EditorInputBehaviorInPlayMode.AllDeviceInputAlwaysGoesToGameView;
#endif
            InputSystem.settings = _override;
            Debug.Log("[CustosBridge] remote input: input now reaches the game without focus (runtime-only settings)");
        }

        /// <summary>元の設定に戻す。差し替えていなければ何もしない。</summary>
        public static void Restore()
        {
            if (_override == null) return;
            if (InputSystem.settings == _override && _original != null) InputSystem.settings = _original;
            Object.DestroyImmediate(_override);
            _override = null;
            _original = null;
        }
    }
}

#endif // ENABLE_INPUT_SYSTEM
#endif // UNITY_EDITOR || DEVELOPMENT_BUILD
