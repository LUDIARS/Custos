#if UNITY_EDITOR || DEVELOPMENT_BUILD

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace Ludiars.Custos.Bridge.Sinks
{
    [Serializable]
    public sealed class PublishCaptureRequest
    {
        public string source;
        public string caption;
        public string sink;
        public string session_id;
    }

    public sealed class PublishCaptureResult
    {
        public bool Success;
        public int StatusCode;
        public string Error;
        public string PngPath;
        public IReadOnlyList<SessionCandidate> Candidates;
    }

    [Serializable]
    public sealed class SessionCandidate
    {
        public string session_id;
        public string cwd;
        public string repo_path;
        public string status;
        public string label;
    }

    public static class SessionSelection
    {
        public static string SelectSingleActiveProjectSession(IEnumerable<SessionCandidate> sessions, string projectRoot, out List<SessionCandidate> candidates)
        {
            candidates = (sessions ?? Enumerable.Empty<SessionCandidate>())
                .Where(s => s != null && string.Equals(s.status, "active", StringComparison.OrdinalIgnoreCase))
                .Where(s => IsUnderProject(s.cwd, projectRoot) || IsUnderProject(s.repo_path, projectRoot))
                .ToList();
            return candidates.Count == 1 ? candidates[0].session_id : null;
        }

        private static bool IsUnderProject(string path, string projectRoot)
        {
            if (string.IsNullOrEmpty(path) || string.IsNullOrEmpty(projectRoot)) return false;
            try
            {
                var root = Path.GetFullPath(projectRoot).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
                var target = Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
                return target.Equals(root, StringComparison.OrdinalIgnoreCase) || target.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
            }
            catch { return false; }
        }
    }
}

#endif
