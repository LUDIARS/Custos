// CustosBridgeRuntime.cs — Player ビルド向け自動起動 ([RuntimeInitializeOnLoadMethod])
//
// Editor 内では動作しない (Application.isEditor チェック + Bootstrap が Editor 版を持つ)。
// DEVELOPMENT_BUILD 時のみ有効 (defineConstraints 参照)。
//
// 起動経路:
//   [RuntimeInitializeOnLoadMethod] → BridgeConfig.Load() → hidden GameObject 生成
//   → RuntimeCameraViewProvider (MonoBehaviour) + pump MonoBehaviour を同一 GO に追加
//   → BridgeServer.Start()
//
// 停止経路:
//   Application.quitting → BridgeServer.Stop() + VirtualKeyboardInjector.Shutdown()
#if UNITY_EDITOR || DEVELOPMENT_BUILD

using UnityEngine;

namespace Ludiars.Custos.Bridge
{
    /// <summary>
    /// Player ビルドにおける Custos Bridge の自動起動 bootstrap。
    /// Editor 内では <see cref="Editor.CustosBridgeEditorBootstrap"/> が担当するため、
    /// このクラスは Editor では即 return する。
    /// </summary>
    public static class CustosBridgeRuntime
    {
        private static BridgeServer   _server;
        private static FrameStreamer  _streamer;
        private static GameObject     _hostGo;

#if !UNITY_EDITOR
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        private static void AutoStart()
        {
            StartInternal();
        }
#endif

        /// <summary>
        /// Editor 以外から呼ばれる内部起動処理。
        /// Editor Bootstrap からもテスト用に呼べる。
        /// </summary>
        internal static void StartInternal()
        {
            if (_server != null && _server.IsRunning) return;

            var cfg = BridgeConfig.Load();
            if (cfg == null || !cfg.Enabled)
            {
                Debug.Log("[CustosBridge] Runtime bootstrap: not enabled.");
                return;
            }

            // runInBackground
            if (cfg.RunInBackground)
                Application.runInBackground = true;

            // 仮想キーボード注入器
#if ENABLE_INPUT_SYSTEM
            var injector = new Input.VirtualKeyboardInjector();
            injector.Initialize();
#endif

            // hidden GameObject (DontDestroyOnLoad + HideAndDontSave)
            _hostGo = new GameObject("[CustosBridgeHost]")
            {
                hideFlags = HideFlags.HideAndDontSave
            };
            Object.DontDestroyOnLoad(_hostGo);

            // RuntimeCameraViewProvider (MonoBehaviour)
            _streamer = new FrameStreamer();
            var provider = _hostGo.AddComponent<Capture.RuntimeCameraViewProvider>();
            provider.Initialize(cfg.MaxLongEdge, _streamer);

            // ポンプ用 MonoBehaviour
            var pump = _hostGo.AddComponent<BridgeRuntimePump>();
            pump.Provider = provider;
            pump.Streamer  = _streamer;

            // BridgeServer
            _server = new BridgeServer(
                provider,
                _streamer,
                cfg,
                (hidCode, down, result) =>
                {
#if ENABLE_INPUT_SYSTEM
                    bool ok = injector.InjectKey(hidCode, down);
                    result?.Invoke(ok);
#else
                    Debug.LogWarning("[CustosBridge] Input System not enabled — key injection skipped.");
                    result?.Invoke(false);
#endif
                });

            _server.Start();

            Application.quitting += () =>
            {
                _server?.Stop();
#if ENABLE_INPUT_SYSTEM
                injector.Shutdown();
#endif
            };
        }
    }

    /// <summary>
    /// hidden GameObject に貼り付けるポンプ MonoBehaviour。
    /// MainThreadDispatcher と FrameStreamer の stream pump を毎フレーム叩く。
    /// </summary>
    internal sealed class BridgeRuntimePump : MonoBehaviour
    {
        internal Capture.RuntimeCameraViewProvider Provider;
        internal FrameStreamer Streamer;

        private void Update()
        {
            // BG スレッドからのアクションを main thread で実行
            MainThreadDispatcher.Pump();

            // ストリーム接続があれば次フレームキャプチャをリクエスト
            if (Streamer != null && Streamer.HasActiveStream && Provider != null)
            {
                Provider.RequestStreamPump();
                Provider.PumpStream(Streamer);
            }
        }
    }
}

#endif // UNITY_EDITOR || DEVELOPMENT_BUILD
