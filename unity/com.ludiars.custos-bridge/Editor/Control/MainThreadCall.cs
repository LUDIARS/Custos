// MainThreadCall.cs — listener スレッドから main thread の処理を待って結果を受け取る
using System;
using System.Threading;

namespace Ludiars.Custos.Bridge.Editor.Control
{
    /// <summary>
    /// Unity API は main thread でしか触れない。listener スレッドから
    /// <see cref="MainThreadDispatcher"/> へ処理を積み、終わるまで待つ。
    /// </summary>
    internal static class MainThreadCall
    {
        /// <summary>
        /// main thread で work を実行して結果を返す。時間内に終わらなければ false で timedOut=true。
        /// 時間切れでも work はキューに残り、main thread が空いたときに実行される。
        /// </summary>
        public static bool TryRun<T>(Func<T> work, int timeoutMs, out T result, out string error, out bool timedOut)
        {
            T value = default;
            string failure = null;
            using var gate = new ManualResetEventSlim(false);
            MainThreadDispatcher.Enqueue(() =>
            {
                try { value = work(); }
                catch (Exception e) { failure = e.Message; }
                finally { gate.Set(); }
            });
            bool done = gate.Wait(timeoutMs);
            result = value;
            timedOut = !done;
            error = done ? failure : "main thread timeout (Unity is busy)";
            return done && failure == null;
        }
    }
}
