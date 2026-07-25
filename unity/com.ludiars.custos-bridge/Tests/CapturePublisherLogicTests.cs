#if UNITY_EDITOR || DEVELOPMENT_BUILD

using System;
using System.Collections.Generic;
using System.IO;
using NUnit.Framework;
using Ludiars.Custos.Bridge.Sinks;

namespace Ludiars.Custos.Bridge.Tests
{
    public class CapturePublisherLogicTests
    {
        [Test]
        public void SessionSelection_NoCandidate_ReturnsNull()
        {
            var selected = SessionSelection.SelectSingleActiveProjectSession(new List<SessionCandidate>(), @"C:\Project", out var candidates);
            Assert.IsNull(selected);
            Assert.AreEqual(0, candidates.Count);
        }

        [Test]
        public void SessionSelection_OneActiveProjectCandidate_SelectsIt()
        {
            var selected = SessionSelection.SelectSingleActiveProjectSession(new[] { Candidate("one", @"C:\Project\Assets") }, @"C:\Project", out var candidates);
            Assert.AreEqual("one", selected);
            Assert.AreEqual(1, candidates.Count);
        }

        [Test]
        public void SessionSelection_MultipleCandidates_RefusesToChoose()
        {
            var selected = SessionSelection.SelectSingleActiveProjectSession(new[] { Candidate("one", @"C:\Project"), Candidate("two", @"C:\Project\Tools") }, @"C:\Project", out var candidates);
            Assert.IsNull(selected);
            Assert.AreEqual(2, candidates.Count);
        }

        [Test]
        public void CapturePath_IsInOperatingSystemTempDirectory_AndHasExpectedName()
        {
            string path = CaptureStorage.CreatePath(new DateTime(2026, 7, 25, 12, 34, 56, 789));
            StringAssert.StartsWith(Path.Combine(Path.GetTempPath(), "ludiars-custos-capture"), path);
            StringAssert.EndsWith("20260725-123456-789.png", path);
        }

        [Test]
        public void CleanupSelection_RemovesFilesOlderThanSevenDays()
        {
            string directory = CreateTestDirectory();
            try
            {
                var oldFile = CreateFile(directory, "old.png", DateTime.UtcNow.AddDays(-8));
                CollectionAssert.Contains(new List<string>(CaptureStorage.SelectCleanupPaths(new[] { oldFile }, DateTime.UtcNow)), oldFile.FullName);
            }
            finally { Directory.Delete(directory, true); }
        }

        [Test]
        public void CleanupSelection_KeepsOnlyNewestTwoHundredFiles()
        {
            string directory = CreateTestDirectory();
            try
            {
                var files = new List<FileInfo>();
                for (var index = 0; index < 201; index++) files.Add(CreateFile(directory, index + ".png", DateTime.UtcNow.AddMinutes(-index)));
                Assert.AreEqual(1, new List<string>(CaptureStorage.SelectCleanupPaths(files, DateTime.UtcNow)).Count);
            }
            finally { Directory.Delete(directory, true); }
        }

        [Test]
        public void ConcordiaRequest_ContainsSessionCaptionAuthorAndAbsolutePngPath()
        {
            string json = ConcordiaChatRequest.Build(new CaptureEnvelope { SessionId = "session-1", Caption = "frame", PngPath = @"C:\Temp\capture.png" }, "PrivateGame/Unity");
            StringAssert.Contains("\"channel\":\"報告\"", json);
            StringAssert.Contains("\"session_id\":\"session-1\"", json);
            StringAssert.Contains("\"author_label\":\"PrivateGame/Unity\"", json);
            StringAssert.Contains("C:\\\\Temp\\\\capture.png", json);
        }

        private static SessionCandidate Candidate(string id, string cwd) => new SessionCandidate { session_id = id, cwd = cwd, status = "active" };
        private static string CreateTestDirectory()
        {
            string path = Path.Combine(Path.GetTempPath(), "ludiars-custos-capture-tests-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(path);
            return path;
        }

        private static FileInfo CreateFile(string directory, string name, DateTime lastWrite)
        {
            string path = Path.Combine(directory, name);
            File.WriteAllBytes(path, new byte[0]);
            File.SetLastWriteTimeUtc(path, lastWrite);
            return new FileInfo(path);
        }
    }
}

#endif
