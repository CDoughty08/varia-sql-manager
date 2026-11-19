using System.Globalization;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Google.Apis.Auth.OAuth2;
using Google.Apis.Http;

namespace Varia.Backend.BigQuery;

/// <summary>
/// The account a connection signs in as. Kind and Account are what the dialog's account line shows; Pin is the identity
/// evidence (docs/bigquery-plan.md, Identity pinning), pinned at connect and checked again on every credential refresh and
/// reconnect. ConnectionInfo carries it as <c>bigquery:</c> + Pin, at most 256 characters.
/// </summary>
internal sealed record BigQueryPrincipal(string Kind, string Account, string Pin, string? Impersonated = null)
{
    public string PrincipalId => "bigquery:" + Pin;
}

internal static class BigQueryIdentity
{
    public const string TokenInfoUrl = "https://oauth2.googleapis.com/tokeninfo";
    public const string MetadataEmailUrl = "http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/email";
    /// <summary>The metadata server's token URL, fixed: the library's default follows GCE_METADATA_HOST, which could name any host.</summary>
    public const string MetadataTokenUrl = "http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token";
    public const string AwsTokenUrl = "http://169.254.169.254/latest/api/token";
    public const string AwsRoleUrl = "http://169.254.169.254/latest/meta-data/iam/security-credentials/";
    /// <summary>The pin's room inside ConnectionInfo's 256-character principal id, after <c>bigquery:</c>.</summary>
    public const int MaxPin = 256 - 9;
    public const int MaxAccount = 256;

    public static readonly BigQueryPrincipal Anonymous = new("emulator", "Anonymous (emulator)", "anonymous:emulator");

    /// <summary>A pin from a kind and its identity; an identity too long (or not one visible line) is replaced by its
    /// fingerprint, which is still exact.</summary>
    public static string Pin(string kind, string identity)
    {
        var value = kind + ":" + identity;
        return value.Length <= MaxPin && Visible(value) ? value : kind + ":" + SubjectTokenSupplier.Fingerprint(identity);
    }

    static bool Visible(string value) => value.EnumerateRunes().All(rune => Rune.GetUnicodeCategory(rune) is not (UnicodeCategory.Control or UnicodeCategory.Format or UnicodeCategory.LineSeparator or UnicodeCategory.ParagraphSeparator));

    /// <summary>The account line's text: one visible line of at most 256 characters.</summary>
    public static string Account(string value)
    {
        var builder = new StringBuilder();
        foreach (var rune in value.EnumerateRunes())
        {
            if (builder.Length >= MaxAccount - 2) break;
            builder.Append(Visible(rune.ToString()) ? rune.ToString() : " ");
        }
        var text = builder.ToString().Trim();
        return text.Length == 0 ? "(unnamed account)" : text;
    }

    public static async Task<string> TokenAsync(GoogleCredential credential, CancellationToken token) =>
        await ((ITokenAccess)credential).GetAccessTokenForRequestAsync(null, token);

    /// <summary>Signs the credential in (so a refused credential fails here, mapped by BigQueryErrors) and resolves its pin.</summary>
    public static async Task<BigQueryPrincipal> ResolveAsync(LoadedCredential credential, IHttpClientFactory http, CancellationToken token)
    {
        var access = await TokenAsync(credential.Credential, token);
        if (credential.Base is { } baseCredential)
        {
            var basePrincipal = await ResolveAsync(baseCredential, http, token);
            return new("impersonated", basePrincipal.Account, Pin("impersonated", credential.Impersonated + "|" + basePrincipal.Pin), credential.Impersonated);
        }
        switch (credential.Kind)
        {
            case "serviceAccount":
                return new("serviceAccount", Account(credential.Email!), Pin("serviceAccount", credential.Email!.ToLowerInvariant()));
            case "user":
            {
                using var client = http.CreateHttpClient(new CreateHttpClientArgs());
                using var content = new FormUrlEncodedContent([new("access_token", access)]);
                using var post = new HttpRequestMessage(HttpMethod.Post, TokenInfoUrl) { Content = content };
                using var response = await client.SendAsync(post, HttpCompletionOption.ResponseHeadersRead, token);
                var info = await Json(response, token);
                var email = Text(info, "email");
                var subject = Text(info, "sub");
                if (email is null && subject is null) throw Unverified();
                return new("user", Account(email ?? subject!), Pin("user", email?.ToLowerInvariant() ?? "sub:" + subject));
            }
            case "computeEngine":
            {
                using var client = http.CreateHttpClient(new CreateHttpClientArgs());
                using var request = new HttpRequestMessage(HttpMethod.Get, MetadataEmailUrl);
                request.Headers.Add("Metadata-Flavor", "Google");
                using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, token);
                if (!response.IsSuccessStatusCode) throw Unverified();
                var email = (await Body(response, token)).Trim();
                if (email.Length is 0 or > BigQueryLimits.ServiceAccount) throw Unverified();
                return new("computeEngine", Account(email), Pin("computeEngine", email.ToLowerInvariant()));
            }
            case "external":
            {
                var subject = credential.Subject?.LastSubject ?? throw new RequestException("AUTH_IDENTITY", "The federated token carries no subject Varia can pin. Use a token with a subject (an OIDC or SAML token).");
                credential.Subject.Pin(subject);
                var basePin = Pin("external", credential.Audience + "|" + subject);
                return credential.ConfigImpersonated is { } target
                    ? new("impersonated", Account(subject), Pin("impersonated", target + "|" + basePin), target)
                    : new("external", Account(subject), basePin);
            }
            case "aws":
            {
                var role = await AwsRoleAsync(http, token);
                var basePin = Pin("aws", credential.Audience + "|" + role);
                return credential.ConfigImpersonated is { } target
                    ? new("impersonated", Account(role), Pin("impersonated", target + "|" + basePin), target)
                    : new("aws", Account(role), basePin);
            }
            case "externalUser":
            {
                var (clientId, clientSecret) = credential.Client ?? throw Unverified();
                using var client = http.CreateHttpClient(new CreateHttpClientArgs());
                using var request = new HttpRequestMessage(HttpMethod.Post, BigQueryCredentials.StsIntrospectUrl) { Content = new FormUrlEncodedContent([new("token", access)]) };
                request.Headers.Authorization = new AuthenticationHeaderValue("Basic", Convert.ToBase64String(Encoding.UTF8.GetBytes(clientId + ":" + clientSecret)));
                using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, token);
                var info = await Json(response, token);
                var name = Text(info, "username") ?? Text(info, "sub") ?? throw Unverified();
                return new("externalUser", Account(name), Pin("externalUser", credential.Audience + "|" + name));
            }
            default: throw Unverified();
        }
    }

    /// <summary>An AWS credential's identity: the role the instance metadata names, or the access key id when AWS's
    /// environment variables supply the keys (an id, not a secret).</summary>
    static async Task<string> AwsRoleAsync(IHttpClientFactory http, CancellationToken token)
    {
        // The library signs with the environment's keys only when both are set, and with the instance role otherwise.
        if (Environment.GetEnvironmentVariable("AWS_ACCESS_KEY_ID") is { Length: > 0 } key && Environment.GetEnvironmentVariable("AWS_SECRET_ACCESS_KEY") is { Length: > 0 })
            return "key:" + key;
        using var client = http.CreateHttpClient(new CreateHttpClientArgs());
        string? session = null;
        using (var put = new HttpRequestMessage(HttpMethod.Put, AwsTokenUrl))
        {
            put.Headers.Add("X-aws-ec2-metadata-token-ttl-seconds", "300");
            try
            {
                using var answer = await client.SendAsync(put, HttpCompletionOption.ResponseHeadersRead, token);
                if (answer.IsSuccessStatusCode) session = (await Body(answer, token)).Trim();
            }
            catch (HttpRequestException) { }
        }
        using var request = new HttpRequestMessage(HttpMethod.Get, AwsRoleUrl);
        if (session is { Length: > 0 }) request.Headers.Add("X-aws-ec2-metadata-token", session);
        using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, token);
        if (!response.IsSuccessStatusCode) throw Unverified();
        var role = (await Body(response, token)).Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).FirstOrDefault();
        return role is { Length: > 0 and <= 128 } ? "role:" + role : throw Unverified();
    }

    static RequestException Unverified() => new("AUTH_IDENTITY", "The Google account could not be verified. Reconnect explicitly.");

    /// <summary>
    /// A response body of at most 64 KiB, read as it streams: anything on the network can answer the metadata address
    /// off-cloud, and a body read whole before its length is checked could exhaust the backend's memory.
    /// </summary>
    internal static async Task<string> Body(HttpResponseMessage response, CancellationToken token)
    {
        await using var stream = await response.Content.ReadAsStreamAsync(token);
        var buffer = new byte[64 * 1024 + 1];
        var read = 0;
        while (read < buffer.Length && await stream.ReadAsync(buffer.AsMemory(read), token) is var count and > 0) read += count;
        if (read > 64 * 1024) throw Unverified();
        return Encoding.UTF8.GetString(buffer, 0, read);
    }

    static async Task<JsonElement> Json(HttpResponseMessage response, CancellationToken token)
    {
        if (!response.IsSuccessStatusCode) throw Unverified();
        var text = await Body(response, token);
        try
        {
            using var document = JsonDocument.Parse(text);
            return document.RootElement.ValueKind == JsonValueKind.Object ? document.RootElement.Clone() : throw Unverified();
        }
        catch (JsonException) { throw Unverified(); }
    }

    static string? Text(JsonElement value, string name) => value.TryGetProperty(name, out var member) && member.ValueKind == JsonValueKind.String && member.GetString() is { Length: > 0 } text ? text : null;
}

/// <summary>
/// The credential a connection's client signs requests with: the loaded credential's tokens, with the identity pin checked
/// again whenever the token changes (a refresh), so a credential that starts signing in as another account fails
/// AUTH_IDENTITY instead of switching accounts silently.
/// </summary>
internal sealed class PinnedCredential(LoadedCredential credential, BigQueryPrincipal pinned, IHttpClientFactory http) : ICredential, IHttpExecuteInterceptor, IHttpUnsuccessfulResponseHandler
{
    private readonly SemaphoreSlim gate = new(1, 1);
    private string? verified;
    /// <summary>Called with each new token before it is used; the checks count refreshes through it.</summary>
    internal Action? Refreshed { get; set; }

    public BigQueryPrincipal Principal => pinned;

    public void Initialize(ConfigurableHttpClient httpClient)
    {
        httpClient.MessageHandler.AddExecuteInterceptor(this);
        httpClient.MessageHandler.AddUnsuccessfulResponseHandler(this);
    }

    public async Task<string> GetAccessTokenForRequestAsync(string? authUri = null, CancellationToken cancellationToken = default)
    {
        var token = await BigQueryIdentity.TokenAsync(credential.Credential, cancellationToken);
        if (token == Volatile.Read(ref verified)) return token;
        await gate.WaitAsync(cancellationToken);
        try
        {
            if (token == verified) return token;
            if (verified is not null)
            {
                Refreshed?.Invoke();
                var now = await BigQueryIdentity.ResolveAsync(credential, http, cancellationToken);
                if (now.Pin != pinned.Pin)
                    throw new RequestException("AUTH_IDENTITY", "The Google credentials now sign in as a different " + Describe(now.Kind) + " than the " + Describe(pinned.Kind) + " this connection was opened with. Reconnect to use the new account.");
            }
            Volatile.Write(ref verified, token);
            return token;
        }
        finally { gate.Release(); }
    }

    /// <summary>The token the connection verified at connect; the first token after it is checked against the pin.</summary>
    internal void Verified(string token) => Volatile.Write(ref verified, token);

    static string Describe(string kind) => kind switch
    {
        "serviceAccount" => "service account", "user" => "user account", "computeEngine" => "metadata server account", "impersonated" => "impersonated account",
        "external" or "aws" or "externalUser" => "federated identity", _ => "account"
    };

    public async Task InterceptAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var token = await GetAccessTokenForRequestAsync(request.RequestUri?.ToString(), cancellationToken);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
    }

    public Task<bool> HandleResponseAsync(HandleUnsuccessfulResponseArgs args) =>
        credential.Credential.UnderlyingCredential is IHttpUnsuccessfulResponseHandler inner ? inner.HandleResponseAsync(args) : Task.FromResult(false);
}

/// <summary>Emulator mode's credential: it signs nothing, so no Google token can reach the emulator's host (decision 15).</summary>
internal sealed class AnonymousCredential : ICredential
{
    public static readonly AnonymousCredential Instance = new();
    public void Initialize(ConfigurableHttpClient httpClient) { }
    public Task<string> GetAccessTokenForRequestAsync(string? authUri = null, CancellationToken cancellationToken = default) => Task.FromResult<string>(null!);
}
