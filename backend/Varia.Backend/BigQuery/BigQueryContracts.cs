using System.Text.RegularExpressions;

namespace Varia.Backend.BigQuery;

/// <summary>
/// BigQuery's branch of connections.connect (src/shared/connections.ts, bigQueryConnectionOptionsSchema), with the credential
/// material main adds after resolving the options' key file reference or the ADC file (src/main/bigquery-credentials.ts).
/// KeyFile is that opaque reference: the backend never sees a path, only what main read.
/// </summary>
internal sealed record BigQueryConnectOptions(string Provider, string Project, string Authentication,
    string? Location = null, string? Dataset = null, IReadOnlyList<string>? ExtraProjects = null, string? KeyFile = null,
    string? ImpersonateServiceAccount = null, long? MaximumBytesBilled = null, bool? CostPrompt = null, string? DisplayName = null, string? Color = null,
    string? Environment = null, bool NonInteractive = false, BigQueryCredentialMaterial? Credential = null);

/// <summary>
/// What main read for a credential: <c>file</c>, a key or federation configuration file (the options' key file reference);
/// <c>adc</c>, the Application Default Credentials file; <c>metadata</c>, no ADC file, so the metadata server (ADC's last
/// step); <c>anonymous</c>, emulator mode (VARIA_TEST_BIGQUERY_ENDPOINT), which sends no Google token. Json is the file's
/// content, at most <see cref="BigQueryLimits.CredentialBytes"/>; it is never echoed in an error or a log.
/// </summary>
internal sealed record BigQueryCredentialMaterial(string Source, string? Json = null);

/// <summary>bigquery.account's parameters: what resolves a credential before a connection exists (the dialog's account
/// line), with the material main injected.</summary>
internal sealed record BigQueryCredentialArgs(string Authentication, string? KeyFile = null, string? ImpersonateServiceAccount = null,
    BigQueryCredentialMaterial? Credential = null);

/// <summary>bigquery.projects' parameters: a credential as for bigquery.account, and the page token of a previous answer.</summary>
internal sealed record BigQueryProjectsArgs(string Authentication, string? KeyFile = null, string? ImpersonateServiceAccount = null,
    BigQueryCredentialMaterial? Credential = null, string? PageToken = null);

/// <summary>The dialog's account line: the account the credential signs in as (an email, or a federated subject), what kind
/// of account it is, and the service account it impersonates, if any.</summary>
internal sealed record BigQueryAccount(string Kind, string Account, string? Impersonated = null);

internal sealed record BigQueryProject(string Id, string? FriendlyName = null);
/// <summary>One page of projects.list (BigQuery v2): at most <see cref="BigQueryLimits.ProjectsPerPage"/> projects and the
/// token of the next page.</summary>
internal sealed record BigQueryProjectList(IReadOnlyList<BigQueryProject> Projects, string? NextPageToken = null);

/// <summary>The limits zod sets on the same fields (bigQueryLimits in src/shared/connections.ts), checked again here.</summary>
internal static partial class BigQueryLimits
{
    public const int Project = 128;
    public const int Dataset = 1024;
    public const int Location = 64;
    public const int ExtraProjects = 16;
    public const int ServiceAccount = 254;
    public const int DisplayName = 128;
    /// <summary>A key or federation configuration file main reads: at most 64 KiB (docs/bigquery-plan.md, Authentication).</summary>
    public const int CredentialBytes = 64 * 1024;
    public const int PageToken = 1024;
    public const int ProjectsPerPage = 1000;
    public const int FriendlyName = 256;
    public const long MaxSafeInteger = 9_007_199_254_740_991;
    public static readonly string[] Modes = ["gcloud", "serviceAccountKey", "externalAccount"];

    [GeneratedRegex(@"^(?:[a-z0-9][a-z0-9.-]{0,61}[a-z0-9]:)?[a-z][a-z0-9-]{4,28}[a-z0-9]\z")]
    public static partial Regex ProjectId();
    // ASCII digits only, as zod's \w (.NET's \d matches every Unicode digit).
    [GeneratedRegex(@"^[A-Za-z0-9_]+\z")]
    public static partial Regex DatasetId();
    [GeneratedRegex(@"^[A-Za-z0-9-]+\z")]
    public static partial Regex LocationId();
    [GeneratedRegex(@"^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$", RegexOptions.IgnoreCase)]
    public static partial Regex Uuid();
    // zod's z.email() shape, narrowed: one @, no spaces or control characters.
    // zod's z.email() pattern exactly, so every address the backend accepts passes main's check of its answer.
    [GeneratedRegex(@"^(?:[A-Za-z0-9_'+\-]+\.)*[A-Za-z0-9_'+\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}\z")]
    public static partial Regex Email();
    [GeneratedRegex(@"^#[\da-f]{6}$", RegexOptions.IgnoreCase)]
    public static partial Regex Color();

    public static bool IsProject(string? value) => value is { Length: > 0 and <= Project } && ProjectId().IsMatch(value);

    static void Invalid(string message) => throw new RequestException("INVALID_PARAMS", message);

    /// <summary>Checks a credential request's mode, key file reference, impersonation target and material, as zod does.</summary>
    public static void CheckCredential(string authentication, string? keyFile, string? impersonate, BigQueryCredentialMaterial? credential, bool emulator)
    {
        if (Array.IndexOf(Modes, authentication) < 0) Invalid("Unsupported BigQuery authentication.");
        var usesKeyFile = authentication != "gcloud";
        if (usesKeyFile != keyFile is not null) Invalid(usesKeyFile ? "This authentication needs a key file." : "gcloud credentials take no key file.");
        if (keyFile is not null && !Uuid().IsMatch(keyFile)) Invalid("The key file reference is not valid.");
        if (impersonate is not null && (impersonate.Length > ServiceAccount || !Email().IsMatch(impersonate))) Invalid("Enter a service account email to impersonate.");
        if (credential is null) Invalid("The credential was not resolved.");
        if (credential!.Json is { Length: > CredentialBytes }) Invalid("The key file is larger than 64 KiB.");
        var expected = emulator ? ["anonymous"] : usesKeyFile ? ["file"] : new[] { "adc", "metadata" };
        if (Array.IndexOf(expected, credential.Source) < 0) Invalid("The credential does not match the authentication.");
        if (credential.Source is "file" or "adc" ? string.IsNullOrEmpty(credential.Json) : credential.Json is not null) Invalid("The credential does not match its source.");
    }

    /// <summary>Checks connect options as zod's BigQuery branch does.</summary>
    public static void Check(BigQueryConnectOptions options, bool emulator)
    {
        if (options.Provider != Providers.BigQuery) Invalid("Unknown connection provider.");
        if (!IsProject(options.Project)) Invalid("Enter a Google Cloud project id.");
        if (options.Location is { } location && (location.Length is 0 or > Location || !LocationId().IsMatch(location))) Invalid("The location is not valid.");
        if (options.Dataset is { } dataset && (dataset.Length is 0 or > Dataset || !DatasetId().IsMatch(dataset))) Invalid("A dataset name has only letters, numbers and underscores.");
        if (options.ExtraProjects is { } extra && (extra.Count > ExtraProjects || extra.Any(project => !IsProject(project)))) Invalid("Extra projects must be at most 16 project ids.");
        if (options.MaximumBytesBilled is < 1 or > MaxSafeInteger) Invalid("Maximum bytes billed is outside its supported range.");
        if (options.DisplayName is { Length: > DisplayName }) Invalid("Display name exceeds its supported length.");
        if (options.Color is { } color && !Color().IsMatch(color)) Invalid("The color is not valid.");
        if (options.Environment is { } environment && !ConnectionSettings.IsEnvironmentLabel(environment))
            Invalid("Environment exceeds its supported length or contains control or formatting characters.");
        CheckCredential(options.Authentication, options.KeyFile, options.ImpersonateServiceAccount, options.Credential, emulator);
    }

    public static void CheckPageToken(string? token)
    {
        if (token is not null && (token.Length is 0 or > PageToken || token.Any(char.IsControl))) Invalid("The page token is not valid.");
    }
}

/// <summary>
/// A BigQuery query's job, on its query.execute result: its fully qualified id and, once BigQuery reported them, its
/// statement type and statistics (bytes processed and billed, cache hit, slot milliseconds). The status bar prices the
/// bytes (docs/bigquery.md, Cost); figures BigQuery did not report are left out.
/// </summary>
internal sealed record BigQueryJobSummary(string Project, string JobId, string? Location = null, string? StatementType = null, long? BytesProcessed = null,
    long? BytesBilled = null, bool? CacheHit = null, long? SlotMs = null);

/// <summary>bigquery.dryRun's parameters (src/shared/bigquery/dry-run.ts): a connected handle, GoogleSQL text (the editor's,
/// or the text Execute is about to run) and the tab's default dataset; or, instead of text, Remote: a results.remoteQuery request
/// whose query is estimated (docs/bigquery.md, Sort and filter in BigQuery).</summary>
internal sealed record BigQueryDryRunArgs(string ConnectionId, string? Sql = null, string? Dataset = null, RemoteDryRunArgs? Remote = null);

/// <summary>A results.remoteQuery request (view or distinct) to estimate, without its query ID; the answer says whether running
/// it would fall back to the original query (BigQueryDryRunResult.Fallback).</summary>
internal sealed record RemoteDryRunArgs(uint ResultId, int Generation, string Kind, RemoteSortArgs[]? Sort = null, RemoteFilterArgs[]? Filters = null,
    int? Column = null, RemoteFilterArgs[]? Kept = null);

/// <summary>bigquery.dryRun's answer: the bytes the query would process, why the figure may be low, the statement type, and
/// whether emulator mode faked it; for a remote request, Fallback when its result table expired, so the figure is the original
/// query's, run again. A refused query is an error value (SQL_ERROR with BigQuery's <c>[line:column]</c>).</summary>
internal sealed record BigQueryDryRunResult(long BytesProcessed, string? Incomplete = null, string? StatementType = null, bool Faked = false, bool? Fallback = null);

/// <summary>query.execute's Preview Rows target (docs/bigquery.md, Preview Rows): the table whose first rows tabledata.list reads
/// instead of running the query text, which is the SELECT the tab shows. BigQuery handles only.</summary>
internal sealed record BigQueryPreviewTarget(string Project, string Dataset, string Table);
/// <summary>The bounds zod sets on bigquery.properties (bigQueryPropertiesLimits in src/shared/bigquery/objects.ts).</summary>
internal static class BigQueryPropertiesLimits
{
    public const int Name = 1024;
    public const int Type = 64;
    public const int FullName = 2200;
    public const int Location = 64;
    public const int Timestamp = 64;
    public const int FactValue = 2000;
    public const int Partitioning = 512;
    public const int ClusteringFields = 16;
    public const int ColumnName = 300;
    public const int ColumnType = 64;
    public const int ColumnMode = 32;
    public const int ColumnDescription = 2000;
    /// <summary>Seven field levels use all 16 MessagePack containers (0-based depth 15 in JsonBridge.FromJson) inside { result: { columns: [...] } }, leaving no headroom for a 7th-level fields array.</summary>
    public const int ColumnDepth = 7;
    public const int ColumnFields = 10_000;
    /// <summary>Estimated UTF-8 byte budget for mapped schema fields so wide schemas with long descriptions truncate cleanly before the 16 MiB response limit.</summary>
    public const int ColumnsTextBytes = 8 * 1024 * 1024;
    public const int Labels = 64;
    public const int LabelKey = 128;
    public const int LabelValue = 256;
    public const int DefinitionChars = 1_000_000;
}

/// <summary>bigquery.properties: a table-like object's facts from tables.get (docs/bigquery.md, Properties).</summary>
internal sealed record BigQueryPropertiesArgs(string ConnectionId, string RequestId, string Kind, string Project, string Dataset, string Name);
internal sealed record BigQueryFact(string Label, string Value);
internal sealed record BigQueryFactGroup(string Title, List<BigQueryFact> Facts);
internal sealed record BigQueryStorageInfo(long? Rows = null, long? LogicalBytes = null, long? LongTermLogicalBytes = null, long? PhysicalBytes = null);
internal sealed record BigQueryLayoutInfo(string? Partitioning = null, bool? RequirePartitionFilter = null, List<string>? Clustering = null);
internal sealed record BigQuerySchemaField(string Name, string Type, string? Mode = null, string? Description = null, List<BigQuerySchemaField>? Fields = null);
internal sealed record BigQueryLabel(string Key, string Value);
/// <summary>Type: tables.get's type in words ("table", "snapshot", "view"…). Groups: Table, Storage, Layout, History, in that
/// order, each left out when it has no facts. Structured fields carry the same free tables.get metadata for the inspector UI.</summary>
internal sealed record BigQueryProperties(
    string Name,
    string Type,
    List<BigQueryFactGroup> Groups,
    long ElapsedMs,
    string? FullName = null,
    string? Location = null,
    string? Description = null,
    string? BaseTable = null,
    string? CreatedUtc = null,
    string? ModifiedUtc = null,
    string? ExpiresUtc = null,
    string? SnapshotTimeUtc = null,
    BigQueryStorageInfo? Storage = null,
    BigQueryLayoutInfo? Layout = null,
    List<BigQuerySchemaField>? Columns = null,
    bool? ColumnsTruncated = null,
    List<BigQueryLabel>? Labels = null,
    string? Definition = null,
    bool? DefinitionTruncated = null);

/// <summary>
/// query.attach (docs/bigquery.md, Re-attaching to jobs): re-attaches the tab <c>SessionId</c> to a job a previous run (or
/// backend) started, by its id, location and project. AdoptSession takes over the BigQuery session the job ran in, starting
/// its transaction state from <c>Transaction</c> (the job record's, decision 54); Detached only holds the session's queue
/// until the job is DONE and reads no results. JobKey is the tab's job key, which main ties the job's record to.
/// </summary>
internal sealed record BigQueryAttachArgs(string ConnectionId, string SessionId, string QueryId, string JobKey, string JobId, string Project, string? Location = null,
    int MaxRows = 0, int MaxResultSets = 10, bool AdoptSession = false, string? Transaction = null, bool Detached = false, string? Residence = null,
    int? WindowCacheMiB = null, bool? Prices = null);

/// <summary>bigquery.endIdleSessions (main only, before every backend stop main makes): KeepJobKeys are the job keys of
/// tabs kept at quit, whose idle sessions with an open or unknown transaction are left for the next start.</summary>
internal sealed record BigQueryEndIdleArgs(IReadOnlyList<string>? KeepJobKeys = null);
internal sealed record BigQueryEndIdleResult(int FailedAborts);

/// <summary>One job bigquery.cancelJobs cancels: its id and location (its project is the call's).</summary>
internal sealed record BigQueryJobReference(string JobId, string? Location = null);

/// <summary>bigquery.cancelJobs (main only, sensitive): cancels jobs of a saved profile with no connection handle, signed
/// in with the credential material main resolved, and ends each job's session (docs/bigquery.md, Re-attaching
/// to jobs).</summary>
/// (The wire's jobs list is References here: BigQuery code names a Jobs member only for the jobs resource's calls, tests/working-memory-lint.test.ts.)
internal sealed record BigQueryCancelJobsArgs(string Authentication, string Project, [property: System.Text.Json.Serialization.JsonPropertyName("jobs")] IReadOnlyList<BigQueryJobReference> References, string? KeyFile = null,
    string? ImpersonateServiceAccount = null, BigQueryCredentialMaterial? Credential = null);

/// <summary>What became of one job: Cancelled says jobs.cancel was accepted (or the job had already finished); Note is
/// committedBeforeCancel or outcomeUnknown, as a cancelJob close reports them; Error, BigQuery's refusal.</summary>
internal sealed record BigQueryCancelledJob(string JobId, bool Cancelled,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] SessionCloseNote? Note = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] string? Error = null);
internal sealed record BigQueryCancelJobsResult(IReadOnlyList<BigQueryCancelledJob> Jobs);

/// <summary>The bounds zod sets on job references and keys (jobLimits in src/shared/bigquery/jobs.ts).</summary>
internal static partial class BigQueryJobLimits
{
    public const int JobId = 1024;
    /// <summary>Job keys bigquery.endIdleSessions and session.cancelRestoredJobs take, and jobs bigquery.cancelJobs cancels.</summary>
    public const int Keys = 1024;
    public const int Cancel = 64;

    // BigQuery's job ids: letters, digits, dashes and underscores, at most 1,024 characters.
    [GeneratedRegex(@"^[A-Za-z0-9_-]{1,1024}\z")]
    public static partial Regex JobIdPattern();

    public static bool IsJobId(string? value) => value is { Length: > 0 and <= JobId } && JobIdPattern().IsMatch(value);
    public static bool IsLocation(string? value) => value is null || value is { Length: > 0 and <= BigQueryLimits.Location } && BigQueryLimits.LocationId().IsMatch(value);
}
