// CustosPlayState.cs — ゲームが自分の状態を Custos の行動ログへ渡す入口
//
// ゲーム側のコード例:
//   CustosPlayState.Register(() => JsonUtility.ToJson(new MyState { stage = "1-1", hp = 0.8f }));
//
// Custos は GET /state を周期的に叩き、返った JSON (1 オブジェクト) の各キーを行動ログの
// `state.<key>` 列に入れる (spec/feature/remote-play-and-play-log.md §2)。
// Commentarii の人間プレイ取り込みは `state.stage` などをここから引く。
// ブリッジはゲームの中身を知らない — 何を入れるかはゲームが決める。
// 生のプレイヤー名・メールなど個人を特定する値は入れないこと。

using System;

namespace Ludiars.Custos.Bridge
{
    public static class CustosPlayState
    {
        private static Func<string> _provider;

        /// <summary>状態 JSON を返す関数を登録する (後から登録したもので置き換え)。main thread で呼ばれる。</summary>
        public static void Register(Func<string> provider) => _provider = provider;

        /// <summary>登録を外す。</summary>
        public static void Unregister() => _provider = null;

        /// <summary>
        /// 登録された状態を取る (main thread)。未登録・例外・JSON オブジェクトでない値は null。
        /// </summary>
        internal static string Capture()
        {
            var provider = _provider;
            if (provider == null) return null;
            try { return NormalizeObjectJson(provider()); }
            catch (Exception e)
            {
                UnityEngine.Debug.LogWarning($"[CustosBridge] CustosPlayState provider threw: {e.Message}");
                return null;
            }
        }

        /// <summary>"{...}" の形をした文字列だけを通す (純関数)。</summary>
        public static string NormalizeObjectJson(string json)
        {
            if (string.IsNullOrEmpty(json)) return null;
            string trimmed = json.Trim();
            if (trimmed.Length < 2 || trimmed[0] != '{' || trimmed[trimmed.Length - 1] != '}') return null;
            return trimmed;
        }
    }
}
