using System.Collections.Concurrent;
using Google.Apis.Bigquery.v2.Data;
using Google.Apis.Http;
using Google.Cloud.BigQuery.V2;
using Varia.Backend.Protocol;

namespace Varia.Backend.BigQuery;

/// <summary>
/// The system proxy, except for cloud instance metadata: those requests are plain http on the instance's link-local
/// address and answer with credentials (an AWS role's keys, an Azure or Compute Engine token), so they never cross a proxy.
/// </summary>
internal sealed class MetadataDirectProxy(System.Net.IWebProxy inner) : System.Net.IWebProxy
{
    public System.Net.ICredentials? Credentials { get => inner.Credentials; set => inner.Credentials = value; }
    public Uri? GetProxy(Uri destination) => IsMetadata(destination) ? null : inner.GetProxy(destination);
    public bool IsBypassed(Uri host) => IsMetadata(host) || inner.IsBypassed(host);

    public static bool IsMetadata(Uri uri) =>
        uri.Host.StartsWith("169.254.", StringComparison.Ordinal) || string.Equals(uri.Host, "[fd00:ec2::254]", StringComparison.OrdinalIgnoreCase)
        || string.Equals(uri.Host, "metadata.google.internal", StringComparison.OrdinalIgnoreCase);
}

/// <summary>Google's HTTP client factory with instance metadata kept off the proxy and its answers capped
/// (<see cref="MetadataResponseCap"/>), for the requests Varia makes and those the library makes itself.</summary>
internal sealed class MetadataSafeHttpClientFactory() : HttpClientFactory(new MetadataDirectProxy(HttpClient.DefaultProxy))
{
    protected override HttpMessageHandler CreateHandler(CreateHttpClientArgs args) => new MetadataResponseCap { InnerHandler = base.CreateHandler(args) };
}

/// <summary>
/// Caps an instance metadata answer at 64 KiB before anything buffers it: off-cloud, anything on the network can answer
/// the link-local address, and the library reads its metadata answers whole. Google's own APIs are not capped here.
/// </summary>
internal sealed class MetadataResponseCap : DelegatingHandler
{
    public const int MaxBytes = 64 * 1024;

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var response = await base.SendAsync(request, cancellationToken);
        if (request.RequestUri is not { } uri || !MetadataDirectProxy.IsMetadata(uri)) return response;
        try
        {
            // Instance metadata never redirects; a redirect would take the library's next request to another host, past
            // this cap and back onto the proxy.
            if ((int)response.StatusCode is >= 300 and < 400)
                throw new RequestException("AUTH_IDENTITY", "The instance metadata service redirected the request elsewhere, so Varia did not follow it.");
            if (response.Content.Headers.ContentLength > MaxBytes) throw TooLarge();
            await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
            var buffer = new byte[MaxBytes + 1];
            var read = 0;
            while (read < buffer.Length && await stream.ReadAsync(buffer.AsMemory(read), cancellationToken) is var count and > 0) read += count;
            if (read > MaxBytes) throw TooLarge();
            var bounded = new ByteArrayContent(buffer, 0, read);
            foreach (var header in response.Content.Headers) bounded.Headers.TryAddWithoutValidation(header.Key, header.Value);
            bounded.Headers.ContentLength = read;
            response.Content.Dispose();
            response.Content = bounded;
            return response;
        }
        catch { response.Dispose(); throw; }
    }

    static RequestException TooLarge() => new("AUTH_IDENTITY", "The instance metadata service answered with more than 64 KiB, so Varia did not use it.");
}

/// <summary>
/// Where BigQuery requests go and how: Google's endpoint, or the emulator VARIA_TEST_BIGQUERY_ENDPOINT names (emulator mode:
/// anonymous credentials, no connect probe and no sessions, faked estimates); the HTTP client factory every request and
/// credential uses (the offline checks put their fake here); and the federation subject token rules. Storage Read goes
/// to Google's gRPC endpoint through <see cref="Proxy"/> (the system proxy when null), or in emulator mode to the
/// emulator's plaintext gRPC port when VARIA_TEST_BIGQUERY_STORAGE_ENDPOINT names it (off otherwise); the offline checks
/// replace the client with <see cref="Storage"/>.
/// </summary>
internal sealed record BigQueryEnvironment(Uri? Endpoint, IHttpClientFactory Http, SubjectTokens Subjects, Uri? StorageEndpoint = null,
    System.Net.IWebProxy? Proxy = null, Func<BigQueryConnection, IBigQueryStorageRead>? Storage = null)
{
    public bool Emulator => Endpoint is not null;

    /// <summary>Whether results may be read through Storage Read: always against Google, in emulator mode only with its
    /// gRPC port named (or a fake).</summary>
    public bool StorageRead => Storage is not null || !Emulator || StorageEndpoint is not null;

    /// <summary>A new Storage Read client for a connection, signed with its pinned credential.</summary>
    public IBigQueryStorageRead StorageClient(BigQueryConnection connection) => Storage?.Invoke(connection)
        ?? new GrpcStorageRead(StorageEndpoint ?? GrpcStorageRead.GoogleEndpoint, Emulator ? null : connection.Credential, Proxy);

    /// <summary>Google's endpoint with the system proxy and certificate store (decision 19).</summary>
    public static BigQueryEnvironment Production() => new(null, new MetadataSafeHttpClientFactory(), SubjectTokens.FromEnvironment());

    /// <summary>The backend process's environment. Main passes VARIA_TEST_BIGQUERY_ENDPOINT only to unpackaged builds
    /// (spawn-spec.ts), and only a loopback http address is honoured, so no build can be pointed at another host.</summary>
    public static BigQueryEnvironment FromEnvironment()
    {
        var endpoint = EmulatorEndpoint(Environment.GetEnvironmentVariable("VARIA_TEST_BIGQUERY_ENDPOINT"));
        // The emulator's gRPC port only beside its REST endpoint, so no build sends Storage Read anywhere but Google or loopback.
        var storage = endpoint is null ? null : EmulatorEndpoint(Environment.GetEnvironmentVariable("VARIA_TEST_BIGQUERY_STORAGE_ENDPOINT"), "VARIA_TEST_BIGQUERY_STORAGE_ENDPOINT", 9060);
        return Production() with { Endpoint = endpoint, StorageEndpoint = storage };
    }

    public static Uri? EmulatorEndpoint(string? value, string variable = "VARIA_TEST_BIGQUERY_ENDPOINT", int port = 9050)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        if (!Uri.TryCreate(value.Trim(), UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttp || !uri.IsLoopback || !string.IsNullOrEmpty(uri.UserInfo)
            || uri.Query.Length > 0 || uri.Fragment.Length > 0 || uri.AbsolutePath != "/")
            throw new InvalidOperationException(variable + " must be a loopback http address such as http://localhost:" + port + ".");
        return uri;
    }

    /// <summary>The REST base the client uses: the emulator's, or Google's default.</summary>
    public string? BaseUri => Endpoint is null ? null : new Uri(Endpoint, "bigquery/v2/").ToString();
}

/// <summary>One BigQuery connection handle: its options (without credential material), client, pinned credential and
/// principal, the default location (the options', or the default dataset's), and its Storage Read client, made on first
/// use. Work that must outlive a Disconnect (a pending session abort, a Stop's jobs.cancel) leases the client; the client
/// and Storage Read client are disposed once the handle is closed and no lease is left.</summary>
internal sealed class BigQueryConnection(string id, BigQueryConnectOptions options, BigQueryClient client, BigQueryPrincipal principal, string? location,
    Google.Apis.Auth.OAuth2.ICredential? credential = null) : IDisposable
{
    private readonly Lock gate = new();
    private IBigQueryStorageRead? storage;
    private int leases;
    private bool closed, disposed;

    public string Id { get; } = id;
    public BigQueryConnectOptions Options { get; } = options;
    public BigQueryClient Client { get; } = client;
    public BigQueryPrincipal Principal { get; } = principal;
    public string? Location { get; } = location;
    public Google.Apis.Auth.OAuth2.ICredential? Credential { get; } = credential;
    /// <summary>Datasets' locations read for tabs whose dataset is not the connection's (datasets.get, free); null when
    /// BigQuery named none or the read failed.</summary>
    public System.Collections.Concurrent.ConcurrentDictionary<string, string?> DatasetLocations { get; } = new(StringComparer.Ordinal);
    /// <summary>Why Storage Read cannot be used on this handle (the API is off, or the principal may not create read
    /// sessions); results are then read through REST without asking again.</summary>
    public volatile string? StorageRefused;
    /// <summary>Until when (Environment.TickCount64) results are read through REST because the Storage API could not be reached.</summary>
    public long StoragePausedUntil;
    /// <summary>The Storage Read fallback reasons Messages has named on this handle, so each is said once.</summary>
    public readonly System.Collections.Concurrent.ConcurrentDictionary<string, byte> StorageNotices = new();
    /// <summary>The fetch lane of this handle's windowed results (docs/bigquery.md, Residence): block reads at once, apart
    /// from the results slots that results.* methods hold.</summary>
    public SemaphoreSlim FetchLane { get; } = new(Results.RemoteResult.FetchesPerConnection);

    public IBigQueryStorageRead Storage(Func<BigQueryConnection, IBigQueryStorageRead> create)
    {
        lock (gate)
        {
            ObjectDisposedException.ThrowIf(closed || disposed, this);
            return storage ??= create(this);
        }
    }

    /// <summary>Keeps the client open past a Disconnect until the lease is disposed; null once the client is disposed.</summary>
    public IDisposable? Lease()
    {
        lock (gate)
        {
            if (disposed) return null;
            leases++;
            return new Release(this);
        }
    }

    sealed class Release(BigQueryConnection connection) : IDisposable
    {
        private int done;
        public void Dispose() { if (Interlocked.Exchange(ref done, 1) == 0) connection.Return(); }
    }

    void Return()
    {
        lock (gate)
        {
            leases--;
            if (!closed || leases > 0 || disposed) return;
            disposed = true;
        }
        DisposeClients();
    }

    /// <summary>Closes the handle: the clients are disposed now, or when the last lease ends.</summary>
    public void Dispose()
    {
        lock (gate)
        {
            closed = true;
            if (leases > 0 || disposed) return;
            disposed = true;
        }
        DisposeClients();
    }

    void DisposeClients()
    {
        storage?.Dispose();
        Client.Dispose();
    }
}

/// <summary>A dry run's estimate; emulator mode fakes it (the emulator does not dry-run). Incomplete says why the figure may
/// be low (docs/bigquery.md, Cost): <c>script</c> (a script's dry run stops at its first DDL or control statement),
/// <c>lowerBound</c> or <c>unknown</c> (BigQuery's own accuracy), or <c>zeroBytes</c> (tables were read but 0 bytes
/// reported: external and row-level-security tables).</summary>
internal sealed record BigQueryEstimate(long BytesProcessed, bool Faked = false, string? Incomplete = null, string? StatementType = null);

/// <summary>
/// The BigQuery engine (docs/bigquery.md): BigQuery connections in a registry keyed by the same handle ids as SQL Server's,
/// connect (credential, identity pin, the probe), disconnect, and the pre-connect methods. SqlService routes a handle here
/// by its provider after the provider check.
/// </summary>
internal sealed partial class BigQueryService(BigQueryEnvironment environment) : IDisposable
{
    public const string ApplicationName = "VariaSqlManager";
    /// <summary>The connect probe (docs/bigquery-plan.md, SQL the backend runs): a free dry run that proves bigquery.jobs.create.</summary>
    public const string ProbeSql = "SELECT 1";
    public const string ProbePermission = "bigquery.jobs.create";
    /// <summary>Labels on every job Varia creates, so Job History can mark them.</summary>
    public static readonly IReadOnlyDictionary<string, string> Labels = new Dictionary<string, string> { ["varia_client"] = "varia" };

    private readonly ConcurrentDictionary<string, BigQueryConnection> connections = new();

    public BigQueryEnvironment Environment => environment;
    /// <summary>Connect's budget inside main's 45 s deadline (12 s inside its 15 s for a background reconnect); the checks shorten it.</summary>
    internal TimeSpan ConnectLimit { get; set; } = TimeSpan.FromSeconds(40);
    internal TimeSpan BackgroundConnectLimit { get; set; } = TimeSpan.FromSeconds(12);
    /// <summary>The pre-connect methods' budget inside their 30 s deadline.</summary>
    internal TimeSpan PreConnectLimit { get; set; } = TimeSpan.FromSeconds(25);
    /// <summary>How long the metadata server may take to answer before ADC concludes there is none.</summary>
    internal TimeSpan MetadataLimit { get; set; } = TimeSpan.FromSeconds(3);

    public bool Owns(string connectionId) => connections.ContainsKey(connectionId);
    public BigQueryConnection? Find(string connectionId) => connections.GetValueOrDefault(connectionId);
    public int Count => connections.Count;

    public async Task<ConnectionInfo> ConnectAsync(BigQueryConnectOptions options, CancellationToken token, RequestContext? context = null)
    {
        BigQueryLimits.Check(options, environment.Emulator);
        using var budget = CancellationTokenSource.CreateLinkedTokenSource(token);
        budget.CancelAfter(options.NonInteractive ? BackgroundConnectLimit : ConnectLimit);
        var bounded = budget.Token;
        var stored = options with { Credential = null };
        BigQueryClient? client = null;
        try
        {
            var (credential, principal) = await SignInAsync(options.Authentication, options.ImpersonateServiceAccount, options.Credential!, bounded);
            client = Client(options.Project, credential, options.Location);
            var location = options.Location;
            if (!environment.Emulator)
                await ProbeAsync(client, options.Project, location, bounded);
            if (location is null && options.Dataset is { } dataset)
                location = await DatasetLocationAsync(client, options.Project, dataset, bounded);
            var id = Guid.NewGuid().ToString();
            connections[id] = new BigQueryConnection(id, stored, client, principal, location, credential);
            client = null;
            if (context is not null)
            {
                var released = 0;
                void Release() { if (Interlocked.Exchange(ref released, 1) == 0) Disconnect(id); }
                context.Unsent = context.Dropped = Release;
            }
            return new(id, options.Project, options.Dataset ?? "", "BigQuery", options.DisplayName, options.Color, Login: principal.Account,
                PrincipalId: principal.PrincipalId, ProviderId: Providers.BigQuery);
        }
        catch (Exception error) { throw BigQueryErrors.Map(error, options.Project, ProbePermission, KindOf(options.Authentication), token: token); }
        finally { client?.Dispose(); }
    }

    static string? KindOf(string authentication) => authentication switch { "serviceAccountKey" => "serviceAccount", "externalAccount" => "externalAccount", _ => null };

    /// <summary>Removes a handle and disposes its client, ending nothing in BigQuery (an unsent connect, the backend's stop).
    /// Results stay readable after a disconnect, as SQL Server's do.</summary>
    public bool Disconnect(string connectionId)
    {
        if (!connections.TryRemove(connectionId, out var connection)) return false;
        ForgetSessions(connection);
        connection.Dispose();
        return true;
    }

    /// <summary>connections.disconnect for a BigQuery handle (docs/bigquery.md, Re-attaching to jobs): removes it, ends its idle
    /// sessions (ABORT_SESSION, in parallel, through a lease on the client) and leaves those holding a running or detached
    /// job. FailedAborts counts the ends that failed, each kept for one retry.</summary>
    public async Task<DisconnectResult> DisconnectAsync(string connectionId, CancellationToken token)
    {
        if (!connections.TryRemove(connectionId, out var connection)) return new(false);
        var lease = connection.Lease();
        var idle = ForgetSessions(connection);
        connection.Dispose();
        if (lease is null) return new(true);
        using (lease) return new(true, idle.Count == 0 ? null : await EndSessionsAsync(idle, token));
    }

    /// <summary>bigquery.account: the account line before connecting.</summary>
    public async Task<BigQueryAccount> AccountAsync(BigQueryCredentialArgs args, CancellationToken token)
    {
        BigQueryLimits.CheckCredential(args.Authentication, args.KeyFile, args.ImpersonateServiceAccount, args.Credential, environment.Emulator);
        using var budget = CancellationTokenSource.CreateLinkedTokenSource(token);
        budget.CancelAfter(PreConnectLimit);
        try
        {
            var (_, principal) = await SignInAsync(args.Authentication, args.ImpersonateServiceAccount, args.Credential!, budget.Token);
            return new(principal.Kind, principal.Account, principal.Impersonated);
        }
        catch (Exception error) { throw BigQueryErrors.Map(error, kind: KindOf(args.Authentication), token: token); }
    }

    /// <summary>bigquery.projects: one page of projects.list (BigQuery v2, not Resource Manager, which needs another API).</summary>
    public async Task<BigQueryProjectList> ProjectsAsync(BigQueryProjectsArgs args, CancellationToken token)
    {
        BigQueryLimits.CheckCredential(args.Authentication, args.KeyFile, args.ImpersonateServiceAccount, args.Credential, environment.Emulator);
        BigQueryLimits.CheckPageToken(args.PageToken);
        using var budget = CancellationTokenSource.CreateLinkedTokenSource(token);
        budget.CancelAfter(PreConnectLimit);
        try
        {
            var (credential, _) = await SignInAsync(args.Authentication, args.ImpersonateServiceAccount, args.Credential!, budget.Token);
            // projects.list names no project; the client needs one, which is never sent.
            using var client = Client("varia-pre-connect", credential, null);
            var request = client.Service.Projects.List();
            request.MaxResults = BigQueryLimits.ProjectsPerPage;
            request.PageToken = args.PageToken;
            var page = await request.ExecuteAsync(budget.Token);
            var projects = new List<BigQueryProject>();
            foreach (var project in page.Projects ?? [])
            {
                // The emulator names a project only by its id; Google fills projectReference too.
                var id = project.ProjectReference?.ProjectId ?? project.Id;
                if (!BigQueryLimits.IsProject(id) || projects.Count >= BigQueryLimits.ProjectsPerPage) continue;
                var name = project.FriendlyName is { Length: > 0 } friendly ? BigQueryIdentity.Account(friendly) : null;
                projects.Add(new(id!, name is { Length: > BigQueryLimits.FriendlyName } ? name[..BigQueryLimits.FriendlyName] : name));
            }
            var next = page.NextPageToken is { Length: > 0 and <= BigQueryLimits.PageToken } value && !value.Any(char.IsControl) ? value : null;
            return new(projects, next);
        }
        catch (Exception error) { throw BigQueryErrors.Map(error, kind: KindOf(args.Authentication), token: token); }
    }

    /// <summary>Resolves the credential main read and pins its identity. Emulator mode signs nothing.</summary>
    internal async Task<(Google.Apis.Auth.OAuth2.ICredential Credential, BigQueryPrincipal Principal)> SignInAsync(string authentication, string? impersonate, BigQueryCredentialMaterial material, CancellationToken token)
    {
        if (environment.Emulator) return (AnonymousCredential.Instance, BigQueryIdentity.Anonymous);
        LoadedCredential loaded;
        if (material.Source == "metadata")
        {
            if (!await MetadataServerAsync(token)) throw new RequestException("AUTH_EXPIRED", BigQueryErrors.NoCredentials);
            loaded = BigQueryCredentials.Metadata(environment.Http);
        }
        else
        {
            var checkedFile = BigQueryCredentials.Parse(material.Json!, authentication, material.Source);
            // The library's own parse (a malformed private key, a value of the wrong JSON type) is a bad file too; its
            // message can quote the file, so it is not passed on.
            try { loaded = BigQueryCredentials.Load(checkedFile, environment.Http, environment.Subjects); }
            catch (Exception error) when (error is not RequestException and not OperationCanceledException)
            {
                throw new RequestException("AUTH_KEY_FILE", "The key file could not be loaded: a field holds a value Google's format does not allow. Choose the file again.");
            }
        }
        // A refused sign-in means what the credential it came from is (a deleted key, a refused federation token, an
        // expired user sign-in), whichever mode found it; ADC can hold any of them.
        var kind = loaded.Kind switch { "serviceAccount" => "serviceAccount", "external" or "aws" => "externalAccount", _ => null };
        try
        {
            if (impersonate is not null) loaded = loaded.Impersonate(impersonate, environment.Http);
            var principal = await BigQueryIdentity.ResolveAsync(loaded, environment.Http, token);
            var pinned = new PinnedCredential(loaded, principal, environment.Http);
            pinned.Verified(await BigQueryIdentity.TokenAsync(loaded.Credential, token));
            return (pinned, principal);
        }
        catch (Exception error) when (error is not RequestException && BigQueryErrors.Map(error, kind: kind, token: token) is RequestException mapped) { throw mapped; }
    }

    /// <summary>Whether a metadata server answers (ADC's last step), within <see cref="MetadataLimit"/>.</summary>
    async Task<bool> MetadataServerAsync(CancellationToken token)
    {
        using var limit = CancellationTokenSource.CreateLinkedTokenSource(token);
        limit.CancelAfter(MetadataLimit);
        try
        {
            using var client = environment.Http.CreateHttpClient(new CreateHttpClientArgs());
            using var request = new HttpRequestMessage(HttpMethod.Get, BigQueryIdentity.MetadataEmailUrl);
            request.Headers.Add("Metadata-Flavor", "Google");
            using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, limit.Token);
            return response.IsSuccessStatusCode && response.Headers.TryGetValues("Metadata-Flavor", out var flavor) && flavor.Contains("Google");
        }
        catch (Exception) when (!token.IsCancellationRequested) { return false; }
    }

    internal BigQueryClient Client(string project, Google.Apis.Auth.OAuth2.ICredential credential, string? location) => new BigQueryClientBuilder
    {
        ProjectId = project, DefaultLocation = location, Credential = credential, HttpClientFactory = environment.Http,
        BaseUri = environment.BaseUri, ApplicationName = ApplicationName,
        // Explicit, so GOOGLE_CLOUD_UNIVERSE_DOMAIN cannot move BigQuery (and its bearer token) to another host; the emulator
        // names its own address instead.
        UniverseDomain = environment.Emulator ? null : BigQueryCredentials.Universe
    }.Build();

    /// <summary>The connect probe: a dry run of SELECT 1 in the billing project. It proves bigquery.jobs.create and bills nothing.</summary>
    internal static async Task ProbeAsync(BigQueryClient client, string project, string? location, CancellationToken token) =>
        await DryRunAsync(client, project, location, ProbeSql, null, token);

    /// <summary>A dry run (free): the bytes a query would process. Emulator mode answers a faked estimate.</summary>
    internal async Task<BigQueryEstimate> EstimateAsync(BigQueryConnection connection, string sql, CancellationToken token, string? dataset = null,
        IList<QueryParameter>? parameters = null, string? location = null)
    {
        if (environment.Emulator) return new(0, Faked: true);
        if (BigQueryErrors.IsLegacySql(sql)) throw new RequestException("LEGACY_SQL", BigQueryErrors.LegacySql);
        Exception failure;
        // Connecting already proved bigquery.jobs.create, so a 403 here is about what the query reads: Google's text stays.
        try { return Estimate(await DryRunAsync(connection.Client, connection.Options.Project, location ?? connection.Location, sql, dataset, token, parameters)); }
        catch (Exception error) { failure = BigQueryErrors.Map(error, connection.Options.Project, token: token); }
        if (failure is not RequestException { Code: "NOT_FOUND" } missing) throw failure;
        // A dataset in another location is told apart as Execute tells it; a table or dataset that does not exist is the
        // query's mistake (marked in the editor), while a missing project stays NOT_FOUND.
        var mapped = await BigQueryErrors.LocationAsync(missing, connection.Client, token);
        if (mapped.Code == "NOT_FOUND" && NamedObject().Match(mapped.Message) is { Success: true } named) throw new RequestException("SQL_ERROR", named.Value);
        throw mapped;
    }

    /// <summary>bigquery.dryRun (docs/bigquery.md, Cost): the free estimate before Execute and the editor's diagnostics. It
    /// sends the text to Google, as Execute would, but runs nothing and bills nothing.</summary>
    public async Task<BigQueryDryRunResult> DryRunQueryAsync(BigQueryDryRunArgs args, CancellationToken token)
    {
        if (string.IsNullOrWhiteSpace(args.Sql) || args.Sql.Length > MaxDryRunCharacters) throw new RequestException("INVALID_PARAMS", "The query text is empty or too long.");
        if (args.Dataset is { } dataset && (dataset.Length is 0 or > BigQueryLimits.Dataset || !BigQueryLimits.DatasetId().IsMatch(dataset)))
            throw new RequestException("INVALID_PARAMS", "A dataset name has only letters, numbers and underscores.");
        var connection = Find(args.ConnectionId) ?? throw new RequestException("NOT_CONNECTED", "The connection is no longer open.");
        var estimate = await EstimateAsync(connection, args.Sql, token, args.Dataset ?? connection.Options.Dataset);
        return new(estimate.BytesProcessed, estimate.Incomplete, estimate.StatementType, estimate.Faked);
    }

    /// <summary>Google's text for a table, view, routine, model or dataset the query names that does not exist (without the
    /// project hint NOT_FOUND adds).</summary>
    // Names may hold spaces and run to 1,024 characters a part, so the name runs to the location clause, NOT_FOUND's hint or
    // the end.
    [System.Text.RegularExpressions.GeneratedRegex(@"^Not found: (?:Table|View|Routine|Model|Dataset) .{1,3100}?(?: was not found in location [A-Za-z\d-]{1,64})?(?= Check the project id|\r?\n|$)")]
    private static partial System.Text.RegularExpressions.Regex NamedObject();

    /// <summary>The most text a dry run takes, as query.execute does (dryRunLimits in src/shared/bigquery/dry-run.ts).</summary>
    public const int MaxDryRunCharacters = 1_000_000;

    /// <summary>The bytes a dry run reports, and why the figure may be low.</summary>
    internal static BigQueryEstimate Estimate(Job answer)
    {
        var query = answer.Statistics?.Query;
        var bytes = Math.Max(0, answer.Statistics?.TotalBytesProcessed ?? query?.TotalBytesProcessed ?? 0);
        var statement = query?.StatementType is { Length: > 0 and <= 64 } type && type.All(c => char.IsAsciiLetterUpper(c) || c == '_') ? type : null;
        var incomplete = statement == "SCRIPT" ? "script"
            : query?.TotalBytesProcessedAccuracy switch { "LOWER_BOUND" => "lowerBound", "UNKNOWN" => "unknown", _ => null }
            // Any statement that reads tables (CREATE TABLE AS SELECT, INSERT ... SELECT, MERGE too), but not DDL that reads none.
            ?? (bytes == 0 && !ReadsNothing(statement) && query?.ReferencedTables is { Count: > 0 } ? "zeroBytes" : null);
        return new(bytes, Incomplete: incomplete, StatementType: statement);
    }

    /// <summary>Statements that process no billed table data whatever they name (DDL, snapshot copies, loads, index
    /// creation), so 0 bytes is the true figure.</summary>
    static bool ReadsNothing(string? statement) => statement is not null && (statement.StartsWith("DROP_", StringComparison.Ordinal)
        || statement.StartsWith("ALTER_", StringComparison.Ordinal) || statement is "CREATE_TABLE" or "CREATE_VIEW" or "CREATE_SCHEMA" or "CREATE_FUNCTION"
        or "CREATE_TABLE_FUNCTION" or "CREATE_PROCEDURE" or "CREATE_ROW_ACCESS_POLICY" or "TRUNCATE_TABLE" or "CREATE_SNAPSHOT_TABLE"
        or "LOAD_DATA" or "CREATE_SEARCH_INDEX" or "CREATE_VECTOR_INDEX");

    static async Task<Job> DryRunAsync(BigQueryClient client, string project, string? location, string sql, string? dataset, CancellationToken token, IList<QueryParameter>? parameters = null)
    {
        var job = new Job
        {
            JobReference = location is null ? null : new JobReference { ProjectId = project, Location = location },
            Configuration = new JobConfiguration
            {
                DryRun = true, Labels = new Dictionary<string, string>(Labels),
                Query = new JobConfigurationQuery
                {
                    Query = sql, UseLegacySql = false,
                    QueryParameters = parameters, ParameterMode = parameters is null ? null : "NAMED",
                    DefaultDataset = dataset is null ? null : new DatasetReference { ProjectId = project, DatasetId = dataset }
                }
            }
        };
        return await client.Service.Jobs.Insert(job, project).ExecuteAsync(token);
    }

    /// <summary>The default dataset's location (datasets.get), the connection's location when the options name none.</summary>
    static async Task<string?> DatasetLocationAsync(BigQueryClient client, string project, string dataset, CancellationToken token)
    {
        var answer = await client.Service.Datasets.Get(project, dataset).ExecuteAsync(token);
        return answer.Location is { Length: > 0 and <= BigQueryLimits.Location } location && BigQueryLimits.LocationId().IsMatch(location) ? location : null;
    }

    public void Dispose()
    {
        // A pending abort ends with the backend: its session is left to expire (docs/bigquery.md, Sessions).
        stopping.Cancel();
        foreach (var id in connections.Keys) Disconnect(id);
    }
}
