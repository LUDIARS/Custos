// HttpJson.cs — HTTP レスポンス整形ヘルパ
#if UNITY_EDITOR || DEVELOPMENT_BUILD

using System;
using System.Net;
using System.Text;

namespace Ludiars.Custos.Bridge.Protocol
{
    /// <summary>
    /// HttpListenerResponse への JSON / バイナリ書き込みヘルパ。
    /// 各ハンドラが直接 OutputStream を触らないようにここに集約する。
    /// </summary>
    public static class HttpJson
    {
        /// <summary>JSON ボディを UTF-8 で書いてレスポンスを閉じる。</summary>
        public static void WriteJson(HttpListenerResponse res, int statusCode, string json)
        {
            try
            {
                byte[] buf = Encoding.UTF8.GetBytes(json);
                res.StatusCode   = statusCode;
                res.ContentType  = "application/json; charset=utf-8";
                res.ContentLength64 = buf.Length;
                res.Headers.Set("Access-Control-Allow-Origin", "*");
                res.OutputStream.Write(buf, 0, buf.Length);
            }
            catch { /* クライアントが切断した場合は無視 */ }
            finally { SafeClose(res); }
        }

        /// <summary>バイナリデータを書いてレスポンスを閉じる。ContentType を指定する。</summary>
        public static void WriteBinary(HttpListenerResponse res, int statusCode, string contentType, byte[] data)
        {
            try
            {
                res.StatusCode   = statusCode;
                res.ContentType  = contentType;
                res.ContentLength64 = data.Length;
                res.Headers.Set("Access-Control-Allow-Origin", "*");
                res.OutputStream.Write(data, 0, data.Length);
            }
            catch { }
            finally { SafeClose(res); }
        }

        /// <summary>JSON エスケープ (ダブルクォート・バックスラッシュのみ)。</summary>
        public static string Escape(string s)
            => (s ?? string.Empty).Replace("\\", "\\\\").Replace("\"", "\\\"");

        /// <summary>例外を握り潰して Close する。</summary>
        public static void SafeClose(HttpListenerResponse res)
        {
            try { res.Close(); } catch { }
        }

        /// <summary>CORS preflight 応答を返す。</summary>
        public static void WriteCorsOptions(HttpListenerResponse res)
        {
            try
            {
                res.StatusCode = 200;
                res.Headers.Set("Access-Control-Allow-Origin", "*");
                res.Headers.Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
                res.Headers.Set("Access-Control-Allow-Headers", "Content-Type, X-Auth-Token");
            }
            catch { }
            finally { SafeClose(res); }
        }
    }
}

#endif // UNITY_EDITOR || DEVELOPMENT_BUILD
