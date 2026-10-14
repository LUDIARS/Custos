// BridgeRoute.cs — BridgeServer の追加エンドポイント (拡張点)
//
// BridgeServer は Unity API に触れない (Runtime 層)。Editor 専用の操作 (/editor/status 等) は
// Editor アセンブリがこの interface を実装して BridgeServer.Routes へ渡す。
// 呼び出しは listener スレッドから行われるので、Unity API を触る実装は自分で
// main thread へ dispatch すること。
#if UNITY_EDITOR || DEVELOPMENT_BUILD

using System.Collections.Specialized;

namespace Ludiars.Custos.Bridge.Protocol
{
    /// <summary>追加エンドポイントへ渡すリクエスト (listener スレッドで組み立て済み)。</summary>
    public sealed class BridgeRouteRequest
    {
        public string Method { get; }
        /// <summary>小文字化・末尾スラッシュ除去済みのパス。</summary>
        public string Path { get; }
        public NameValueCollection Query { get; }
        public string Body { get; }

        public BridgeRouteRequest(string method, string path, NameValueCollection query, string body)
        {
            Method = method;
            Path = path;
            Query = query ?? new NameValueCollection();
            Body = body ?? string.Empty;
        }
    }

    /// <summary>追加エンドポイントの応答 (JSON 本文)。</summary>
    public readonly struct BridgeRouteResponse
    {
        public int Status { get; }
        public string Json { get; }

        public BridgeRouteResponse(int status, string json)
        {
            Status = status;
            Json = json;
        }
    }

    /// <summary>BridgeServer が知らないパスを引き受ける追加エンドポイント。</summary>
    public interface IBridgeRouteHandler
    {
        /// <summary>このパスを扱うか (body を読む前に判定する)。</summary>
        bool Handles(string path);

        /// <summary>
        /// リクエストを処理して応答を返す。listener スレッドで呼ばれる。
        /// </summary>
        BridgeRouteResponse Handle(BridgeRouteRequest request);
    }
}

#endif // UNITY_EDITOR || DEVELOPMENT_BUILD
