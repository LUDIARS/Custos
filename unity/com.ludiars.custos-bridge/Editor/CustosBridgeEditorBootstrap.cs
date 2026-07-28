// CustosBridgeEditorBootstrap.cs — Editor 起動 ([InitializeOnLoad] + メニュートグル)
//
// 設計 (spec/unity-bridge.md §4.2):
//   - [InitializeOnLoad] で設定ファイルがあり enabled == true なら自動起動
//   - メニュー LUDIARS/Custos Bridge/Enabled でいつでも ON/OFF
//   - AssemblyReloadEvents.beforeAssemblyReload と EditorApplication.quitting で停止
//   - PlayMode 遷移 (playModeStateChanged) で listener は維持、provider だけ切替
//   - Editor 内では Runtime bootstrap (CustosBridgeRuntime) は動かない (二重 bind 防止)
using UnityEngine;
using UnityEditor;
using System;
using Ludiars.Custos.Bridge;
using Ludiars.Custos.Bridge.Capture;

namespace Ludiars.Custos.Bridge.Editor
{
    /// <summary>
    /// Unity Editor における Custos Bridge の lifecycle 管理。
    /// </summary>
    [InitializeOnLoad]
    public static class CustosBridgeEditorBootstrap
    {
        private const string PrefsKey = "Ludiars.CustosBridge.Enabled";

        private static BridgeServer  _server;
        private static FrameStreamer _streamer;
        private static GameObject    _hostGo;

        // ── 静的コンストラクタ ────────────────────────────

        static CustosBridgeEditorBootstrap()
        {
            // EditorPrefs 上の enabled + 設定ファイルの enabled どちらも確認
            bool editorEnabled = EditorPrefs.GetBool(PrefsKey, false);
            var cfg = BridgeConfig.Load();

            if (cfg != null && cfg.Enabled && editorEnabled)
            {
                StartBridge(cfg);
            }
            else if (cfg != null && cfg.Enabled && !editorEnabled)
            {
                Debug.Log("[CustosBridge] Config enabled=true but Editor toggle is OFF. " +
                    "Use menu LUDIARS/Custos Bridge/Enabled to enable.");
            }

            // hook 登録 (毎回登録)
            EditorApplication.update               += OnEditorUpdate;
            EditorApplication.quitting             += StopBridge;
            AssemblyReloadEvents.beforeAssemblyReload += StopBridge;
            EditorApplication.playModeStateChanged += OnPlayModeChanged;
        }

        // ── メニュートグル ────────────────────────────────

        [MenuItem("LUDIARS/Custos Bridge/Enabled", false, 1)]
        private static void ToggleEnabled()
        {
            bool current = EditorPrefs.GetBool(PrefsKey, false);
            bool next    = !current;
            EditorPrefs.SetBool(PrefsKey, next);
            Menu.SetChecked("LUDIARS/Custos Bridge/Enabled", next);

            if (next)
            {
                var cfg = BridgeConfig.Load();
                if (cfg == null)
                {
                    Debug.LogWarning("[CustosBridge] Cannot enable: custos_bridge.json not found.");
                    EditorPrefs.SetBool(PrefsKey, false);
                    return;
                }
                StartBridge(cfg);
            }
            else
            {
                StopBridge();
            }
        }

        [MenuItem("LUDIARS/Custos Bridge/Enabled", true)]
        private static bool ToggleEnabledValidate()
        {
            Menu.SetChecked("LUDIARS/Custos Bridge/Enabled", EditorPrefs.GetBool(PrefsKey, false));
            return true;
        }

        [MenuItem("LUDIARS/Custos Bridge/Status", false, 2)]
        private static void ShowStatus()
        {
            bool running = _server != null && _server.IsRunning;
            EditorUtility.DisplayDialog(
                "Custos Bridge Status",
                $"Running: {running}\n" +
                $"Editor toggle: {EditorPrefs.GetBool(PrefsKey, false)}\n" +
                $"Stream active: {(_streamer?.HasActiveStream ?? false)}",
                "OK");
        }

        // ── 起動 / 停止 ──────────────────────────────────

        private static void StartBridge(BridgeConfig cfg)
        {
            if (_server != null && _server.IsRunning) return;

            if (cfg.RunInBackground)
                Application.runInBackground = true;

            // 仮想キーボード注入器
#if ENABLE_INPUT_SYSTEM
            var injector = new Input.VirtualKeyboardInjector();
            injector.Initialize();
#endif

            // hidden GameObject (EditorSceneManager と DontDestroyOnLoad の外に置く)
            _hostGo = new GameObject("[CustosBridgeEditorHost]")
            {
                hideFlags = HideFlags.HideAndDontSave
            };

            _streamer = new FrameStreamer();

            // RuntimeCameraViewProvider (MonoBehaviour, hidden GO に追加)
            var runtimeProvider = _hostGo.AddComponent<RuntimeCameraViewProvider>();
            runtimeProvider.Initialize(cfg.MaxLongEdge, _streamer);

            // EditorGameViewFrameProvider (thin wrapper)
            var editorProvider = new EditorGameViewFrameProvider(
                cfg.CaptureMode, cfg.MaxLongEdge, runtimeProvider, _streamer);
            CustosCapturePublisher.Configure(editorProvider, cfg);

            _server = new BridgeServer(
                editorProvider,
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
                },
                CustosCapturePublisher.PublishAsync);

            _server.Start();

            // quitting で injector も片付ける
            EditorApplication.quitting += () =>
            {
#if ENABLE_INPUT_SYSTEM
                injector.Shutdown();
#endif
            };
        }

        private static void StopBridge()
        {
            _server?.Stop();
            _server = null;

            if (_hostGo != null)
            {
                UnityEngine.Object.DestroyImmediate(_hostGo);
                _hostGo = null;
            }
            _streamer = null;
            CustosCapturePublisher.Reset();
        }

        // ── EditorApplication.update ポンプ ─────────────

        private static void OnEditorUpdate()
        {
            MainThreadDispatcher.Pump();

            // ストリーム接続中はフレームキャプチャをリクエスト
            // (EditorApplication.update は ~100Hz 程度で呼ばれる)
            if (_streamer != null && _streamer.HasActiveStream && _hostGo != null)
            {
                var provider = _hostGo.GetComponent<RuntimeCameraViewProvider>();
                if (provider != null && Application.isPlaying)
                {
                    provider.RequestStreamPump();
                    provider.PumpStream(_streamer);
                }
            }
        }

        // ── PlayMode 遷移 ─────────────────────────────────

        private static void OnPlayModeChanged(PlayModeStateChange state)
        {
            // listener は維持する。provider の PlayMode 判断は RequestFrame 内で行う (Application.isPlaying)。
            // 特別な切り替え処理は現在不要 (EditorGameViewFrameProvider が isPlaying で内部分岐)。
            switch (state)
            {
                case PlayModeStateChange.EnteredPlayMode:
                    Debug.Log("[CustosBridge] Entered PlayMode — using ScreenCapture provider.");
                    break;
                case PlayModeStateChange.EnteredEditMode:
                    Debug.Log("[CustosBridge] Entered EditMode — using SingleCameraRequest provider.");
                    break;
            }
        }
    }
}
