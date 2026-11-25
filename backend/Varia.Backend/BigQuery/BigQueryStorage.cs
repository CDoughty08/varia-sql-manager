using System.Net;
using System.Runtime.CompilerServices;
using Google.Api.Gax;
using Google.Api.Gax.Grpc;
using Google.Apis.Auth.OAuth2;
using Google.Cloud.BigQuery.Storage.V1;
using Grpc.Auth;
using Grpc.Core;
using Grpc.Net.Client;

namespace Varia.Backend.BigQuery;

/// <summary>The two Storage Read calls Varia makes (docs/bigquery.md, Storage Read). The offline checks replace the gRPC
/// client with a fake through <see cref="BigQueryEnvironment.Storage"/>.</summary>
internal interface IBigQueryStorageRead : IDisposable
{
    Task<ReadSession> CreateReadSessionAsync(CreateReadSessionRequest request, CancellationToken token);
    IAsyncEnumerable<ReadRowsResponse> ReadRowsAsync(ReadRowsRequest request, CancellationToken token);
}

/// <summary>
/// The Storage Read API over gRPC on a channel Varia owns: HTTP/2 through <see cref="SocketsHttpHandler"/> with the system
/// proxy (CONNECT for TLS) and certificate store, as REST calls use, the connection's pinned credential on every call, and a
/// bounded message size. The emulator's plaintext port gets an insecure channel, in emulator mode only.
/// </summary>
internal sealed class GrpcStorageRead : IBigQueryStorageRead
{
    /// <summary>Google's Storage Read endpoint, named explicitly as the REST client's universe is.</summary>
    public static readonly Uri GoogleEndpoint = new("https://bigquerystorage.googleapis.com");
    /// <summary>The largest response message Varia accepts; Google's ReadRows messages are far smaller.</summary>
    public const int MaxMessageBytes = 128 << 20;

    private readonly GrpcChannel channel;
    private readonly BigQueryReadClient client;

    public GrpcStorageRead(Uri endpoint, ICredential? credential, IWebProxy? proxy)
    {
        var insecure = endpoint.Scheme == Uri.UriSchemeHttp;
        channel = GrpcChannel.ForAddress(endpoint, new Grpc.Net.Client.GrpcChannelOptions
        {
            // A client, not a handler: given a SocketsHttpHandler (even inside a DelegatingHandler), Grpc.Net.Client puts its
            // subchannel balancer on it, which takes the handler's ConnectCallback and fails every call through a proxy.
            // Streams are long, so the client has no overall timeout; each call has its own deadline and cancellation.
            HttpClient = new HttpClient(Handler(proxy), disposeHandler: true) { Timeout = Timeout.InfiniteTimeSpan },
            DisposeHttpClient = true,
            MaxReceiveMessageSize = MaxMessageBytes,
            MaxSendMessageSize = 1 << 20,
            Credentials = insecure ? ChannelCredentials.Insecure
                : credential is null ? ChannelCredentials.SecureSsl
                : ChannelCredentials.Create(ChannelCredentials.SecureSsl, credential.ToCallCredentials()),
            // A request is never sent twice by the channel; Varia resumes a stream itself from its offset.
            MaxRetryAttempts = 0
        });
        client = new BigQueryReadClientBuilder { CallInvoker = channel.CreateCallInvoker(), Settings = Settings() }.Build();
    }

    /// <summary>CreateReadSession without the library's own retry (Unavailable for up to ten minutes), so an unreachable
    /// endpoint fails within one call's limit and REST reads the result; Varia retries a session itself, boundedly.</summary>
    internal static BigQueryReadSettings Settings()
    {
        var settings = BigQueryReadSettings.GetDefault();
        settings.CreateReadSessionSettings = CallSettings.FromExpiration(Expiration.None);
        return settings;
    }

    /// <summary>The channel's handler: the system proxy (or the one given), the platform's certificate store, keep-alive
    /// pings for long reads, and several HTTP/2 connections for parallel streams.</summary>
    internal static SocketsHttpHandler Handler(IWebProxy? proxy) => new()
    {
        Proxy = proxy ?? HttpClient.DefaultProxy,
        UseProxy = true,
        EnableMultipleHttp2Connections = true,
        // Short: an endpoint a firewall drops costs this much before REST reads the result.
        ConnectTimeout = TimeSpan.FromSeconds(10),
        KeepAlivePingDelay = TimeSpan.FromSeconds(60),
        KeepAlivePingTimeout = TimeSpan.FromSeconds(30),
        PooledConnectionIdleTimeout = TimeSpan.FromMinutes(5),
        AutomaticDecompression = DecompressionMethods.None
    };

    public Task<ReadSession> CreateReadSessionAsync(CreateReadSessionRequest request, CancellationToken token) =>
        client.CreateReadSessionAsync(request, CallSettings.FromCancellationToken(token));

    public async IAsyncEnumerable<ReadRowsResponse> ReadRowsAsync(ReadRowsRequest request, [EnumeratorCancellation] CancellationToken token)
    {
        using var call = client.ReadRows(request, CallSettings.FromCancellationToken(token));
        await foreach (var response in call.GetResponseStream().WithCancellation(token)) yield return response;
    }

    public void Dispose() => channel.Dispose();
}
