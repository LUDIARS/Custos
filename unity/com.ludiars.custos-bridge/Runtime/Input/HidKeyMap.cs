// HidKeyMap.cs — USB HID usage code → InputSystem Key 対応表
//
// 変更時は以下 3 点を同一 PR で同期すること (非自明な依存):
//   1. Custos/src/capture/ergo-custos-client.ts の KEY_TABLE
//   2. このファイル
//   3. ergo/include/ergo/input/types.h の enum class KeyCode
//
// 対応根拠: HID usage page 0x07 (Keyboard/Keypad) のサブセット。
// 保証範囲は KEY_TABLE に存在するコードのみ。それ以外は Key.None を返す。
#if UNITY_EDITOR || DEVELOPMENT_BUILD

#if ENABLE_INPUT_SYSTEM
using UnityEngine.InputSystem;
#endif

namespace Ludiars.Custos.Bridge.Input
{
    /// <summary>
    /// USB HID usage code (ergo_custos protocol) → <see cref="Key"/> への純関数マッパ。
    /// 未対応コードは <see cref="Key.None"/> を返す。
    /// </summary>
    public static class HidKeyMap
    {
#if ENABLE_INPUT_SYSTEM
        /// <summary>HID usage code → Key。未対応は Key.None。</summary>
        public static Key ToKey(int hidCode)
        {
            // A–Z : HID 4–29 → Key.A + offset
            // Key enum は A=0,B=1,...Z=25 の連番 (InputSystem 1.x)。
            if (hidCode >= 4 && hidCode <= 29)
                return Key.A + (hidCode - 4);

            // 1–9 : HID 30–38 → Key.Digit1 + offset
            if (hidCode >= 30 && hidCode <= 38)
                return Key.Digit1 + (hidCode - 30);

            // F1–F12 : HID 58–69 → Key.F1 + offset
            if (hidCode >= 58 && hidCode <= 69)
                return Key.F1 + (hidCode - 58);

            switch (hidCode)
            {
                // 0 (KEY_TABLE: "0"/"Num0")
                case 39: return Key.Digit0;

                // 制御キー
                case 40: return Key.Enter;
                case 41: return Key.Escape;
                case 42: return Key.Backspace;
                case 43: return Key.Tab;
                case 44: return Key.Space;

                // 記号 (KEY_TABLE 外だが HID 0x07 で定義済み、前方互換で追加)
                case 45: return Key.Minus;
                case 46: return Key.Equals;
                case 47: return Key.LeftBracket;
                case 48: return Key.RightBracket;
                case 49: return Key.Backslash;
                case 51: return Key.Semicolon;
                case 52: return Key.Quote;
                case 53: return Key.Backquote;
                case 54: return Key.Comma;
                case 55: return Key.Period;
                case 56: return Key.Slash;

                // ナビゲーション
                case 73: return Key.Insert;
                case 74: return Key.Home;
                case 75: return Key.PageUp;
                case 76: return Key.Delete;
                case 77: return Key.End;
                case 78: return Key.PageDown;

                // 矢印
                case 79: return Key.RightArrow;
                case 80: return Key.LeftArrow;
                case 81: return Key.DownArrow;
                case 82: return Key.UpArrow;

                // テンキー
                case 89: return Key.Numpad1;
                case 90: return Key.Numpad2;
                case 91: return Key.Numpad3;
                case 92: return Key.Numpad4;
                case 93: return Key.Numpad5;
                case 94: return Key.Numpad6;
                case 95: return Key.Numpad7;
                case 96: return Key.Numpad8;
                case 97: return Key.Numpad9;
                case 98: return Key.Numpad0;

                // 修飾キー (left)
                case 224: return Key.LeftCtrl;
                case 225: return Key.LeftShift;
                case 226: return Key.LeftAlt;
                case 227: return Key.LeftMeta;

                // 修飾キー (right)
                case 228: return Key.RightCtrl;
                case 229: return Key.RightShift;
                case 230: return Key.RightAlt;
                case 231: return Key.RightMeta;

                default: return Key.None;
            }
        }
#endif // ENABLE_INPUT_SYSTEM
    }
}

#endif // UNITY_EDITOR || DEVELOPMENT_BUILD
