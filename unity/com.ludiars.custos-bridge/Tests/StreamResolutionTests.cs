// StreamResolutionTests.cs — 配信解像度の決定 (EditMode)
#if UNITY_EDITOR || DEVELOPMENT_BUILD

using NUnit.Framework;
using Ludiars.Custos.Bridge.VideoEncoding;

namespace Ludiars.Custos.Bridge.Tests
{
    public class StreamResolutionTests
    {
        [Test]
        public void SmallOddWindow_ScalesUpToTheBox_AndAlignsTo16()
        {
            StreamResolution.Fit(603, 319, 1280, 720, out int w, out int h);
            Assert.AreEqual(1280, w);
            Assert.AreEqual(672, h);   // 1280 x 677 を 16 の倍数に切り捨て
        }

        [Test]
        public void Exact16x9_KeepsTheBox()
        {
            StreamResolution.Fit(1920, 1080, 1280, 720, out int w, out int h);
            Assert.AreEqual(1280, w);
            Assert.AreEqual(720, h);
        }

        [Test]
        public void TallScreen_FitsHeight()
        {
            StreamResolution.Fit(1080, 1920, 1280, 720, out int w, out int h);
            Assert.AreEqual(720, h);
            Assert.AreEqual(400, w);   // 405 → 400
            Assert.AreEqual(0, w % 16);
        }

        [Test]
        public void BoxNotMultipleOf16_StaysInsideTheBox()
        {
            StreamResolution.Fit(1366, 768, 1366, 768, out int w, out int h);
            Assert.AreEqual(1360, w);
            Assert.AreEqual(768, h);
        }

        [Test]
        public void UnknownScreen_UsesTheBox()
        {
            StreamResolution.Fit(0, 0, 1280, 720, out int w, out int h);
            Assert.AreEqual(1280, w);
            Assert.AreEqual(720, h);
        }
    }
}

#endif // UNITY_EDITOR || DEVELOPMENT_BUILD
