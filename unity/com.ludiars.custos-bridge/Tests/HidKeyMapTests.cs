// HidKeyMapTests.cs — HidKeyMap の往復テスト (EditMode)
// KEY_TABLE (ergo-custos-client.ts) に載っている全コードが Key.None 以外を返すことを検証する。
#if UNITY_EDITOR || DEVELOPMENT_BUILD

using NUnit.Framework;
using UnityEngine.InputSystem;
using Ludiars.Custos.Bridge.Input;

namespace Ludiars.Custos.Bridge.Tests
{
    public class HidKeyMapTests
    {
#if ENABLE_INPUT_SYSTEM
        // ── KEY_TABLE 保証範囲のコードが Key.None 以外を返すこと ──

        [Test]
        public void AlphaKeys_A_to_Z_AreNotNone()
        {
            for (int hid = 4; hid <= 29; hid++)
            {
                var key = HidKeyMap.ToKey(hid);
                Assert.AreNotEqual(Key.None, key, $"HID {hid} should map to a letter key");
            }
        }

        [Test]
        public void DigitKeys_1_to_9_AreNotNone()
        {
            for (int hid = 30; hid <= 38; hid++)
            {
                var key = HidKeyMap.ToKey(hid);
                Assert.AreNotEqual(Key.None, key, $"HID {hid} should map to digit key");
            }
        }

        [Test]
        public void Digit0_Maps_Correctly()
        {
            Assert.AreEqual(Key.Digit0, HidKeyMap.ToKey(39));
        }

        [Test]
        public void ControlKeys_AreNotNone()
        {
            int[] controlHids = { 40, 41, 42, 43, 44 }; // Enter, Escape, Backspace, Tab, Space
            foreach (int hid in controlHids)
                Assert.AreNotEqual(Key.None, HidKeyMap.ToKey(hid), $"HID {hid}");
        }

        [Test]
        public void FunctionKeys_F1_to_F12_AreNotNone()
        {
            for (int hid = 58; hid <= 69; hid++)
                Assert.AreNotEqual(Key.None, HidKeyMap.ToKey(hid), $"HID {hid} (F{hid - 57})");
        }

        [Test]
        public void ArrowKeys_AreNotNone()
        {
            Assert.AreEqual(Key.RightArrow, HidKeyMap.ToKey(79));
            Assert.AreEqual(Key.LeftArrow,  HidKeyMap.ToKey(80));
            Assert.AreEqual(Key.DownArrow,  HidKeyMap.ToKey(81));
            Assert.AreEqual(Key.UpArrow,    HidKeyMap.ToKey(82));
        }

        [Test]
        public void ModifierKeys_AreNotNone()
        {
            Assert.AreEqual(Key.LeftCtrl,  HidKeyMap.ToKey(224));
            Assert.AreEqual(Key.LeftShift, HidKeyMap.ToKey(225));
            Assert.AreEqual(Key.LeftAlt,   HidKeyMap.ToKey(226));
            Assert.AreEqual(Key.LeftMeta,  HidKeyMap.ToKey(227));
        }

        [Test]
        public void UnknownCode_ReturnsNone()
        {
            Assert.AreEqual(Key.None, HidKeyMap.ToKey(0));
            Assert.AreEqual(Key.None, HidKeyMap.ToKey(1));
            Assert.AreEqual(Key.None, HidKeyMap.ToKey(255));
        }

        // KzSUnity の実際に使われるキー (PlayerInputActions.inputactions の binding から)
        [Test]
        public void GameplayCriticalKeys_W_A_S_D_AreCorrect()
        {
            // KEY_TABLE: W=26, A=4, S=22, D=7
            Assert.AreEqual(Key.W, HidKeyMap.ToKey(26));
            Assert.AreEqual(Key.A, HidKeyMap.ToKey(4));
            Assert.AreEqual(Key.S, HidKeyMap.ToKey(22));
            Assert.AreEqual(Key.D, HidKeyMap.ToKey(7));
        }

        [Test]
        public void Space_IsCorrect()
        {
            Assert.AreEqual(Key.Space, HidKeyMap.ToKey(44));
        }
#else
        [Test]
        [Ignore("ENABLE_INPUT_SYSTEM is not defined — skipping HidKeyMap tests.")]
        public void Placeholder() { }
#endif
    }
}

#endif // UNITY_EDITOR || DEVELOPMENT_BUILD
