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

        /// <summary>JSON 文字列のエスケープ (引用符・バックスラッシュ・改行などの制御文字)。</summary>
        public static string Escape(string s)
        {
            if (string.IsNullOrEmpty(s)) return string.Empty;
            var sb = new StringBuilder(s.Length + 8);
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"':  sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n");  break;
                    case '\r': sb.Append("\\r");  break;
                    case '\t': sb.Append("\\t");  break;
                    default:
                        if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            return sb.ToString();
        }

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
