using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using System.Web;
using Varia.Backend.BigQuery;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>
/// BigQuery execution offline (docs/bigquery.md, Execution): query.execute against a scripted BigQuery (<see cref="Jobs"/>,
/// on <see cref="BigQueryFake"/>) in the shapes Google documents for jobs.insert, jobs.getQueryResults and jobs.get. The
/// insert's body and client job id, polling, paging, the converter for every type, truncation by the row limit, the budget
/// and the cell caps, read errors, each error row, the lookup after a network failure and the 409 path, statistics and
/// cost text. No request leaves the process.
/// </summary>
internal static partial class BigQueryExecutionChecks
{
    static readonly JsonSerializerOptions Wire = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull, UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow
    };
    const string Base = "http://localhost:9050/bigquery/v2/projects/varia-emulator";

    /// <summary>A scripted BigQuery: one query job at a time, its schema and rows, how many polls it takes, and how it fails.</summary>
    sealed class Jobs
    {
        public JsonNode? Schema;
        public List<JsonNode> Rows = [];
        /// <summary>The most rows one page answers, whatever maxResults asks (BigQuery's own ~10 MB cut).</summary>
        public int PageCap = int.MaxValue;
        /// <summary>Serializes each page's rows once and reuses the text (the read bench: building the page's JSON again for
        /// every read would time the fake, not Varia).</summary>
        public bool CacheRows;
        private readonly System.Collections.Concurrent.ConcurrentDictionary<(int Offset, int Count), string> cachedRows = new();
        public int PollsBeforeDone;
        public string StatementType = "SELECT";
        /// <summary>A script (statementType SCRIPT) whose one SELECT child, child_1, answers these rows: jobs.list names it.</summary>
        public bool ScriptChild;
        /// <summary>With <see cref="ScriptChild"/>, how many SELECT children the script has (child_1, child_2, …), each answering
        /// these rows.</summary>
        public int ScriptChildren = 1;
        bool IsChild(string id) => id == ChildId || ScriptChild && id.StartsWith("child_", StringComparison.Ordinal) && int.TryParse(id[6..], out var n) && n >= 1 && n <= ScriptChildren;
        /// <summary>The script child's statement type and statistics, as jobs.list and jobs.get answer them.</summary>
        public string ChildStatementType = "SELECT";
        public JsonNode? ChildStatistics;
        /// <summary>Whether jobs.list carries the child's DDL target; off, only its own jobs.get does.</summary>
        public bool ListChildTarget = true;
        /// <summary>The script child's own statement, as jobs.get answers it (configuration.query.query); set, the child is
        /// known to jobs.get even once ScriptChild is off.</summary>
        public string? ChildQuery;
        /// <summary>Each inserted job's configuration.query, which jobs.get answers back (its query text and default dataset).</summary>
        readonly ConcurrentDictionary<string, JsonNode> insertedQueries = new();
        public long? DmlAffected;
        public string? DdlOperation;
        public JsonNode? Statistics;
        /// <summary>The job's errorResult: at insert (status DONE in the insert's answer) or after it runs (getQueryResults 400).</summary>
        public JsonNode? Failure;
        public bool FailsAtInsert;
        /// <summary>Answers each insert, in order, before the normal one: a status and body, or null to throw a network failure.</summary>
        public Queue<(int Status, string Body)?> InsertReplies = new();
        /// <summary>Holds getQueryResults until the request is cancelled.</summary>
        public bool Hang;
        /// <summary>Holds jobs.insert until the request is cancelled, while BigQuery goes on creating the job: the first
        /// jobs.cancel about it answers 404 (not created yet, <see cref="MissedCancels"/>), later ones find it.</summary>
        public volatile bool HangInsert;
        public readonly ConcurrentDictionary<string, bool> Unborn = new();
        public readonly ConcurrentQueue<string> MissedCancels = new();
        /// <summary>Holds only the later pages (a finished job's rows still loading).</summary>
        public bool HangPages;
        /// <summary>Holds tabledata.list (a windowed result's block reads) until the request is cancelled.</summary>
        public volatile bool HangTable;
        /// <summary>Refuses the later pages (403 accessDenied): a read that fails part way.</summary>
        public bool DenyPages;
        /// <summary>Replaces the next page's token (one Varia cannot send back).</summary>
        public string? Token;
        public string? Location;
        /// <summary>The job's destination table (configuration.query.destinationTable), and what tables.get says of it.</summary>
        public JsonObject? Destination;
        public long? TableBytes;
        /// <summary>tables.get's type (TABLE, VIEW, ...); none, as the emulator, when null.</summary>
        public string? TableType;
        public readonly ConcurrentQueue<string> InsertedIds = new();
        public readonly ConcurrentQueue<JsonNode> InsertBodies = new();
        public readonly ConcurrentQueue<Uri> Reads = new();
        public readonly ConcurrentQueue<string> Cancels = new();
        public readonly HashSet<string> Created = [];
        /// <summary>Set when a held getQueryResults arrives: the query is running.</summary>
        public TaskCompletionSource Polling = new(TaskCreationOptions.RunContinuationsAsynchronously);
        int polls;
        public const string ChildId = "child_1";

        public BigQueryFake Fake()
        {
            var fake = new BigQueryFake();
            fake.Hang = request =>
            {
                if (HangTable && request.Url.EndsWith("/data", StringComparison.Ordinal)) { Polling.TrySetResult(); return true; }
                if (HangInsert && request.Method == "POST" && request.Url == Base + "/jobs" && JsonNode.Parse(request.Body)?["jobReference"]?["jobId"]?.GetValue<string>() is { } unborn)
                {
                    Unborn[unborn] = true;
                    Polling.TrySetResult();
                    return true;
                }
                if (!request.Url.Contains("/queries/", StringComparison.Ordinal) || !(Hang || HangPages && request.Uri.Query.Contains("pageToken=", StringComparison.Ordinal))) return false;
                Polling.TrySetResult();
                return true;
            };
            // Connect reads the connection's dataset.
            fake.On("GET", Base + "/datasets/varia_fixture", new BigQueryFake.Reply(200, "{\"datasetReference\":{\"projectId\":\"varia-emulator\",\"datasetId\":\"varia_fixture\"}}"));
            fake.On("POST", Base + "/jobs", Insert);
            fake.On("GET", Base + "/queries/[^/]+", Results);
            fake.On("GET", Base + "/jobs/[^/]+", Get);
            // A script's children, listed between polls: these jobs have none.
            fake.On("GET", Base + "/jobs", request => !ScriptChild || HttpUtility.ParseQueryString(request.Uri.Query)["parentJobId"] is not { } parent
                ? new(200, "{\"kind\":\"bigquery#jobList\"}")
                : new(200, new JsonObject
                {
                    ["kind"] = "bigquery#jobList",
                    ["jobs"] = new JsonArray([.. Enumerable.Range(1, ScriptChildren).Select(n => (JsonNode)new JsonObject
                    {
                        ["jobReference"] = Reference("child_" + n), ["state"] = "DONE", ["status"] = new JsonObject { ["state"] = "DONE" },
                        ["statistics"] = ListedChildStatistics(parent, n),
                    })]),
                }.ToJsonString()));
            // Stop's jobs.cancel, best-effort.
            fake.On("POST", Base + "/jobs/[^/]+/cancel", request =>
            {
                var id = request.Url.Split('/')[^2];
                if (Unborn.TryRemove(id, out _)) { MissedCancels.Enqueue(id); return BigQueryFake.Fixture("error-not-found", 404); }
                Cancels.Enqueue(id);
                return new(200, "{\"kind\":\"bigquery#jobCancelResponse\"}");
            });
            fake.On("GET", Base + "/datasets/[^/]+/tables/[^/]+", Table);
            fake.On("GET", Base + "/datasets/[^/]+/tables/[^/]+/data", TableData);
            return fake;
        }

        /// <summary>What tabledata.list answers instead of rows: 404 (the result table expired), or a status for each of the
        /// next reads in order (429 rateLimitExceeded).</summary>
        public int TableDataStatus;
        public Queue<int> TableDataReplies = new();
        /// <summary>Holds each tabledata.list until it is set or the request is cancelled.</summary>
        public TaskCompletionSource? TableDataGate;
        /// <summary>The totalRows BigQuery reports, when it is not the rows the fake has (the row cap).</summary>
        public long? ReportedTotal;
        public readonly ConcurrentQueue<(long? StartIndex, int MaxResults, string? PageToken)> TableReads = new();

        BigQueryFake.Reply TableData(BigQueryFake.Request request)
        {
            var parameters = HttpUtility.ParseQueryString(request.Uri.Query);
            long? start = parameters["startIndex"] is { } given ? long.Parse(given, System.Globalization.CultureInfo.InvariantCulture) : null;
            var asked = int.Parse(parameters["maxResults"] ?? "100000", System.Globalization.CultureInfo.InvariantCulture);
            var token = parameters["pageToken"];
            TableReads.Enqueue((start, asked, token));
            TableDataGate?.Task.Wait(TimeSpan.FromSeconds(30));
            int status;
            lock (TableDataReplies) status = TableDataReplies.TryDequeue(out var next) ? next : TableDataStatus;
            if (status == 404) return BigQueryFake.Fixture("error-not-found", 404);
            if (status == 429)
                return new(429, "{\"error\":{\"code\":429,\"message\":\"Exceeded rate limits.\",\"errors\":[{\"reason\":\"rateLimitExceeded\",\"message\":\"Exceeded rate limits.\"}]}}");
            var offset = token is not null ? int.Parse(token[5..], System.Globalization.CultureInfo.InvariantCulture) : (int)(start ?? 0);
            var count = Math.Max(0, Math.Min(Math.Min(asked, PageCap), Rows.Count - offset));
            var answer = new JsonObject { ["kind"] = "bigquery#tableDataList", ["totalRows"] = (ReportedTotal ?? Rows.Count).ToString(System.Globalization.CultureInfo.InvariantCulture), ["rows"] = PageRows(offset, count) };
            if (offset + count < Rows.Count) answer["pageToken"] = "page-" + (offset + count).ToString(System.Globalization.CultureInfo.InvariantCulture);
            return new(200, answer.ToJsonString());
        }

        BigQueryFake.Reply Insert(BigQueryFake.Request request)
        {
            var body = JsonNode.Parse(request.Body)!;
            var id = body["jobReference"]?["jobId"]?.GetValue<string>() ?? "";
            InsertBodies.Enqueue(body);
            InsertedIds.Enqueue(id);
            if (body["configuration"]?["query"] is { } inserted) insertedQueries[id] = inserted.DeepClone();
            if (InsertReplies.TryDequeue(out var reply))
            {
                if (reply is null) throw new HttpRequestException("The connection was reset.");
                if (reply.Value.Status >= 500) lock (Created) Created.Add(id);
                return new(reply.Value.Status, reply.Value.Body);
            }
            lock (Created) Created.Add(id);
            return new(200, Job(id, FailsAtInsert ? "DONE" : "RUNNING", FailsAtInsert ? Failure : null, null).ToJsonString());
        }

        BigQueryFake.Reply Table(BigQueryFake.Request request)
        {
            var table = new JsonObject { ["kind"] = "bigquery#table", ["tableReference"] = Destination?.DeepClone(), ["numRows"] = Rows.Count.ToString(System.Globalization.CultureInfo.InvariantCulture) };
            if (TableBytes is { } bytes) table["numBytes"] = bytes.ToString(System.Globalization.CultureInfo.InvariantCulture);
            if (TableType is not null) table["type"] = TableType;
            // An expired table is gone from tables.get as from tabledata.list.
            return Destination is null || TableDataStatus == 404 ? BigQueryFake.Fixture("error-not-found", 404) : new(200, table.ToJsonString());
        }

        JsonObject Job(string id, string state, JsonNode? error, JsonNode? statistics)
        {
            var status = new JsonObject { ["state"] = state };
            if (error is not null) { status["errorResult"] = error.DeepClone(); status["errors"] = new JsonArray(error.DeepClone()); }
            var job = new JsonObject
            {
                ["kind"] = "bigquery#job", ["id"] = "varia-emulator:" + (Location is null ? "" : Location + ".") + id,
                ["jobReference"] = Reference(id), ["status"] = status,
                ["configuration"] = new JsonObject { ["jobType"] = "QUERY", ["query"] = new JsonObject { ["useLegacySql"] = false } }
            };
            if (Destination is not null) job["configuration"]!["query"]!["destinationTable"] = Destination.DeepClone();
            if (statistics is not null) job["statistics"] = statistics.DeepClone();
            return job;
        }

        JsonObject Reference(string id)
        {
            var reference = new JsonObject { ["projectId"] = "varia-emulator", ["jobId"] = id };
            if (Location is not null) reference["location"] = Location;
            return reference;
        }

        string Id(BigQueryFake.Request request) => request.Url[(request.Url.LastIndexOf('/') + 1)..];

        /// <summary>The script child's statistics as jobs.list (full projection) gives them: ChildStatistics' query, with its statement type.</summary>
        JsonObject ListedChildStatistics(string parent, int n = 1)
        {
            var query = (ListChildTarget ? ChildStatistics?["query"]?.DeepClone().AsObject() : null) ?? new JsonObject();
            query["statementType"] = ChildStatementType;
            return new JsonObject { ["creationTime"] = n.ToString(System.Globalization.CultureInfo.InvariantCulture), ["parentJobId"] = parent, ["query"] = query };
        }

        public BigQueryFake.Reply Get(BigQueryFake.Request request)
        {
            var id = Id(request);
            bool known;
            lock (Created) known = Created.Contains(id) || (ScriptChild || ChildQuery is not null) && IsChild(id);
            if (!known) return BigQueryFake.Fixture("error-not-found", 404);
            var child = ScriptChild && IsChild(id);
            var query = new JsonObject { ["statementType"] = child ? ChildStatementType : StatementType };
            if (DmlAffected is { } dml) query["numDmlAffectedRows"] = dml.ToString(System.Globalization.CultureInfo.InvariantCulture);
            if (DdlOperation is not null) query["ddlOperationPerformed"] = DdlOperation;
            var statistics = (child ? ChildStatistics : Statistics)?.DeepClone().AsObject() ?? new JsonObject();
            if (statistics["query"] is JsonObject given) foreach (var (name, value) in query) given[name] ??= value?.DeepClone();
            else statistics["query"] = query;
            var job = Job(id, "DONE", Failure, statistics);
            var configuration = job["configuration"]!["query"]!;
            if (id == ChildId && ChildQuery is not null) configuration["query"] = ChildQuery;
            else if (insertedQueries.TryGetValue(id, out var inserted))
            {
                if (inserted["query"] is { } text) configuration["query"] = text.DeepClone();
                if (inserted["defaultDataset"] is { } dataset) configuration["defaultDataset"] = dataset.DeepClone();
            }
            return new(200, job.ToJsonString());
        }

        BigQueryFake.Reply Results(BigQueryFake.Request request)
        {
            Reads.Enqueue(request.Uri);
            var id = Id(request);
            var parameters = HttpUtility.ParseQueryString(request.Uri.Query);
            if (Failure is not null)
                return new(400, new JsonObject { ["error"] = new JsonObject { ["code"] = 400, ["message"] = Failure["message"]?.DeepClone(), ["errors"] = new JsonArray(Failure.DeepClone()) } }.ToJsonString());
            if (DenyPages && parameters["pageToken"] is not null) return BigQueryFake.Fixture("error-access-denied", 403);
            if (Interlocked.Increment(ref polls) <= PollsBeforeDone)
                return new(200, new JsonObject { ["kind"] = "bigquery#getQueryResultsResponse", ["jobReference"] = Reference(id), ["jobComplete"] = false }.ToJsonString());
            var offset = parameters["pageToken"] is { } token ? int.Parse(token[5..], System.Globalization.CultureInfo.InvariantCulture) : 0;
            var asked = int.Parse(parameters["maxResults"] ?? "100000", System.Globalization.CultureInfo.InvariantCulture);
            var count = Math.Max(0, Math.Min(Math.Min(asked, PageCap), Rows.Count - offset));
            var answer = new JsonObject
            {
                ["kind"] = "bigquery#getQueryResultsResponse", ["etag"] = "\"example\"", ["jobReference"] = Reference(id), ["jobComplete"] = true,
                ["totalBytesProcessed"] = "0", ["cacheHit"] = false
            };
            if (Schema is not null)
            {
                answer["schema"] = Schema.DeepClone();
                // BigQuery leaves out rows and totalRows when a query returns none.
                if (Rows.Count > 0)
                {
                    answer["totalRows"] = (ReportedTotal ?? Rows.Count).ToString(System.Globalization.CultureInfo.InvariantCulture);
                    if (!CacheRows) answer["rows"] = PageRows(offset, count);
                }
                if (offset + count < Rows.Count) answer["pageToken"] = Token ?? "page-" + (offset + count).ToString(System.Globalization.CultureInfo.InvariantCulture);
            }
            if (DmlAffected is { } dml) answer["numDmlAffectedRows"] = dml.ToString(System.Globalization.CultureInfo.InvariantCulture);
            var text = answer.ToJsonString();
            if (CacheRows && Schema is not null && Rows.Count > 0)
                text = string.Concat(text.AsSpan(0, text.Length - 1), ",\"rows\":", cachedRows.GetOrAdd((offset, count), key => PageRows(key.Offset, key.Count).ToJsonString()), "}");
            return new(200, text);
        }

        JsonArray PageRows(int offset, int count) => new([.. Rows.Skip(offset).Take(count).Select(row => row.DeepClone())]);
    }

    sealed class Harness : IDisposable
    {
        public Jobs Jobs { get; }
        public BigQueryFake Fake { get; }
        public SqlService Service { get; }
        public string ConnectionId { get; private set; } = "";

        public Harness(Jobs jobs, ResultStore? store = null, IBigQueryStorageRead? storage = null, Func<BigQueryEnvironment, BigQueryEnvironment>? environment = null)
        {
            Jobs = jobs;
            Fake = jobs.Fake();
            var settings = new BigQueryEnvironment(new Uri("http://localhost:9050/"), Fake.Factory, new SubjectTokens([]), Storage: storage is null ? null : _ => storage);
            Service = new SqlService(store: store ?? CheckStores.Unprobed(), bigQuery: environment is null ? settings : environment(settings));
            Service.BigQuery.RetryDelay = TimeSpan.FromMilliseconds(1);
            Service.BigQuery.ChildPollMs = 50;
        }

        public async Task ConnectAsync(Action<JsonObject>? change = null)
        {
            var options = new JsonObject
            {
                ["provider"] = "bigquery", ["project"] = "varia-emulator", ["authentication"] = "gcloud", ["dataset"] = "varia_fixture",
                ["credential"] = new JsonObject { ["source"] = "anonymous" }
            };
            change?.Invoke(options);
            var (code, result, message) = await Call("connections.connect", options);
            if (code != "ok") throw new InvalidOperationException("connect: " + code + " " + message);
            ConnectionId = ((ConnectionInfo)result!).Id;
        }

        public async Task<(string Code, object? Result, string Message)> Call(string method, JsonNode parameters)
        {
            using var document = JsonDocument.Parse(parameters.ToJsonString());
            try { return ("ok", await Service.DispatchAsync(method, document.RootElement.Clone(), Wire), ""); }
            catch (RequestException error) { return (error.Code, null, error.Message); }
        }

        public JsonObject Query(string sql, Action<JsonObject>? change = null)
        {
            var args = new JsonObject
            {
                ["connectionId"] = ConnectionId, ["sessionId"] = Guid.NewGuid().ToString(), ["queryId"] = Guid.NewGuid().ToString(), ["sql"] = sql,
                ["maxRows"] = 0, ["timeoutSeconds"] = 0
            };
            change?.Invoke(args);
            return args;
        }

        public async Task<(string Code, QueryResult? Result, string Message)> Execute(string sql, Action<JsonObject>? change = null)
        {
            var (code, result, message) = await Call("query.execute", Query(sql, change));
            return (code, result as QueryResult, message);
        }

        public List<PageCell[]> Rows(ResultDescriptor descriptor)
        {
            var set = Service.Results.Find(descriptor.ResultId) ?? throw new InvalidOperationException("The result is not stored.");
            return [.. set.SealedSnapshot().SelectMany(page => PageReader.Read(PinnedPage.Body(page), set.Wires).Rows)];
        }

        public void Dispose() => Service.Dispose();
    }

    static JsonObject Field(string name, string type, string mode = "NULLABLE", JsonArray? fields = null, Action<JsonObject>? change = null)
    {
        var field = new JsonObject { ["name"] = name, ["type"] = type, ["mode"] = mode };
        if (fields is not null) field["fields"] = fields;
        change?.Invoke(field);
        return field;
    }

    static JsonObject Schema(params JsonObject[] fields) => new() { ["fields"] = new JsonArray(fields) };
    static JsonObject Row(params JsonNode?[] values) => new() { ["f"] = new JsonArray([.. values.Select(value => (JsonNode)new JsonObject { ["v"] = value })]) };
    static JsonObject Error(string reason, string message) => new() { ["reason"] = reason, ["location"] = "query", ["message"] = message };
    static string Texts(IEnumerable<MessageEntry> messages) => string.Join(" | ", messages.Select(message => message.Text));
    static bool Says(QueryResult? result, string text) => result?.Messages.Any(message => message.Text.Contains(text, StringComparison.Ordinal)) == true;

    public static async Task RunAsync(Action<bool, string> check)
    {
        await RunCoreAsync(check);
        await RunResidenceAsync(check);
        await RunViewsCopySaveAsync(check);
        await RunStorageAsync(check);
    }

    public static async Task RunCoreAsync(Action<bool, string> check)
    {
        Trace("References");
        References(check);
        Trace("CostText");
        CostText(check);
        Trace("Converter");
        Converter(check);
        Trace("BooleanResults");
        BooleanResults(check);
        Trace("JobErrors");
        JobErrors(check);
        Trace("InsertAsync");
        await InsertAsync(check);
        Trace("PollAndPageAsync");
        await PollAndPageAsync(check);
        Trace("TruncationAsync");
        await TruncationAsync(check);
        Trace("FailuresAsync");
        await FailuresAsync(check);
        Trace("RetriesAsync");
        await RetriesAsync(check);
        Trace("StatementsAsync");
        await StatementsAsync(check);
        Trace("IndexMarksAsync");
        await IndexMarksAsync(check);
        Trace("RefusalsAsync");
        await RefusalsAsync(check);
        Trace("EdgesAsync");
        await EdgesAsync(check);
        Trace("CancelAsync");
        await CancelAsync(check);
    }

    public static Task RunStorageAsync(Action<bool, string> check) => StorageReadAsync(check);

    /// <summary>VARIA_TRACE_CHECKS=1 names each section on stderr, to find a section that hangs.</summary>
    static void Trace(string section) { if (Environment.GetEnvironmentVariable("VARIA_TRACE_CHECKS") == "1") Console.Error.WriteLine("BigQueryExecution: " + section); }

    /// <summary>tests/fixtures/bigquery/cost.json: the backend writes bytes and dollars as src/shared/bigquery/cost.ts does.</summary>
    static void CostText(Action<bool, string> check)
    {
        using var fixture = JsonDocument.Parse(File.ReadAllText(Path.Combine(GoldenText.Repository(), "tests", "fixtures", "bigquery", "cost.json")));
        var differences = new List<string>();
        var cases = 0;
        foreach (var item in fixture.RootElement.GetProperty("cases").EnumerateArray())
        {
            cases++;
            var bytes = item.GetProperty("bytes").GetInt64();
            var (text, dollars) = (BigQueryCost.Bytes(bytes), BigQueryCost.Dollars(bytes));
            if (text != item.GetProperty("text").GetString() || dollars != item.GetProperty("dollars").GetString()) differences.Add(bytes + ": " + text + " " + dollars);
        }
        check(cases > 10 && differences.Count == 0, "BigQuery byte and price text matches tests/fixtures/bigquery/cost.json: " + string.Join(", ", differences));
        check(BigQueryCost.SlotTime(250) == "250 ms" && BigQueryCost.SlotTime(1250) == "1.3 s" && BigQueryCost.SlotTime(184_000) == "3 min 4 s" && BigQueryCost.SlotTime(7_500_000) == "2 h 5 min"
            && BigQueryCost.Bytes(-5) == "0 B" && BigQueryCost.Dollars(-5) == "$0.00",
            "slot time reads in ms, s, min and h, and nothing negative is shown");
        var line = BigQueryCost.Summary(new BigQueryJobSummary("p", "j", "US", "SELECT", 1331439862, 1331691520, false, 1250));
        check(line == "Bytes processed: 1.24 GiB (< $0.01) · Bytes billed: 1.24 GiB (< $0.01) · Slot time: 1.3 s · Cache hit: no · Prices are on-demand estimates at $6.25 per TiB."
            && BigQueryCost.Summary(new BigQueryJobSummary("p", "j")) is null && BigQueryCost.Summary(new BigQueryJobSummary("p", "j", CacheHit: true)) == "Cache hit: yes",
            "the Messages cost line names each figure BigQuery reported, priced, and nothing when it reported none: " + line);
    }

    /// <summary>BOOL cells hold the words false and true, which every result tool reads as SQL Server's bit 0 and 1: sort,
    /// filters, Pivot's groups and extremes, profiles and Save Results As. NULL stays a value of its own.</summary>
    private static void BooleanResults(Action<bool, string> check)
    {
        var plan = BigQueryColumnPlan.From(JsonSerializer.SerializeToElement(Schema(Field("flag", "BOOL"))))!;
        var store = new ResultStore(1L << 27, 1L << 26);
        var set = store.Open(store.BeginQuery("bool"), 0, 1, 1, "rows", plan.Columns, plan.Wires)!;
        // Rows 0 to 3: true, false, true, NULL.
        foreach (var value in new JsonNode?[] { "true", "false", "true", null })
        {
            set.CountRow();
            plan.ReadRow(JsonSerializer.SerializeToElement(Row(value)), set.BeginRow()!, _ => { });
            set.TryCommitRow();
        }
        set.Complete();
        var pages = set.SealedSnapshot();
        var sorted = ViewSorter.Sort(set, pages, [new(0, false, SortMode.Value)], default).Order;
        var profile = ColumnProfiler.Profile(set, pages, null, [0], true, default).Columns[0];
        check(sorted.SequenceEqual([3, 1, 0, 2]) && profile.Min == "false" && profile.Max == "true" && profile.Distinct == 2 && profile.Nulls == 1,
            "BigQuery BOOL sorts and profiles NULL, then false before true: " + string.Join(",", sorted));
        // A Between filter resolves to its low and high ends: false (row 1) then true (row 0), keeping both values but not NULL.
        var between = ViewSorter.Build(set, pages, [], [new ViewFilter(FilterOp.Between, 0, [0, 1], false, null, [])], default);
        check(between.Order.SequenceEqual([0, 1, 2]) && between.Filters[0].Rows is [1, 0],
            "a Between filter over BigQuery BOOL runs from false to true: " + string.Join(",", between.Filters[0].Rows ?? []));
        var model = ResultPivoter.Build(set, pages, null, new PivotSpec([0], -1, [new(PivotAggregate.Min, 0), new(PivotAggregate.Max, 0)]), default, _ => true);
        var whole = ResultPivoter.Build(set, pages, null, new PivotSpec([], -1, [new(PivotAggregate.Min, 0), new(PivotAggregate.Max, 0)]), default, _ => true);
        check(model.RowReps.SequenceEqual([3, 1, 0]) && whole.Figures[0].Best[0] == 1 && whole.Figures[1].Best[0] is 0 or 2,
            "Pivot groups BigQuery BOOL as NULL, false, true and its Min is false and Max true: " + string.Join(",", model.RowReps));
        var output = new System.Buffers.ArrayBufferWriter<byte>();
        var writer = new ResultTextWriter(output, TextOptions.Export(TextFormat.Json, false, "empty"), set.Columns);
        writer.Begin();
        using var pin = set.Pin();
        foreach (var page in pages)
        {
            var view = PageView.Parse(page.Body(), 1);
            for (var r = 0; r < view.Rows; r++) writer.Row(view, r, [0]);
        }
        writer.End();
        using var saved = JsonDocument.Parse(output.WrittenMemory);
        var kinds = string.Join(",", saved.RootElement.EnumerateArray().Select(row => row.GetProperty("flag").ValueKind));
        check(kinds == "True,False,True,Null", "Save Results As writes BigQuery BOOL cells as JSON booleans and NULL as null: " + kinds);
    }

    /// <summary>The REST converter for every type straight into a page, as the result store reads it.</summary>
    static void Converter(Action<bool, string> check)
    {
        var plan = BigQueryColumnPlan.From(JsonSerializer.SerializeToElement(TypesSchema()))!;
        var builder = new PageBuilder(1, plan.Wires);
        var warnings = new List<string>();
        foreach (var row in TypesRows())
        {
            builder.BeginRow();
            plan.ReadRow(JsonSerializer.SerializeToElement(row), builder, warnings.Add);
            builder.CommitRow();
        }
        var body = builder.Seal(out var lengths);
        var rows = PageReader.Read(body, plan.Wires).Rows;
        var expected = TypesExpected();
        var differences = new List<string>();
        for (var r = 0; r < expected.Length; r++)
            for (var c = 0; c < expected[r].Length; c++)
                if (rows[r][c].Text != expected[r][c]) differences.Add(plan.Columns[c].Name + "[" + r + "]: ‘" + rows[r][c].Text + "’");
        check(rows.Length == expected.Length && differences.Count == 0 && warnings.Count == 0, "the REST converter writes every BigQuery type as Varia shows it: " + string.Join(", ", differences) + string.Join("; ", warnings));
        check(rows[^1].All(cell => cell.Flags == PageReader.Null), "a row of nulls is NULL in every column, with no read-error flag");
        var types = string.Join(",", plan.Columns.Select(column => column.DataType));
        check(types == "INT64,FLOAT64,NUMERIC(10, 2),BIGNUMERIC,BOOL,STRING(20),BYTES,DATE,TIME,DATETIME,TIMESTAMP,INTERVAL,RANGE<DATE>,RANGE<TIMESTAMP>,GEOGRAPHY,JSON,STRUCT<a INT64, b ARRAY<STRING>>,ARRAY<INT64>,ARRAY<STRUCT<x FLOAT64, t TIMESTAMP>>",
            "column types read as GoogleSQL writes them, from the legacy names REST reports: " + types);
        var sorts = string.Join(",", plan.Columns.Select(column => column.SortKind));
        check(sorts == "integer,float,decimal,decimal,boolean,text,binary,date,time,datetime,timestamp,other,other,other,other,json,json,json,json", "each type sorts by its kind: " + sorts);
        check(plan.Wires[6] == WireKind.Binary && plan.Wires.Count(wire => wire == WireKind.Binary) == 1 && plan.Columns[15].Role == "json" && plan.Columns[16].Role == "json" && plan.Columns[17].Role == "json"
            && plan.Columns[0].Nullable && !plan.Columns[1].Nullable && !plan.Columns[17].Nullable,
            "BYTES is binary on the wire, JSON, STRUCT and ARRAY are documents, and REQUIRED and REPEATED columns are not nullable");
        // Every cell's recorded bytes follow its column's rule: the row size bar reads them back from the text.
        var mismatched = new List<string>();
        for (var r = 0; r < rows.Length; r++)
        {
            long derivedRow = 0;
            for (var c = 0; c < plan.Columns.Count; c++)
            {
                if (rows[r][c].Text is not { } text) continue;
                var stored = plan.Wires[c] == WireKind.Binary ? Convert.FromHexString(text[2..]) : Encoding.UTF8.GetBytes(text);
                var derived = plan.Lengths[c].Derive(stored, plan.Wires[c]);
                if (!derived.Exact || lengths.TryCell(r, c, out _)) mismatched.Add(plan.Columns[c].Name + "[" + r + "]");
                derivedRow += derived.Bytes;
            }
            if (lengths.RowBytes(r) != derivedRow) mismatched.Add("row " + r + ": " + lengths.RowBytes(r) + " recorded, " + derivedRow + " derived");
        }
        check(mismatched.Count == 0 && lengths.RowBytes(0) > 0 && plan.Lengths[0].Rule == LengthRule.Fixed && plan.Lengths[0].FixedBytes == 8 && plan.Lengths[2].FixedBytes == 16 && plan.Lengths[4].FixedBytes == 1,
            "each cell's bytes are BigQuery's logical size for fixed types and the text's or value's own for the rest, as the row size bar derives them: " + string.Join(", ", mismatched));

        // Values that cannot be read: NULL with the read-error flag, one message a column, and the rest of the row read.
        var bad = BigQueryColumnPlan.From(JsonSerializer.SerializeToElement(Schema(Field("n", "INTEGER"), Field("f", "FLOAT"), Field("b", "BOOLEAN"), Field("t", "TIMESTAMP"), Field("y", "BYTES"), Field("d", "NUMERIC"), Field("ok", "STRING"))))!;
        builder = new PageBuilder(2, bad.Wires);
        warnings.Clear();
        foreach (var row in new[] { Row("12x", "fast", "yes", "999999999999999999", "@@@", "1.2.3", "fine"), Row("99999999999999999999", JsonValue.Create(1.5), "true", "-1", "AQI=", "1E+400", "also"), new JsonObject { ["f"] = new JsonArray(new JsonObject { ["v"] = "1" }) } })
        {
            builder.BeginRow();
            bad.ReadRow(JsonSerializer.SerializeToElement(row), builder, warnings.Add);
            builder.CommitRow();
        }
        var read = PageReader.Read(builder.Seal(), bad.Wires).Rows;
        check(read[0].Take(6).All(cell => cell.Flags == (PageReader.Null | PageReader.Error)) && read[0][6].Text == "fine"
            && read[1][0].Flags == (PageReader.Null | PageReader.Error) && read[1][1].Text == "1.5" && read[1][2].Text == "true" && read[1][3].Text == "1969-12-31 23:59:59.999999 UTC" && read[1][4].Text == "0x0102"
            && read[1][5].Flags == (PageReader.Null | PageReader.Error) && read[1][6].Text == "also"
            && read[2][0].Text == "1" && read[2].Skip(1).All(cell => cell.Flags == (PageReader.Null | PageReader.Error))
            && warnings.Count == 7 && warnings[0] == "Column ‘n’ (INT64): some values could not be read and are shown as NULL.",
            "a value that cannot be read is NULL with the read-error flag, a short row's missing cells too, and each column says so once: " + string.Join(" / ", warnings));

        // Cells past the caps SQL Server's reader keeps are stored as prefixes, with their full lengths beside the page.
        var caps = BigQueryColumnPlan.From(JsonSerializer.SerializeToElement(Schema(Field("s", "STRING"), Field("y", "BYTES"), Field("j", "JSON"), Field("e", "STRING"))))!;
        builder = new PageBuilder(3, caps.Wires);
        var longText = new string('é', ColumnPlan.TextCap + 10);
        builder.BeginRow();
        var cut = caps.ReadRow(JsonSerializer.SerializeToElement(Row(longText, Convert.ToBase64String(new byte[ColumnPlan.BinaryCap + 5]), "{\"a\":\"" + new string('x', ColumnPlan.DocumentCap) + "\"}", "tab\there \"quoted\" \\u00e9")), builder, warnings.Add);
        builder.CommitRow();
        var capped = PageReader.Read(builder.Seal(out var capLengths), caps.Wires).Rows[0];
        check(cut == 3 && capped[0].Text!.Length == ColumnPlan.TextCap && (capped[0].Flags & PageReader.Truncated) != 0 && capLengths.TryCell(0, 0, out var textSize) && textSize.Chars == longText.Length && textSize.Bytes == 2L * longText.Length
            && capped[1].Text!.Length == 2 + 2 * ColumnPlan.BinaryCap && (capped[1].Flags & PageReader.Truncated) != 0 && capped[2].Text!.Length == ColumnPlan.DocumentCap
            && capped[3].Text == "tab\there \"quoted\" \\u00e9",
            "STRING, BYTES and JSON past their caps are stored as prefixes flagged truncated, with their full lengths kept, and escaped text is unescaped");

        // A cell the 8 MiB row limit cuts keeps its characters and bytes, counted from text read without copying.
        var many = BigQueryColumnPlan.From(JsonSerializer.SerializeToElement(Schema([.. Enumerable.Range(0, 130).Select(i => Field("c" + i, "STRING"))])))!;
        var accented = new string('é', 32_767);
        using (var wideRow = JsonDocument.Parse("{\"f\":[" + string.Join(",", Enumerable.Repeat("{\"v\":\"" + accented + "\"}", 130)) + "]}"))
        {
            builder = new PageBuilder(4, many.Wires);
            builder.BeginRow();
            many.ReadRow(wideRow.RootElement, builder, warnings.Add);
            builder.CommitRow();
            builder.Seal(out var wideLengths);
            var kept = wideLengths.Cells.ToList();
            check(kept.Count > 0 && kept.All(cell => cell.Chars == accented.Length && cell.Bytes == 2L * accented.Length),
                "a cell the row limit cuts records its characters and bytes, not its bytes twice: " + string.Join(",", kept.Select(cell => cell.Chars + "/" + cell.Bytes).Distinct()));
        }

        // Type text is bounded, and a schema past the descriptor's columns keeps the first ones.
        var deep = Field("leaf", "INTEGER");
        for (var i = 0; i < 14; i++) deep = Field("level_with_a_long_name_" + i, "RECORD", fields: new JsonArray(deep));
        var nested = BigQueryColumnPlan.From(JsonSerializer.SerializeToElement(Schema(deep)))!;
        check(nested.Columns[0].DataType.Length <= 256 && nested.Columns[0].DataType.EndsWith('…') && nested.Columns[0].DataType.StartsWith("STRUCT<level_with_a_long_name_12 STRUCT<", StringComparison.Ordinal),
            "a deep STRUCT's type text is cut at 256 characters: " + nested.Columns[0].DataType);
        var wide = BigQueryColumnPlan.From(JsonSerializer.SerializeToElement(Schema([.. Enumerable.Range(0, PageBuilder.MaxColumns + 4).Select(i => Field("c" + i, "STRING"))])))!;
        check(wide.Columns.Count == PageBuilder.MaxColumns && wide.TruncatedColumns && wide.SchemaColumns == PageBuilder.MaxColumns + 4 && wide.Columns[^1].Name == "c" + (PageBuilder.MaxColumns - 1),
            "a schema of more than 4,096 columns keeps the first 4,096");
        check(BigQueryColumnPlan.From(JsonSerializer.SerializeToElement(new JsonObject())) is null && BigQueryColumnPlan.From(null) is null
            && BigQueryColumnPlan.From(JsonSerializer.SerializeToElement(Schema(Field("x", "SOMETHING_NEW")))) is { } unknown && unknown.Columns[0].DataType == "SOMETHING_NEW" && unknown.Columns[0].SortKind == "other",
            "no schema is no result set, and a type this build does not know reads as BigQuery names it");
        check(BigQueryColumnPlan.CanonicalDecimal("0E5"u8, new byte[256]) == 1 && Canonical("1.50") == "1.5" && Canonical("1E-9") == "0.000000001" && Canonical("-0.0") == "0" && Canonical("+12.3400E2") == "1234"
            && Canonical("123456789012345678901234567890.123456789") == "123456789012345678901234567890.123456789",
            "NUMERIC text is canonical: no exponent, leading or trailing zeros, or negative zero");
    }

    static string Canonical(string text)
    {
        var buffer = new byte[256];
        return Encoding.ASCII.GetString(buffer, 0, BigQueryColumnPlan.CanonicalDecimal(Encoding.ASCII.GetBytes(text), buffer));
    }

    static JsonObject TypesSchema() => Schema(
        Field("i", "INTEGER"), Field("f", "FLOAT", "REQUIRED"), Field("n", "NUMERIC", change: field => { field["precision"] = "10"; field["scale"] = "2"; }), Field("bn", "BIGNUMERIC"), Field("b", "BOOLEAN"),
        Field("s", "STRING", change: field => field["maxLength"] = "20"), Field("y", "BYTES"), Field("d", "DATE"), Field("t", "TIME"), Field("dt", "DATETIME"), Field("ts", "TIMESTAMP"),
        Field("iv", "INTERVAL"), Field("rd", "RANGE", change: field => field["rangeElementType"] = new JsonObject { ["type"] = "DATE" }),
        Field("rt", "RANGE", change: field => field["rangeElementType"] = new JsonObject { ["type"] = "TIMESTAMP" }), Field("g", "GEOGRAPHY"), Field("j", "JSON"),
        Field("st", "RECORD", fields: new JsonArray(Field("a", "INTEGER"), Field("b", "STRING", "REPEATED"))), Field("ai", "INTEGER", "REPEATED"),
        Field("as", "RECORD", "REPEATED", new JsonArray(Field("x", "FLOAT"), Field("t", "TIMESTAMP"))));

    static JsonObject[] TypesRows() =>
    [
        Row("-9223372036854775808", "1.5E20", "12345678.90", "-0.000000000000000000000000000000000000001", "true", "héllo", "3q2+7w==", "2026-11-15", "09:30:00.123456",
            "2026-11-15T09:30:00.5", "1794735000123456", "1-2 3 4:5:6.789", "[2026-01-01, 2026-12-31)", "[1794735000000000, UNBOUNDED)", "POINT(1 2)", "{\"k\":[1,2]}",
            new JsonObject { ["f"] = new JsonArray(new JsonObject { ["v"] = "7" }, new JsonObject { ["v"] = new JsonArray(new JsonObject { ["v"] = "a\"b" }, new JsonObject { ["v"] = null }) }) },
            new JsonArray(new JsonObject { ["v"] = "1" }, new JsonObject { ["v"] = "2" }),
            new JsonArray(new JsonObject { ["v"] = new JsonObject { ["f"] = new JsonArray(new JsonObject { ["v"] = "NaN" }, new JsonObject { ["v"] = "0" }) } })),
        Row("0", "-0", "0", "1E+3", "false", "", "", "0001-01-01", "00:00:00", "9999-12-31T23:59:59.999999", "-62135596800000000", "0-0 0 0:0:0", "[UNBOUNDED, UNBOUNDED)", "[UNBOUNDED, 0)",
            "GEOMETRYCOLLECTION EMPTY", "null", new JsonObject { ["f"] = new JsonArray(new JsonObject { ["v"] = null }, new JsonObject { ["v"] = new JsonArray() }) }, new JsonArray(), new JsonArray()),
        Row(null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null)
    ];

    static string?[][] TypesExpected() =>
    [
        ["-9223372036854775808", "1.5E+20", "12345678.9", "-0.000000000000000000000000000000000000001", "true", "héllo", "0xDEADBEEF", "2026-11-15", "09:30:00.123456",
            "2026-11-15T09:30:00.5", "2026-11-15 09:30:00.123456 UTC", "1-2 3 4:5:6.789", "[2026-01-01, 2026-12-31)", "[2026-11-15 09:30:00.000000 UTC, UNBOUNDED)", "POINT(1 2)", "{\"k\":[1,2]}",
            "{\"a\":\"7\",\"b\":[\"a\\\"b\",null]}", "[\"1\",\"2\"]", "[{\"x\":\"NaN\",\"t\":\"1970-01-01 00:00:00.000000 UTC\"}]"],
        ["0", "-0", "0", "1000", "false", "", "0x", "0001-01-01", "00:00:00", "9999-12-31T23:59:59.999999", "0001-01-01 00:00:00.000000 UTC", "0-0 0 0:0:0", "[UNBOUNDED, UNBOUNDED)",
            "[UNBOUNDED, 1970-01-01 00:00:00.000000 UTC)", "GEOMETRYCOLLECTION EMPTY", "null", "{\"a\":null,\"b\":[]}", "[]", "[]"],
        [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null]
    ];

    /// <summary>Job and call errors as Varia error values (docs/bigquery.md, Errors).</summary>
    static void JobErrors(Action<bool, string> check)
    {
        RequestException Job(string reason, string message, long? cap = null) => BigQueryErrors.Job(new() { Reason = reason, Message = message }, [], "varia-alpha", cap);
        var invalid = Job("invalidQuery", "Syntax error: Unexpected keyword FROM at [1:8]");
        var capped = Job("bytesBilledLimitExceeded", "Query exceeded limit for bytes billed: 10485760. 20971520 or higher required.", 10485760);
        var large = Job("responseTooLarge", "Response too large to return.");
        var stopped = Job("stopped", "Job execution was cancelled: User requested cancellation");
        var timeout = Job("timeout", "Query exceeded the job timeout.");
        var internalError = Job("jobInternalError", "The job encountered an internal error during execution.");
        var quota = Job("quotaExceeded", "Quota exceeded: Your project exceeded quota for free query bytes scanned.");
        var other = Job("somethingNew", "A new failure ya29.abcdefghijklmnop");
        check(invalid is { Code: "SQL_ERROR", Message: "Syntax error: Unexpected keyword FROM at [1:8]" }
            && capped.Code == "COST_CAP" && capped.Message.Contains("(10.00 MiB (< $0.01))", StringComparison.Ordinal) && capped.Message.Contains("20971520 or higher required", StringComparison.Ordinal)
            && large.Code == "RESULT_TOO_LARGE" && large.Message.Contains("10 GB", StringComparison.Ordinal) && stopped.Code == "CANCELLED" && timeout.Code == "TIMEOUT"
            && internalError.Code == "BACKEND_ERROR" && quota.Code == "QUOTA" && other is { Code: "SQL_ERROR" } && !other.Message.Contains("ya29.", StringComparison.Ordinal),
            $"a failed job's reason maps to its error row with Google's text, tokens redacted: {invalid.Code} {capped.Code} {large.Code} {stopped.Code} {timeout.Code} {internalError.Code} {quota.Code} {other.Message}");
        var api = BigQueryErrors.Map(new Google.GoogleApiException("bigquery", "Response too large")
        {
            HttpStatusCode = System.Net.HttpStatusCode.Forbidden,
            Error = new Google.Apis.Requests.RequestError { Code = 403, Message = "Response too large to return.", Errors = [new() { Reason = "responseTooLarge", Message = "Response too large to return." }] }
        }, "varia-alpha");
        check(api is RequestException { Code: "RESULT_TOO_LARGE" }, $"a call refused for a job's reason (403 responseTooLarge) maps as the job's would, not as a permission: {(api as RequestException)?.Code}");

        // VPC Service Controls: the same accessDenied as a missing role, told apart by its message or its ErrorInfo detail.
        var perimeterJob = Job("accessDenied", "VPC Service Controls: Request is prohibited by organization's policy. vpcServiceControlsUniqueIdentifier: Job-Id_42");
        check(perimeterJob.Code == "PERMISSION_DENIED" && perimeterJob.Message.StartsWith("VPC Service Controls blocked this request to project varia-alpha", StringComparison.Ordinal)
            && perimeterJob.Message.Contains("identifier Job-Id_42", StringComparison.Ordinal),
            $"a job VPC Service Controls refused says so with its identifier: {perimeterJob.Message}");
        Exception Refusal(string message, string raw, string? permission, bool quote = true) => BigQueryErrors.Map(new Google.GoogleApiException("bigquery", message)
        {
            HttpStatusCode = System.Net.HttpStatusCode.Forbidden,
            Error = new Google.Apis.Requests.RequestError { Code = 403, Message = message, Errors = [new() { Reason = "accessDenied", Message = message }], ErrorResponseContent = raw }
        }, "varia-alpha", permission, quote: quote);
        var detailOnly = Refusal("Request is prohibited by organization's policy.",
            """{"error":{"code":403,"details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"SECURITY_POLICY_VIOLATED","domain":"googleapis.com","metadata":{"uniqueIdentifier":"Detail-Id_7"}}]}}""", "bigquery.jobs.create") as RequestException;
        check(detailOnly is { Code: "PERMISSION_DENIED" } && detailOnly.Message.StartsWith("VPC Service Controls blocked", StringComparison.Ordinal)
            && detailOnly.Message.Contains("identifier Detail-Id_7", StringComparison.Ordinal) && !detailOnly.Message.Contains("bigquery.jobs.create", StringComparison.Ordinal),
            $"a refusal whose only VPC sign is its SECURITY_POLICY_VIOLATED detail is not reported as a missing permission: {detailOnly?.Message}");
        var narrower = Refusal("Access Denied: Table varia-alpha:sales.orders: restricted by an IAM deny policy.", "{}", "bigquery.tables.get") as RequestException;
        var unquoted = Refusal("Access Denied: Table varia-alpha:sales.orders: restricted by an IAM deny policy.", "{}", "bigquery.tables.get", quote: false) as RequestException;
        check(narrower is { Code: "PERMISSION_DENIED" } && narrower.Message.Contains("bigquery.tables.get", StringComparison.Ordinal) && narrower.Message.Contains("Google says: Access Denied", StringComparison.Ordinal)
            && !narrower.Message.Contains("Job User", StringComparison.Ordinal) && unquoted is { Code: "PERMISSION_DENIED" } && !unquoted.Message.Contains("orders", StringComparison.Ordinal),
            $"a permission refusal keeps Google's text beside the permission (left out when asked), and names Job User only for jobs.create: {narrower?.Message} | {unquoted?.Message}");
    }

    static async Task InsertAsync(Action<bool, string> check)
    {
        var jobs = new Jobs { Schema = TypesSchema(), Rows = [.. TypesRows()] };
        using var harness = new Harness(jobs);
        await harness.ConnectAsync(options => options["maximumBytesBilled"] = 10485760);
        var (code, result, message) = await harness.Execute("SELECT * FROM t", args => args["timeoutSeconds"] = 30);
        var body = jobs.InsertBodies.Single();
        var id = jobs.InsertedIds.Single();
        var query = body["configuration"]?["query"];
        check(code == "ok" && id.StartsWith(BigQueryService.JobIdPrefix, StringComparison.Ordinal) && id.Length == BigQueryService.JobIdPrefix.Length + 32
            && body["jobReference"]?["projectId"]?.GetValue<string>() == "varia-emulator" && query?["useLegacySql"]?.GetValue<bool>() == false && query?["query"]?.GetValue<string>() == "SELECT * FROM t"
            && query?["defaultDataset"]?["datasetId"]?.GetValue<string>() == "varia_fixture" && query?["maximumBytesBilled"]?.ToString() == "10485760"
            && body["configuration"]?["jobTimeoutMs"]?.ToString() == "30000" && body["configuration"]?["labels"]?["varia_client"]?.GetValue<string>() == "varia",
            $"a query is one jobs.insert under a client job id, GoogleSQL, the default dataset, the cost cap, the timeout and Varia's label: {code} {message} {body.ToJsonString()[..Math.Min(400, body.ToJsonString().Length)]}");
        var first = HttpUtility.ParseQueryString(jobs.Reads.First().Query);
        check(first["formatOptions.useInt64Timestamp"] == "true" && first["maxResults"] == SqlService.BigQueryFirstPageRows.ToString(System.Globalization.CultureInfo.InvariantCulture) && first["timeoutMs"] == "50" && first["pageToken"] is null,
            "results are read with jobs.getQueryResults: epoch-microsecond times, the first page's rows and the long poll's wait: " + jobs.Reads.First().Query);
        var set = result?.ResultSets.Single();
        var rows = set is null ? [] : harness.Rows(set);
        check(set is { RowsRead: 3, RowsStored: 3, Truncated: null, Incomplete: false, Kind: "rows" } && rows.Count == 3 && rows[0][10].Text == "2026-11-15 09:30:00.123456 UTC" && rows[0][6].Text == "0xDEADBEEF"
            && set.Columns[2].DataType == "NUMERIC(10, 2)" && set.Columns[2].SortKind == "decimal",
            $"the rows are stored as SQL Server's are, with BigQuery's columns: {set?.RowsRead} {set?.RowsStored} {set?.Truncated}");
        check(result is { Status: "completed", Error: null, CompletedBatches: 1, TotalBatches: 1, RecordsAffected: -1, Database: "varia_fixture", Spid: null, Login: null }
            && Says(result, "BigQuery job varia-emulator:" + id + ".") && Says(result, "(3 rows affected)") && result.Job is { Project: "varia-emulator", StatementType: "SELECT", BytesProcessed: null } job && job.JobId == id
            && !Says(result, "Bytes processed"),
            $"the summary names the job, the rows and the dataset, and no cost when BigQuery reported none: {Texts(result?.Messages ?? [])}");

        // Statistics from jobs.get, in Messages and the summary's job.
        jobs.Statistics = new JsonObject
        {
            ["totalBytesProcessed"] = "1331439862", ["totalSlotMs"] = "1250",
            ["query"] = new JsonObject { ["totalBytesProcessed"] = "1331439862", ["totalBytesBilled"] = "1331691520", ["cacheHit"] = false, ["totalSlotMs"] = "1250", ["statementType"] = "SELECT" }
        };
        jobs.Location = "US";
        (code, result, message) = await harness.Execute("SELECT * FROM t", args => args["dataset"] = "other_set");
        body = jobs.InsertBodies.Last();
        check(code == "ok" && result?.Job is { Location: "US", BytesProcessed: 1331439862, BytesBilled: 1331691520, CacheHit: false, SlotMs: 1250 }
            && Says(result, "Bytes processed: 1.24 GiB (< $0.01) · Bytes billed: 1.24 GiB (< $0.01) · Slot time: 1.3 s · Cache hit: no · Prices are on-demand estimates at $6.25 per TiB.")
            && Says(result, "BigQuery job varia-emulator:US.") && result.Database == "other_set" && body["configuration"]?["query"]?["defaultDataset"]?["datasetId"]?.GetValue<string>() == "other_set"
            && body["configuration"]?["jobTimeoutMs"] is null && HttpUtility.ParseQueryString(jobs.Reads.Last().Query)["location"] == "US",
            $"a finished job's bytes, slot time and cache hit are in Messages, priced, and in the summary; a request's dataset replaces the connection's: {code} {message} {Texts(result?.Messages ?? [])}");

        // Show cost as Bytes only: the same figures without dollars.
        (code, result, message) = await harness.Execute("SELECT * FROM t", args => args["prices"] = false);
        check(code == "ok" && Says(result, "Bytes processed: 1.24 GiB · Bytes billed: 1.24 GiB · Slot time: 1.3 s · Cache hit: no") && !Texts(result?.Messages ?? []).Contains('$'),
            $"prices: false leaves the dollars out of the job's Messages line: {code} {message} {Texts(result?.Messages ?? [])}");
        // Tools › Options' cap goes out as the job's maximumBytesBilled when the connection sets none (this one sets 10 MiB).
        (code, result, message) = await harness.Execute("SELECT * FROM t", args => args["maximumBytesBilled"] = 10_737_418_240L);
        var ownCap = jobs.InsertBodies.Last()["configuration"]?["query"]?["maximumBytesBilled"]?.ToString();
        await harness.Call("connections.disconnect", new JsonObject { ["connectionId"] = harness.ConnectionId });
        await harness.ConnectAsync();
        (code, result, message) = await harness.Execute("SELECT * FROM t", args => args["maximumBytesBilled"] = 10_737_418_240L);
        body = jobs.InsertBodies.Last();
        check(code == "ok" && ownCap == "10485760" && body["configuration"]?["query"]?["maximumBytesBilled"]?.ToString() == "10737418240",
            $"the connection's cap wins; Options' maximum bytes billed is the job's cap when the connection has none: {ownCap} {code} {message} {body}");
        (code, _, _) = await harness.Execute("SELECT * FROM t", args => args["maximumBytesBilled"] = 0);
        check(code == "INVALID_PARAMS", $"a cap below one byte is refused: {code}");

        // A SELECT that returns nothing: BigQuery's page has the schema but no rows or totalRows.
        jobs.Statistics = null;
        jobs.Rows = [];
        (code, result, message) = await harness.Execute("SELECT * FROM t WHERE FALSE");
        check(code == "ok" && result?.ResultSets.Single() is { RowsRead: 0, RowsStored: 0, Truncated: null, Incomplete: false } empty && empty.Columns.Count == jobs.Schema!["fields"]!.AsArray().Count
            && Says(result, "(0 rows affected)"),
            $"a page with a schema and no rows is one empty result set: {code} {message} {Texts(result?.Messages ?? [])}");
        check(harness.Fake.Unmatched.IsEmpty, "execution sends nothing the scripted BigQuery does not answer: " + string.Join(", ", harness.Fake.Unmatched.Select(request => request.Method + " " + request.Url)));
    }

    static async Task PollAndPageAsync(Action<bool, string> check)
    {
        var jobs = new Jobs { Schema = Schema(Field("n", "INTEGER")), Rows = [.. Enumerable.Range(0, 1203).Select(i => Row(i.ToString(System.Globalization.CultureInfo.InvariantCulture)))], PollsBeforeDone = 2, PageCap = 400 };
        using var harness = new Harness(jobs);
        await harness.ConnectAsync();
        var (code, result, message) = await harness.Execute("SELECT n FROM t");
        var reads = jobs.Reads.Select(uri => HttpUtility.ParseQueryString(uri.Query)).ToList();
        var set = result?.ResultSets.Single();
        var values = set is null ? [] : harness.Rows(set).Select(row => row[0].Text).ToList();
        check(code == "ok" && reads.Count == 3 + 3 && reads.Take(3).All(read => read["pageToken"] is null && read["timeoutMs"] == "50")
            && reads.Skip(3).Select(read => read["pageToken"]).SequenceEqual(["page-400", "page-800", "page-1200"])
            && reads.Skip(3).All(read => read["maxResults"] == harness.Service.BigQueryPageRows(1).ToString(System.Globalization.CultureInfo.InvariantCulture) && read["timeoutMs"] == "0"),
            $"execution polls until the job is complete, then follows each page token: {code} {message} {string.Join(" ", jobs.Reads.Select(uri => uri.Query))}");
        check(set is { RowsRead: 1203, RowsStored: 1203, Truncated: null } && values.SequenceEqual(Enumerable.Range(0, 1203).Select(i => i.ToString(System.Globalization.CultureInfo.InvariantCulture)))
            && Says(result, "(1203 rows affected)"),
            $"every page's rows are stored in order: {set?.RowsRead} {set?.RowsStored} {values.Count}");
        check(harness.Service.BigQueryPageRows(1) == 10_000 && harness.Service.BigQueryPageRows(100) == 2_500 && harness.Service.BigQueryPageRows(4096) == SqlService.BigQueryFirstPageRows,
            "later pages ask for fewer rows the wider the result");

        // discardResults reads no rows: the result is counted from BigQuery's total.
        var before = jobs.Reads.Count;
        (code, result, message) = await harness.Execute("SELECT n FROM t", args => args["discardResults"] = true);
        check(code == "ok" && result is { ResultSets.Count: 0, DiscardedResultSets: 1 } && jobs.Reads.Skip(before).All(uri => HttpUtility.ParseQueryString(uri.Query)["maxResults"] == "0")
            && Says(result, "(1203 rows affected)") && Says(result, "Results were discarded after execution"),
            $"Discard results reads no rows and counts them from BigQuery's total: {code} {message} {Texts(result?.Messages ?? [])}");
    }

    static async Task TruncationAsync(Action<bool, string> check)
    {
        var jobs = new Jobs { Schema = Schema(Field("n", "INTEGER"), Field("s", "STRING")), Rows = [.. Enumerable.Range(0, 1203).Select(i => Row(i.ToString(System.Globalization.CultureInfo.InvariantCulture), new string('x', 200)))], PageCap = 400 };
        using (var harness = new Harness(jobs))
        {
            await harness.ConnectAsync();
            var (code, result, _) = await harness.Execute("SELECT n, s FROM t", args => args["maxRows"] = 100);
            var set = result?.ResultSets.Single();
            check(code == "ok" && set is { RowsRead: 1203, RowsStored: 100, Truncated: "rowLimit" } && jobs.Reads.Count == 1
                && Says(result, "Results were truncated by display limits. Display limits do not stop script execution.") && Says(result, "(1203 rows affected)"),
                $"the row limit stops storing and reading pages, and the rows past it are counted from BigQuery's total: {set?.RowsRead} {set?.RowsStored} {set?.Truncated} {jobs.Reads.Count}");
        }

        // Rows kept per execution counts over a script's result sets, as SQL Server's reader does: the second SELECT keeps what
        // the first left, and the third, with nothing left, keeps none (in memory, cut by the row limit, its rows counted).
        foreach (var residence in new[] { "memory", "windowed" })
        {
            jobs = new Jobs { Schema = jobs.Schema, Rows = jobs.Rows, PageCap = 400, StatementType = "SCRIPT", ScriptChild = true, ScriptChildren = 3, Destination = Destination };
            using var harness = new Harness(jobs);
            await harness.ConnectAsync();
            var (code, result, message) = await harness.Execute("SELECT n, s FROM t; SELECT n, s FROM t; SELECT n, s FROM t", args => { args["maxRows"] = 1500; args["residence"] = residence; });
            var shown = result?.ResultSets.Select(set => (set.Residence, Rows: set.Residence == "remote" ? set.RowsAvailable : set.RowsStored, set.Truncated, set.RowsRead)).ToList() ?? [];
            var remote = residence == "windowed" ? "remote" : "memory";
            check(code == "ok" && shown is [var first, var second, var third]
                && first == (remote, 1203, null, 1203) && second == (remote, 297, "rowLimit", 1203) && third == ("memory", 0, "rowLimit", 1203),
                $"{residence}: Rows kept per execution counts over every result set of a script: {code} {message} {string.Join(" | ", shown)}");
            if (residence != "windowed" || result?.ResultSets is not [_, var windowedChild, _]) continue;
            // A new query from that second result (a BigQuery-side sort here, a rerun alike) runs with Maximum rows, not the share
            // the script left that result.
            jobs.StatementType = "SELECT";
            jobs.ScriptChild = false;
            var (viewCode, view, _, viewMessage) = await Run(harness, "results.remoteQuery", View(windowedChild.ResultId, sort: [Key(0, descending: true)]));
            var viewSet = view?.ResultSets.SingleOrDefault();
            var viewRows = viewSet?.Residence == "remote" ? viewSet.RowsAvailable : viewSet?.RowsStored;
            check(viewCode == "ok" && viewRows == 1203 && viewSet?.Truncated is null,
                $"a script child's BigQuery-side view keeps Maximum rows, not the child's share: {viewCode} {viewMessage} {viewSet?.Residence} {viewRows} {viewSet?.Truncated}");
        }

        // A limit that lands on a page's last row reads no further page.
        jobs = new Jobs { Schema = jobs.Schema, Rows = jobs.Rows, PageCap = 400 };
        using (var harness = new Harness(jobs))
        {
            await harness.ConnectAsync();
            var (_, result, _) = await harness.Execute("SELECT n, s FROM t", args => args["maxRows"] = 400);
            var set = result?.ResultSets.Single();
            check(set is { RowsRead: 1203, RowsStored: 400, Truncated: "rowLimit" } && jobs.Reads.Count == 1,
                $"a row limit reached on a page's last row stops there: {set?.RowsStored} {set?.Truncated} {jobs.Reads.Count} reads");
        }

        // The result budget stops storing as it does for SQL Server, and execution completes.
        jobs = new Jobs { Schema = jobs.Schema, Rows = jobs.Rows, PageCap = 400 };
        using (var harness = new Harness(jobs, new ResultStore(256 * 1024, 128 * 1024)))
        {
            await harness.ConnectAsync();
            var (code, result, message) = await harness.Execute("SELECT n, s FROM t");
            var set = result?.ResultSets.Single();
            check(code == "ok" && result?.Status == "completed" && set is { RowsRead: 1203, Truncated: "queryBudget" } && set.RowsStored is > 0 and < 1203
                && Says(result, "Results were truncated because the result memory budget (<1 MB) is full."),
                $"the result budget stops storing, the query completes, and the rows are counted: {code} {message} {set?.RowsStored} {set?.Truncated} {Texts(result?.Messages ?? [])}");
            check(harness.Service.Results.UsedBytes <= 256 * 1024, "the pages being decoded stay within the budget: " + harness.Service.Results.UsedBytes);
        }
        // The note's figure (SQL Server's too) is written as the results strip writes it: never "(0 MB)".
        var figures = new[] { 0L, 256 * 1024, 1L << 20, 3L << 19, 8L << 30, 10L << 30 }.Select(SqlService.MemoryFigure).ToList();
        check(figures.SequenceEqual(["<1 MB", "<1 MB", "1 MB", "2 MB", "8,192 MB", "10.0 GB"]), "the budget note's figure matches the strip's: " + string.Join(", ", figures));
        // SQL Server's Messages note is the same text, which SqlService's batch loop writes through BudgetFullNote.
        check(SqlService.BudgetFullNote(256 * 1024) == "Results were truncated because the result memory budget (<1 MB) is full. Execution continued; close other query results to free memory."
            && SqlService.BudgetFullNote(8L << 30).Contains("(8,192 MB) is full.", StringComparison.Ordinal),
            "the budget note's whole text, SQL Server's and BigQuery's: " + SqlService.BudgetFullNote(256 * 1024));

        // A cell past its cap and a read error, through query.execute.
        jobs = new Jobs { Schema = Schema(Field("n", "INTEGER"), Field("s", "STRING")), Rows = [Row("x1", new string('a', ColumnPlan.TextCap + 1)), Row("x2", "b")] };
        using (var harness = new Harness(jobs))
        {
            await harness.ConnectAsync();
            var (code, result, _) = await harness.Execute("SELECT n, s FROM t");
            var set = result?.ResultSets.Single();
            var rows = set is null ? [] : harness.Rows(set);
            check(code == "ok" && set is { TruncatedCells: 1, RowsStored: 2 } && rows[0][0].Flags == (PageReader.Null | PageReader.Error) && rows[1][1].Text == "b"
                && result!.Messages.Count(entry => entry.Text.StartsWith("Column ‘n’", StringComparison.Ordinal)) == 1 && Says(result, "Results were truncated by display limits."),
                $"a cell past its cap counts as truncated, and a column's read errors are one message: {Texts(result?.Messages ?? [])}");
        }

        // More than 4,096 columns: the first ones, and a note.
        jobs = new Jobs { Schema = Schema([.. Enumerable.Range(0, PageBuilder.MaxColumns + 2).Select(i => Field("c" + i, "INTEGER"))]), Rows = [Row([.. Enumerable.Range(0, PageBuilder.MaxColumns + 2).Select(i => (JsonNode?)JsonValue.Create(i.ToString(System.Globalization.CultureInfo.InvariantCulture)))])] };
        using (var harness = new Harness(jobs))
        {
            await harness.ConnectAsync();
            var (code, result, _) = await harness.Execute("SELECT * FROM wide");
            var set = result?.ResultSets.Single();
            var rows = set is null ? [] : harness.Rows(set);
            check(code == "ok" && set?.Columns.Count == PageBuilder.MaxColumns && rows.Single()[^1].Text == (PageBuilder.MaxColumns - 1).ToString(System.Globalization.CultureInfo.InvariantCulture)
                && Says(result, "The result has 4,098 columns; the first 4,096 are shown."),
                $"a result past 4,096 columns shows the first ones and says so: {Texts(result?.Messages ?? [])}");
        }
    }

    static async Task FailuresAsync(Action<bool, string> check)
    {
        // A job that fails at insert: the insert's answer is DONE with its error.
        var jobs = new Jobs { Failure = Error("invalidQuery", "Syntax error: Unexpected end of script at [1:7]"), FailsAtInsert = true };
        using (var harness = new Harness(jobs))
        {
            await harness.ConnectAsync();
            var (code, result, _) = await harness.Execute("SELECT");
            check(code == "ok" && result is { Status: "failed", Error: { Code: "SQL_ERROR", BatchNumber: 1 }, ResultSets.Count: 0, CompletedBatches: 0 } && result.Error.Message == "Syntax error: Unexpected end of script at [1:7]"
                && result.Messages.Any(entry => entry.Kind == "error" && entry.Text == "Syntax error: Unexpected end of script at [1:7]") && jobs.Reads.IsEmpty && result.Job?.JobId == jobs.InsertedIds.Single(),
                $"a job that fails at insert is the summary's error, with BigQuery's text, and nothing is read: {result?.Status} {result?.Error} {Texts(result?.Messages ?? [])}");

            // A job that fails while it runs: getQueryResults answers 400, and the job's own error is read with jobs.get.
            jobs.FailsAtInsert = false;
            jobs.Failure = Error("bytesBilledLimitExceeded", "Query exceeded limit for bytes billed: 1000. 10485760 or higher required.");
            await harness.Call("connections.disconnect", new JsonObject { ["connectionId"] = harness.ConnectionId });
            await harness.ConnectAsync(options => options["maximumBytesBilled"] = 1000);
            (code, result, _) = await harness.Execute("SELECT * FROM big");
            check(code == "ok" && result is { Status: "failed", Error.Code: "COST_CAP" } && result.Error.Message.Contains("1000 B (< $0.01)", StringComparison.Ordinal)
                && result.Error.Message.Contains("10485760 or higher required", StringComparison.Ordinal) && harness.Fake.To(Base + "/jobs/[^/]+").Any(),
                $"a job over the connection's cap fails as COST_CAP naming the cap: {result?.Error}");
            (code, result, _) = await harness.Execute("SELECT * FROM big", args => args["maximumBytesBilled"] = 10_737_418_240L);
            check(code == "ok" && jobs.InsertBodies.Last()["configuration"]?["query"]?["maximumBytesBilled"]?.ToString() == "1000" && result?.Error?.Message.Contains("1000 B (< $0.01)", StringComparison.Ordinal) == true,
                $"the connection's own cap wins over Options' and is the one COST_CAP names: {jobs.InsertBodies.Last()} {result?.Error}");
            (code, result, _) = await harness.Execute("SELECT * FROM big", args => args["prices"] = false);
            check(result is { Error.Code: "COST_CAP" } && result.Error.Message.Contains("(1000 B)", StringComparison.Ordinal) && !result.Error.Message.Contains('$', StringComparison.Ordinal)
                && !result.Messages.Any(entry => entry.Text.Contains('$', StringComparison.Ordinal)),
                $"prices: false names the cap in bytes alone: {result?.Error} {Texts(result?.Messages ?? [])}");

            jobs.Failure = Error("responseTooLarge", "Response too large to return. Consider specifying a destination table in your job configuration.");
            (code, result, _) = await harness.Execute("SELECT * FROM huge");
            check(result is { Status: "failed", Error.Code: "RESULT_TOO_LARGE" }, $"a result over BigQuery's limit fails as RESULT_TOO_LARGE: {result?.Error}");

            jobs.Failure = Error("stopped", "Job execution was cancelled: User requested cancellation");
            (code, result, _) = await harness.Execute("SELECT * FROM elsewhere");
            check(result is { Status: "cancelled", Error.Code: "CANCELLED" }, $"a job cancelled elsewhere (Job History, the console) is cancelled: {result?.Status} {result?.Error}");
            jobs.Failure = Error("stopped", "Job execution was cancelled: Job timed out after 30 sec");
            (code, result, _) = await harness.Execute("SELECT * FROM queued");
            check(result is { Status: "timedOut", Error.Code: "TIMEOUT" }, $"a job BigQuery stopped at its jobTimeoutMs (reason stopped, timed out) is timedOut: {result?.Status} {result?.Error}");

            jobs.Failure = Error("timeout", "Job timed out after 1 sec.");
            (code, result, _) = await harness.Execute("SELECT * FROM slow");
            check(result is { Status: "timedOut", Error.Code: "TIMEOUT" }, $"a job BigQuery stopped at its timeout is timedOut: {result?.Status} {result?.Error}");

            // A dataset in another location: datasets.get says where it is, and the error names both.
            jobs.Failure = Error("notFound", "Not found: Dataset varia-emulator:sales_eu was not found in location US");
            harness.Fake.On("GET", Base + "/datasets/sales_eu", new BigQueryFake.Reply(200, "{\"kind\":\"bigquery#dataset\",\"datasetReference\":{\"projectId\":\"varia-emulator\",\"datasetId\":\"sales_eu\"},\"location\":\"EU\"}"));
            (code, result, _) = await harness.Execute("SELECT * FROM sales_eu.orders");
            check(result is { Status: "failed", Error.Code: "LOCATION_MISMATCH" } && result.Error.Message.Contains("is in location EU, but the query ran in US", StringComparison.Ordinal),
                $"a dataset in another location fails as LOCATION_MISMATCH naming both: {result?.Error}");
            jobs.Failure = Error("notFound", "Not found: Dataset varia-emulator:sales_us was not found in location US");
            harness.Fake.On("GET", Base + "/datasets/sales_us", BigQueryFake.Fixture("error-not-found", 404));
            (code, result, _) = await harness.Execute("SELECT * FROM sales_us.orders");
            check(result is { Status: "failed", Error.Code: "NOT_FOUND" } && result.Error.Message.Contains("sales_us was not found", StringComparison.Ordinal),
                $"a dataset that does not exist stays NOT_FOUND: {result?.Error}");
        }
    }

    static async Task RetriesAsync(Action<bool, string> check)
    {
        // A network failure before Google answered: jobs.get finds no job, so the insert is sent again under the same id.
        var jobs = new Jobs { Schema = Schema(Field("n", "INTEGER")), Rows = [Row("1")] };
        jobs.InsertReplies.Enqueue(null);
        using var harness = new Harness(jobs);
        await harness.ConnectAsync();
        var (code, result, message) = await harness.Execute("SELECT 1");
        var ids = jobs.InsertedIds.ToArray();
        check(code == "ok" && result?.Status == "completed" && ids.Length == 2 && ids[0] == ids[1] && harness.Fake.To(Base + "/jobs/" + ids[0]).Count() >= 2,
            $"after a network failure the job is looked up, and sent again under the same id only when it does not exist: {code} {message} {ids.Length}");

        // A 5xx after Google created the job: the lookup finds it, and it is not sent again.
        jobs.InsertedIds.Clear();
        jobs.InsertReplies.Enqueue((500, BigQueryFake.FixtureText("error-backend")));
        (code, result, message) = await harness.Execute("SELECT 1");
        check(code == "ok" && result?.Status == "completed" && jobs.InsertedIds.Count == 1, $"a job that exists after a 5xx is never sent twice: {code} {message} {jobs.InsertedIds.Count}");

        // 409: the job exists (an earlier attempt's), so it is read rather than created.
        jobs.InsertedIds.Clear();
        jobs.InsertReplies.Enqueue((409, "{\"error\":{\"code\":409,\"message\":\"Already Exists: Job varia-emulator:job\",\"errors\":[{\"message\":\"Already Exists: Job varia-emulator:job\",\"domain\":\"global\",\"reason\":\"duplicate\"}],\"status\":\"ALREADY_EXISTS\"}}"));
        lock (jobs.Created) jobs.Created.Clear();
        var before = harness.Fake.Seen.Count;
        // The 409's job is the one the scripted server knows under the id the request sent.
        harness.Fake.Fault = request => { if (request.Method == "POST") lock (jobs.Created) jobs.Created.Add(JsonNode.Parse(request.Body)!["jobReference"]!["jobId"]!.GetValue<string>()); return null; };
        (code, result, message) = await harness.Execute("SELECT 1");
        harness.Fake.Fault = null;
        check(code == "ok" && result?.Status == "completed" && jobs.InsertedIds.Count == 1 && harness.Fake.Seen.Skip(before).Count(request => request.Method == "GET" && request.Url.Contains("/jobs/", StringComparison.Ordinal)) >= 2,
            $"a 409 on insert means the job exists: it is read with jobs.get, not created again: {code} {message}");

        // Network failures past the attempts fail the query as CONNECTION_LOST, after asking each time.
        jobs.InsertedIds.Clear();
        for (var i = 0; i < 3; i++) jobs.InsertReplies.Enqueue(null);
        lock (jobs.Created) jobs.Created.Clear();
        (code, result, message) = await harness.Execute("SELECT 1");
        check(code == "ok" && result is { Status: "failed", Error.Code: "CONNECTION_LOST" } && jobs.InsertedIds.Count == 3 && jobs.InsertedIds.Distinct().Count() == 1,
            $"an insert that never reaches Google fails after its attempts, all under one id: {result?.Error} {jobs.InsertedIds.Count}");
        check(harness.Fake.Unmatched.IsEmpty, "retries send nothing the scripted BigQuery does not answer");
    }

    static async Task StatementsAsync(Action<bool, string> check)
    {
        var jobs = new Jobs { StatementType = "UPDATE", DmlAffected = 3 };
        using var harness = new Harness(jobs);
        await harness.ConnectAsync();
        var (code, result, _) = await harness.Execute("UPDATE t SET a = 1 WHERE TRUE");
        check(code == "ok" && result is { Status: "completed", RecordsAffected: 3, ResultSets.Count: 0 } && Says(result, "(3 rows affected)") && result.Job?.StatementType == "UPDATE",
            $"DML reports BigQuery's affected rows: {Texts(result?.Messages ?? [])}");
        jobs.DmlAffected = null;
        jobs.StatementType = "CREATE_TABLE";
        jobs.DdlOperation = "CREATE";
        (code, result, _) = await harness.Execute("CREATE TABLE t (a INT64)");
        check(result is { Status: "completed", RecordsAffected: -1, ResultSets.Count: 0 } && Says(result, "CREATE TABLE completed."), $"DDL says it completed: {Texts(result?.Messages ?? [])}");
        jobs.DdlOperation = "SKIP";
        jobs.StatementType = "CREATE_TABLE";
        (code, result, _) = await harness.Execute("CREATE TABLE IF NOT EXISTS t (a INT64)");
        check(Says(result, "CREATE TABLE did nothing"), $"a DDL statement BigQuery skipped says so: {Texts(result?.Messages ?? [])}");
        jobs.DdlOperation = null;
        jobs.StatementType = "SCRIPT";
        jobs.Schema = Schema(Field("x", "INTEGER"));
        jobs.Rows = [Row("1")];
        (code, result, _) = await harness.Execute("DECLARE x INT64 DEFAULT 1; SELECT x;");
        check(result is { Status: "completed", ResultSets.Count: 1 } && Says(result, "BigQuery returns the rows of a script's last statement only."), $"a script returns its last statement's rows and says so: {Texts(result?.Messages ?? [])}");
    }

    /// <summary>A run's DDL marks the Search Objects index (docs/object-search.md, BigQuery): a finished statement its target, a script's
    /// DDL each statement's own target, a temp table nothing, and a stopped run once BigQuery reports its job DONE. The result numbers
    /// the newest unspent mark, so the renderer asks one stale-only build per mark.</summary>
    static async Task IndexMarksAsync(Action<bool, string> check)
    {
        static JsonObject Target(string dataset) => new() { ["query"] = new JsonObject { ["ddlTargetTable"] = new JsonObject { ["projectId"] = "varia-emulator", ["datasetId"] = dataset, ["tableId"] = "t" } } };
        var jobs = new Jobs { StatementType = "CREATE_TABLE", Statistics = Target("staging") };
        using var harness = new Harness(jobs);
        await harness.ConnectAsync();
        harness.Service.Search.TrackBigQuery(harness.ConnectionId);
        var (code, result, _) = await harness.Execute("CREATE TABLE staging.t (a INT64)");
        var first = result?.IndexStale;
        check(code == "ok" && first > 0 && harness.Service.Search.StaleOf(harness.ConnectionId).SequenceEqual([("varia-emulator", "staging")]),
            $"a finished CREATE TABLE marks its target's dataset, and the result numbers the mark: {code} {first}");
        // A temp table's target is the session's anonymous dataset: nothing more is marked.
        jobs.Statistics = Target("_session_8f2c");
        (_, result, _) = await harness.Execute("CREATE TEMP TABLE t AS SELECT 1");
        check(result?.IndexStale == first && harness.Service.Search.StaleOf(harness.ConnectionId).Count == 1, $"a temp table marks nothing: {result?.IndexStale}");
        // LOAD DATA counts, by its target table.
        jobs.StatementType = "LOAD_DATA";
        jobs.Statistics = Target("landing");
        (_, result, _) = await harness.Execute("LOAD DATA INTO landing.t FROM FILES (format = 'CSV', uris = ['gs://example/f.csv'])");
        check(result?.IndexStale > first && harness.Service.Search.StaleOf(harness.ConnectionId).Contains(("varia-emulator", "landing")), $"LOAD DATA marks its table's dataset: {result?.IndexStale}");
        // A script's DDL statement in another dataset: its entry in the child listing names the target, with no jobs.get of its own.
        jobs.StatementType = "SCRIPT";
        jobs.Statistics = null;
        jobs.ScriptChild = true;
        jobs.ChildStatementType = "DROP_TABLE";
        jobs.ChildStatistics = Target("marketing");
        var childGets = harness.Fake.To(Base + "/jobs/" + Jobs.ChildId + @"(\?.*)?").Count(request => request.Method == "GET");
        (code, result, _) = await harness.Execute("DECLARE n INT64 DEFAULT 1; DROP TABLE marketing.t;");
        check(code == "ok" && harness.Service.Search.StaleOf(harness.ConnectionId).Contains(("varia-emulator", "marketing")) && harness.Service.Search.StaleProjectsOf(harness.ConnectionId).Count == 0
            && harness.Fake.To(Base + "/jobs/" + Jobs.ChildId + @"(\?.*)?").Count(request => request.Method == "GET") == childGets,
            $"a script's DDL on another dataset marks that dataset, read from the child listing without a jobs.get: {code} {string.Join(",", harness.Service.Search.StaleOf(harness.ConnectionId))}");
        // A listing that names no target: the statement's own job is read in the background, and its target marked.
        jobs.ListChildTarget = false;
        jobs.ChildStatistics = Target("finance");
        (code, _, _) = await harness.Execute("DECLARE n INT64 DEFAULT 1; DROP TABLE finance.t;");
        var resolved = await BigQuerySessionChecks.Poll(() => harness.Service.Search.StaleOf(harness.ConnectionId).Contains(("varia-emulator", "finance")));
        check(code == "ok" && resolved && harness.Service.Search.StaleProjectsOf(harness.ConnectionId).Count == 0 && await BigQuerySessionChecks.Poll(() => harness.Service.IndexMarkWatches == 0),
            $"a script statement whose listing names no target is read with jobs.get in the background and marks its dataset: {code} {resolved}");
        // A target in a project the index does not read marks nothing.
        jobs.ListChildTarget = true;
        jobs.ChildStatistics = new JsonObject { ["query"] = new JsonObject { ["ddlTargetTable"] = new JsonObject { ["projectId"] = "elsewhere-project", ["datasetId"] = "d", ["tableId"] = "t" } } };
        var before = harness.Service.Search.StaleMarkOf(harness.ConnectionId);
        await harness.Execute("DECLARE n INT64 DEFAULT 1; DROP TABLE `elsewhere-project.d.t`;");
        check(harness.Service.Search.StaleMarkOf(harness.ConnectionId) == before, "DDL on a project the index does not read leaves no mark");
        jobs.ScriptChild = false;
        jobs.ChildStatementType = "SELECT";
        jobs.ChildStatistics = null;
        // Stop before the job finishes: the mark lands once BigQuery reports it DONE, in the background.
        jobs.StatementType = "CREATE_TABLE";
        jobs.Statistics = Target("archive");
        jobs.Hang = true;
        var args = harness.Query("CREATE TABLE archive.t AS SELECT 1");
        var running = harness.Call("query.execute", args);
        await Task.WhenAny(jobs.Polling.Task, running).WaitAsync(TimeSpan.FromSeconds(30));
        await harness.Call("query.cancel", new JsonObject { ["queryId"] = args["queryId"]!.GetValue<string>() });
        var (stopCode, stopped, _) = await running.WaitAsync(TimeSpan.FromSeconds(30));
        var marked = await BigQuerySessionChecks.Poll(() => harness.Service.Search.StaleOf(harness.ConnectionId).Contains(("varia-emulator", "archive")));
        check(stopCode == "ok" && (stopped as QueryResult)?.Status == "cancelled" && marked && await BigQuerySessionChecks.Poll(() => harness.Service.IndexMarkWatches == 0),
            $"a stopped CREATE TABLE marks its dataset once the job is DONE: {stopCode} {(stopped as QueryResult)?.Status} {marked}");
        // A stopped query with no DDL word follows nothing.
        jobs.Polling = new(TaskCreationOptions.RunContinuationsAsynchronously);
        args = harness.Query("SELECT n FROM slow");
        running = harness.Call("query.execute", args);
        await Task.WhenAny(jobs.Polling.Task, running).WaitAsync(TimeSpan.FromSeconds(30));
        await harness.Call("query.cancel", new JsonObject { ["queryId"] = args["queryId"]!.GetValue<string>() });
        await running.WaitAsync(TimeSpan.FromSeconds(30));
        check(harness.Service.IndexMarkWatches == 0, "a stopped query whose text changes no object starts no background follow");
        jobs.Hang = false;
    }

    static async Task RefusalsAsync(Action<bool, string> check)
    {
        var jobs = new Jobs { Schema = Schema(Field("n", "INTEGER")), Rows = [Row("1")] };
        using var harness = new Harness(jobs);
        await harness.ConnectAsync();
        foreach (var option in new[] { "stopOnError", "includeActualPlan", "includeLivePlan", "includeClientStatistics" })
        {
            var (code, _, _) = await harness.Execute("SELECT 1", args => args[option] = true);
            check(code == "UNSUPPORTED_PROVIDER", $"{option} is refused for a BigQuery query: {code}");
        }
        var legacy = await harness.Execute("#legacySQL\nSELECT 1 FROM [p:d.t]");
        var badDataset = await harness.Execute("SELECT 1", args => args["dataset"] = "not-a-dataset");
        var badSql = await harness.Execute(" ");
        var sqlServerDataset = await harness.Call("query.execute", new JsonObject
        {
            ["connectionId"] = Guid.NewGuid().ToString(), ["sessionId"] = Guid.NewGuid().ToString(), ["queryId"] = Guid.NewGuid().ToString(), ["sql"] = "SELECT 1",
            ["database"] = "master", ["dataset"] = "d", ["maxRows"] = 0, ["timeoutSeconds"] = 0
        });
        var noDatabase = await harness.Call("query.execute", new JsonObject
        {
            ["connectionId"] = Guid.NewGuid().ToString(), ["sessionId"] = Guid.NewGuid().ToString(), ["queryId"] = Guid.NewGuid().ToString(), ["sql"] = "SELECT 1", ["maxRows"] = 0, ["timeoutSeconds"] = 0
        });
        var sqlServerCap = await harness.Call("query.execute", new JsonObject
        {
            ["connectionId"] = Guid.NewGuid().ToString(), ["sessionId"] = Guid.NewGuid().ToString(), ["queryId"] = Guid.NewGuid().ToString(), ["sql"] = "SELECT 1",
            ["database"] = "master", ["maximumBytesBilled"] = 1024, ["maxRows"] = 0, ["timeoutSeconds"] = 0
        });
        var sqlServerPrices = await harness.Call("query.execute", new JsonObject
        {
            ["connectionId"] = Guid.NewGuid().ToString(), ["sessionId"] = Guid.NewGuid().ToString(), ["queryId"] = Guid.NewGuid().ToString(), ["sql"] = "SELECT 1",
            ["database"] = "master", ["prices"] = false, ["maxRows"] = 0, ["timeoutSeconds"] = 0
        });
        check(sqlServerCap.Code == "INVALID_PARAMS" && sqlServerPrices.Code == "INVALID_PARAMS", $"maximum bytes billed and prices are refused for SQL Server: {sqlServerCap.Code} {sqlServerPrices.Code}");
        var sqlServerResidence = await harness.Call("query.execute", new JsonObject
        {
            ["connectionId"] = Guid.NewGuid().ToString(), ["sessionId"] = Guid.NewGuid().ToString(), ["queryId"] = Guid.NewGuid().ToString(), ["sql"] = "SELECT 1",
            ["database"] = "master", ["residence"] = "memory", ["maxRows"] = 0, ["timeoutSeconds"] = 0
        });
        var sqlServerCache = await harness.Call("query.execute", new JsonObject
        {
            ["connectionId"] = Guid.NewGuid().ToString(), ["sessionId"] = Guid.NewGuid().ToString(), ["queryId"] = Guid.NewGuid().ToString(), ["sql"] = "SELECT 1",
            ["database"] = "master", ["windowCacheMiB"] = 64, ["maxRows"] = 0, ["timeoutSeconds"] = 0
        });
        check(sqlServerResidence.Code == "INVALID_PARAMS" && sqlServerCache.Code == "INVALID_PARAMS", $"residence and the window cache are refused for SQL Server: {sqlServerResidence.Code} {sqlServerCache.Code}");
        check(legacy.Code == "LEGACY_SQL" && badDataset.Code == "INVALID_PARAMS" && badSql.Code == "INVALID_PARAMS" && sqlServerDataset.Code == "INVALID_PARAMS" && noDatabase.Code == "INVALID_PARAMS"
            && jobs.InsertedIds.IsEmpty,
            $"legacy SQL, a bad dataset or script, a dataset for SQL Server and SQL Server without a database are refused before any job: {legacy.Code} {badDataset.Code} {badSql.Code} {sqlServerDataset.Code} {noDatabase.Code}");
    }

    /// <summary>The review's cases: a token Varia cannot send back, a disconnect mid-query, and the lookup after a failure
    /// asking in the default dataset's location.</summary>
    static async Task EdgesAsync(Action<bool, string> check)
    {
        var jobs = new Jobs { Schema = Schema(Field("n", "INTEGER")), Rows = [.. Enumerable.Range(0, 20).Select(i => Row(i.ToString(System.Globalization.CultureInfo.InvariantCulture)))], PageCap = 5, Token = new string('t', 1025) };
        using (var harness = new Harness(jobs))
        {
            await harness.ConnectAsync();
            var (code, result, _) = await harness.Execute("SELECT n FROM t");
            check(code == "ok" && result is { Status: "failed", Error.Code: "BACKEND_ERROR" } && result.ResultSets.Single().Incomplete,
                $"a page token Varia cannot send back fails the read instead of ending it with rows unread: {result?.Status} {result?.Error}");

            jobs.Token = null;
            jobs.Hang = true;
            var running = harness.Call("query.execute", harness.Query("SELECT n FROM slow"));
            await Task.WhenAny(jobs.Polling.Task, running).WaitAsync(TimeSpan.FromSeconds(30));
            var disconnect = await harness.Call("connections.disconnect", new JsonObject { ["connectionId"] = harness.ConnectionId });
            var (ran, value, _) = await running.WaitAsync(TimeSpan.FromSeconds(30));
            check(disconnect.Code == "ok" && ran == "ok" && value is QueryResult { Status: "cancelled", Error.Code: "CANCELLED" },
                $"disconnecting ends the handle's running query as cancelled: {ran} {(value as QueryResult)?.Status} {(value as QueryResult)?.Error}");
        }

        jobs = new Jobs { Schema = Schema(Field("n", "INTEGER")), Rows = [Row("1")] };
        jobs.InsertReplies.Enqueue(null);
        using (var harness = new Harness(jobs))
        {
            await harness.ConnectAsync();
            harness.Fake.On("GET", Base + "/datasets/varia_fixture", new BigQueryFake.Reply(200, "{\"datasetReference\":{\"projectId\":\"varia-emulator\",\"datasetId\":\"varia_fixture\"},\"location\":\"asia-northeast1\"}"));
            var (code, result, _) = await harness.Execute("SELECT 1");
            var lookups = harness.Fake.To(Base + "/jobs/[^/]+").Select(request => HttpUtility.ParseQueryString(request.Uri.Query)["location"]).ToList();
            var bodies = jobs.InsertBodies.ToArray();
            check(code == "ok" && result?.Status == "completed" && lookups.Count > 0 && lookups[0] == "asia-northeast1" && bodies.Length == 2
                && bodies[0]["jobReference"]?["location"] is null && bodies[1]["jobReference"]?["location"]?.GetValue<string>() == "asia-northeast1",
                $"after a failed insert with no location, the lookup asks in the default dataset's location, and the insert goes there again: {code} {string.Join(",", lookups)}");
        }
    }

    static async Task CancelAsync(Action<bool, string> check)
    {
        var jobs = new Jobs { Schema = Schema(Field("n", "INTEGER")), Rows = [Row("1")], Hang = true };
        using var harness = new Harness(jobs);
        await harness.ConnectAsync();
        var args = harness.Query("SELECT n FROM slow");
        var running = harness.Call("query.execute", args);
        await Task.WhenAny(jobs.Polling.Task, running).WaitAsync(TimeSpan.FromSeconds(30));
        // A second query in the same tab while the first runs.
        var busy = await harness.Execute("SELECT 1", second => second["sessionId"] = args["sessionId"]!.GetValue<string>());
        var stop = await harness.Call("query.cancel", new JsonObject { ["queryId"] = args["queryId"]!.GetValue<string>() });
        var (code, value, _) = await running.WaitAsync(TimeSpan.FromSeconds(30));
        var result = value as QueryResult;
        check(busy.Code == "SESSION_BUSY" && stop.Code == "ok" && code == "ok" && result is { Status: "cancelled", Error.Code: "CANCELLED" }
            && Says(result, "The script was cancelled.") && Says(result, "Varia asked BigQuery to cancel job varia-emulator:" + jobs.InsertedIds.Single() + ". Cancelling is best-effort"),
            $"a tab runs one query at a time, and Stop ends the request, saying Varia asked BigQuery to cancel the job: {busy.Code} {code} {result?.Status} {Texts(result?.Messages ?? [])}");
        var cancelled = await BigQuerySessionChecks.Poll(() => jobs.Cancels.Contains(jobs.InsertedIds.Single()));
        check(cancelled, "Stop sends jobs.cancel for the running job");
        jobs.Hang = false;
        var again = await harness.Execute("SELECT 1", next => next["sessionId"] = args["sessionId"]!.GetValue<string>());
        check(again is { Code: "ok", Result.Status: "completed" }, $"the tab runs again once its query ended: {again.Code} {again.Result?.Status}");
        jobs.Hang = true;

        // Stop while a finished job's later pages load: the job is not said to be running.
        jobs.Hang = false;
        jobs.HangPages = true;
        jobs.PageCap = 1;
        jobs.Rows = [Row("1"), Row("2")];
        jobs.Polling = new(TaskCreationOptions.RunContinuationsAsynchronously);
        var paging = harness.Query("SELECT n FROM t");
        var reading = harness.Call("query.execute", paging);
        await Task.WhenAny(jobs.Polling.Task, reading).WaitAsync(TimeSpan.FromSeconds(30));
        await harness.Call("query.cancel", new JsonObject { ["queryId"] = paging["queryId"]!.GetValue<string>() });
        var stopped = (await reading.WaitAsync(TimeSpan.FromSeconds(30))).Result as QueryResult;
        check(stopped is { Status: "cancelled" } && !Says(stopped, "cancel job") && stopped.ResultSets.Single() is { RowsStored: 1, Incomplete: true },
            $"Stop after the job finished keeps the rows read and does not say the job runs on: {stopped?.Status} {Texts(stopped?.Messages ?? [])}");
        jobs.HangPages = false;
        jobs.Hang = true;

        // The execution timeout: Varia stops reading, and BigQuery ends the job itself (jobTimeoutMs).
        var timed = await harness.Execute("SELECT n FROM slow", next => next["timeoutSeconds"] = 1);
        check(timed.Result is { Status: "timedOut", Error.Code: "TIMEOUT" } && Says(timed.Result, "exceeded its execution timeout")
            && jobs.InsertBodies.Last()["configuration"]?["jobTimeoutMs"]?.ToString() == "1000",
            $"the execution timeout ends the request as timedOut, and the job carries it as jobTimeoutMs: {timed.Result?.Status} {timed.Result?.Error}");
    }
}
