using System.Collections.Concurrent;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using Google.Apis.Http;

namespace Varia.Backend.Tests;

/// <summary>
/// The offline BigQuery fake (docs/bigquery.md, Testing): an HTTP handler injected through the client's and every
/// credential's HttpClientFactory (BigQueryEnvironment.Http) that answers Google's endpoints from the REST JSON in
/// Fixtures/BigQuery and records every request. A request no route answers is recorded in <see cref="Unmatched"/> and
/// fails with 599, so a check that sees none knows nothing left the process. Later routes win, so a check overrides a
/// default by adding its own.
/// </summary>
internal sealed class BigQueryFake
{
    public sealed record Request(string Method, Uri Uri, string Body, IReadOnlyDictionary<string, string> Headers)
    {
        /// <summary>The URL without its query, unescaped: what routes match.</summary>
        public string Url => Uri.UnescapeDataString(Uri.GetLeftPart(UriPartial.Path));
        public string? Header(string name) => Headers.TryGetValue(name, out var value) ? value : null;
        public string? Form(string name)
        {
            foreach (var part in Body.Split('&'))
            {
                var equals = part.IndexOf('=');
                if (equals > 0 && Uri.UnescapeDataString(part[..equals].Replace('+', ' ')) == name) return Uri.UnescapeDataString(part[(equals + 1)..].Replace('+', ' '));
            }
            return null;
        }
    }

    public sealed record Reply(int Status, string Body, string ContentType = "application/json", IReadOnlyDictionary<string, string>? Headers = null);

    private readonly List<(string Method, Regex Url, Func<Request, Reply> Answer)> routes = [];
    private readonly Lock gate = new();
    public ConcurrentQueue<Request> Seen { get; } = new();
    public ConcurrentQueue<Request> Unmatched { get; } = new();
    /// <summary>Runs before routing; an exception it returns is thrown as the transport's (a network failure).</summary>
    public Func<Request, Exception?>? Fault { get; set; }
    /// <summary>Holds a request until the token ends (a server that never answers).</summary>
    public Func<Request, bool>? Hang { get; set; }

    public IHttpClientFactory Factory => new FakeFactory(this);

    public static string FixtureText(string name) => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "BigQuery", name + ".json"));
    public static Reply Fixture(string name, int status = 200) => new(status, FixtureText(name));
    public static Reply Text(string body, IReadOnlyDictionary<string, string>? headers = null) => new(200, body, "text/plain", headers);

    public BigQueryFake On(string method, string urlPattern, Func<Request, Reply> answer)
    {
        lock (gate) routes.Add((method, new Regex("^" + urlPattern + "$"), answer));
        return this;
    }
    public BigQueryFake On(string method, string urlPattern, Reply reply) => On(method, urlPattern, _ => reply);

    public IEnumerable<Request> To(string urlPattern)
    {
        var pattern = new Regex("^" + urlPattern + "$");
        return Seen.Where(request => pattern.IsMatch(request.Url));
    }

    public const string Token = @"https://oauth2\.googleapis\.com/token";
    public const string TokenInfo = @"https://oauth2\.googleapis\.com/tokeninfo";
    public const string Jobs = @"https://bigquery\.googleapis\.com/bigquery/v2/projects/[^/]+/jobs";
    public const string Datasets = @"https://bigquery\.googleapis\.com/bigquery/v2/projects/[^/]+/datasets/[^/]+";
    public const string Projects = @"https://bigquery\.googleapis\.com/bigquery/v2/projects";
    public const string Sts = @"https://sts\.googleapis\.com/v1/token";
    public const string StsOAuth = @"https://sts\.googleapis\.com/v1/oauthtoken";
    public const string StsIntrospect = @"https://sts\.googleapis\.com/v1/introspect";
    public const string Impersonate = @"https://iamcredentials\.googleapis\.com/v1/projects/-/serviceAccounts/[^/]+:generateAccessToken";
    public const string MetadataEmail = @"http://(?:169\.254\.169\.254|metadata\.google\.internal)/computeMetadata/v1/instance/service-accounts/default/email";
    public const string MetadataToken = @"http://(?:169\.254\.169\.254|metadata\.google\.internal)/computeMetadata/v1/instance/service-accounts/default/token";
    public const string AwsToken = @"http://169\.254\.169\.254/latest/api/token";
    public const string AwsZone = @"http://169\.254\.169\.254/latest/meta-data/placement/availability-zone";
    public const string AwsRoles = @"http://169\.254\.169\.254/latest/meta-data/iam/security-credentials/?";
    public const string AwsRole = @"http://169\.254\.169\.254/latest/meta-data/iam/security-credentials/varia-role";
    public const string Azure = @"http://169\.254\.169\.254/metadata/identity/oauth2/token";

    /// <summary>Google's endpoints answering success, as a working project and credential would.</summary>
    public static BigQueryFake Google()
    {
        var metadata = new Dictionary<string, string> { ["Metadata-Flavor"] = "Google" };
        return new BigQueryFake()
            .On("POST", Token, Fixture("token"))
            .On("POST", TokenInfo, Fixture("tokeninfo-user"))
            .On("POST", Jobs, Fixture("dry-run"))
            .On("GET", Datasets, Fixture("dataset"))
            .On("GET", Projects, request => Fixture(request.Uri.Query.Contains("pageToken=page-2", StringComparison.Ordinal) ? "projects-page-2" : "projects"))
            .On("POST", Sts, Fixture("sts-token"))
            .On("POST", StsOAuth, Fixture("sts-oauthtoken"))
            .On("POST", StsIntrospect, Fixture("sts-introspect"))
            .On("POST", Impersonate, Fixture("iam-generate-access-token"))
            .On("GET", MetadataEmail, Text("vm-runner@varia-alpha.iam.gserviceaccount.com", metadata))
            .On("GET", MetadataToken, new Reply(200, FixtureText("metadata-token"), Headers: metadata))
            .On("PUT", AwsToken, Text("imds-session-token"))
            .On("GET", AwsZone, Text("us-east-1b"))
            .On("GET", AwsRoles, Text("varia-role"))
            .On("GET", AwsRole, Fixture("aws-credentials"));
    }

    internal async Task<HttpResponseMessage> HandleAsync(HttpRequestMessage message, CancellationToken token)
    {
        var body = "";
        if (message.Content is not null)
        {
            // The client gzips request bodies (Content-Encoding: gzip); routes and checks read the JSON.
            var bytes = await message.Content.ReadAsByteArrayAsync(token);
            if (message.Content.Headers.ContentEncoding.Contains("gzip"))
            {
                using var inflated = new System.IO.Compression.GZipStream(new MemoryStream(bytes), System.IO.Compression.CompressionMode.Decompress);
                using var plain = new MemoryStream();
                await inflated.CopyToAsync(plain, token);
                bytes = plain.ToArray();
            }
            body = Encoding.UTF8.GetString(bytes);
        }
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var header in message.Headers) headers[header.Key] = string.Join(",", header.Value);
        if (message.Content is not null) foreach (var header in message.Content.Headers) headers[header.Key] = string.Join(",", header.Value);
        var request = new Request(message.Method.Method, message.RequestUri!, body, headers);
        Seen.Enqueue(request);
        if (Fault?.Invoke(request) is { } fault) throw fault;
        if (Hang?.Invoke(request) == true) await Task.Delay(Timeout.Infinite, token);
        Func<Request, Reply>? answer = null;
        lock (gate)
            for (var index = routes.Count - 1; index >= 0 && answer is null; index--)
                if (routes[index].Method == request.Method && routes[index].Url.IsMatch(request.Url)) answer = routes[index].Answer;
        if (answer is null)
        {
            Unmatched.Enqueue(request);
            return new HttpResponseMessage((HttpStatusCode)599) { Content = new StringContent("{}", Encoding.UTF8, "application/json") };
        }
        var reply = answer(request);
        var response = new HttpResponseMessage((HttpStatusCode)reply.Status) { Content = new StringContent(reply.Body, Encoding.UTF8, reply.ContentType), RequestMessage = message };
        foreach (var (name, value) in reply.Headers ?? new Dictionary<string, string>()) response.Headers.TryAddWithoutValidation(name, value);
        return response;
    }

    /// <summary>Every client the Google libraries create gets a relay to this fake; disposing a client disposes only its relay.</summary>
    private sealed class FakeFactory(BigQueryFake fake) : HttpClientFactory
    {
        protected override HttpMessageHandler CreateHandler(CreateHttpClientArgs args) => new Relay(fake);
    }

    private sealed class Relay(BigQueryFake fake) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) => fake.HandleAsync(request, cancellationToken);
    }
}
