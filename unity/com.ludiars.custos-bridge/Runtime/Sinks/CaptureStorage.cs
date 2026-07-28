#if UNITY_EDITOR || DEVELOPMENT_BUILD

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace Ludiars.Custos.Bridge.Sinks
{
    public static class CaptureStorage
    {
        public const string DirectoryName = "ludiars-custos-capture";
        public static string CaptureDirectory => Path.Combine(Path.GetTempPath(), DirectoryName);

        public static string CreatePath(DateTime now)
        {
            return Path.Combine(CaptureDirectory, now.ToString("yyyyMMdd-HHmmss-fff") + ".png");
        }

        public static IEnumerable<string> SelectCleanupPaths(IEnumerable<FileInfo> files, DateTime now)
        {
            var ordered = (files ?? Enumerable.Empty<FileInfo>())
                .Where(file => file != null && string.Equals(file.Extension, ".png", StringComparison.OrdinalIgnoreCase))
                .OrderByDescending(file => file.LastWriteTimeUtc)
                .ToList();
            return ordered.Where((file, index) => file.LastWriteTimeUtc < now.ToUniversalTime().AddDays(-7) || index >= 200)
                .Select(file => file.FullName);
        }
    }
}

#endif
