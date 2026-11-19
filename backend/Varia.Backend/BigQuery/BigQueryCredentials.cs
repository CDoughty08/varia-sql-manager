using System.Text.Json;
using System.Text.RegularExpressions;
using Google.Apis.Auth.OAuth2;
using Google.Apis.Http;

namespace Varia.Backend.BigQuery;

/// <summary>
/// Loads the credential main read (a key file, a federation configuration or the ADC file) the only ways Varia allows:
/// its <c>type</c> checked against the authentication mode, every URL it names pinned to Google's documented endpoints
/// (decision 48), federation sources limited to the shapes decision 23 lists, then a typed load (never the untyped
/// <c>GoogleCredential.FromJson</c>, which accepts any type). Every HTTP call the credential makes goes through
/// <paramref name="http"/>, so the offline checks' fake answers all of them. A refusal is AUTH_KEY_FILE naming the field,
/// never the file's content.
/// </summary>
internal static partial class BigQueryCredentials
{
    public const string Scope = "https://www.googleapis.com/auth/cloud-platform";
    public const string StsTokenUrl = "https://sts.googleapis.com/v1/token";
    public const string StsOAuthTokenUrl = "https://sts.googleapis.com/v1/oauthtoken";
    public const string StsIntrospectUrl = "https://sts.googleapis.com/v1/introspect";
    public const string StsRevokeUrl = "https://sts.googleapis.com/v1/revoke";
    /// <summary>The OAuth token endpoints Google documents for service account and user credentials.</summary>
    public static readonly string[] TokenUris = ["https://oauth2.googleapis.com/token", "https://accounts.google.com/o/oauth2/token", "https://www.googleapis.com/oauth2/v4/token"];
    /// <summary>Hosts a URL field the loads never fetch may name (a key file's <c>auth_uri</c> and certificate URLs).</summary>
    static readonly string[] InertHosts = ["accounts.google.com", "oauth2.googleapis.com", "www.googleapis.com", "sts.googleapis.com", "iamcredentials.googleapis.com"];
    /// <summary>AWS's instance metadata service, IPv4 only: the library compares AWS's IPv6 host without its brackets, so an
    /// IPv6 metadata URL could never load.</summary>
    static readonly string[] AwsMetadataHosts = ["169.254.169.254"];
    const string AwsVerificationUrl = "https://sts.{region}.amazonaws.com?Action=GetCallerIdentity&Version=2011-06-15";
    /// <summary>The query parameters Azure's instance metadata token endpoint documents.</summary>
    static readonly string[] AzureParameters = ["api-version", "resource", "client_id", "object_id", "msi_res_id"];

    [GeneratedRegex(@"^https://iamcredentials\.googleapis\.com/v1/projects/-/serviceAccounts/([^/:?#]+):generateAccessToken\z")]
    private static partial Regex ImpersonationUrl();

    /// <summary>The credential types each mode loads. gcloud credentials take whatever ADC's file holds.</summary>
    static string[] TypesFor(string mode, string source) => (mode, source) switch
    {
        ("serviceAccountKey", _) => ["service_account"],
        ("externalAccount", _) => ["external_account", "external_account_authorized_user"],
        (_, "adc") => ["authorized_user", "service_account", "external_account", "external_account_authorized_user", "impersonated_service_account"],
        _ => []
    };

    static RequestException Refused(string message) => new("AUTH_KEY_FILE", message);
    static RequestException Field(string field, string why) => Refused("The key file's " + field + " " + why + ", so Varia does not use it.");

    /// <summary>Parses and checks a credential file's content without loading it. Throws AUTH_KEY_FILE naming the field.</summary>
    public static JsonElement Parse(string json, string mode, string source)
    {
        JsonElement root;
        try
        {
            // A file saved with a byte order mark (Notepad writes one) is the same credential.
            using var document = JsonDocument.Parse(json.TrimStart('﻿'), new JsonDocumentOptions { MaxDepth = 16 });
            root = document.RootElement.Clone();
        }
        catch (JsonException) { throw Refused("The key file could not be read: it is not a JSON credential file. Choose the file again."); }
        if (root.ValueKind != JsonValueKind.Object) throw Refused("The key file could not be read: it is not a JSON credential file. Choose the file again.");
        Names(root, "");
        var type = Text(root, "type");
        var allowed = TypesFor(mode, source);
        if (type is null || Array.IndexOf(allowed, type) < 0)
            throw Refused(mode == "serviceAccountKey" ? "This file is not a service account key. Choose a service account's JSON key."
                : mode == "externalAccount" ? "This file is not a workload or workforce identity federation configuration."
                : "The Application Default Credentials file holds a credential type Varia does not use.");
        CheckType(root, type, "", nested: false);
        return root;
    }

    /// <summary>
    /// Every member name is Google's lower-case snake_case and appears once, at every depth. The checks below read names
    /// exactly, but the library's loads (Newtonsoft) match them case-insensitively with the last one winning, so a
    /// <c>Token_Url</c> or a second <c>token_url</c> would reach the load unchecked. HTTP header names are the one
    /// exception; CredentialSource then allows only Azure's <c>Metadata</c> there, naming the field otherwise.
    /// </summary>
    static void Names(JsonElement value, string path)
    {
        if (value.ValueKind == JsonValueKind.Array) { foreach (var item in value.EnumerateArray()) Names(item, path); return; }
        if (value.ValueKind != JsonValueKind.Object) return;
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var headers = path == "credential_source.headers." || path.EndsWith(".credential_source.headers.", StringComparison.Ordinal);
        foreach (var member in value.EnumerateObject())
        {
            // Messages never echo a name that failed the check: it is the file's text, not one of Google's names.
            if (!headers && !SnakeCase().IsMatch(member.Name))
                throw Refused("The key file has a field name that is not one of Google's (they are lower case), so Varia does not use it.");
            if (!seen.Add(member.Name)) throw Field(path + member.Name, "appears more than once");
            Names(member.Value, path + member.Name + ".");
        }
    }

    [GeneratedRegex(@"^[a-z][a-z0-9_]{0,63}\z")]
    private static partial Regex SnakeCase();

    static string? Text(JsonElement value, string name) => value.TryGetProperty(name, out var member) && member.ValueKind == JsonValueKind.String ? member.GetString() : null;

    static void CheckType(JsonElement root, string type, string prefix, bool nested)
    {
        if (root.TryGetProperty("universe_domain", out var universe) && (universe.ValueKind != JsonValueKind.String || universe.GetString() != "googleapis.com"))
            throw Field(prefix + "universe_domain", "is not googleapis.com");
        // Every URL field is pinned: the ones a load fetches to their exact endpoint (below), the rest to Google's hosts.
        var pinned = new HashSet<string>(StringComparer.Ordinal);
        switch (type)
        {
            case "service_account":
                Require(root, prefix, "client_email", "private_key");
                Exact(root, prefix, "token_uri", TokenUris, pinned, required: false);
                break;
            case "authorized_user":
                Require(root, prefix, "client_id", "client_secret", "refresh_token");
                Exact(root, prefix, "token_uri", TokenUris, pinned, required: false);
                break;
            case "impersonated_service_account":
                if (nested) throw Field(prefix + "source_credentials", "nests another impersonated credential");
                Impersonation(root, prefix, "service_account_impersonation_url", pinned, required: true);
                if (!root.TryGetProperty("source_credentials", out var source) || source.ValueKind != JsonValueKind.Object)
                    throw Field(prefix + "source_credentials", "is missing");
                var sourceType = Text(source, "type");
                // Google's library impersonates only from these (an external account only when it impersonates nothing itself).
                if (sourceType is not ("authorized_user" or "service_account" or "external_account"))
                    throw Field(prefix + "source_credentials.type", "is not a credential Varia impersonates from");
                CheckType(source, sourceType, prefix + "source_credentials.", nested: true);
                pinned.Add("source_credentials");
                if (root.TryGetProperty("delegates", out var delegates) && (delegates.ValueKind != JsonValueKind.Array || delegates.GetArrayLength() > 16
                    || delegates.EnumerateArray().Any(item => item.ValueKind != JsonValueKind.String || !BigQueryLimits.Email().IsMatch(item.GetString()!))))
                    throw Field(prefix + "delegates", "is not a list of service account emails");
                pinned.Add("delegates");
                break;
            case "external_account":
                Require(root, prefix, "audience", "subject_token_type");
                Exact(root, prefix, "token_url", [StsTokenUrl], pinned, required: true);
                Exact(root, prefix, "token_info_url", [StsIntrospectUrl], pinned, required: false);
                if (nested && root.TryGetProperty("service_account_impersonation_url", out _))
                    throw Field(prefix + "service_account_impersonation_url", "impersonates inside an impersonated credential");
                Impersonation(root, prefix, "service_account_impersonation_url", pinned, required: false);
                // gcloud writes the impersonated token's lifetime here; it holds nothing else.
                if (root.TryGetProperty("service_account_impersonation", out var lifetime) && (lifetime.ValueKind != JsonValueKind.Object
                    || lifetime.EnumerateObject().Any(member => member.Name != "token_lifetime_seconds" || !member.Value.TryGetInt32(out var seconds) || seconds is < 600 or > 43200)))
                    throw Field(prefix + "service_account_impersonation", "holds more than a token lifetime of 600 to 43,200 seconds");
                pinned.Add("service_account_impersonation");
                CredentialSource(root, prefix);
                pinned.Add("credential_source");
                break;
            case "external_account_authorized_user":
                Require(root, prefix, "audience", "refresh_token", "client_id", "client_secret");
                Exact(root, prefix, "token_url", [StsOAuthTokenUrl], pinned, required: true);
                Exact(root, prefix, "token_info_url", [StsIntrospectUrl], pinned, required: false);
                Exact(root, prefix, "revoke_url", [StsRevokeUrl], pinned, required: false);
                break;
        }
        foreach (var member in root.EnumerateObject())
        {
            if (pinned.Contains(member.Name)) continue;
            if (member.Value.ValueKind is JsonValueKind.Object or JsonValueKind.Array) throw Field(prefix + member.Name, "is not a field Varia reads");
            if ((member.Name.EndsWith("_url", StringComparison.OrdinalIgnoreCase) || member.Name.EndsWith("_uri", StringComparison.OrdinalIgnoreCase))
                && (member.Value.ValueKind != JsonValueKind.String || !Uri.TryCreate(member.Value.GetString(), UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps
                    || !string.IsNullOrEmpty(uri.UserInfo) || Array.IndexOf(InertHosts, uri.IdnHost.ToLowerInvariant()) < 0 || !uri.IsDefaultPort))
                throw Field(prefix + member.Name, "is not a Google endpoint");
        }
    }

    static void Require(JsonElement root, string prefix, params string[] names)
    {
        foreach (var name in names)
            if (Text(root, name) is not { Length: > 0 }) throw Field(prefix + name, "is missing");
    }

    static void Exact(JsonElement root, string prefix, string name, string[] allowed, HashSet<string> pinned, bool required)
    {
        pinned.Add(name);
        if (!root.TryGetProperty(name, out var value)) { if (required) throw Field(prefix + name, "is missing"); return; }
        if (value.ValueKind != JsonValueKind.String || Array.IndexOf(allowed, value.GetString()) < 0) throw Field(prefix + name, "is not Google's endpoint");
    }

    static void Impersonation(JsonElement root, string prefix, string name, HashSet<string> pinned, bool required)
    {
        pinned.Add(name);
        if (!root.TryGetProperty(name, out var value)) { if (required) throw Field(prefix + name, "is missing"); return; }
        if (value.ValueKind != JsonValueKind.String || ImpersonatedAccount(value.GetString()!) is null) throw Field(prefix + name, "is not Google's IAM credentials endpoint");
    }

    /// <summary>The service account an IAM credentials impersonation URL names, or null when the URL is not Google's.</summary>
    public static string? ImpersonatedAccount(string url)
    {
        var match = ImpersonationUrl().Match(url);
        if (!match.Success) return null;
        var account = Uri.UnescapeDataString(match.Groups[1].Value);
        return account.Length <= BigQueryLimits.ServiceAccount && BigQueryLimits.Email().IsMatch(account) ? account : null;
    }

    /// <summary>credential_source: a file (read by Varia, decision 49), AWS at its documented metadata URLs (the signed
    /// verification URL is never called), or Azure's instance metadata token URL. Executable sources and any other host are
    /// refused, naming the field (decision 23).</summary>
    static void CredentialSource(JsonElement root, string prefix)
    {
        var field = prefix + "credential_source";
        if (!root.TryGetProperty("credential_source", out var source) || source.ValueKind != JsonValueKind.Object) throw Field(field, "is missing");
        if (source.TryGetProperty("executable", out _)) throw Field(field + ".executable", "runs a program");
        if (source.TryGetProperty("certificate", out _)) throw Field(field + ".certificate", "is not a source Varia supports");
        string[] keys;
        if (source.TryGetProperty("file", out var file))
        {
            if (file.ValueKind != JsonValueKind.String || file.GetString() is not { Length: > 0 and <= 1024 } path || !SubjectTokens.IsLocalPath(path)) throw Field(field + ".file", "is not a full path on a local disk");
            keys = ["file", "format"];
        }
        else if (Text(source, "environment_id") is { } environment)
        {
            if (environment != "aws1") throw Field(field + ".environment_id", "is not aws1");
            Metadata(source, field, "region_url", AwsMetadataHosts, ["/latest/meta-data/placement/availability-zone"], required: false);
            Metadata(source, field, "url", AwsMetadataHosts, ["/latest/meta-data/iam/security-credentials", "/latest/meta-data/iam/security-credentials/"], required: false);
            Metadata(source, field, "imdsv2_session_token_url", AwsMetadataHosts, ["/latest/api/token"], required: false);
            if (Text(source, "regional_cred_verification_url") != AwsVerificationUrl) throw Field(field + ".regional_cred_verification_url", "is not AWS's documented GetCallerIdentity URL");
            keys = ["environment_id", "region_url", "url", "regional_cred_verification_url", "imdsv2_session_token_url"];
        }
        else if (source.TryGetProperty("url", out _))
        {
            var uri = Metadata(source, field, "url", ["169.254.169.254"], ["/metadata/identity/oauth2/token"], required: true, AzureParameters)!;
            var parameters = Query(uri);
            if (!parameters.ContainsKey("api-version") || !parameters.ContainsKey("resource")) throw Field(field + ".url", "lacks Azure's api-version or resource");
            if (source.TryGetProperty("headers", out var headers) && (headers.ValueKind != JsonValueKind.Object
                || headers.EnumerateObject().Any(header => header.Name != "Metadata" || header.Value.ValueKind != JsonValueKind.String || header.Value.GetString() != "True")))
                throw Field(field + ".headers", "names a header Azure's metadata service does not take");
            keys = ["url", "headers", "format"];
        }
        else throw Field(field, "is not a file, AWS or Azure source");
        foreach (var member in source.EnumerateObject())
            if (Array.IndexOf(keys, member.Name) < 0) throw Field(field + "." + member.Name, "is not a field Varia reads");
        if (source.TryGetProperty("format", out var format))
        {
            if (format.ValueKind != JsonValueKind.Object) throw Field(field + ".format", "is not an object");
            foreach (var member in format.EnumerateObject())
                if (member.Name is not ("type" or "subject_token_field_name") || member.Value.ValueKind != JsonValueKind.String) throw Field(field + ".format." + member.Name, "is not a field Varia reads");
            var formatType = Text(format, "type") ?? "text";
            if (formatType is not ("text" or "json")) throw Field(field + ".format.type", "is not text or json");
            if (formatType == "json" && Text(format, "subject_token_field_name") is not { Length: > 0 and <= 128 }) throw Field(field + ".format.subject_token_field_name", "is missing");
        }
    }

    /// <summary>A metadata URL: http, one of the hosts, one of the paths, and only the named query parameters.</summary>
    static Uri? Metadata(JsonElement source, string field, string name, string[] hosts, string[] paths, bool required, string[]? parameters = null)
    {
        if (!source.TryGetProperty(name, out var value)) { if (required) throw Field(field + "." + name, "is missing"); return null; }
        if (value.ValueKind != JsonValueKind.String || !Uri.TryCreate(value.GetString(), UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttp
            || !string.IsNullOrEmpty(uri.UserInfo) || !string.IsNullOrEmpty(uri.Fragment) || !uri.IsDefaultPort
            || !hosts.Any(host => string.Equals(uri.Host, host, StringComparison.OrdinalIgnoreCase)) || Array.IndexOf(paths, uri.AbsolutePath) < 0
            || (parameters is null ? uri.Query.Length > 0 : Query(uri).Keys.Any(key => Array.IndexOf(parameters, key) < 0)))
            throw Field(field + "." + name, "is not the documented metadata endpoint");
        return uri;
    }

    static Dictionary<string, string> Query(Uri uri)
    {
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var part in uri.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var equals = part.IndexOf('=');
            var key = Uri.UnescapeDataString(equals < 0 ? part : part[..equals]);
            if (!result.TryAdd(key, equals < 0 ? "" : Uri.UnescapeDataString(part[(equals + 1)..]))) result[key] = "\0duplicate";
        }
        if (result.ContainsValue("\0duplicate")) throw Refused("The key file names a URL with a repeated parameter, so Varia does not use it.");
        return result;
    }

    /// <summary>
    /// A typed load of a checked credential: scoped to cloud-platform, with every HTTP call through <paramref name="http"/>.
    /// File and Azure federation sources read their subject token through <paramref name="subjects"/>, which re-reads it on
    /// every token exchange. A nested impersonation is built here rather than by the library, so its source credential
    /// uses <paramref name="http"/> too.
    /// </summary>
    public static LoadedCredential Load(JsonElement root, IHttpClientFactory http, SubjectTokens subjects)
    {
        var json = root.GetRawText();
        var type = Text(root, "type")!;
        switch (type)
        {
            case "service_account":
            {
                var typed = CredentialFactory.FromJson<ServiceAccountCredential>(json);
                return new(Scoped(typed.ToGoogleCredential(), http), "serviceAccount", typed.Id, null, null);
            }
            case "authorized_user":
            {
                var typed = CredentialFactory.FromJson<UserCredential>(json);
                return new(Pinned(typed.ToGoogleCredential()).CreateWithHttpClientFactory(http), "user", null, null, null);
            }
            case "external_account_authorized_user":
            {
                var typed = CredentialFactory.FromJson<ExternalAccountAuthorizedUserCredential>(json);
                return new(Scoped(typed.ToGoogleCredential(), http), "externalUser", null, Text(root, "audience"), null) { Client = (Text(root, "client_id")!, Text(root, "client_secret")!) };
            }
            case "impersonated_service_account":
            {
                var source = Load(root.GetProperty("source_credentials"), http, subjects);
                var target = ImpersonatedAccount(Text(root, "service_account_impersonation_url")!)!;
                var delegates = root.TryGetProperty("delegates", out var list) ? list.EnumerateArray().Select(item => item.GetString()!).ToArray() : [];
                return source.Impersonate(target, http, delegates);
            }
            case "external_account":
            {
                var audience = Text(root, "audience")!;
                var credentialSource = root.GetProperty("credential_source");
                var impersonation = Text(root, "service_account_impersonation_url");
                if (Text(credentialSource, "environment_id") is not null)
                {
                    var typed = CredentialFactory.FromJson<AwsExternalAccountCredential>(json);
                    return new(Scoped(typed.ToGoogleCredential(), http), "aws", null, audience, impersonation is null ? null : ImpersonatedAccount(impersonation));
                }
                var supplier = subjects.For(credentialSource, http);
                var initializer = new ProgrammaticExternalAccountCredential.Initializer(StsTokenUrl, audience, Text(root, "subject_token_type")!, supplier)
                {
                    HttpClientFactory = http, Scopes = [Scope], ServiceAccountImpersonationUrl = impersonation,
                    WorkforcePoolUserProject = Text(root, "workforce_pool_user_project"), ClientId = Text(root, "client_id"), ClientSecret = Text(root, "client_secret")
                };
                var credential = Pinned(GoogleCredential.FromProgrammaticExternalAccountCredential(new ProgrammaticExternalAccountCredential(initializer)));
                return new(credential, "external", null, audience, impersonation is null ? null : ImpersonatedAccount(impersonation)) { Subject = supplier };
            }
            default: throw Refused("The key file holds a credential type Varia does not use.");
        }
    }

    static GoogleCredential Scoped(GoogleCredential credential, IHttpClientFactory http) => Pinned(credential).CreateScoped(Scope).CreateWithHttpClientFactory(http);

    /// <summary>Google's universe, set explicitly: otherwise a Compute Engine credential asks the metadata host (which
    /// GCE_METADATA_HOST can move) and an impersonation built on any credential takes its IAM host from that answer.</summary>
    public static GoogleCredential Pinned(GoogleCredential credential) => credential.CreateWithUniverseDomain(Universe);

    public const string Universe = "googleapis.com";

    /// <summary>The metadata server's credential (ADC's last step, when no ADC file exists).</summary>
    public static LoadedCredential Metadata(IHttpClientFactory http) =>
        new(Pinned(GoogleCredential.FromComputeCredential(new ComputeCredential(new ComputeCredential.Initializer(BigQueryIdentity.MetadataTokenUrl) { HttpClientFactory = http }))), "computeEngine", null, null, null);
}

/// <summary>A loaded credential and what its identity pin is made from: the kind of account, the email a key names, a
/// federation audience, the account a configuration impersonates, and for file and Azure sources the subject token
/// supplier, whose tokens carry the subject.</summary>
internal sealed record LoadedCredential(GoogleCredential Credential, string Kind, string? Email, string? Audience, string? ConfigImpersonated)
{
    public SubjectTokenSupplier? Subject { get; init; }
    /// <summary>An external_account_authorized_user's OAuth client, which STS introspection authenticates with.</summary>
    public (string ClientId, string ClientSecret)? Client { get; init; }
    /// <summary>The base identity when this credential impersonates (Varia's option, or an impersonated_service_account file).</summary>
    public LoadedCredential? Base { get; init; }
    public string? Impersonated { get; init; }

    /// <summary>Whether Google's library can impersonate from this credential: a service account, a user, the metadata
    /// server, or a federation configuration that impersonates nothing itself.</summary>
    public bool CanImpersonate => Kind is "serviceAccount" or "user" or "computeEngine" || (Kind is "external" or "aws" && ConfigImpersonated is null);

    /// <summary>Impersonates a service account on top of this credential, with the impersonation call through <paramref name="http"/>.</summary>
    public LoadedCredential Impersonate(string target, IHttpClientFactory http, IReadOnlyList<string>? delegates = null)
    {
        if (!CanImpersonate)
            throw new RequestException("AUTH_KEY_FILE", "This credential cannot impersonate a service account: it already impersonates one, or it is a workforce sign-in. Remove the impersonation or choose another credential.");
        var initializer = new ImpersonatedCredential.Initializer(target) { HttpClientFactory = http, Scopes = [BigQueryCredentials.Scope], DelegateAccounts = delegates ?? [] };
        return new(Credential.Impersonate(initializer), "impersonated", target, null, null) { Base = this, Impersonated = target };
    }
}
