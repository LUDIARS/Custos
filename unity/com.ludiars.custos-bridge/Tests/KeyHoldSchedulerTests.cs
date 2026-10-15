// KeyHoldSchedulerTests.cs — 短いタップの離しを保留する判定 (EditMode)
#if UNITY_EDITOR || DEVELOPMENT_BUILD

using NUnit.Framework;
using Ludiars.Custos.Bridge.Input;

namespace Ludiars.Custos.Bridge.Tests
{
    public class KeyHoldSchedulerTests
    {
        private const int Key = 44;   // Space

        [Test]
        public void ReleaseInSameFrame_IsDeferredUntilMinHoldFrames()
        {
            var s = new KeyHoldScheduler();
            s.OnDown(Key, frame: 10, time: 1.00f);
            Assert.IsFalse(s.OnUp(Key, frame: 10, time: 1.01f));
            Assert.IsEmpty(s.TakeDueReleases(frame: 11, time: 1.02f));
            CollectionAssert.AreEqual(new[] { Key }, s.TakeDueReleases(frame: 12, time: 1.03f));
            Assert.IsFalse(s.HasPending);
        }

        [Test]
        public void ReleaseAfterMinHoldFrames_AppliesImmediately()
        {
            var s = new KeyHoldScheduler();
            s.OnDown(Key, frame: 10, time: 1.0f);
            Assert.IsTrue(s.OnUp(Key, frame: 10 + KeyHoldScheduler.MinHoldFrames, time: 1.1f));
            Assert.IsFalse(s.HasPending);
        }

        [Test]
        public void FrozenFrames_ReleaseAfterMaxHoldSeconds()
        {
            var s = new KeyHoldScheduler();
            s.OnDown(Key, frame: 5, time: 2.0f);
            Assert.IsFalse(s.OnUp(Key, frame: 5, time: 2.0f));
            Assert.IsEmpty(s.TakeDueReleases(frame: 5, time: 2.1f));
            CollectionAssert.AreEqual(new[] { Key }, s.TakeDueReleases(frame: 5, time: 2.0f + KeyHoldScheduler.MaxHoldSeconds));
        }

        [Test]
        public void PressAgainWhilePending_CancelsTheRelease()
        {
            var s = new KeyHoldScheduler();
            s.OnDown(Key, frame: 1, time: 0f);
            Assert.IsFalse(s.OnUp(Key, frame: 1, time: 0f));
            s.OnDown(Key, frame: 1, time: 0f);
            Assert.IsFalse(s.HasPending);
            Assert.IsEmpty(s.TakeDueReleases(frame: 10, time: 5f));
        }

        [Test]
        public void ReleaseWithoutPress_AppliesImmediately()
        {
            var s = new KeyHoldScheduler();
            Assert.IsTrue(s.OnUp(Key, frame: 0, time: 0f));
        }
    }
}

#endif // UNITY_EDITOR || DEVELOPMENT_BUILD
