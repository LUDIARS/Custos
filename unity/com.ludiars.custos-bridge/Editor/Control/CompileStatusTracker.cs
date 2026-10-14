// CompileStatusTracker.cs — スクリプトコンパイルの結果 (/editor/compile-status の正本)
//
// 成功するとドメインリロードで static が消えるため、要約 JSON は SessionState に退避する。
// 失敗時はリロードが起きないので、エラー一覧はそのまま残る。
using System;
using System.Collections.Generic;
using System.Text;
using UnityEditor;
using UnityEditor.Compilation;
using Ludiars.Custos.Bridge.Protocol;

namespace Ludiars.Custos.Bridge.Editor.Control
{
    internal static class CompileStatusTracker
    {
        private const string SummaryKey = "Ludiars.CustosBridge.CompileSummary";
        private const int MaxMessages = 200;

        private static readonly List<CompilerMessage> Errors = new List<CompilerMessage>();
        private static readonly List<CompilerMessage> Warnings = new List<CompilerMessage>();
        private static readonly Dictionary<string, string> AssemblyOf = new Dictionary<string, string>();
        private static bool _installed;

        /// <summary>main thread で 1 回だけ呼ぶ。</summary>
        public static void Install()
        {
            if (_installed) return;
            _installed = true;
            CompilationPipeline.compilationStarted += OnStarted;
            CompilationPipeline.assemblyCompilationFinished += OnAssemblyFinished;
            CompilationPipeline.compilationFinished += OnFinished;
        }

        /// <summary>main thread で呼ぶ (EditorApplication / SessionState を読むため)。</summary>
        public static string StatusJson()
        {
            // 退避した要約は isCompiling を含まない (問い合わせ時点の値を前に付ける)。
            string summary = SessionState.GetString(SummaryKey, string.Empty);
            if (string.IsNullOrEmpty(summary))
                summary = "\"errorCount\":0,\"warningCount\":0,\"errors\":[],\"warnings\":[],\"finishedAt\":\"\"";
            string compiling = EditorApplication.isCompiling ? "true" : "false";
            return "{\"isCompiling\":" + compiling + "," + summary + "}";
        }

        private static void OnStarted(object _)
        {
            Errors.Clear();
            Warnings.Clear();
            AssemblyOf.Clear();
        }

        private static void OnAssemblyFinished(string assemblyPath, CompilerMessage[] messages)
        {
            string assembly = System.IO.Path.GetFileNameWithoutExtension(assemblyPath);
            foreach (var m in messages)
            {
                var bucket = m.type == CompilerMessageType.Error ? Errors : Warnings;
                if (bucket.Count >= MaxMessages) continue;
                bucket.Add(m);
                AssemblyOf[Key(m)] = assembly;
            }
        }

        private static void OnFinished(object _)
        {
            var sb = new StringBuilder();
            sb.Append("\"errorCount\":").Append(Errors.Count);
            sb.Append(",\"warningCount\":").Append(Warnings.Count);
            sb.Append(",\"errors\":");
            AppendMessages(sb, Errors);
            sb.Append(",\"warnings\":");
            AppendMessages(sb, Warnings);
            sb.Append(",\"finishedAt\":\"").Append(DateTime.UtcNow.ToString("o")).Append('"');
            SessionState.SetString(SummaryKey, sb.ToString());
        }

        private static void AppendMessages(StringBuilder sb, List<CompilerMessage> messages)
        {
            sb.Append('[');
            for (int i = 0; i < messages.Count; i++)
            {
                var m = messages[i];
                if (i > 0) sb.Append(',');
                AssemblyOf.TryGetValue(Key(m), out string assembly);
                sb.Append("{\"file\":\"").Append(HttpJson.Escape(m.file))
                  .Append("\",\"line\":").Append(m.line)
                  .Append(",\"column\":").Append(m.column)
                  .Append(",\"message\":\"").Append(HttpJson.Escape(m.message))
                  .Append("\",\"assembly\":\"").Append(HttpJson.Escape(assembly))
                  .Append("\"}");
            }
            sb.Append(']');
        }

        private static string Key(CompilerMessage m) => $"{m.file}:{m.line}:{m.column}:{m.message}";
    }
}
