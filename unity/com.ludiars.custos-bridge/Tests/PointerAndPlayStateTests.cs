// PointerAndPlayStateTests.cs — /pointer 座標変換と /state の JSON 正規化 (EditMode)
#if UNITY_EDITOR || DEVELOPMENT_BUILD

using NUnit.Framework;
using UnityEngine;
using Ludiars.Custos.Bridge.Input;

namespace Ludiars.Custos.Bridge.Tests
{
    public class PointerAndPlayStateTests
    {
        [Test]
        public void ToScreen_FlipsYToBottomLeftOrigin()
        {
            Assert.AreEqual(new Vector2(0f, 1080f),    PointerCoordinates.ToScreen(0f, 0f, 1920, 1080));
            Assert.AreEqual(new Vector2(1920f, 0f),    PointerCoordinates.ToScreen(1f, 1f, 1920, 1080));
            Assert.AreEqual(new Vector2(960f, 270f),   PointerCoordinates.ToScreen(0.5f, 0.75f, 1920, 1080));
        }

        [Test]
        public void ToScreen_ClampsOutOfRangeAndNaN()
        {
            Assert.AreEqual(new Vector2(0f, 1080f), PointerCoordinates.ToScreen(-0.5f, float.NaN, 1920, 1080));
            Assert.AreEqual(new Vector2(1920f, 0f), PointerCoordinates.ToScreen(2f, 3f, 1920, 1080));
        }

        [Test]
        public void Phase_MapsToPressed()
        {
            Assert.AreEqual(true,  PointerCoordinates.PhaseToPressed("down"));
            Assert.AreEqual(false, PointerCoordinates.PhaseToPressed("up"));
            Assert.IsNull(PointerCoordinates.PhaseToPressed("move"));
            Assert.IsTrue(PointerCoordinates.IsKnownPhase("move"));
            Assert.IsFalse(PointerCoordinates.IsKnownPhase("drag"));
            Assert.IsFalse(PointerCoordinates.IsKnownPhase(null));
        }

        [Test]
        public void NormalizeObjectJson_AcceptsOnlyObjects()
        {
            Assert.AreEqual("{\"stage\":\"1-1\"}", CustosPlayState.NormalizeObjectJson("  {\"stage\":\"1-1\"}\n"));
            Assert.IsNull(CustosPlayState.NormalizeObjectJson(null));
            Assert.IsNull(CustosPlayState.NormalizeObjectJson(""));
            Assert.IsNull(CustosPlayState.NormalizeObjectJson("[1,2]"));
            Assert.IsNull(CustosPlayState.NormalizeObjectJson("42"));
        }
    }
}

#endif // UNITY_EDITOR || DEVELOPMENT_BUILD
