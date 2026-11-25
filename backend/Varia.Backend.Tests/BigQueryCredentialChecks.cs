using System.Text.Json;
using System.Text.Json.Nodes;
using Varia.Backend.BigQuery;

namespace Varia.Backend.Tests;

/// <summary>
/// The credential shapes Varia loads and refuses, offline (docs/bigquery.md, Authentication): each mode's types, every
/// URL pinned to Google's endpoints for every credential type, and the federation sources Varia
/// allows. A refusal is AUTH_KEY_FILE naming the field and never the file's secrets.
/// </summary>
internal static class BigQueryCredentialChecks
{
    public const string Audience = "//iam.googleapis.com/projects/100000000001/locations/global/workloadIdentityPools/varia-pool/providers/varia-oidc";
    public const string ServiceAccount = "loader@varia-alpha.iam.gserviceaccount.com";
    public const string Target = "reader@varia-alpha.iam.gserviceaccount.com";
    public const string Secret = "do-not-echo-this-secret";

    public static JsonObject User() => new() { ["type"] = "authorized_user", ["client_id"] = "764086051850-example.apps.googleusercontent.com", ["client_secret"] = Secret, ["refresh_token"] = "1//refresh-" + Secret };

    public static JsonObject Key(string privateKeyPem) => new()
    {
        ["type"] = "service_account", ["project_id"] = "varia-alpha", ["private_key_id"] = "k1", ["private_key"] = privateKeyPem, ["client_email"] = ServiceAccount,
        ["client_id"] = "100000000000000000001", ["auth_uri"] = "https://accounts.google.com/o/oauth2/auth", ["token_uri"] = "https://oauth2.googleapis.com/token",
        ["auth_provider_x509_cert_url"] = "https://www.googleapis.com/oauth2/v1/certs",
        ["client_x509_cert_url"] = "https://www.googleapis.com/robot/v1/metadata/x509/loader%40varia-alpha.iam.gserviceaccount.com", ["universe_domain"] = "googleapis.com"
    };

    public static JsonObject External(JsonObject source, string tokenType = "urn:ietf:params:oauth:token-type:jwt") => new()
    {
        ["type"] = "external_account", ["audience"] = Audience, ["subject_token_type"] = tokenType, ["token_url"] = "https://sts.googleapis.com/v1/token", ["credential_source"] = source
    };

    public static JsonObject Aws() => new()
    {
        ["environment_id"] = "aws1", ["region_url"] = "http://169.254.169.254/latest/meta-data/placement/availability-zone",
        ["url"] = "http://169.254.169.254/latest/meta-data/iam/security-credentials", ["imdsv2_session_token_url"] = "http://169.254.169.254/latest/api/token",
        ["regional_cred_verification_url"] = "https://sts.{region}.amazonaws.com?Action=GetCallerIdentity&Version=2011-06-15"
    };

    public static JsonObject Azure() => new()
    {
        ["url"] = "http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=api://varia-app",
        ["headers"] = new JsonObject { ["Metadata"] = "True" }, ["format"] = new JsonObject { ["type"] = "json", ["subject_token_field_name"] = "access_token" }
    };

    public static JsonObject WorkforceUser() => new()
    {
        ["type"] = "external_account_authorized_user", ["audience"] = "//iam.googleapis.com/locations/global/workforcePools/varia-pool/providers/varia-idp",
        ["refresh_token"] = "refresh-" + Secret, ["token_url"] = "https://sts.googleapis.com/v1/oauthtoken", ["token_info_url"] = "https://sts.googleapis.com/v1/introspect",
        ["client_id"] = "workforce-client", ["client_secret"] = Secret, ["revoke_url"] = "https://sts.googleapis.com/v1/revoke"
    };

    public static JsonObject Impersonated(JsonObject source, string target = Target) => new()
    {
        ["type"] = "impersonated_service_account", ["delegates"] = new JsonArray(),
        ["service_account_impersonation_url"] = "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/" + target + ":generateAccessToken", ["source_credentials"] = source
    };

    /// <summary>An Azure-source federation configuration that impersonates <see cref="Target"/> itself.</summary>
    public static JsonObject ImpersonatingExternal() => With(External(Azure()),
        value => value["service_account_impersonation_url"] = "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/" + Target + ":generateAccessToken");

    static JsonObject With(JsonObject value, Action<JsonObject> change)
    {
        var copy = (JsonObject)value.DeepClone();
        change(copy);
        return copy;
    }

    /// <summary>AUTH_KEY_FILE's message for a shape, or "ok".</summary>
    static string Outcome(JsonNode value, string mode, string source = "file")
    {
        try { BigQueryCredentials.Parse(value.ToJsonString(), mode, source); return "ok"; }
        catch (RequestException error) { return error.Code + ": " + error.Message; }
    }

    public static void Run(Action<bool, string> check)
    {
        using var rsa = System.Security.Cryptography.RSA.Create(2048);
        var key = Key(rsa.ExportPkcs8PrivateKeyPem());
        var file = External(new JsonObject { ["file"] = Path.Combine(Path.GetTempPath(), "varia-token.jwt") });
        var fileJson = External(new JsonObject { ["file"] = Path.Combine(Path.GetTempPath(), "varia-token.json"), ["format"] = new JsonObject { ["type"] = "json", ["subject_token_field_name"] = "id_token" } });

        // Accepted: each mode's types, as Google's tools write them.
        (JsonNode Value, string Mode, string Source, string Name)[] accepted =
        [
            (key, "serviceAccountKey", "file", "a service account key"),
            (key, "gcloud", "adc", "a service account key as the ADC file"),
            (User(), "gcloud", "adc", "gcloud's authorized_user ADC file"),
            (With(User(), user => user["token_uri"] = "https://accounts.google.com/o/oauth2/token"), "gcloud", "adc", "an authorized_user file naming the older token URI"),
            (file, "externalAccount", "file", "a federation configuration with a file source"),
            (fileJson, "externalAccount", "file", "a file source whose JSON names the token's field"),
            (With(file, value => value["service_account_impersonation_url"] = "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/" + Target + ":generateAccessToken"), "externalAccount", "file", "a federation configuration that impersonates"),
            (With(file, value => { value["token_info_url"] = "https://sts.googleapis.com/v1/introspect"; value["workforce_pool_user_project"] = "varia-alpha"; value["universe_domain"] = "googleapis.com"; }), "externalAccount", "file", "a workforce configuration with its user project"),
            (External(Aws(), "urn:ietf:params:aws:token-type:aws4_request"), "externalAccount", "file", "an AWS source at the documented metadata URLs"),
            (External(Azure()), "externalAccount", "file", "an Azure source at the instance metadata token URL"),
            (WorkforceUser(), "externalAccount", "file", "an external_account_authorized_user (workforce) file"),
            (file, "gcloud", "adc", "a federation configuration as the ADC file"),
            (Impersonated(User()), "gcloud", "adc", "gcloud's impersonated_service_account ADC file"),
            (With(file, value => value["service_account_impersonation"] = new JsonObject { ["token_lifetime_seconds"] = 3600 }), "externalAccount", "file", "a federation configuration with gcloud's impersonation lifetime")
        ];
        foreach (var (value, mode, source, name) in accepted)
            check(Outcome(value, mode, source) == "ok", name + " is accepted: " + Outcome(value, mode, source));

        // Refused, naming the field (per credential type, and for federation sources).
        (JsonNode Value, string Mode, string Source, string Field, string Name)[] refused =
        [
            (With(key, value => value["token_uri"] = "https://tokens.example.com/token"), "serviceAccountKey", "file", "token_uri", "a service account key's token_uri on another host"),
            (With(key, value => value["token_uri"] = "http://oauth2.googleapis.com/token"), "serviceAccountKey", "file", "token_uri", "a service account key's token_uri over http"),
            (With(key, value => value["universe_domain"] = "example.com"), "serviceAccountKey", "file", "universe_domain", "a service account key in another universe"),
            (With(key, value => value["auth_provider_x509_cert_url"] = "https://certs.example.com/certs"), "serviceAccountKey", "file", "auth_provider_x509_cert_url", "a key's unused certificate URL on another host"),
            (With(User(), value => value["token_uri"] = "https://oauth2.googleapis.com.example.com/token"), "gcloud", "adc", "token_uri", "an authorized_user's token_uri on a look-alike host"),
            (With(User(), value => value["universe_domain"] = "example.com"), "gcloud", "adc", "universe_domain", "an authorized_user in another universe"),
            (Impersonated(User(), "reader@varia-alpha.iam.gserviceaccount.com/../x"), "gcloud", "adc", "service_account_impersonation_url", "an impersonated file's URL with a path trick"),
            (With(Impersonated(User()), value => value["service_account_impersonation_url"] = "https://iam.example.com/v1/projects/-/serviceAccounts/" + Target + ":generateAccessToken"), "gcloud", "adc", "service_account_impersonation_url", "an impersonated file's URL on another host"),
            (Impersonated(With(User(), value => value["token_uri"] = "https://tokens.example.com/token")), "gcloud", "adc", "source_credentials.token_uri", "an impersonated file's source token_uri, recursively"),
            (Impersonated(Impersonated(User())), "gcloud", "adc", "source_credentials.type", "an impersonated file nesting another"),
            (Impersonated(WorkforceUser()), "gcloud", "adc", "source_credentials.type", "an impersonated file built on a workforce user, which Google's library cannot impersonate from"),
            (Impersonated(ImpersonatingExternal()), "gcloud", "adc", "source_credentials.service_account_impersonation_url", "an impersonated file built on a federation configuration that already impersonates"),
            (Impersonated(With(User(), value => value["universe_domain"] = "example.com")), "gcloud", "adc", "source_credentials.universe_domain", "an impersonated file's source universe"),
            (With(file, value => value["token_url"] = "https://sts.example.com/v1/token"), "externalAccount", "file", "token_url", "a federation token_url on another host"),
            (With(file, value => value["token_url"] = "https://sts.googleapis.com/v1/token?x=1"), "externalAccount", "file", "token_url", "a federation token_url with a query"),
            (With(file, value => value["token_info_url"] = "https://sts.example.com/v1/introspect"), "externalAccount", "file", "token_info_url", "a federation token_info_url on another host"),
            (With(file, value => value["service_account_impersonation_url"] = "https://iamcredentials.example.com/v1/projects/-/serviceAccounts/" + Target + ":generateAccessToken"), "externalAccount", "file", "service_account_impersonation_url", "a federation impersonation URL on another host"),
            (With(file, value => value["universe_domain"] = "example.com"), "externalAccount", "file", "universe_domain", "a federation configuration in another universe"),
            (External(new JsonObject { ["executable"] = new JsonObject { ["command"] = "/usr/bin/id" } }), "externalAccount", "file", "credential_source.executable", "an executable source"),
            (External(new JsonObject { ["url"] = "http://169.254.169.254/latest/token" }), "externalAccount", "file", "credential_source.url", "a URL source at another metadata path"),
            (External(new JsonObject { ["url"] = "https://idp.example.com/token" }), "externalAccount", "file", "credential_source.url", "a URL source at another host"),
            (External(With(Azure(), value => value["url"] = "http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=x&redirect=http://evil")), "externalAccount", "file", "credential_source.url", "an Azure URL with an undocumented parameter"),
            (External(With(Azure(), value => value["url"] = "http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01")), "externalAccount", "file", "credential_source.url", "an Azure URL without its resource"),
            (External(With(Azure(), value => value["headers"] = new JsonObject { ["X-Forwarded-For"] = "1" })), "externalAccount", "file", "credential_source.headers", "an Azure source with another header"),
            (External(With(Aws(), value => value["region_url"] = "http://evil.example.com/latest/meta-data/placement/availability-zone")), "externalAccount", "file", "credential_source.region_url", "an AWS region URL on another host"),
            (External(With(Aws(), value => value["url"] = "http://169.254.169.254/latest/user-data")), "externalAccount", "file", "credential_source.url", "an AWS credentials URL at another path"),
            (External(With(Aws(), value => value["imdsv2_session_token_url"] = "https://169.254.169.254/latest/api/token")), "externalAccount", "file", "credential_source.imdsv2_session_token_url", "an AWS session URL over https"),
            (External(With(Aws(), value => value["regional_cred_verification_url"] = "https://sts.example.com?Action=GetCallerIdentity&Version=2011-06-15")), "externalAccount", "file", "credential_source.regional_cred_verification_url", "an AWS verification URL that is not AWS's"),
            (External(With(Aws(), value => value["region_url"] = "http://[fd00:ec2::254]/latest/meta-data/placement/availability-zone")), "externalAccount", "file", "credential_source.region_url", "an AWS source at the IPv6 metadata address, which the library cannot load"),
            (External(With(Aws(), value => value["environment_id"] = "aws2")), "externalAccount", "file", "credential_source.environment_id", "an unknown AWS environment"),
            (External(new JsonObject { ["file"] = "relative/token" }), "externalAccount", "file", "credential_source.file", "a relative file source"),
            (External(new JsonObject { ["file"] = @"\\files.example.com\share\token" }), "externalAccount", "file", "credential_source.file", "a file source on a UNC share"),
            (External(new JsonObject { ["file"] = "//files.example.com/share/token" }), "externalAccount", "file", "credential_source.file", "a file source on a forward-slash UNC share"),
            (External(new JsonObject { ["file"] = @"\\?\C:\token" }), "externalAccount", "file", "credential_source.file", "a file source with a device prefix"),
            (External(new JsonObject { ["file"] = @"\\.\pipe\token" }), "externalAccount", "file", "credential_source.file", "a file source naming a pipe"),
            (External(new JsonObject { ["file"] = @"\??\UNC\files.example.com\share\token" }), "externalAccount", "file", "credential_source.file", "a file source with an NT UNC prefix"),
            (External(new JsonObject { ["file"] = @"\??\C:\token" }), "externalAccount", "file", "credential_source.file", "a file source with an NT prefix"),
            (Impersonated(User(), Target + "%0A"), "gcloud", "adc", "service_account_impersonation_url", "an impersonation URL whose account ends in an escaped newline"),
            (External(new JsonObject { ["file"] = Path.Combine(Path.GetTempPath(), "t"), ["url"] = "http://169.254.169.254/x" }), "externalAccount", "file", "credential_source.url", "a source naming a file and a URL"),
            (External(new JsonObject { ["certificate"] = new JsonObject { ["use_default_certificate_config"] = true } }), "externalAccount", "file", "credential_source.certificate", "an X.509 certificate source"),
            (External(new JsonObject { ["environment_id"] = "aws1" }), "externalAccount", "file", "credential_source.regional_cred_verification_url", "an AWS source without its verification URL"),
            (With(WorkforceUser(), value => value["token_url"] = "https://sts.googleapis.com/v1/token"), "externalAccount", "file", "token_url", "a workforce user's token_url other than oauthtoken"),
            (With(WorkforceUser(), value => value["revoke_url"] = "https://sts.example.com/v1/revoke"), "externalAccount", "file", "revoke_url", "a workforce user's revoke_url on another host"),
            (With(file, value => value["extra"] = new JsonObject { ["url"] = "https://example.com" }), "externalAccount", "file", "extra", "an object field Varia does not read"),
            (With(file, value => value["service_account_impersonation"] = new JsonObject { ["token_lifetime_seconds"] = 3600, ["url"] = "https://example.com" }), "externalAccount", "file", "service_account_impersonation", "an impersonation object holding more than a lifetime"),
            (With(file, value => value["service_account_impersonation"] = new JsonObject { ["token_lifetime_seconds"] = 60 }), "externalAccount", "file", "service_account_impersonation", "an impersonation lifetime under ten minutes"),
        ];
        foreach (var (value, mode, source, field, name) in refused)
        {
            var outcome = Outcome(value, mode, source);
            check(outcome.StartsWith("AUTH_KEY_FILE: The key file's " + field + " ", StringComparison.Ordinal) && !outcome.Contains(Secret, StringComparison.Ordinal),
                name + " is refused with AUTH_KEY_FILE naming " + field + ": " + outcome);
        }

        // Each mode loads only its own types; a file of another type, or not JSON at all, is refused without its content.
        (JsonNode? Value, string Text, string Mode, string Source, string Name)[] mismatched =
        [
            (User(), "", "serviceAccountKey", "file", "an authorized_user file picked as a service account key"),
            (file, "", "serviceAccountKey", "file", "a federation configuration picked as a service account key"),
            (key, "", "externalAccount", "file", "a service account key picked as a federation configuration"),
            (new JsonObject { ["type"] = "gdch_service_account" }, "", "gcloud", "adc", "an ADC file of a type Varia does not use"),
            (null, "-----BEGIN PRIVATE KEY-----\n" + Secret, "serviceAccountKey", "file", "a PEM file"),
            (null, "[1,2]", "serviceAccountKey", "file", "a JSON array"),
            (null, "{\"type\":\"service_account\",\"client_email\":\"" + ServiceAccount + "\"}", "serviceAccountKey", "file", "a key without its private key"),
        ];
        foreach (var (value, text, mode, source, name) in mismatched)
        {
            string outcome;
            try { BigQueryCredentials.Parse(value?.ToJsonString() ?? text, mode, source); outcome = "ok"; }
            catch (RequestException error) { outcome = error.Code + ": " + error.Message; }
            check(outcome.StartsWith("AUTH_KEY_FILE: ", StringComparison.Ordinal) && !outcome.Contains(Secret, StringComparison.Ordinal), name + " is refused with AUTH_KEY_FILE: " + outcome);
        }

        // The library's loads match names case-insensitively with the last one winning, so another spelling or a repeat of
        // a pinned field would reach the load unchecked; both are refused at every depth, without echoing the name.
        static string Raw(JsonObject value, string from, string to) => value.ToJsonString().Replace(from, to, StringComparison.Ordinal);
        var fileText = file.ToJsonString();
        var duplicateTail = ",\"token_url\":\"https://sts.example.com/v1/token\"}";
        (string Text, string Mode, string Expect, string Name)[] spelled =
        [
            (Raw(file, "\"token_url\"", "\"Token_Url\""), "externalAccount", "a field name that is not one of Google's", "a federation Token_Url"),
            (Raw(file, "\"token_url\"", "\"TOKEN_URL\""), "externalAccount", "a field name that is not one of Google's", "a federation TOKEN_URL"),
            (Raw(key, "\"token_uri\"", "\"Token_Uri\""), "serviceAccountKey", "a field name that is not one of Google's", "a key's Token_Uri"),
            (key.ToJsonString()[..^1] + ",\"Universe_Domain\":\"example.com\"}", "serviceAccountKey", "a field name that is not one of Google's", "a key's Universe_Domain"),
            (Raw(Impersonated(User()), "\"service_account_impersonation_url\"", "\"Service_Account_Impersonation_Url\""), "gcloud", "a field name that is not one of Google's", "an impersonation URL spelled otherwise"),
            (Raw(Impersonated(User()), "\"refresh_token\"", "\"Refresh_Token\""), "gcloud", "a field name that is not one of Google's", "a nested source field spelled otherwise"),
            (Raw(External(new JsonObject { ["file"] = Path.Combine(Path.GetTempPath(), "t") }), "\"file\"", "\"File\""), "externalAccount", "a field name that is not one of Google's", "a credential_source File"),
            (fileText[..^1] + duplicateTail, "externalAccount", "token_url appears more than once", "a repeated token_url"),
            (Raw(Impersonated(User()), "\"refresh_token\"", "\"token_uri\":\"https://tokens.example.com/token\",\"token_uri\":\"https://oauth2.googleapis.com/token\",\"refresh_token\""), "gcloud", "source_credentials.token_uri appears more than once", "a repeated nested token_uri"),
        ];
        foreach (var (text, mode, expect, name) in spelled)
        {
            string outcome;
            try { BigQueryCredentials.Parse(text, mode, mode == "gcloud" ? "adc" : "file"); outcome = "ok"; }
            catch (RequestException error) { outcome = error.Code + ": " + error.Message; }
            check(outcome.StartsWith("AUTH_KEY_FILE: ", StringComparison.Ordinal) && outcome.Contains(expect, StringComparison.Ordinal)
                && !outcome.Contains("Token_", StringComparison.Ordinal) && !outcome.Contains("TOKEN_", StringComparison.Ordinal) && !outcome.Contains(Secret, StringComparison.Ordinal),
                name + " is refused: " + outcome);
        }
        // A key saved with a byte order mark is the same key.
        string bom;
        try { BigQueryCredentials.Parse("﻿" + key.ToJsonString(), "serviceAccountKey", "file"); bom = "ok"; }
        catch (RequestException error) { bom = error.Message; }
        check(bom == "ok", "a service account key saved with a byte order mark is accepted: " + bom);

        // Emails are checked with zod's pattern, so the backend never answers one main's check would refuse.
        check(((string[])["a%b@x.com", "a..b@x.com", ".a@x.com", "a@x.c0m", "a@-x.com", "a@x.com\n"]).All(email => !BigQueryLimits.Email().IsMatch(email))
            && ((string[])[ServiceAccount, Target, "first.last+tag@example.co.uk"]).All(email => BigQueryLimits.Email().IsMatch(email)),
            "the email pattern refuses what zod refuses and accepts service account and ordinary addresses");

        // An instance metadata answer is capped at 64 KiB before anything buffers it, whoever asked (the library included).
        static string Capped(string url, int bytes, bool declareLength, int status = 200)
        {
            using var invoker = new HttpMessageInvoker(new MetadataResponseCap { InnerHandler = new StubHandler(bytes, declareLength, status) });
            try
            {
                using var response = invoker.SendAsync(new HttpRequestMessage(HttpMethod.Get, url), CancellationToken.None).GetAwaiter().GetResult();
                return "ok:" + response.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult().Length;
            }
            catch (RequestException error) { return error.Code; }
        }
        check(Capped("http://169.254.169.254/latest/meta-data/iam/security-credentials/varia-role", 70 * 1024, declareLength: false) == "AUTH_IDENTITY"
            && Capped("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", 70 * 1024, declareLength: true) == "AUTH_IDENTITY"
            && Capped("http://169.254.169.254/latest/api/token", 100, declareLength: false) == "ok:100"
            && Capped("http://169.254.169.254/latest/meta-data/iam/security-credentials/", 10, declareLength: true, status: 302) == "AUTH_IDENTITY"
            && Capped("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", 10, declareLength: true, status: 307) == "AUTH_IDENTITY"
            && Capped("https://bigquery.googleapis.com/bigquery/v2/projects", 70 * 1024, declareLength: false) == "ok:" + 70 * 1024,
            "a metadata answer over 64 KiB or a metadata redirect is refused, a small answer passes whole, and Google's APIs are not capped");

        // Instance metadata (plain http, answering with credentials) never crosses the system proxy; Google's APIs still do.
        var proxy = new MetadataDirectProxy(new System.Net.WebProxy("http://proxy.example.com:8080"));
        check(((string[])["http://169.254.169.254/latest/meta-data/iam/security-credentials/varia-role", "http://[fd00:ec2::254]/latest/api/token",
                "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", "http://169.254.169.254/metadata/identity/oauth2/token"])
                .All(url => proxy.IsBypassed(new Uri(url)) && proxy.GetProxy(new Uri(url)) is null)
            && !proxy.IsBypassed(new Uri("https://bigquery.googleapis.com/bigquery/v2/projects")) && proxy.GetProxy(new Uri("https://sts.googleapis.com/v1/token")) is not null,
            "instance metadata requests bypass the system proxy and Google's APIs keep it");
        var azureHeader = External(Azure());
        check(Outcome(azureHeader, "externalAccount", "file") == "ok", "Azure's Metadata header keeps Azure's spelling");

        // The options are checked as zod checks them.
        var material = new BigQueryCredentialMaterial("adc", User().ToJsonString());
        var valid = new BigQueryConnectOptions("bigquery", "varia-alpha", "gcloud", Credential: material);
        string Options(BigQueryConnectOptions options, bool emulator = false)
        {
            try { BigQueryLimits.Check(options, emulator); return "ok"; }
            catch (RequestException error) { return error.Code; }
        }
        check(Options(valid) == "ok" && Options(valid with { Project = "example.com:varia-alpha", Dataset = "sales_2026", Location = "us-east1", ExtraProjects = ["bigquery-public-data"], MaximumBytesBilled = 1L << 30, CostThreshold = 50, ImpersonateServiceAccount = Target }) == "ok"
            && Options(valid with { CostThreshold = 0 }) == "ok" && Options(valid with { CostThreshold = BigQueryLimits.CostThresholdGiB }) == "ok",
            "valid BigQuery options pass the backend's checks, domain-scoped projects included");
        (BigQueryConnectOptions Options, string Name)[] invalid =
        [
            (valid with { Project = "Varia-Alpha" }, "an upper-case project"), (valid with { Project = "abc" }, "a short project"), (valid with { Project = new string('a', 129) }, "a 129-character project"),
            (valid with { Dataset = "sales-2026" }, "a dataset with a dash"), (valid with { Dataset = "sälj" }, "a dataset with a non-ASCII letter"), (valid with { Dataset = new string('d', 1025) }, "a 1,025-character dataset"),
            (valid with { Location = "us east" }, "a location with a space"), (valid with { ExtraProjects = [.. Enumerable.Range(0, 17).Select(index => "varia-extra-" + index)] }, "17 extra projects"),
            (valid with { MaximumBytesBilled = 0 }, "a zero byte cap"), (valid with { CostThreshold = -1 }, "a negative cost threshold"),
            (valid with { CostThreshold = BigQueryLimits.CostThresholdGiB + 1 }, "a cost threshold over 1,048,576 GiB"), (valid with { ImpersonateServiceAccount = "not an email" }, "an impersonation target that is not an email"),
            (valid with { Authentication = "windows" }, "SQL Server's authentication"), (valid with { KeyFile = Guid.NewGuid().ToString() }, "gcloud with a key file"),
            (valid with { Authentication = "serviceAccountKey" }, "a key mode without a key file"), (valid with { Authentication = "serviceAccountKey", KeyFile = "C:/keys/sa.json", Credential = new("file", "{}") }, "a key file path instead of a reference"),
            (valid with { Credential = null }, "no credential material"), (valid with { Credential = new("file", "{}") }, "gcloud with key file material"),
            (valid with { Credential = new("adc", new string(' ', 64 * 1024 + 1)) }, "material over 64 KiB"), (valid with { Credential = new("metadata", "{}") }, "metadata with content"),
            (valid with { Credential = new("anonymous") }, "anonymous material outside emulator mode"), (valid with { Environment = "PROD\u202e" }, "an environment with a bidirectional override"),
            (valid with { Provider = "sqlserver" }, "SQL Server's provider")
        ];
        foreach (var (options, name) in invalid) check(Options(options) == "INVALID_PARAMS", "the backend refuses BigQuery options with " + name);
        check(Options(valid with { Credential = new("anonymous") }, emulator: true) == "ok" && Options(valid, emulator: true) == "INVALID_PARAMS",
            "emulator mode takes only anonymous material, so no Google credential is ever resolved for it");

        // Legacy SQL is refused before a job exists; comments and blank lines may come first.
        check(BigQueryErrors.IsLegacySql("#legacySQL\nSELECT 1") && BigQueryErrors.IsLegacySql("  -- note\n/* x */ #legacysql\nSELECT [p:d.t]")
            && !BigQueryErrors.IsLegacySql("SELECT '#legacySQL'") && !BigQueryErrors.IsLegacySql("# a comment\nSELECT 1") && !BigQueryErrors.IsLegacySql("#legacySQLx\nSELECT 1")
            && !BigQueryErrors.IsLegacySql("#standardSQL\nSELECT 1"),
            "a #legacySQL line before any statement is legacy SQL; one in a string, another comment or #standardSQL is not");
        // Messages never carry Google tokens.
        var sanitized = BigQueryErrors.Sanitize("bad ya29.a0AfH6SMBx-secret and 1//0gRefresh-secret\nnext eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln");
        check(!sanitized.Contains("secret", StringComparison.Ordinal) && !sanitized.Contains('\n') && sanitized.Contains("<token>", StringComparison.Ordinal),
            "error text from Google is one line with access, refresh and JSON Web Tokens redacted: " + sanitized);
        // Pins fit ConnectionInfo's 256 characters and stay exact when an identity is longer.
        var longPin = BigQueryIdentity.Pin("external", Audience + "|" + new string('s', 300));
        check(BigQueryIdentity.Pin("user", "ada@example.com") == "user:ada@example.com" && longPin.Length <= BigQueryIdentity.MaxPin && longPin.StartsWith("external:sha256:", StringComparison.Ordinal)
            && longPin != BigQueryIdentity.Pin("external", Audience + "|" + new string('t', 300)) && BigQueryIdentity.Pin("user", "a\u0007b").StartsWith("user:sha256:", StringComparison.Ordinal),
            "a pin is kind:identity, and an identity too long or not one visible line is replaced by its exact fingerprint");
        check(SubjectTokenSupplier.SubjectOf(BigQueryChecks.Jwt("workload-1")) == "workload-1" && SubjectTokenSupplier.SubjectOf("opaque-token") is null
            && SubjectTokenSupplier.SubjectOf(Convert.ToBase64String("<Assertion xmlns='urn:oasis:names:tc:SAML:2.0:assertion'><Subject><NameID>grace@example.com</NameID></Subject></Assertion>"u8.ToArray())) == "grace@example.com"
            && SubjectTokenSupplier.SubjectOf(Convert.ToBase64String("<!DOCTYPE x [<!ENTITY e SYSTEM 'file:///etc/passwd'>]><Assertion><NameID>&e;</NameID></Assertion>"u8.ToArray())) is null,
            "a federated subject is a JWT's sub or a SAML NameID; an opaque token has none, and a SAML document with a DTD is refused");
        check(BigQueryEnvironment.EmulatorEndpoint("http://localhost:9050")?.ToString() == "http://localhost:9050/" && BigQueryEnvironment.EmulatorEndpoint("http://127.0.0.1:9050/") is not null
            && BigQueryEnvironment.EmulatorEndpoint(" ") is null
            && new[] { "https://localhost:9050", "http://emulator.example.com:9050", "http://localhost:9050/bigquery", "http://user:pw@localhost:9050", "localhost:9050" }
                .All(value => { try { BigQueryEnvironment.EmulatorEndpoint(value); return false; } catch (InvalidOperationException) { return true; } }),
            "VARIA_TEST_BIGQUERY_ENDPOINT is honoured only as a loopback http address with no path, so it cannot point Varia at another host");
    }

    /// <summary>Answers every request with a body of the given size, streamed, with or without a Content-Length.</summary>
    sealed class StubHandler(int bytes, bool declareLength, int status = 200) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            HttpContent content = new StreamContent(new MemoryStream(new byte[bytes]));
            if (declareLength) content.Headers.ContentLength = bytes;
            else content.Headers.ContentLength = null;
            return Task.FromResult(new HttpResponseMessage((System.Net.HttpStatusCode)status) { Content = content });
        }
    }
}
