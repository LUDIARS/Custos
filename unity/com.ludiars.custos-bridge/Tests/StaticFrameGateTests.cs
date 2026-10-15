// StaticFrameGateTests.cs — 画面が変わらない間はエンコードしない判定 (EditMode)
#if UNITY_EDITOR || DEVELOPMENT_BUILD

using NUnit.Framework;
using Ludiars.Custos.Bridge.VideoEncoding;

namespace Ludiars.Custos.Bridge.Tests
{
    public class StaticFrameGateTests
    {
        [Test]
        public void FirstFrame_AlwaysPasses()
        {
            var gate = new StaticFrameGate();
            Assert.IsTrue(gate.ShouldEncode(false, false, 0));
        }

        [Test]
        public void UnchangedFrames_PassOncePerInterval()
        {
            var gate = new StaticFrameGate();
            gate.ShouldEncode(true, false, 0);
            Assert.IsFalse(gate.ShouldEncode(false, false, 500));
            Assert.IsFalse(gate.ShouldEncode(false, false, StaticFrameGate.MinIntervalMs - 1));
            Assert.IsTrue(gate.ShouldEncode(false, false, StaticFrameGate.MinIntervalMs));
            Assert.IsFalse(gate.ShouldEncode(false, false, StaticFrameGate.MinIntervalMs + 10));
        }

        [Test]
        public void ChangedFrame_OrKeyframeRequest_AlwaysPasses()
        {
            var gate = new StaticFrameGate();
            gate.ShouldEncode(true, false, 0);
            Assert.IsTrue(gate.ShouldEncode(true, false, 10));
            Assert.IsTrue(gate.ShouldEncode(false, true, 20));
        }

        [Test]
        public void FramesFasterThanTheStreamFps_AreDropped_ButKeyframesAreNot()
        {
            var gate = new StaticFrameGate { FrameIntervalMs = 33 };   // 30fps
            Assert.IsTrue(gate.ShouldEncode(true, false, 0));
            Assert.IsFalse(gate.ShouldEncode(true, false, 16));          // 60Hz の更新は半分捨てる
            Assert.IsTrue(gate.ShouldEncode(true, false, 33));
            Assert.IsTrue(gate.ShouldEncode(false, true, 40));           // キーフレーム要求は待たせない
        }

        [Test]
        public void SameFrame_ComparesContentAndLength()
        {
            Assert.IsTrue(StaticFrameGate.SameFrame(new byte[] { 1, 2, 3 }, new byte[] { 1, 2, 3 }));
            Assert.IsFalse(StaticFrameGate.SameFrame(new byte[] { 1, 2, 3 }, new byte[] { 1, 2, 4 }));
            Assert.IsFalse(StaticFrameGate.SameFrame(new byte[] { 1, 2 }, new byte[] { 1, 2, 3 }));
            Assert.IsFalse(StaticFrameGate.SameFrame(null, new byte[] { 1 }));
        }
    }
}

#endif // UNITY_EDITOR || DEVELOPMENT_BUILD
