// EditorLogBuffer.cs — Console ログのリングバッファ (/editor/log の正本)
//
// Application.logMessageReceivedThreaded は任意スレッドから呼ばれるので lock で守る。
// ドメインリロードで static は消えるが、seq は SessionState に退避して続きから振る
// (クライアントの since が巻き戻らないようにする)。
using System;
using System.Collections.Generic;
using System.Text;
using UnityEditor;
using UnityEngine;
using Ludiars.Custos.Bridge.Protocol;

namespace Ludiars.Custos.Bridge.Editor.Control
{
    internal static class EditorLogBuffer
    {
        private const int Capacity = 2000;
        private const string SeqKey = "Ludiars.CustosBridge.LogNextSeq";

        private struct Entry
        {
            public long Seq;
            public string Ts;
            public string Level;
            public string Message;
            public string StackTrace;
        }

        private static readonly object Gate = new object();
        private static readonly Queue<Entry> Entries = new Queue<Entry>(Capacity);
        private static long _nextSeq;
        private static bool _installed;

        /// <summary>main thread で 1 回だけ呼ぶ (SessionState を読むため)。</summary>
        public static void Install()
        {
            if (_installed) return;
            _installed = true;
            lock (Gate) _nextSeq = Math.Max(_nextSeq, SessionState.GetInt(SeqKey, 0));
            Application.logMessageReceivedThreaded += OnLog;
            AssemblyReloadEvents.beforeAssemblyReload += SaveSeq;
        }

        /// <summary>Unity の LogType を UI のフィルタ名 (error / warn / log) に寄せる。</summary>
        public static string LevelOf(LogType type)
        {
            switch (type)
            {
                case LogType.Error:
                case LogType.Exception:
                case LogType.Assert:
                    return "Error";
                case LogType.Warning:
                    return "Warn";
                default:
                    return "Log";
            }
        }

        /// <summary>since 以降のエントリを JSON で返す (level は大文字小文字を区別しない)。</summary>
        public static string PageJson(long since, string level, int limit)
        {
            var sb = new StringBuilder("{\"entries\":[");
            long next;
            lock (Gate)
            {
                int written = 0;
                foreach (var e in Entries)
                {
                    if (e.Seq < since) continue;
                    if (!string.IsNullOrEmpty(level) && !string.Equals(e.Level, level, StringComparison.OrdinalIgnoreCase)) continue;
                    if (written >= limit) break;
                    if (written > 0) sb.Append(',');
                    sb.Append("{\"seq\":").Append(e.Seq)
                      .Append(",\"ts\":\"").Append(e.Ts)
                      .Append("\",\"level\":\"").Append(e.Level)
                      .Append("\",\"message\":\"").Append(HttpJson.Escape(e.Message))
                      .Append("\",\"stackTrace\":\"").Append(HttpJson.Escape(e.StackTrace))
                      .Append("\"}");
                    written++;
                }
                next = written >= limit ? LastWrittenSeq(since, level, limit) + 1 : _nextSeq;
            }
            sb.Append("],\"nextSeq\":").Append(next).Append('}');
            return sb.ToString();
        }

        private static long LastWrittenSeq(long since, string level, int limit)
        {
            long last = since - 1;
            int count = 0;
            foreach (var e in Entries)
            {
                if (e.Seq < since) continue;
                if (!string.IsNullOrEmpty(level) && !string.Equals(e.Level, level, StringComparison.OrdinalIgnoreCase)) continue;
                last = e.Seq;
                if (++count >= limit) break;
            }
            return last;
        }

        private static void OnLog(string message, string stackTrace, LogType type)
        {
            lock (Gate)
            {
                if (Entries.Count >= Capacity) Entries.Dequeue();
                Entries.Enqueue(new Entry
                {
                    Seq = _nextSeq++,
                    Ts = DateTime.UtcNow.ToString("o"),
                    Level = LevelOf(type),
                    Message = message,
                    StackTrace = stackTrace,
                });
            }
        }

        private static void SaveSeq()
        {
            long next;
            lock (Gate) next = _nextSeq;
            SessionState.SetInt(SeqKey, (int)Math.Min(next, int.MaxValue));
        }
    }
}
