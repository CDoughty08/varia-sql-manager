using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Varia.Backend.BigQuery;

/// <summary>
/// The <c>bigquery.jobs</c> live source's args (src/shared/bigquery/history.ts, jobHistoryArgsSchema): the scope (the principal's
/// jobs, or the project's), the time range (Hours back from now, or From and To in epoch ms), the state, type, statement and
/// Started from Varia filters, pinned jobs (the wire's <c>jobs</c>), the scripts whose children show under them and whether the
/// Cost column is written.
/// </summary>
internal sealed record BigQueryJobHistoryArgs(string? Scope = null, int? Hours = null, long? From = null, long? To = null, string[]? States = null, string[]? Types = null,
    string[]? Statements = null, bool? Varia = null, [property: JsonPropertyName("jobs")] BigQueryJobReference[]? Pinned = null, BigQueryJobReference[]? Expand = null,
    bool? Prices = null)
{
    public bool AllUsers => Scope == "all";
    /// <summary>The same listing: every member but the expanded scripts and the price setting, which only change what is written.</summary>
    public bool SameListing(BigQueryJobHistoryArgs other) => Scope == other.Scope && Hours == other.Hours && From == other.From && To == other.To && Same(States, other.States)
        && Same(Types, other.Types) && Same(Statements, other.Statements) && Varia == other.Varia
        && Same(Pinned?.Select(job => job.JobId + "/" + job.Location).ToArray(), other.Pinned?.Select(job => job.JobId + "/" + job.Location).ToArray());

    static bool Same(string[]? a, string[]? b) => a is null ? b is null : b is not null && a.Order(StringComparer.Ordinal).SequenceEqual(b.Order(StringComparer.Ordinal), StringComparer.Ordinal);
}

/// <summary>bigquery.jobs.get and bigquery.jobs.cancel: one job of the connection's billing project. AllUsers (get) lists a
/// script's children with allUsers, for another user's script.</summary>
internal sealed record BigQueryJobArgs(string ConnectionId, string JobId, string? Location = null, bool? AllUsers = null);

internal sealed record BigQueryJobError(
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Reason,
    string Message,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Location);
internal sealed record BigQueryJobLabel(string Key, string Value);
/// <summary>bigquery.jobs.get's job: what jobs.get answered, cut to the bounds of jobHistoryDetailsSchema.</summary>
internal sealed record BigQueryJobDetail(string JobId, string Project, string? Location, string State, string Type, string? Statement, string? User, long? Created, long? Started,
    long? Ended, string? Sql, bool? SqlTruncated, string? Dataset, string? Destination, long? MaximumBytesBilled, bool? Session, List<BigQueryJobLabel> Labels, long? Processed,
    long? Billed, long? SlotMs, bool? CacheHit, long? RowsAffected, BigQueryJobError? Error, string? ParentJobId, long? ChildCount, bool Varia, bool Hidden);
internal sealed record BigQueryJobChild(string JobId, string? Location, string State, string? Statement, long? Created, long? DurationMs, long? Processed, long? Billed, long? SlotMs,
    bool? CacheHit, string? Sql, string? Error, bool Hidden);
internal sealed record BigQueryJobDetails(BigQueryJobDetail Job, List<BigQueryJobChild> Children,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] bool? ChildrenMore = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? ChildrenError = null);
internal sealed record BigQueryJobCancelResult(bool Cancelled, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? State = null);

/// <summary>One job as Job History holds it: a jobs.list item (or a jobs.get answer) read from BigQuery's JSON, its SQL cut to
/// the preview as it is read. State is derived: failed and cancelled are DONE jobs with an error, cancelled when its reason is
/// stopped and it did not time out. Hidden: BigQuery left out the configuration, as it does for another user's job without
/// bigquery.jobs.listAll; such a row shows only what came back.</summary>
internal sealed record HistoryJob(string Id, string? Location, string State, string Type, string? Statement, string? User, long? Created, long? Started, long? Ended,
    long? Processed, long? Billed, long? SlotMs, bool? CacheHit, string? Destination, string? ErrorReason, string? ErrorMessage, string? Sql, string? Parent, long Children, bool Varia,
    bool Hidden)
{
    public bool Open => State is "running" or "pending";
    public bool Script => Children > 0 || Statement == "SCRIPT";
}

/// <summary>One jobs.list page as Job History reads it: its jobs, the next page's token and the locations BigQuery could not
/// read.</summary>
internal sealed record HistoryPage(List<HistoryJob> Items, string? Next, List<string> Unreachable, long Bytes);

/// <summary>Job History's bounds and the rules that read BigQuery's job JSON (docs/bigquery.md, Job History). The bounds repeat
/// src/shared/bigquery/history-catalog.ts's jobHistoryLimits; the checks compare them.</summary>
internal static class BigQueryJobHistory
{
    public const int MaxJobs = 1000, PageJobs = 100, PreviewChars = 200, RetentionDays = 180, Children = 1000, Expanded = 4, Pinned = 64, Statements = 16, StatementChars = 64,
        ErrorChars = 300, OverlapMs = 60_000, DetailsChars = 1_000_000, ChildrenErrorChars = 2000;
    public const int ResponseBytes = 10 * 1024 * 1024;
    /// <summary>One jobs.get answer: a job's whole query text (up to 1 MB, escaped in JSON) and its statistics.</summary>
    public const int JobBytes = 8 * 1024 * 1024;
    public static readonly int[] Hours = [1, 24, 168, 720];
    public static readonly string[] States = ["running", "pending", "done", "failed", "cancelled"];
    public static readonly string[] Types = ["query", "load", "extract", "copy"];
    public const long RetentionMs = RetentionDays * 24L * 60 * 60 * 1000;

    static RequestException Invalid() => new("INVALID_PARAMS", "Invalid arguments for this source.");

    /// <summary>Checks args as main's schema does.</summary>
    public static BigQueryJobHistoryArgs Check(BigQueryJobHistoryArgs args)
    {
        if (args.Scope is not ("mine" or "all")) throw Invalid();
        if (args.Hours is { } hours && (Array.IndexOf(Hours, hours) < 0 || args.From is not null || args.To is not null)) throw Invalid();
        if (args.From is null != args.To is null) throw Invalid();
        if (args.From is { } from && args.To is { } to && (from < 0 || to > BigQueryLimits.MaxSafeInteger || from >= to || to - from > RetentionMs)) throw Invalid();
        if (!Subset(args.States, States) || !Subset(args.Types, Types)) throw Invalid();
        if (args.Statements is { } statements && (statements.Length is 0 or > Statements || statements.Distinct(StringComparer.Ordinal).Count() != statements.Length
            || statements.Any(statement => !IsStatement(statement)))) throw Invalid();
        if (args.Varia is false) throw Invalid();
        CheckJobs(args.Pinned, Pinned);
        CheckJobs(args.Expand, Expanded);
        return args;
    }

    static bool Subset(string[]? values, string[] allowed) => values is null
        || values.Length >= 1 && values.Length <= allowed.Length && values.All(value => Array.IndexOf(allowed, value) >= 0) && values.Distinct(StringComparer.Ordinal).Count() == values.Length;

    static void CheckJobs(BigQueryJobReference[]? jobs, int max)
    {
        if (jobs is null) return;
        if (jobs.Length is 0 || jobs.Length > max || jobs.Any(job => job is null || !BigQueryJobLimits.IsJobId(job.JobId) || !BigQueryJobLimits.IsLocation(job.Location))
            || jobs.Select(job => job.JobId).Distinct(StringComparer.Ordinal).Count() != jobs.Length) throw Invalid();
    }

    public static bool IsStatement(string? value) => value is { Length: > 0 and <= StatementChars } && value.All(c => char.IsAsciiLetterUpper(c) || c == '_');

    /// <summary>Checks bigquery.jobs.get's and bigquery.jobs.cancel's parameters as main's schema does.</summary>
    public static BigQueryJobArgs Check(BigQueryJobArgs args)
    {
        if (args.ConnectionId is not { Length: 36 } || !Guid.TryParseExact(args.ConnectionId, "D", out _) || !BigQueryJobLimits.IsJobId(args.JobId) || !BigQueryJobLimits.IsLocation(args.Location))
            throw new RequestException("INVALID_PARAMS", "The job is invalid.");
        return args;
    }

    /// <summary>A jobs.list page's jobs, next page token and unreachable locations.</summary>
    public static HistoryPage Page(JsonElement root, long bytes)
    {
        var items = new List<HistoryJob>();
        if (root.TryGetProperty("jobs", out var list) && list.ValueKind == JsonValueKind.Array)
            foreach (var item in list.EnumerateArray())
                if (Job(item) is { } job) items.Add(job);
        var unreachable = new List<string>();
        if (root.TryGetProperty("unreachable", out var places) && places.ValueKind == JsonValueKind.Array)
            foreach (var place in places.EnumerateArray())
                if (place.ValueKind == JsonValueKind.String && place.GetString() is { } name && BigQueryJobLimits.IsLocation(name) && unreachable.Count < 32) unreachable.Add(name);
        var next = Text(root, "nextPageToken") is { Length: > 0 and <= BigQueryLimits.PageToken } token && !token.Any(char.IsControl) ? token : null;
        return new(items, next, unreachable, bytes);
    }

    /// <summary>One job from a jobs.list item or a jobs.get answer; null when it names no usable job id.</summary>
    public static HistoryJob? Job(JsonElement item)
    {
        if (item.ValueKind != JsonValueKind.Object || !item.TryGetProperty("jobReference", out var reference) || Text(reference, "jobId") is not { } id || !BigQueryJobLimits.IsJobId(id)) return null;
        var location = Text(reference, "location") is { } place && BigQueryJobLimits.IsLocation(place) ? place : null;
        var statistics = Member(item, "statistics");
        var query = statistics is { } s ? Member(s, "query") : null;
        var configuration = Member(item, "configuration");
        var hidden = configuration is not { } config || !config.EnumerateObject().Any();
        var error = ErrorOf(item);
        var state = StateOf(item, error);
        var queryConfig = configuration is { } c ? Member(c, "query") : null;
        return new(id, location, state, TypeOf(configuration, statistics), StatementOf(query), User(item), Number(statistics, "creationTime"), Number(statistics, "startTime"),
            Number(statistics, "endTime"), Number(query, "totalBytesProcessed") ?? Number(statistics, "totalBytesProcessed"), Number(query, "totalBytesBilled"),
            Number(statistics, "totalSlotMs") ?? Number(query, "totalSlotMs"), Bool(query, "cacheHit"), Destination(configuration),
            error is { } e ? Reason(e) : null, error is { } m ? Clip(BigQueryErrors.Sanitize(Text(m, "message")), ErrorChars) : null,
            queryConfig is { } q && Text(q, "query") is { } sql ? Preview(sql) : null,
            Text(statistics, "parentJobId") is { } parent && BigQueryJobLimits.IsJobId(parent) ? parent : null, Number(statistics, "numChildJobs") ?? 0, IsVaria(configuration), hidden);
    }

    /// <summary>bigquery.jobs.get's job, read from a jobs.get answer.</summary>
    public static BigQueryJobDetail? Detail(JsonElement item, string project)
    {
        if (Job(item) is not { } job) return null;
        var configuration = Member(item, "configuration");
        var queryConfig = configuration is { } c ? Member(c, "query") : null;
        var statistics = Member(item, "statistics");
        var query = statistics is { } s ? Member(s, "query") : null;
        string? sql = null;
        bool? truncated = null;
        if (queryConfig is { } q && Text(q, "query") is { } text)
        {
            truncated = text.Length > DetailsChars ? true : null;
            sql = text.Length > DetailsChars ? text[..(char.IsHighSurrogate(text[DetailsChars - 1]) ? DetailsChars - 1 : DetailsChars)] : text;
        }
        var labels = new List<BigQueryJobLabel>();
        if (configuration is { } config && Member(config, "labels") is { } named)
            foreach (var label in named.EnumerateObject())
                if (labels.Count < 64 && label.Value.ValueKind == JsonValueKind.String && label.Name.Length <= 63 && label.Value.GetString() is { Length: <= 63 } value) labels.Add(new(label.Name, value));
        var error = ErrorOf(item);
        // Whether it ran in a session, never the session's id, which stays in the backend (docs/bigquery.md, Sessions).
        var session = statistics is { } stats && Member(stats, "sessionInfo") is { } info && Text(info, "sessionId") is { Length: > 0 };
        return new(job.Id, project, job.Location, job.State, job.Type, job.Statement, job.User, job.Created, job.Started, job.Ended, sql, truncated,
            queryConfig is { } d && Member(d, "defaultDataset") is { } dataset ? Table(dataset, table: false) : null, job.Destination,
            Number(queryConfig, "maximumBytesBilled"), session ? true : null, labels, job.Processed, job.Billed, job.SlotMs, job.CacheHit,
            Number(query, "numDmlAffectedRows"),
            error is { } e ? new BigQueryJobError(Reason(e), Clip(BigQueryErrors.Sanitize(Text(e, "message")), 16_384) ?? "BigQuery reported an error.", Clip(Text(e, "location"), 1024)) : null,
            job.Parent, job.Children == 0 ? null : job.Children, job.Varia, job.Hidden);
    }

    public static BigQueryJobChild Child(HistoryJob job, long now) => new(job.Id, job.Location, job.State, job.Statement, job.Created, DurationOf(job, now), job.Processed, job.Billed,
        job.SlotMs, job.CacheHit, job.Sql, job.ErrorMessage is null ? null : Clip((job.ErrorReason is null ? "" : job.ErrorReason + ": ") + job.ErrorMessage, ErrorChars), job.Hidden);

    /// <summary>How long a job ran: start to end, or to now while it runs; null before it starts.</summary>
    public static long? DurationOf(HistoryJob job, long now) => job.Started is { } start ? Math.Max(0, (job.Ended ?? (job.Open ? now : start)) - start) : null;

    /// <summary>BigQuery's states are PENDING, RUNNING and DONE; a DONE job's error makes it failed or, reason stopped without a
    /// timeout, cancelled.</summary>
    /// <summary>A DONE job's error that means it was cancelled: reason stopped, without a timeout.</summary>
    internal static bool Cancelled(string? reason, string? message) => reason == "stopped" && message?.Contains("timed out", StringComparison.OrdinalIgnoreCase) != true;

    static string StateOf(JsonElement item, JsonElement? error)
    {
        var raw = Text(item, "state") ?? (Member(item, "status") is { } status ? Text(status, "state") : null);
        if (raw == "PENDING") return "pending";
        if (raw == "RUNNING") return "running";
        if (error is not { } e) return "done";
        return Cancelled(Text(e, "reason"), Text(e, "message")) ? "cancelled" : "failed";
    }

    static JsonElement? ErrorOf(JsonElement item) => Member(item, "errorResult") ?? (Member(item, "status") is { } status ? Member(status, "errorResult") : null);

    static string TypeOf(JsonElement? configuration, JsonElement? statistics)
    {
        var declared = configuration is { } c ? Text(c, "jobType") : null;
        if (declared is "QUERY" or "LOAD" or "EXTRACT" or "COPY") return declared.ToLowerInvariant();
        foreach (var type in Types)
            if (configuration is { } config && Member(config, type) is not null || statistics is { } stats && Member(stats, type) is not null) return type;
        return "other";
    }

    static string? StatementOf(JsonElement? query) => Text(query, "statementType") is { } type && IsStatement(type) ? type : null;

    static string? User(JsonElement item)
    {
        var email = Text(item, "user_email");
        return email is { Length: > 0 and <= 320 } && !email.Any(char.IsControl) ? email : null;
    }

    static bool IsVaria(JsonElement? configuration) => configuration is { } c && Member(c, "labels") is { } labels && Text(labels, "varia_client") == "varia";

    static string? Reason(JsonElement error) => Text(error, "reason") is { Length: > 0 and <= 64 } reason && reason.All(char.IsAsciiLetterOrDigit) ? reason : null;

    /// <summary>The table a job writes: a query's named destination (not the anonymous result table BigQuery creates in a hidden
    /// dataset), a load's or copy's destination, or an extract's first URI.</summary>
    static string? Destination(JsonElement? configuration)
    {
        if (configuration is not { } config) return null;
        foreach (var kind in new[] { "query", "load", "copy" })
            if (Member(config, kind) is { } part && Member(part, "destinationTable") is { } table && Table(table, table: true) is { } name)
                return kind == "query" && Text(table, "datasetId")?.StartsWith('_') == true ? null : name;
        if (Member(config, "extract") is { } extract && extract.TryGetProperty("destinationUris", out var uris) && uris.ValueKind == JsonValueKind.Array && uris.GetArrayLength() > 0
            && uris[0].ValueKind == JsonValueKind.String) return Clip(uris[0].GetString(), 2048);
        return null;
    }

    static string? Table(JsonElement reference, bool table)
    {
        var project = Text(reference, "projectId");
        var dataset = Text(reference, "datasetId");
        var name = table ? Text(reference, "tableId") : "";
        if (project is null || dataset is null || name is null) return null;
        return Clip(project + "." + dataset + (table ? "." + name : ""), 2048);
    }

    /// <summary>The grid's one-line SQL preview: whitespace runs as one space, cut at <see cref="PreviewChars"/> characters with
    /// an ellipsis, never a lone surrogate. Reads only as much of the text as the preview needs.</summary>
    public static string Preview(string sql)
    {
        var builder = new StringBuilder(Math.Min(sql.Length, PreviewChars + 1));
        var space = false;
        foreach (var c in sql)
        {
            if (char.IsWhiteSpace(c) || char.IsControl(c)) { space = builder.Length > 0; continue; }
            if (space) { builder.Append(' '); space = false; }
            builder.Append(c);
            if (builder.Length > PreviewChars) break;
        }
        if (builder.Length <= PreviewChars) return builder.ToString();
        var cut = PreviewChars - 1;
        if (char.IsHighSurrogate(builder[cut - 1])) cut--;
        return builder.ToString(0, cut) + "…";
    }

    internal static string? Clip(string? text, int max) => text is null ? null : text.Length <= max ? text : text[..(char.IsHighSurrogate(text[max - 2]) ? max - 2 : max - 1)] + "…";

    internal static JsonElement? Member(JsonElement? element, string name) => element is { ValueKind: JsonValueKind.Object } e && e.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Object ? value : null;

    internal static string? Text(JsonElement? element, string name) => element is { ValueKind: JsonValueKind.Object } e && e.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;

    static bool? Bool(JsonElement? element, string name) => element is { ValueKind: JsonValueKind.Object } e && e.TryGetProperty(name, out var value)
        ? value.ValueKind switch { JsonValueKind.True => true, JsonValueKind.False => false, _ => null } : null;

    /// <summary>A count BigQuery writes as an int64 string (or a number), within JavaScript's safe integers; null otherwise.</summary>
    internal static long? Number(JsonElement? element, string name)
    {
        if (element is not { ValueKind: JsonValueKind.Object } e || !e.TryGetProperty(name, out var value)) return null;
        long number;
        if (value.ValueKind == JsonValueKind.String && long.TryParse(value.GetString(), NumberStyles.None, CultureInfo.InvariantCulture, out number)
            || value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out number))
            return number >= 0 && number <= BigQueryLimits.MaxSafeInteger ? number : null;
        return null;
    }
}
