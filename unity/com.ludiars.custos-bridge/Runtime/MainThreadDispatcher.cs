// MainThreadDispatcher.cs — BG スレッド → Unity main thread へのアクション転送
// pump の登録は各 bootstrap (Runtime/Editor) が担当。
#if UNITY_EDITOR || DEVELOPMENT_BUILD

using System;
using System.Collections.Concurrent;
using UnityEngine;

namespace Ludiars.Custos.Bridge
{
    /// <summary>
    /// スレッドセーフなアクションキュー。
    /// バックグラウンドスレッド (HttpListener) からエンキューし、
    /// Unity main thread (Update / EditorApplication.update) でデキューして実行する。
    /// </summary>
    public static class MainThreadDispatcher
    {
        private static readonly ConcurrentQueue<Action> _queue = new ConcurrentQueue<Action>();

        /// <summary>
        /// バックグラウンドスレッドから安全に呼べる。
        /// </summary>
        public static void Enqueue(Action action)
        {
            if (action == null) return;
            _queue.Enqueue(action);
        }

        /// <summary>
        /// main thread のポンプ (Update / EditorApplication.update) から毎フレーム呼ぶ。
        /// キューに溜まったアクションをすべて実行する。
        /// </summary>
        public static void Pump()
        {
            while (_queue.TryDequeue(out Action action))
            {
                try
                {
                    action();
                }
                catch (Exception e)
                {
                    Debug.LogError($"[CustosBridge] MainThreadDispatcher action threw: {e}");
                }
            }
        }
    }
}

#endif // UNITY_EDITOR || DEVELOPMENT_BUILD
