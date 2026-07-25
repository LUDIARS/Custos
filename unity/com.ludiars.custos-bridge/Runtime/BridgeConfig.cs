// BridgeConfig.cs — 設定ファイル / 環境変数 / 既定値の解決
// 変更時は spec/unity-bridge.md §4.3 も更新すること。
#if UNITY_EDITOR || DEVELOPMENT_BUILD

using System;
using System.IO;
using UnityEngine;

namespace Ludiars.Custos.Bridge
{
    /// <summary>
    /// Custos Unity Bridge の実行時設定。
    /// 読み込み優先順位: 環境変数 > 設定ファイル > 既定値。
    /// I/O はこのクラスだけが担当する (SRP)。
    /// </summary>
    public sealed class BridgeConfig
    {
        // ── 既定値 ────────────────────────────────────────────
        public const int    DefaultPort         = 17778;
        public const string ConfigFileName      = "custos_bridge.json";
        public const string LegacyConfigFileName = "ergo_custos_bridge.json";

        // ── 設定値 ────────────────────────────────────────────
        public int    Port           { get; private set; } = DefaultPort;
        public bool   Enabled        { get; private set; } = false;
        public string Token          { get; private set; } = null;
        public string CaptureMode    { get; private set; } = "auto";
        public int    MaxLongEdge    { get; private set; } = 1280;
        public bool   RunInBackground{ get; private set; } = true;
        public int    ConcordiaPort  { get; private set; } = 11111;
        public string SessionId      { get; private set; } = null;
        public string AuthorLabel    { get; private set; } = "PrivateGame/Unity";

        // ── 設定ファイル DTO (JsonUtility 用) ────────────────
        [Serializable]
        private class ConfigDto
        {
            public int    port           = DefaultPort;
            public bool   enabled        = true;
            public string token          = "";
            public string captureMode    = "auto";
            public int    maxLongEdge    = 1280;
            public bool   runInBackground = true;
            public int    concordiaPort = 11111;
            public string authorLabel = "PrivateGame/Unity";
            public SessionDto session;
        }

        [Serializable]
        private class SessionDto
        {
            public string id = "";
        }

        /// <summary>
        /// プロジェクトルート付近の設定ファイルを読み込み、BridgeConfig を返す。
        /// 設定ファイルが存在しない場合は null。
        /// </summary>
        public static BridgeConfig Load()
        {
            string projectRoot = FindProjectRoot();
            string path        = FindConfigFile(projectRoot);
            if (path == null)
            {
                Debug.Log("[CustosBridge] No config file found. " +
                    $"Create {ConfigFileName} in project root to enable.");
                return null;
            }

            ConfigDto dto;
            try
            {
                dto = JsonUtility.FromJson<ConfigDto>(File.ReadAllText(path));
                if (dto == null) { Debug.LogError($"[CustosBridge] Config parse returned null: {path}"); return null; }
                Debug.Log($"[CustosBridge] Config loaded: port={dto.port}, captureMode={dto.captureMode} ({path})");
            }
            catch (Exception e)
            {
                Debug.LogError($"[CustosBridge] Config load failed: {e.Message} ({path})");
                return null;
            }

            var cfg = new BridgeConfig();
            cfg.Port            = dto.port;
            cfg.Enabled         = dto.enabled;
            cfg.Token           = string.IsNullOrEmpty(dto.token) ? null : dto.token;
            cfg.CaptureMode     = string.IsNullOrEmpty(dto.captureMode) ? "auto" : dto.captureMode.Trim().ToLowerInvariant();
            cfg.MaxLongEdge     = dto.maxLongEdge;
            cfg.RunInBackground = dto.runInBackground;
            cfg.ConcordiaPort   = dto.concordiaPort;
            cfg.SessionId       = string.IsNullOrEmpty(dto.session?.id) ? null : dto.session.id;
            cfg.AuthorLabel     = string.IsNullOrEmpty(dto.authorLabel) ? "PrivateGame/Unity" : dto.authorLabel;

            // 環境変数で上書き
            ApplyEnvOverrides(cfg);

            if (cfg.Port < 1 || cfg.Port > 65535)
            {
                Debug.LogError($"[CustosBridge] Invalid port: {cfg.Port}");
                return null;
            }
            if (cfg.ConcordiaPort < 1 || cfg.ConcordiaPort > 65535)
            {
                Debug.LogError($"[CustosBridge] Invalid Concordia port: {cfg.ConcordiaPort}");
                return null;
            }

            return cfg;
        }

        private static void ApplyEnvOverrides(BridgeConfig cfg)
        {
            string envPort = Environment.GetEnvironmentVariable("CUSTOS_UNITY_BRIDGE_PORT");
            if (!string.IsNullOrEmpty(envPort) && int.TryParse(envPort, out int p))
                cfg.Port = p;

            string envEnabled = Environment.GetEnvironmentVariable("CUSTOS_UNITY_BRIDGE_ENABLED");
            if (!string.IsNullOrEmpty(envEnabled))
                cfg.Enabled = envEnabled.ToLowerInvariant() != "false" && envEnabled != "0";
        }

        // ── 設定ファイル探索 ─────────────────────────────────

        private static string FindProjectRoot()
        {
            // Application.dataPath = <Project>/Assets
            // そのひとつ上が Unity プロジェクトルート
            return Path.GetDirectoryName(Application.dataPath);
        }

        private static string FindConfigFile(string projectRoot)
        {
            // 新名 → 旧名 の順でチェック。サブディレクトリも含む
            string[] searchDirs =
            {
                projectRoot,
                Path.Combine(projectRoot, "custos"),
                Path.Combine(projectRoot, "musa", "terpsichore"),
            };
            string[] fileNames = { ConfigFileName, LegacyConfigFileName };

            foreach (string dir in searchDirs)
            {
                foreach (string fn in fileNames)
                {
                    string p = Path.Combine(dir, fn);
                    if (File.Exists(p)) return p;
                }
            }
            return null;
        }
    }
}

#endif // UNITY_EDITOR || DEVELOPMENT_BUILD
