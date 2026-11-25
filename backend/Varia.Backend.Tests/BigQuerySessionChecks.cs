using System.Collections.Concurrent;
using System.Globalization;
using System.Net.Http;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using System.Web;
using Varia.Backend.BigQuery;
using Varia.Backend.Protocol;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>
/// BigQuery sessions, scripts and Stop offline (docs/bigquery.md, Scripts, Sessions): a scripted BigQuery (<see cref="Bq"/>,
/// on <see cref="BigQueryFake"/>) that creates sessions, runs scripts with child jobs, commits, aborts sessions and cancels
/// jobs in the shapes Google documents for jobs.insert, jobs.getQueryResults, jobs.get, jobs.list and jobs.cancel. The
/// emulator has no sessions, so everything here is proved on the fake; no request leaves the process.
/// </summary>
internal static partial class BigQuerySessionChecks
{
    static readonly JsonSerializerOptions Wire = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull, UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow
    };
    const string Base = @"https://bigquery\.googleapis\.com/bigquery/v2/projects/varia-alpha";

    /// <summary>A scripted BigQuery with sessions. Statement types come from <see cref="Statements"/> by query text (SELECT
    /// otherwise), scripts' children from <see cref="Scripts"/>, failures from <see cref="Failures"/>.</summary>
    internal sealed class Bq
    {
        internal sealed class FakeJob
        {
            public required string Id;
            public string Sql = "";
            public string? Session;
            public string Statement = "SELECT";
            public string State = "RUNNING";
            public JsonNode? Error;
            public int Polls;
            public string? Parent;
            public long Created;
            public List<FakeJob> Children = [];
            public int Released;
            /// <summary>Stays RUNNING (getQueryResults held, jobs.get RUNNING) until released.</summary>
            public volatile bool Hold;
            /// <summary>Keeps running after jobs.cancel.</summary>
            public bool KeepRunning;
        }

        public readonly ConcurrentDictionary<string, FakeJob> Jobs = new();
        public readonly ConcurrentQueue<JsonNode> Inserts = new();
        public readonly ConcurrentQueue<JsonNode> DryRuns = new();
        public readonly ConcurrentQueue<string> Cancels = new();
        public readonly ConcurrentQueue<string> Aborts = new();
        public readonly ConcurrentQueue<string> Lists = new();
        public readonly Dictionary<string, string> Statements = new(StringComparer.Ordinal);
        public readonly Dictionary<string, (string Statement, JsonNode? Error)[]> Scripts = new(StringComparer.Ordinal);
        public readonly Dictionary<string, JsonNode> Failures = new(StringComparer.Ordinal);
        public readonly HashSet<string> Expired = new(StringComparer.Ordinal);
        /// <summary>Jobs another principal created: jobs.list without allUsers leaves them out.</summary>
        public readonly HashSet<string> Foreign = new(StringComparer.Ordinal);
        /// <summary>DONE jobs whose result table is gone (getQueryResults answers 404).</summary>
        public readonly HashSet<string> ExpiredResults = new(StringComparer.Ordinal);
        /// <summary>Queries whose failure jobs.insert already answers (DONE with the error), as BigQuery does for most analysis errors.</summary>
        public readonly HashSet<string> FailAtInsert = new(StringComparer.Ordinal);
        /// <summary>The next user queries stay RUNNING until released (Stop, JOB_RUNNING).</summary>
        public bool HoldQueries;
        public bool KeepRunningAfterCancel;
        /// <summary>jobs.list answers 403, as for a principal with the Job User role only.</summary>
        public bool ListDenied;
        public int PollsBeforeDone;
        /// <summary>How many more of a script's children each poll of a running script lists.</summary>
        public int ReleaseStep = 1;
        public JsonNode? CommitError;
        public JsonNode? AbortError;
        /// <summary>Answers a COMMIT insert before the normal answer: return a reply, or null for the normal one.</summary>
        public Func<FakeJob, BigQueryFake.Reply?>? CommitReply;
        public TaskCompletionSource Polling = new(TaskCreationOptions.RunContinuationsAsynchronously);
        /// <summary>Other requests the fake leaves unanswered until their call is cancelled.</summary>
        public Func<BigQueryFake.Request, bool>? AlsoHang;
        int sessions;
        long clock = 1_763_500_000_000;

        public BigQueryFake Fake()
        {
            var fake = BigQueryFake.Google();
            fake.Hang = request =>
            {
                if (AlsoHang?.Invoke(request) == true) return true;
                if (!request.Url.Contains("/queries/", StringComparison.Ordinal) || !Jobs.TryGetValue(Last(request), out var job) || !job.Hold) return false;
                Polling.TrySetResult();
                return true;
            };
            fake.On("POST", Base + "/jobs", Insert);
            fake.On("GET", Base + "/jobs", List);
            fake.On("GET", Base + "/jobs/[^/]+", Get);
            fake.On("POST", Base + "/jobs/[^/]+/cancel", Cancel);
            fake.On("GET", Base + "/queries/[^/]+", Results);
            return fake;
        }

        static string Last(BigQueryFake.Request request) => request.Url[(request.Url.LastIndexOf('/') + 1)..];

        public FakeJob Create(JsonNode body)
        {
            var query = body["configuration"]!["query"]!;
            var job = new FakeJob { Id = body["jobReference"]!["jobId"]!.GetValue<string>(), Sql = query["query"]!.GetValue<string>(), Created = Interlocked.Increment(ref clock) };
            var property = query["connectionProperties"]?.AsArray().FirstOrDefault(item => item?["key"]?.GetValue<string>() == "session_id");
            job.Session = property?["value"]?.GetValue<string>() ?? (query["createSession"]?.GetValue<bool>() == true ? "sess-" + Interlocked.Increment(ref sessions) : null);
            if (job.Sql == BigQuerySql.AbortSession)
            {
                job.Statement = "CALL";
                var sessionId = query["queryParameters"]![0]!["parameterValue"]!["value"]!.GetValue<string>();
                Aborts.Enqueue(sessionId);
                job.State = "DONE";
                job.Error = Expired.Contains(sessionId) ? Gone(sessionId) : AbortError?.DeepClone();
            }
            else if (job.Session is { } session && Expired.Contains(session) && property is not null)
            {
                job.State = "DONE";
                job.Error = Gone(session);
            }
            else if (job.Sql == BigQuerySql.Commit)
            {
                job.Statement = "COMMIT_TRANSACTION";
                job.State = "DONE";
                job.Error = CommitError?.DeepClone();
            }
            else if (Scripts.TryGetValue(job.Sql, out var children))
            {
                job.Statement = "SCRIPT";
                job.Polls = PollsBeforeDone;
                job.Hold = HoldQueries;
                job.KeepRunning = KeepRunningAfterCancel;
                foreach (var (statement, error) in children)
                {
                    var child = new FakeJob { Id = "child_" + Guid.NewGuid().ToString("N"), Parent = job.Id, Statement = statement, State = "DONE", Error = error, Created = Interlocked.Increment(ref clock), Session = job.Session };
                    job.Children.Add(child);
                    Jobs[child.Id] = child;
                    if (error is not null) { job.Error = error.DeepClone(); break; }
                }
            }
            else
            {
                job.Statement = Statements.GetValueOrDefault(job.Sql, "SELECT");
                job.Error = Failures.GetValueOrDefault(job.Sql)?.DeepClone();
                if (job.Error is not null && FailAtInsert.Contains(job.Sql)) job.State = "DONE";
                job.Polls = PollsBeforeDone;
                job.Hold = HoldQueries;
                job.KeepRunning = KeepRunningAfterCancel;
            }
            Jobs[job.Id] = job;
            return job;
        }

        static JsonObject Gone(string session) => new() { ["reason"] = "invalidQuery", ["message"] = "Session " + session + " has expired and is no longer available." };

        public BigQueryFake.Reply InsertReply(BigQueryFake.Request request) => Insert(request);
        public BigQueryFake.Reply GetReply(BigQueryFake.Request request) => Get(request);

        BigQueryFake.Reply Insert(BigQueryFake.Request request)
        {
            var body = JsonNode.Parse(request.Body)!;
            if (body["configuration"]?["dryRun"]?.GetValue<bool>() == true)
            {
                DryRuns.Enqueue(body);
                var asked = body["configuration"]!["query"]!["connectionProperties"]?.AsArray().FirstOrDefault(item => item?["key"]?.GetValue<string>() == "session_id")?["value"]?.GetValue<string>();
                if (asked is not null && Expired.Contains(asked)) return new(400, Error(400, Gone(asked)["message"]!.GetValue<string>(), "invalidQuery"));
                return BigQueryFake.Fixture("dry-run");
            }
            Inserts.Enqueue(body);
            var id = body["jobReference"]!["jobId"]!.GetValue<string>();
            if (Jobs.TryGetValue(id, out var existing)) return new(409, Error(409, "Already Exists: Job varia-alpha:US." + existing.Id));
            var job = Create(body);
            if (job.Sql == BigQuerySql.Commit && CommitReply?.Invoke(job) is { } reply) return reply;
            return new(200, Json(job).ToJsonString());
        }

        public static string Error(int code, string message, string reason = "duplicate") =>
            new JsonObject { ["error"] = new JsonObject { ["code"] = code, ["message"] = message, ["errors"] = new JsonArray(new JsonObject { ["reason"] = reason, ["message"] = message }) } }.ToJsonString();

        JsonObject Json(FakeJob job)
        {
            var status = new JsonObject { ["state"] = job.State };
            if (job.State == "DONE" && job.Error is not null) { status["errorResult"] = job.Error.DeepClone(); status["errors"] = new JsonArray(job.Error.DeepClone()); }
            var query = new JsonObject { ["statementType"] = job.Statement };
            if (job.Statement is "INSERT" or "UPDATE" or "DELETE") query["numDmlAffectedRows"] = "2";
            var statistics = new JsonObject { ["creationTime"] = job.Created.ToString(CultureInfo.InvariantCulture), ["query"] = query };
            if (job.Session is not null) statistics["sessionInfo"] = new JsonObject { ["sessionId"] = job.Session };
            if (job.Parent is not null) statistics["parentJobId"] = job.Parent;
            if (job.Children.Count > 0) statistics["numChildJobs"] = job.Children.Count.ToString(CultureInfo.InvariantCulture);
            return new JsonObject
            {
                ["kind"] = "bigquery#job", ["id"] = "varia-alpha:US." + job.Id, ["state"] = job.State,
                ["jobReference"] = new JsonObject { ["projectId"] = "varia-alpha", ["jobId"] = job.Id, ["location"] = "US" },
                ["status"] = status, ["statistics"] = statistics,
                ["configuration"] = new JsonObject { ["jobType"] = "QUERY", ["query"] = new JsonObject { ["useLegacySql"] = false } }
            };
        }

        /// <summary>A held job finishes: its children are all listed, and it is DONE.</summary>
        public void Release(FakeJob job)
        {
            job.Released = job.Children.Count;
            job.Hold = false;
            job.State = "DONE";
        }

        BigQueryFake.Reply Get(BigQueryFake.Request request)
        {
            if (!Jobs.TryGetValue(Last(request), out var job)) return BigQueryFake.Fixture("error-not-found", 404);
            if (!job.Hold && job.Polls == 0 && job.State != "DONE") Release(job);
            return new(200, Json(job).ToJsonString());
        }

        BigQueryFake.Reply Cancel(BigQueryFake.Request request)
        {
            var id = request.Url.Split('/')[^2];
            Cancels.Enqueue(id);
            if (Jobs.TryGetValue(id, out var job) && !job.KeepRunning && job.State != "DONE")
            {
                job.Error = new JsonObject { ["reason"] = "stopped", ["message"] = "Job execution was cancelled: User requested cancellation" };
                Release(job);
            }
            return new(200, "{\"kind\":\"bigquery#jobCancelResponse\"}");
        }

        BigQueryFake.Reply List(BigQueryFake.Request request)
        {
            var query = HttpUtility.ParseQueryString(request.Uri.Query);
            var parent = query["parentJobId"] ?? "";
            Lists.Enqueue(parent);
            if (ListDenied) return new(403, Error(403, "Access Denied: Project varia-alpha: User does not have bigquery.jobs.list permission in project varia-alpha.", "accessDenied"));
            if (parent.Length == 0 && query["minCreationTime"] is { } min && query["maxCreationTime"] is { } max)
            {
                // The caller's own jobs created in the window (no allUsers): another principal's are not listed.
                var from = long.Parse(min, CultureInfo.InvariantCulture);
                var to = long.Parse(max, CultureInfo.InvariantCulture);
                var own = Jobs.Values.Where(item => item.Parent is null && item.Created >= from && item.Created <= to && !Foreign.Contains(item.Id)).Select(item => (JsonNode)Json(item)).ToArray();
                return new(200, new JsonObject { ["kind"] = "bigquery#jobList", ["jobs"] = new JsonArray(own) }.ToJsonString());
            }
            if (!Jobs.TryGetValue(parent, out var job)) return new(200, "{\"kind\":\"bigquery#jobList\"}");
            // Newest first, as BigQuery lists them, in pages of maxResults.
            var skip = query["pageToken"] is { } from0 && from0.StartsWith('p') ? int.Parse(from0[1..], CultureInfo.InvariantCulture) : 0;
            var size = query["maxResults"] is { } asked ? int.Parse(asked, CultureInfo.InvariantCulture) : int.MaxValue;
            var all = job.Children.Take(job.Released).Reverse().ToList();
            var items = all.Skip(skip).Take(size).Select(child => (JsonNode)Json(child)).ToArray();
            var list = new JsonObject { ["kind"] = "bigquery#jobList", ["jobs"] = new JsonArray(items) };
            if (skip + items.Length < all.Count) list["nextPageToken"] = "p" + (skip + items.Length).ToString(CultureInfo.InvariantCulture);
            return new(200, list.ToJsonString());
        }

        BigQueryFake.Reply Results(BigQueryFake.Request request)
        {
            if (!Jobs.TryGetValue(Last(request), out var job)) return BigQueryFake.Fixture("error-not-found", 404);
            if (ExpiredResults.Contains(job.Id) && job.State == "DONE") return BigQueryFake.Fixture("error-not-found", 404);
            var reference = new JsonObject { ["projectId"] = "varia-alpha", ["jobId"] = job.Id, ["location"] = "US" };
            if (job.Polls > 0)
            {
                job.Polls--;
                job.Released = Math.Min(job.Children.Count, job.Released + ReleaseStep);
                return new(200, new JsonObject { ["kind"] = "bigquery#getQueryResultsResponse", ["jobReference"] = reference, ["jobComplete"] = false }.ToJsonString());
            }
            Release(job);
            if (job.Error is not null) return new(400, Error(400, job.Error["message"]!.GetValue<string>(), job.Error["reason"]!.GetValue<string>()));
            var answer = new JsonObject { ["kind"] = "bigquery#getQueryResultsResponse", ["jobReference"] = reference, ["jobComplete"] = true, ["totalBytesProcessed"] = "0", ["cacheHit"] = false };
            if (job.Statement is "SELECT" or "SCRIPT")
            {
                answer["schema"] = new JsonObject { ["fields"] = new JsonArray(new JsonObject { ["name"] = "n", ["type"] = "INTEGER", ["mode"] = "NULLABLE" }) };
                answer["totalRows"] = "1";
                answer["rows"] = new JsonArray(new JsonObject { ["f"] = new JsonArray(new JsonObject { ["v"] = "1" }) });
            }
            if (job.Statement is "INSERT" or "UPDATE" or "DELETE") answer["numDmlAffectedRows"] = "2";
            return new(200, answer.ToJsonString());
        }

        public IEnumerable<JsonNode> UserInserts => Inserts.Where(body => body["configuration"]!["query"]!["query"]!.GetValue<string>() is not (BigQuerySql.Commit or BigQuerySql.AbortSession));
        public IEnumerable<JsonNode> Commits => Inserts.Where(body => body["configuration"]!["query"]!["query"]!.GetValue<string>() == BigQuerySql.Commit);
    }

    sealed class Harness : IDisposable
    {
        public Bq Bq { get; }
        public BigQueryFake Fake { get; }
        public SqlService Service { get; }
        public BigQueryService BigQuery => Service.BigQuery;
        public string ConnectionId { get; private set; } = "";
        public readonly ConcurrentQueue<(string Type, bool Droppable, JsonElement Body)> Events = new();
        uint ids;

        public Harness(Bq bq)
        {
            Bq = bq;
            Fake = bq.Fake();
            Service = new SqlService(CheckStores.Unprobed(), bigQuery: new BigQueryEnvironment(null, Fake.Factory, new SubjectTokens([])));
            BigQuery.RetryDelay = TimeSpan.FromMilliseconds(1);
            BigQuery.ChildPollMs = 50;
            BigQuery.DonePoll = TimeSpan.FromMilliseconds(10);
            BigQuery.PendingPoll = TimeSpan.FromMilliseconds(20);
            BigQuery.HeldPoll = TimeSpan.FromMilliseconds(20);
        }

        public async Task ConnectAsync(JsonObject key, Action<JsonObject>? configure = null)
        {
            var options = new JsonObject
            {
                ["provider"] = "bigquery", ["project"] = "varia-alpha", ["authentication"] = "serviceAccountKey", ["dataset"] = "sales", ["location"] = "US",
                ["credential"] = new JsonObject { ["source"] = "file", ["json"] = key.ToJsonString() }, ["keyFile"] = Guid.NewGuid().ToString()
            };
            configure?.Invoke(options);
            var (code, result, message) = await Call("connections.connect", options);
            if (code != "ok") throw new InvalidOperationException("connect: " + code + " " + message);
            ConnectionId = ((ConnectionInfo)result!).Id;
        }

        public async Task<(string Code, object? Result, string Message)> Call(string method, JsonNode parameters, RequestContext? context = null)
        {
            using var document = JsonDocument.Parse(parameters.ToJsonString());
            try { return ("ok", await Service.DispatchAsync(method, document.RootElement.Clone(), Wire, context), ""); }
            catch (RequestException error) { return (error.Code, null, error.Message); }
        }

        public JsonObject Query(string tab, string sql, Action<JsonObject>? change = null)
        {
            var args = new JsonObject
            {
                ["connectionId"] = ConnectionId, ["sessionId"] = tab, ["queryId"] = Guid.NewGuid().ToString(), ["sql"] = sql, ["maxRows"] = 0, ["timeoutSeconds"] = 0
            };
            change?.Invoke(args);
            return args;
        }

        /// <summary>Runs a query with a request context, so its events are recorded.</summary>
        public async Task<(string Code, QueryResult? Result, string Message)> Execute(string tab, string sql, Action<JsonObject>? change = null)
        {
            using var context = new RequestContext(++ids, "query.execute", RequestLane.Query, 0, sendEvent: (_, body, droppable) =>
            {
                var element = JsonSerializer.SerializeToElement(body, body.GetType(), Wire);
                Events.Enqueue((element.GetProperty("type").GetString() ?? "", droppable, element));
            });
            var (code, result, message) = await Call("query.execute", Query(tab, sql, change), context);
            return (code, result as QueryResult, message);
        }

        public async Task<(string Code, SessionState? State)> State(string tab)
        {
            var (code, result, _) = await Call("query.session.state", new JsonObject { ["sessionId"] = tab });
            return (code, result as SessionState);
        }

        public async Task<(string Code, SessionCloseResult? Result, string Message)> Close(string tab, string? transaction = null, bool? abortOnRefusedCommit = null)
        {
            var args = new JsonObject { ["sessionId"] = tab };
            if (transaction is not null) args["transaction"] = transaction;
            if (abortOnRefusedCommit is { } abort) args["abortOnRefusedCommit"] = abort;
            var (code, result, message) = await Call("query.session.close", args);
            return (code, result as SessionCloseResult, message);
        }

        public void Dispose() => Service.Dispose();
    }

    static string Texts(IEnumerable<MessageEntry> messages) => string.Join(" | ", messages.Select(message => message.Text));
    static bool Says(QueryResult? result, string text) => result?.Messages.Any(message => message.Text.Contains(text, StringComparison.Ordinal)) == true;
    static JsonObject Failure(string reason, string message) => new() { ["reason"] = reason, ["location"] = "query", ["message"] = message };
    static string Tab() => Guid.NewGuid().ToString();
    static string? SessionOf(JsonNode body) =>
        body["configuration"]!["query"]!["connectionProperties"]?.AsArray().FirstOrDefault(item => item?["key"]?.GetValue<string>() == "session_id")?["value"]?.GetValue<string>();

    /// <summary>Waits for a condition (background work: a pending abort, a best-effort cancel), returning early.</summary>
    internal static async Task<bool> Poll(Func<bool> condition, int seconds = 30)
    {
        var watch = System.Diagnostics.Stopwatch.StartNew();
        while (!condition())
        {
            if (watch.Elapsed > TimeSpan.FromSeconds(seconds)) return false;
            await Task.Delay(5);
        }
        return true;
    }

    public static async Task RunAsync(Action<bool, string> check)
    {
        Lint(check);
        Positions(check);
        Transitions(check);
        using var rsa = System.Security.Cryptography.RSA.Create(2048);
        var key = BigQueryCredentialChecks.Key(rsa.ExportPkcs8PrivateKeyPem());
        await SessionsAsync(check, key);
        await ScriptsAsync(check, key);
        await RefusalsAsync(check, key);
        await UnknownOutcomeAsync(check, key);
        await ExpiryAsync(check, key);
        await DryRunsAsync(check, key);
        await StopAsync(check, key);
        await StopWhileDecidingAsync(check, key);
        await DetachAsync(check, key);
        await AttachAsync(check, key);
        await IdleEndsAsync(check, key);
        await CancelJobsAsync(check, key);
    }

    /// <summary>Stop while a script child's residence is being decided (its jobs.get hangs): the set the run's end closes was
    /// announced first, never a resultSet.closed for a set the grid never heard open.</summary>
    static async Task StopWhileDecidingAsync(Action<bool, string> check, JsonObject key)
    {
        var bq = new Bq();
        bq.Scripts["SCRIPT two"] = [("SELECT", null), ("SELECT", null)];
        using var harness = new Harness(bq);
        await harness.ConnectAsync(key);
        // A child's first page with more to come, so deciding its residence asks jobs.get for the destination table.
        harness.Fake.On("GET", Base + "/queries/child_[^/]+", request =>
        {
            var id = request.Url[(request.Url.LastIndexOf('/') + 1)..];
            var asked = HttpUtility.ParseQueryString(request.Uri.Query);
            var offset = asked["pageToken"] is { } token ? int.Parse(token[5..], CultureInfo.InvariantCulture) : 0;
            var count = Math.Min(100, 5000 - offset);
            var rows = new JsonArray([.. Enumerable.Range(offset, count).Select(i => (JsonNode)new JsonObject { ["f"] = new JsonArray(new JsonObject { ["v"] = i.ToString(CultureInfo.InvariantCulture) }, new JsonObject { ["v"] = "x" }) })]);
            var answer = new JsonObject { ["kind"] = "bigquery#getQueryResultsResponse", ["jobReference"] = new JsonObject { ["projectId"] = "varia-alpha", ["jobId"] = id, ["location"] = "US" }, ["jobComplete"] = true,
                ["schema"] = new JsonObject { ["fields"] = new JsonArray(new JsonObject { ["name"] = "n", ["type"] = "INTEGER", ["mode"] = "NULLABLE" }, new JsonObject { ["name"] = "s", ["type"] = "STRING", ["mode"] = "NULLABLE" }) },
                ["totalRows"] = "5000", ["rows"] = rows, ["pageToken"] = "page-" + (offset + count) };
            return new(200, answer.ToJsonString());
        });
        var hung = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        harness.Fake.Hang = request => { if (request.Method == "GET" && request.Url.Contains("/jobs/child_", StringComparison.Ordinal)) { hung.TrySetResult(); return true; } return false; };
        var args = harness.Query(Tab(), "SCRIPT two", query => query["residence"] = "windowed");
        using var context = new RequestContext(1, "query.execute", RequestLane.Query, 0, sendEvent: (_, body, droppable) =>
        {
            var element = JsonSerializer.SerializeToElement(body, body.GetType(), Wire);
            harness.Events.Enqueue((element.GetProperty("type").GetString() ?? "", droppable, element));
        });
        var running = harness.Call("query.execute", args, context);
        var deciding = await Task.WhenAny(hung.Task, Task.Delay(15_000)) == hung.Task;
        await harness.Call("query.cancel", new JsonObject { ["queryId"] = args["queryId"]!.GetValue<string>() });
        var (code, result, _) = await running;
        harness.Fake.Hang = null;
        var order = harness.Events.Where(item => item.Type.StartsWith("resultSet.", StringComparison.Ordinal)).Select(item => item.Type).ToArray();
        check(deciding && code == "ok" && (result as QueryResult)?.Status == "cancelled" && order.Length > 0 && order[0] == "resultSet.opened" && order.Count(type => type == "resultSet.closed") == 1,
            $"Stop while a script child's residence is decided announces its set before closing it: {deciding} {code} {(result as QueryResult)?.Status} {string.Join(", ", order)}");
    }

    /// <summary>The SQL the backend runs against BigQuery (docs/architecture.md, SQL the backend runs): constant text, values
    /// only as parameters, and a session id kept only when it is a token.</summary>
    static void Lint(Action<bool, string> check)
    {
        var parameters = BigQuerySql.All.SelectMany(sql => System.Text.RegularExpressions.Regex.Matches(sql, @"@(\w+)").Select(match => match.Groups[1].Value)).ToArray();
        check(BigQuerySql.All.Count == 2 && BigQuerySql.All.All(sql => !sql.Contains('\'') && !sql.Contains('"') && !sql.Contains('`') && !sql.Contains(';') && !sql.Contains("--", StringComparison.Ordinal))
            && parameters.SequenceEqual([BigQuerySql.AbortSessionParameter]),
            "BigQuery's own statements are constant text with no literal, and ABORT_SESSION takes the session id only as a parameter: " + string.Join(", ", parameters));
        check(BigQuerySql.SessionId().IsMatch("CgwKCnZhcmlhLWFscGhhEAEaJDA2ZmQ5ZjZh-YzI0_ZC00=") && !BigQuerySql.SessionId().IsMatch("a'b") && !BigQuerySql.SessionId().IsMatch("")
            && !BigQuerySql.SessionId().IsMatch(new string('a', 1025)) && !BigQuerySql.SessionId().IsMatch("a b"),
            "a session id is kept only as an opaque token of URL-safe base64 characters, at most 1,024");
        check(BigQueryErrors.IsSessionGone("Session CgwK has expired and is no longer available.") && BigQueryErrors.IsSessionGone("The session was not found.")
            && !BigQueryErrors.IsSessionGone("Not found: Table varia-alpha:sales.sessions was not found in location US") && !BigQueryErrors.IsSessionGone("Transaction is aborted due to concurrent update")
            && !BigQueryErrors.IsSessionGone(null),
            "only a message saying the session is gone counts as an expired session");
        check(!BigQueryErrors.IsSessionGone("Name session not found inside e at [1:10]") && !BigQueryErrors.IsSessionGone("Not found: Table varia-alpha:sales.session was not found in location US")
            && !BigQueryErrors.IsSessionGone("Field name session does not exist in STRUCT<a INT64> at [1:8]")
            && BigQueryErrors.IsSessionGone("Cannot run the query: session CgwKCnZhcmlh has expired.", "CgwKCnZhcmlh") && !BigQueryErrors.IsSessionGone("Cannot run the query: session CgwKCnZhcmlh has expired."),
            "an analysis error about a name, table or field called session is not an expired session; a message naming the session's id is");
    }

    /// <summary>BigQuery's [line:column] positions are the submitted text's; Varia adds the selection's first line and, on
    /// that line only, its first column.</summary>
    static void Positions(Action<bool, string> check)
    {
        var first = SqlService.EditorPositions("Syntax error: Unexpected keyword FROM at [1:8]", 5, 3, out var firstLine);
        var later = SqlService.EditorPositions("Unrecognized name: x at [3:4]; see [1:2]", 10, 7, out var laterLine);
        var none = SqlService.EditorPositions("Access Denied", 4, 2, out var noLine);
        var odd = SqlService.EditorPositions("at [0:4] and [99999999:1]", 1, 1, out _);
        check(first == "Syntax error: Unexpected keyword FROM at [5:10]" && firstLine == 5 && later == "Unrecognized name: x at [12:4]; see [10:8]" && laterLine == 12
            && none == "Access Denied" && noLine is null && odd == "at [0:4] and [99999999:1]",
            $"error positions map to the editor's line and column: {first} {later} {odd}");
    }

    static void Transitions(Action<bool, string> check)
    {
        var none = BigQueryTransaction.None;
        var open = BigQueryService.Apply(none, "BEGIN_TRANSACTION", false);
        check(open == BigQueryTransaction.Open && BigQueryService.Apply(open, "INSERT", false) == BigQueryTransaction.Open
            && BigQueryService.Apply(open, "COMMIT_TRANSACTION", false) == none && BigQueryService.Apply(open, "ROLLBACK_TRANSACTION", false) == none
            && BigQueryService.Apply(open, "COMMIT_TRANSACTION", true) == BigQueryTransaction.Unknown && BigQueryService.Apply(none, "SELECT", true) == none
            && BigQueryService.Apply(BigQueryTransaction.Unknown, "BEGIN_TRANSACTION", false) == BigQueryTransaction.Open && BigQueryService.Apply(BigQueryTransaction.Unknown, "COMMIT_TRANSACTION", false) == none,
            "BEGIN opens a transaction, a successful COMMIT or ROLLBACK closes it, and a failure inside it leaves it unknown");
    }

    /// <summary>A tab's session: created by its first job, carried by the next, tracked, committed and ended.</summary>
    static async Task SessionsAsync(Action<bool, string> check, JsonObject key)
    {
        var bq = new Bq();
        bq.Statements["BEGIN TRANSACTION"] = "BEGIN_TRANSACTION";
        bq.Statements["INSERT INTO t VALUES (1)"] = "INSERT";
        bq.Failures["SELECT boom"] = Failure("invalidQuery", "Unrecognized name: boom at [1:8]");
        using var harness = new Harness(bq);
        await harness.ConnectAsync(key);
        var tab = Tab();
        var none = await harness.State(tab);
        var begun = await harness.Execute(tab, "BEGIN TRANSACTION");
        var first = bq.UserInserts.Single();
        check(none.Code == "SESSION_CLOSED" && begun is { Code: "ok", Result.Status: "completed" } && first["configuration"]!["query"]!["createSession"]?.GetValue<bool>() == true && SessionOf(first) is null,
            $"a tab's first job creates its BigQuery session and carries no session id: {none.Code} {begun.Code} {begun.Message} {Texts(begun.Result?.Messages ?? [])}");
        var opened = await harness.State(tab);
        check(opened is { Code: "ok", State: { TransactionCount: 1, Checked: true } }, $"BEGIN TRANSACTION opens the tracked transaction: {opened.Code} {opened.State}");
        var jobs = harness.Events.Where(item => item.Type == "query.job").ToArray();
        check(jobs.Length == 2 && jobs.All(item => !item.Droppable) && jobs[0].Body.GetProperty("state").GetString() == "running" && jobs[1].Body.GetProperty("state").GetString() == "done"
            && jobs.All(item => item.Body.GetProperty("transaction").GetString() == "none" && item.Body.GetProperty("project").GetString() == "varia-alpha" && !item.Body.GetProperty("auxiliary").GetBoolean()
                && item.Body.GetProperty("jobId").GetString() == first["jobReference"]!["jobId"]!.GetValue<string>())
            && !jobs.Any(item => item.Body.GetRawText().Contains("sess-", StringComparison.Ordinal)),
            "query.job is essential, sent as the job starts and finishes with the transaction as it started, and never names the session: " + string.Join(", ", jobs.Select(item => item.Body.GetRawText())));

        var inserted = await harness.Execute(tab, "INSERT INTO t VALUES (1)");
        var second = bq.UserInserts.Last();
        var running = harness.Events.Where(item => item.Type == "query.job").Skip(2).FirstOrDefault();
        check(inserted is { Code: "ok", Result.RecordsAffected: 2 } && SessionOf(second) == "sess-1" && second["configuration"]!["query"]!["createSession"] is null
            && running.Body.ValueKind == JsonValueKind.Object && running.Body.GetProperty("transaction").GetString() == "open",
            $"the next job carries the session id, and its event says the transaction was open: {inserted.Code} {second.ToJsonString()}");
        var failed = await harness.Execute(tab, "SELECT boom");
        var unknown = await harness.State(tab);
        check(failed.Result is { Status: "failed" } && unknown is { Code: "ok", State: { TransactionCount: 0, Checked: false } },
            $"a statement that fails inside the transaction leaves it unknown (not checked): {failed.Result?.Status} {unknown.State}");

        // Close with Commit: COMMIT TRANSACTION in the session, then ABORT_SESSION outside it with the id as a parameter.
        var closed = await harness.Close(tab, "commit");
        var commit = bq.Commits.Single();
        var abort = bq.Inserts.Last();
        check(closed is { Code: "ok", Result: { Closed: true, Note: null } } && SessionOf(commit) == "sess-1" && bq.Aborts.SequenceEqual(["sess-1"]) && SessionOf(abort) is null
            && abort["configuration"]!["query"]!["queryParameters"]![0]!["parameterType"]!["type"]!.GetValue<string>() == "STRING",
            $"a commit close commits in the session, then ends it outside the session: {closed.Code} {closed.Message} {closed.Result}");
        check((await harness.State(tab)).Code == "SESSION_CLOSED" && (await harness.Close(tab)).Result is { Closed: false }, "an ended session is gone: its state reads SESSION_CLOSED and a second close finds none");

        // A plain close of a tab with no transaction ends the session; emulator-free, so the abort runs.
        var plain = Tab();
        await harness.Execute(plain, "SELECT 1");
        var ended = await harness.Close(plain);
        check(ended is { Code: "ok", Result: { Closed: true, Note: null } } && bq.Aborts.Last() == "sess-2", $"a plain close ends the session: {ended.Code} {string.Join(",", bq.Aborts)}");
        check(harness.Fake.Unmatched.IsEmpty, "sessions send nothing the scripted BigQuery does not answer: " + string.Join(", ", harness.Fake.Unmatched.Select(request => request.Method + " " + request.Url)));

        // Varia's own session jobs bill nothing, but none goes out uncapped: 10 MiB, even under a lower connection cap, which
        // would otherwise refuse a commit and roll its transaction back.
        var own = bq.Inserts.Where(body => body["configuration"]!["query"]!["query"]!.GetValue<string>() is BigQuerySql.Commit or BigQuerySql.AbortSession).ToArray();
        check(own.Length == 3 && own.All(body => Cap(body) == "10485760"),
            "COMMIT TRANSACTION and ABORT_SESSION carry a 10 MiB maximumBytesBilled: " + string.Join(", ", own.Select(Cap)));
        var lowBq = new Bq();
        lowBq.Statements["BEGIN TRANSACTION"] = "BEGIN_TRANSACTION";
        using var low = new Harness(lowBq);
        await low.ConnectAsync(key, options => options["maximumBytesBilled"] = 1000);
        var capped = Tab();
        await low.Execute(capped, "BEGIN TRANSACTION");
        await low.Close(capped, "commit");
        var lowOwn = lowBq.Inserts.Where(body => body["configuration"]!["query"]!["query"]!.GetValue<string>() is BigQuerySql.Commit or BigQuerySql.AbortSession).ToArray();
        check(lowOwn.Length == 2 && lowOwn.All(body => Cap(body) == "10485760"),
            "a connection's cap below 10 MiB leaves its session jobs at 10 MiB: " + string.Join(", ", lowOwn.Select(Cap)));
        static string? Cap(JsonNode body) => body["configuration"]!["query"]!["maximumBytesBilled"]?.ToString();
    }

    /// <summary>Scripts: children listed between polls and read in statement order, DML counts and DDL sentences, a failing
    /// child with its billed predecessors and its position in the editor, and the children deciding the transaction.</summary>
    static async Task ScriptsAsync(Action<bool, string> check, JsonObject key)
    {
        var bq = new Bq { PollsBeforeDone = 2 };
        bq.Scripts["SCRIPT ok"] = [("BEGIN_TRANSACTION", null), ("SELECT", null), ("INSERT", null), ("CREATE_TABLE", null), ("COMMIT_TRANSACTION", null)];
        bq.Scripts["SCRIPT fails"] = [("BEGIN_TRANSACTION", null), ("INSERT", null), ("UPDATE", Failure("invalidQuery", "Syntax error: Unexpected identifier at [2:5]"))];
        using var harness = new Harness(bq);
        await harness.ConnectAsync(key);
        var tab = Tab();
        var ok = await harness.Execute(tab, "SCRIPT ok");
        var parent = bq.UserInserts.Single()["jobReference"]!["jobId"]!.GetValue<string>();
        var texts = Texts(ok.Result?.Messages ?? []);
        check(ok is { Code: "ok", Result.Status: "completed", Result.RecordsAffected: 2 } && ok.Result.ResultSets.Count == 1 && ok.Result.ResultSets[0].RowsStored == 1
            && Says(ok.Result, "(2 rows affected)") && Says(ok.Result, "The script completed.") && texts.IndexOf("(1 row affected)", StringComparison.Ordinal) < texts.IndexOf("(2 rows affected)", StringComparison.Ordinal),
            $"a script's SELECT child is a result set and its DML child a row count, in statement order: {ok.Code} {texts}");
        check(bq.Lists.Count(item => item == parent) >= 3, $"children are listed between polls, then once in full: {bq.Lists.Count(item => item == parent)}");
        var state = await harness.State(tab);
        check(state.State is { TransactionCount: 0, Checked: true }, $"a script's children decide the transaction (BEGIN … COMMIT closes it): {state.State}");
        // The fake's minimal projection leaves out statistics.query and parentJobId, as BigQuery's does: only the full one names
        // a child's statement type, rows affected and DDL target.
        var childListings = harness.Fake.To(Base + "/jobs").Where(request => HttpUtility.ParseQueryString(request.Uri.Query)["parentJobId"] is not null).ToList();
        check(childListings.Count >= 3 && childListings.All(request => HttpUtility.ParseQueryString(request.Uri.Query)["projection"] == "full"),
            $"a script's children are listed with projection=full: {string.Join(" | ", childListings.Select(request => request.Uri.Query))}");
        // A poll between reads asks for a few children first; the final listing for pages of 200.
        check(childListings.Select(request => HttpUtility.ParseQueryString(request.Uri.Query)["maxResults"]).ToHashSet() is var asked && asked.Contains("20") && asked.Contains("200"),
            $"listings between polls start at 20 children a page, the final one at 200: {string.Join(",", childListings.Select(request => HttpUtility.ParseQueryString(request.Uri.Query)["maxResults"]))}");

        // A page of full jobs larger than the byte limit is asked again with fewer jobs; one child alone too large cuts the listing short.
        var listed0 = harness.Fake.Seen.Count;
        var pageBytes = harness.BigQuery.ChildPageBytes;
        harness.BigQuery.ChildPageBytes = 1_000;
        var shrunk = await harness.Execute(Tab(), "SCRIPT ok");
        var sizes = harness.Fake.Seen.Skip(listed0).Where(request => request.Url.EndsWith("/jobs", StringComparison.Ordinal) && HttpUtility.ParseQueryString(request.Uri.Query)["parentJobId"] is not null)
            .Select(request => HttpUtility.ParseQueryString(request.Uri.Query)["maxResults"]).Distinct().ToList();
        check(shrunk is { Code: "ok", Result.Status: "completed" } && Says(shrunk.Result, "(2 rows affected)") && sizes.Contains("200") && sizes.Contains("50"),
            $"a children page over the byte limit is asked again with fewer jobs: {string.Join(",", sizes)}");
        harness.BigQuery.ChildPageBytes = 100;
        var tooLarge = Tab();
        var cut = await harness.Execute(tooLarge, "SCRIPT ok");
        check(cut is { Code: "ok", Result.Status: "completed" } && (await harness.State(tooLarge)).State is { Checked: false },
            $"a child larger than the byte limit leaves the listing incomplete, so the transaction is unknown: {cut.Code} {(await harness.State(tooLarge)).State}");
        harness.BigQuery.ChildPageBytes = pageBytes;

        // A listing between polls that is cut short holds only the newest children: none is read until a listing reaches the
        // ones before it, so statements still come in order (here two finish per poll, and a poll lists one page of one).
        bq.ReleaseStep = 2;
        (harness.BigQuery.IncrementalChildPageSize, harness.BigQuery.MaxChildPages) = (1, 1);
        var inOrder = await harness.Execute(Tab(), "SCRIPT ok");
        (harness.BigQuery.IncrementalChildPageSize, harness.BigQuery.MaxChildPages) = (20, 500);
        bq.ReleaseStep = 1;
        static string Ids(string text) => System.Text.RegularExpressions.Regex.Replace(text, "varia_[0-9a-f]{32}", "job");
        check(inOrder is { Code: "ok", Result.Status: "completed" } && Ids(Texts(inOrder.Result.Messages)) == Ids(texts) && inOrder.Result.ResultSets.Count == 1,
            $"an incremental listing cut short reads nothing, so the statements keep their order: {Texts(inOrder.Result?.Messages ?? [])}");

        var failed = await harness.Execute(tab, "SCRIPT fails", args => { args["startLine"] = 10; args["startColumn"] = 3; });
        var error = failed.Result?.Messages.FirstOrDefault(message => message.Kind == "error" && message.Text.Contains("Syntax error", StringComparison.Ordinal));
        check(failed.Result is { Status: "failed" } && error is { Line: 11 } && error.Text.Contains("[11:5]", StringComparison.Ordinal)
            && Says(failed.Result, "2 statements before the failing one ran, and BigQuery billed them."),
            $"a failing child names its editor position and how many statements ran and were billed: {Texts(failed.Result?.Messages ?? [])}");
        var unknown = await harness.State(tab);
        check(unknown.State is { TransactionCount: 0, Checked: false }, $"a child failing inside the script's transaction leaves it unknown: {unknown.State}");

        // Without bigquery.jobs.list the script still runs: the parent's rows are shown, and the transaction is unknown.
        bq.ListDenied = true;
        var denied = Tab();
        var listed = await harness.Execute(denied, "SCRIPT ok");
        bq.ListDenied = false;
        check(listed is { Code: "ok", Result.Status: "completed" } && listed.Result.ResultSets.Count == 1 && Says(listed.Result, "Varia could not list the script's statements")
            && (await harness.State(denied)).State is { Checked: false },
            $"a script whose children cannot be listed still completes with its last statement's rows, and its transaction is unknown: {listed.Code} {Texts(listed.Result?.Messages ?? [])}");
    }

    /// <summary>Refused commits: kept on a checked session, ended with a note on an unchecked one (not at quit), retryable
    /// refusals kept, an insert that never left kept as CONNECTION_LOST, an answer lost after sending found by lookup, and
    /// a failed abort.</summary>
    static async Task RefusalsAsync(Action<bool, string> check, JsonObject key)
    {
        var bq = new Bq();
        bq.Statements["BEGIN TRANSACTION"] = "BEGIN_TRANSACTION";
        bq.Failures["SELECT boom"] = Failure("invalidQuery", "Unrecognized name: boom");
        using var harness = new Harness(bq);
        await harness.ConnectAsync(key);
        async Task<string> Open(bool unchecked_)
        {
            var tab = Tab();
            await harness.Execute(tab, "BEGIN TRANSACTION");
            if (unchecked_) await harness.Execute(tab, "SELECT boom");
            return tab;
        }

        bq.CommitError = Failure("invalidQuery", "Transaction is aborted due to concurrent update against table t.");
        var checkedTab = await Open(false);
        var aborts = bq.Aborts.Count;
        var refused = await harness.Close(checkedTab, "commit");
        check(refused.Code is not "ok" && refused.Message.StartsWith("The transaction was not committed, and the query stays open. ", StringComparison.Ordinal)
            && refused.Message.Contains("concurrent update", StringComparison.Ordinal) && bq.Aborts.Count == aborts && (await harness.State(checkedTab)).Code == "ok",
            $"a commit refused on a checked session keeps the session and its transaction: {refused.Code} {refused.Message}");

        var uncheckedTab = await Open(true);
        var quit = await harness.Close(uncheckedTab, "commit", abortOnRefusedCommit: false);
        check(quit.Code is not "ok" && quit.Message.StartsWith("The transaction was not committed", StringComparison.Ordinal) && bq.Aborts.Count == aborts && (await harness.State(uncheckedTab)).Code == "ok",
            $"at quit (abortOnRefusedCommit false) a refused commit on an unchecked session keeps it too: {quit.Code}");
        var fell = await harness.Close(uncheckedTab, "commit");
        check(fell is { Code: "ok", Result: { Closed: true, Note: { Code: "commitNotApplied" } note } } && note.Message!.Contains("concurrent update", StringComparison.Ordinal)
            && bq.Aborts.Count == aborts + 1 && (await harness.State(uncheckedTab)).Code == "SESSION_CLOSED",
            $"a commit refused on an unchecked session falls through to the session's end, saying the commit was not applied: {fell.Code} {fell.Result}");

        bq.CommitError = Failure("rateLimitExceeded", "Exceeded rate limits: too many concurrent queries.");
        var retryTab = await Open(true);
        var retry = await harness.Close(retryTab, "commit");
        check(retry.Code is not "ok" && retry.Message.StartsWith("The transaction was not committed, and the query stays open.", StringComparison.Ordinal) && (await harness.State(retryTab)).Code == "ok",
            $"a retryable refusal keeps even an unchecked session: {retry.Code} {retry.Message}");

        // An insert that never left the machine: retried, then refused so the user can close again.
        bq.CommitError = null;
        harness.Fake.Fault = request => request.Method == "POST" && request.Body.Contains("COMMIT TRANSACTION", StringComparison.Ordinal)
            ? new HttpRequestException(HttpRequestError.ConnectionError, "No connection could be made.") : null;
        var lostTab = await Open(false);
        var lost = await harness.Close(lostTab, "commit");
        harness.Fake.Fault = null;
        check(lost.Code == "CONNECTION_LOST" && lost.Message.StartsWith("The transaction was not committed, and the query stays open:", StringComparison.Ordinal) && (await harness.State(lostTab)).State is { TransactionCount: 1 },
            $"a commit whose insert never reached BigQuery is refused and keeps the session: {lost.Code} {lost.Message}");
        var again = await harness.Close(lostTab, "commit");
        check(again is { Code: "ok", Result.Note: null }, $"the same close succeeds on the next try: {again.Code} {again.Message}");

        // The commit budget runs out during a retry's backoff: still nothing was sent, so still CONNECTION_LOST.
        var (delay, budget) = (harness.BigQuery.RetryDelay, harness.BigQuery.CommitLimit);
        harness.BigQuery.RetryDelay = TimeSpan.FromSeconds(10);
        harness.BigQuery.CommitLimit = TimeSpan.FromMilliseconds(300);
        harness.Fake.Fault = request => request.Method == "POST" && request.Body.Contains("COMMIT TRANSACTION", StringComparison.Ordinal)
            ? new HttpRequestException(HttpRequestError.ConnectionError, "No connection could be made.") : null;
        var backoffTab = await Open(false);
        var pending = harness.BigQuery.PendingAborts;
        var backoff = await harness.Close(backoffTab, "commit");
        harness.Fake.Fault = null;
        (harness.BigQuery.RetryDelay, harness.BigQuery.CommitLimit) = (delay, budget);
        check(backoff.Code == "CONNECTION_LOST" && (await harness.State(backoffTab)).State is { TransactionCount: 1 } && harness.BigQuery.PendingAborts == pending,
            $"a commit budget spent between retries of an insert that never left is CONNECTION_LOST, not an unknown outcome: {backoff.Code} {backoff.Result}");
        await harness.Close(backoffTab, "rollback");

        // A session query whose insert never left (or BigQuery refused) created no job, so it does not hold the session.
        var unsentTab = Tab();
        await harness.Execute(unsentTab, "SELECT 1");
        harness.Fake.Fault = request => request.Method == "POST" && request.Body.Contains("SELECT 2", StringComparison.Ordinal)
            ? new HttpRequestException(HttpRequestError.ConnectionError, "No connection could be made.") : null;
        var unsent = await harness.Execute(unsentTab, "SELECT 2");
        harness.Fake.Fault = null;
        var after = await harness.Execute(unsentTab, "SELECT 3");
        var unsentState = await harness.State(unsentTab);
        check(unsent.Code == "ok" && unsent.Result?.Status == "failed" && after is { Code: "ok", Result.Status: "completed" } && !Says(after.Result, "Waiting for BigQuery job")
            && unsentState.State is { Checked: true },
            $"an insert that never reached BigQuery leaves the session free for the next query: {unsent.Result?.Status} {after.Code} {after.Result?.Status} {Texts(after.Result?.Messages ?? [])}");

        // A 500 after BigQuery created the COMMIT: the outcome is found by its job id.
        bq.CommitReply = job => new(500, Bq.Error(500, "Backend error.", "backendError"));
        var lookupTab = await Open(false);
        var looked = await harness.Close(lookupTab, "commit");
        bq.CommitReply = null;
        check(looked is { Code: "ok", Result.Note: null } && bq.Commits.Count(body => SessionOf(body) is not null) >= 1,
            $"a commit answered with a 5xx is looked up by its id and counts once it is DONE: {looked.Code} {looked.Message}");

        // A column called session that does not exist is an ordinary error: the session and its transaction stay.
        bq.Failures["SELECT e.session FROM events e"] = Failure("invalidQuery", "Name session not found inside e at [1:10]");
        bq.FailAtInsert.Add("SELECT e.session FROM events e");
        var namedTab = await Open(false);
        var creates = bq.UserInserts.Count(body => body["configuration"]!["query"]!["createSession"]?.GetValue<bool>() == true);
        var named = await harness.Execute(namedTab, "SELECT e.session FROM events e");
        var namedState = await harness.State(namedTab);
        check(named.Result is { Status: "failed" } && !Says(named.Result, "started a new BigQuery session") && namedState.State is { Checked: false }
            && bq.UserInserts.Count(body => body["configuration"]!["query"]!["createSession"]?.GetValue<bool>() == true) == creates,
            $"an error about a column named session keeps the session and leaves its transaction unknown: {Texts(named.Result?.Messages ?? [])} {namedState.State}");
        await harness.Close(namedTab, "rollback");

        // A BEGIN whose job reached DONE but whose final read failed: it may have opened the transaction, so it is unknown.
        var readTab = Tab();
        await harness.Execute(readTab, "SELECT 1");
        var readSession = bq.Jobs[bq.UserInserts.Last()["jobReference"]!["jobId"]!.GetValue<string>()].Session;
        harness.Fake.Fault = request => request.Method == "GET" && !request.Url.Contains("/queries/", StringComparison.Ordinal)
            && bq.Jobs.Values.Any(job => job.Session == readSession && job.Sql == "BEGIN TRANSACTION" && request.Url.Contains("/jobs/" + job.Id, StringComparison.Ordinal))
            ? new HttpRequestException(HttpRequestError.ConnectionError, "No connection could be made.") : null;
        var unread = await harness.Execute(readTab, "BEGIN TRANSACTION");
        harness.Fake.Fault = null;
        var unreadState = await harness.State(readTab);
        check(unread.Result is { Status: "failed" } && unreadState.State is { Checked: false },
            $"a job that finished but whose final read failed leaves the transaction unknown, not untouched: {unread.Result?.Status} {unreadState.State}");
        await harness.Close(readTab, "rollback");

        // A COMMIT whose answer was lost and whose lookups keep failing: an unknown outcome, never an unmapped error.
        bq.CommitReply = job => new(500, Bq.Error(500, "Backend error.", "backendError"));
        harness.Fake.Fault = request => request.Method == "GET" && bq.Jobs.Values.Any(job => job.Sql == BigQuerySql.Commit && request.Url.Contains("/jobs/" + job.Id, StringComparison.Ordinal))
            ? new HttpRequestException(HttpRequestError.ConnectionError, "No connection could be made.") : null;
        var budget2 = harness.BigQuery.CommitLimit;
        harness.BigQuery.CommitLimit = TimeSpan.FromMilliseconds(500);
        var blindTab = await Open(false);
        (string Code, SessionCloseResult? Result, string Message) blind;
        try { blind = await harness.Close(blindTab, "commit"); }
        catch (Exception error) { blind = ("thrown " + error.GetType().Name, null, ""); }
        harness.Fake.Fault = null;
        bq.CommitReply = null;
        harness.BigQuery.CommitLimit = budget2;
        check(blind is { Code: "ok", Result.Note.Code: "outcomeUnknown" } && (await harness.State(blindTab)).Code == "SESSION_CLOSED",
            $"a commit whose lookups keep failing closes with an unknown outcome: {blind.Code} {blind.Result}");

        // A COMMIT job BigQuery stopped for its timeout refused the commit: not main's TIMEOUT, whose outcome is unknown.
        bq.CommitError = Failure("timeout", "Query exceeded the job timeout.");
        var timedTab = await Open(false);
        var timed = await harness.Close(timedTab, "commit");
        bq.CommitError = null;
        check(timed.Code == "SQL_ERROR" && timed.Message.StartsWith("The transaction was not committed, and the query stays open.", StringComparison.Ordinal),
            $"a COMMIT job that timed out is refused with SQL_ERROR, never TIMEOUT: {timed.Code} {timed.Message}");
        await harness.Close(timedTab, "rollback");

        // A query BigQuery refuses at insert is DONE already: the session is not held, and its transaction is untouched.
        var refusedTab = Tab();
        await harness.Execute(refusedTab, "SELECT 1");
        await harness.Execute(refusedTab, "SELECT e.session FROM events e");
        var refusedState = await harness.State(refusedTab);
        var afterRefusal = await harness.Execute(refusedTab, "SELECT 1");
        check(refusedState.State is { Checked: true, TransactionCount: 0 } && !Says(afterRefusal.Result, "Waiting for BigQuery job"),
            $"a query refused at insert leaves the session checked and free: {refusedState.State} {Texts(afterRefusal.Result?.Messages ?? [])}");

        // A script child's rows that fail to read fail the query, rather than showing a partial result as complete.
        bq.Scripts["SCRIPT two selects"] = [("SELECT", null), ("SELECT", null)];
        var childTab = Tab();
        await harness.Execute(childTab, "SELECT 1");
        harness.Fake.Fault = request => request.Url.Contains("/queries/child_", StringComparison.Ordinal) ? new HttpRequestException(HttpRequestError.ConnectionError, "No connection could be made.") : null;
        var partial = await harness.Execute(childTab, "SCRIPT two selects");
        harness.Fake.Fault = null;
        check(partial.Result is { Status: "failed" } && !Says(partial.Result, "The script completed."),
            $"a script whose child rows fail to read fails, never completes: {partial.Result?.Status} {Texts(partial.Result?.Messages ?? [])}");

        // The same while the script still runs: it is cancelled in BigQuery, and the session waits for it as for a Stop.
        bq.PollsBeforeDone = 1000;
        harness.Fake.Fault = request => request.Url.Contains("/queries/child_", StringComparison.Ordinal) ? new HttpRequestException(HttpRequestError.ConnectionError, "No connection could be made.") : null;
        var running = await harness.Execute(childTab, "SCRIPT two selects");
        harness.Fake.Fault = null;
        bq.PollsBeforeDone = 0;
        var runningId = bq.UserInserts.Last()["jobReference"]!["jobId"]!.GetValue<string>();
        check(running.Result is { Status: "failed" } && await Poll(() => bq.Cancels.Contains(runningId)) && Says(running.Result, "whose results could not be read"),
            $"a running script whose child rows fail to read is cancelled in BigQuery: {running.Result?.Status} {Texts(running.Result?.Messages ?? [])}");
        bq.Release(bq.Jobs[runningId]);
        await harness.Close(childTab);

        // An insert whose first attempt may have created the job, then retries that never left: the job may exist, so it holds the session.
        var ambiguousTab = Tab();
        await harness.Execute(ambiguousTab, "SELECT 1");
        Bq.FakeJob? ambiguousJob = null;
        harness.Fake.On("POST", Base + "/jobs", request =>
        {
            var body = JsonNode.Parse(request.Body)!;
            if (body["configuration"]!["query"]!["query"]!.GetValue<string>() != "SELECT ambiguous") return bq.InsertReply(request);
            ambiguousJob = bq.Create(body);
            ambiguousJob.Hold = true;
            return new(500, Bq.Error(500, "Backend error.", "backendError"));
        });
        var sentOnce = false;
        harness.Fake.Fault = request =>
        {
            if (request.Method == "POST" && request.Body.Contains("SELECT ambiguous", StringComparison.Ordinal))
            {
                if (!sentOnce) { sentOnce = true; return null; }
                return new HttpRequestException(HttpRequestError.ConnectionError, "No connection could be made.");
            }
            return request.Method == "GET" && ambiguousJob is { } held && request.Url.Contains("/jobs/" + held.Id, StringComparison.Ordinal)
                ? new HttpRequestException(HttpRequestError.ConnectionError, "No connection could be made.") : null;
        };
        var ambiguous = await harness.Execute(ambiguousTab, "SELECT ambiguous");
        harness.Fake.Fault = null;
        var ambiguousState = await harness.State(ambiguousTab);
        check(ambiguous.Result is { Status: "failed" } && ambiguousJob is not null && ambiguousState.State is { Checked: false },
            $"an insert whose first attempt may have reached BigQuery holds the session even when later retries never left: {ambiguous.Result?.Status} {ambiguousState.State}");
        if (ambiguousJob is not null) bq.Release(ambiguousJob);
        await harness.Close(ambiguousTab);

        // The same when the lookup after the first attempt is refused outright (a 403): the job may still exist.
        var deniedTab = Tab();
        await harness.Execute(deniedTab, "SELECT 1");
        ambiguousJob = null;
        harness.Fake.On("GET", Base + "/jobs/[^/]+", request => ambiguousJob is { } held && request.Url.Contains("/jobs/" + held.Id, StringComparison.Ordinal) && !bq.Jobs[held.Id].Hold.Equals(false)
            ? new(403, Bq.Error(403, "Exceeded rate limits: too many api requests.", "rateLimitExceeded")) : bq.GetReply(request));
        var denied = await harness.Execute(deniedTab, "SELECT ambiguous");
        var deniedState = await harness.State(deniedTab);
        check(denied.Result is { Status: "failed" } && ambiguousJob is not null && deniedState.State is { Checked: false },
            $"an insert whose lookup is refused outright still holds the session for the job it may have created: {denied.Result?.Status} {deniedState.State}");
        if (ambiguousJob is not null) bq.Release(ambiguousJob);
        await harness.Close(deniedTab);

        // A retry refused outright after an attempt that may have created the job, and a 409 whose lookup is refused: both hold.
        var retryDeniedTab = Tab();
        await harness.Execute(retryDeniedTab, "SELECT 1");
        ambiguousJob = null;
        var posts = 0;
        harness.Fake.On("POST", Base + "/jobs", request =>
        {
            var body = JsonNode.Parse(request.Body)!;
            var sql = body["configuration"]!["query"]!["query"]!.GetValue<string>();
            if (sql == "SELECT retry denied")
            {
                if (Interlocked.Increment(ref posts) == 1) { ambiguousJob = bq.Create(body); ambiguousJob.Hold = true; return new(500, Bq.Error(500, "Backend error.", "backendError")); }
                return new(403, Bq.Error(403, "Exceeded rate limits: too many api requests.", "rateLimitExceeded"));
            }
            if (sql == "SELECT conflict")
            {
                ambiguousJob = bq.Create(body);
                ambiguousJob.Hold = true;
                return new(409, Bq.Error(409, "Already Exists: Job varia-alpha:US." + ambiguousJob.Id, "duplicate"));
            }
            return bq.InsertReply(request);
        });
        harness.Fake.On("GET", Base + "/jobs/[^/]+", request => ambiguousJob is { } held && request.Url.Contains("/jobs/" + held.Id, StringComparison.Ordinal) && held.Hold && held.Sql == "SELECT retry denied"
            ? new(500, Bq.Error(500, "Backend error.", "backendError"))
            : ambiguousJob is { } conflicted && request.Url.Contains("/jobs/" + conflicted.Id, StringComparison.Ordinal) && conflicted.Hold
                ? BigQueryFake.Fixture("error-not-found", 404) : bq.GetReply(request));
        var retryDenied = await harness.Execute(retryDeniedTab, "SELECT retry denied");
        var retryDeniedState = await harness.State(retryDeniedTab);
        check(retryDenied.Result is { Status: "failed" } && posts >= 2 && retryDeniedState.State is { Checked: false },
            $"a retry refused outright after an attempt that may have created the job still holds the session: {retryDenied.Result?.Status} {posts} {retryDeniedState.State}");
        if (ambiguousJob is not null) bq.Release(ambiguousJob);
        await harness.Close(retryDeniedTab);
        var conflictTab = Tab();
        await harness.Execute(conflictTab, "SELECT 1");
        ambiguousJob = null;
        var conflict = await harness.Execute(conflictTab, "SELECT conflict");
        var conflictState = await harness.State(conflictTab);
        var conflictSession = ambiguousJob?.Session;
        var conflictClose = await harness.Close(conflictTab);
        check(conflict.Result is { Status: "failed" } && conflictState.State is { Checked: false } && conflictClose.Code == "ok" && conflictSession is not null && !bq.Aborts.Contains(conflictSession),
            $"a 409 whose lookup finds nothing still holds the session for the job that exists, so a close never aborts under it: {conflict.Result?.Status} {conflictState.State} {conflictClose.Code}");
        if (ambiguousJob is not null) bq.Release(ambiguousJob);

        // A retried insert refused for an expired session still runs again in a new session, after a first attempt lost to a 500.
        var expiringTab = Tab();
        await harness.Execute(expiringTab, "SELECT 1");
        var expiringSession = bq.Jobs[bq.UserInserts.Last()["jobReference"]!["jobId"]!.GetValue<string>()].Session!;
        var expiringPosts = 0;
        harness.Fake.On("POST", Base + "/jobs", request =>
        {
            var body = JsonNode.Parse(request.Body)!;
            if (body["configuration"]!["query"]!["query"]!.GetValue<string>() != "SELECT expiring" || SessionOf(body) != expiringSession) return bq.InsertReply(request);
            return Interlocked.Increment(ref expiringPosts) == 1 ? new(500, Bq.Error(500, "Backend error.", "backendError"))
                : new(400, Bq.Error(400, "Session " + expiringSession + " has expired and is no longer available.", "invalidQuery"));
        });
        var expiring = await harness.Execute(expiringTab, "SELECT expiring");
        check(expiring.Result is { Status: "completed" } && expiringPosts >= 2 && Says(expiring.Result, "started a new BigQuery session"),
            $"an expired-session refusal on a retried insert still runs the query in a new session: {expiring.Result?.Status} {expiringPosts} {Texts(expiring.Result?.Messages ?? [])}");
        await harness.Close(expiringTab);

        // The session's end fails: abortFailed, with BigQuery's message.
        bq.AbortError = Failure("accessDenied", "Access Denied: Project varia-alpha: User does not have bigquery.jobs.create permission.");
        var failTab = await Open(false);
        var failedEnd = await harness.Close(failTab, "rollback");
        bq.AbortError = null;
        check(failedEnd is { Code: "ok", Result: { Closed: true, Note: { Code: "abortFailed" } note2 } } && note2.Message!.Contains("Access Denied", StringComparison.Ordinal)
            && (await harness.State(failTab)).Code == "SESSION_CLOSED",
            $"a session whose end fails still closes, with abortFailed: {failedEnd.Code} {failedEnd.Result}");
    }

    /// <summary>A commit whose outcome is unknown: the close answers outcomeUnknown at once, and the session is aborted only
    /// once the COMMIT is DONE (or never found), even after Disconnect; a COMMIT that never finishes is left to expire.</summary>
    static async Task UnknownOutcomeAsync(Action<bool, string> check, JsonObject key)
    {
        var bq = new Bq();
        bq.Statements["BEGIN TRANSACTION"] = "BEGIN_TRANSACTION";
        using var harness = new Harness(bq);
        harness.BigQuery.CommitLimit = TimeSpan.FromMilliseconds(300);
        harness.BigQuery.PendingNotFound = TimeSpan.FromMilliseconds(300);
        await harness.ConnectAsync(key);
        var tab = Tab();
        await harness.Execute(tab, "BEGIN TRANSACTION");
        // The COMMIT's insert never answers: it may have arrived.
        var hang = harness.Fake.Hang!;
        harness.Fake.Hang = request => request.Method == "POST" && request.Body.Contains("COMMIT TRANSACTION", StringComparison.Ordinal) || hang(request);
        var closed = await harness.Close(tab, "commit");
        // The held insert never reached the routes, so its body is read from what the fake saw.
        var commitId = JsonNode.Parse(harness.Fake.Seen.Last(request => request.Method == "POST" && request.Body.Contains("COMMIT TRANSACTION", StringComparison.Ordinal)).Body)!["jobReference"]!["jobId"]!.GetValue<string>();
        check(closed is { Code: "ok", Result: { Closed: true, Note: { Code: "outcomeUnknown" } note } } && note.JobId == commitId && bq.Aborts.IsEmpty && harness.BigQuery.PendingAborts == 1
            && (await harness.State(tab)).Code == "SESSION_CLOSED",
            $"a commit with an unknown outcome closes at once with outcomeUnknown and its job id, and does not abort yet: {closed.Code} {closed.Result} {string.Join(",", bq.Aborts)}");
        // Disconnect does not stop the pending abort; the COMMIT is never found, so the session is aborted after the wait.
        await harness.Call("connections.disconnect", new JsonObject { ["connectionId"] = harness.ConnectionId });
        var aborted = await Poll(() => bq.Aborts.Contains("sess-1") && harness.BigQuery.PendingAborts == 0);
        check(aborted, $"the pending abort survives Disconnect and ends the session once the COMMIT is not found: {string.Join(",", bq.Aborts)} {harness.BigQuery.PendingAborts}");

        // A COMMIT that exists but never finishes: the abort gives up at its cap, and the session is left to expire.
        harness.Fake.Hang = hang;
        await harness.ConnectAsync(key);
        harness.BigQuery.PendingLimit = TimeSpan.FromMilliseconds(400);
        var stuck = Tab();
        await harness.Execute(stuck, "BEGIN TRANSACTION");
        bq.CommitReply = job => { job.State = "RUNNING"; job.Hold = true; return new(500, Bq.Error(500, "Backend error.", "backendError")); };
        var unknown = await harness.Close(stuck, "commit");
        bq.CommitReply = null;
        var gaveUp = await Poll(() => harness.BigQuery.PendingAborts == 0);
        check(unknown.Result?.Note?.Code == "outcomeUnknown" && gaveUp && !bq.Aborts.Contains("sess-2"),
            $"a pending abort gives up at its cap while the COMMIT still runs, and never aborts under it: {unknown.Code} {unknown.Result} {string.Join(",", bq.Aborts)}");
    }

    /// <summary>An expired session: a query resubmitted once in a new session saying what was lost, a close at once (with a
    /// note only for a tracked transaction), and a commit answering SESSION_LOST.</summary>
    static async Task ExpiryAsync(Action<bool, string> check, JsonObject key)
    {
        var bq = new Bq();
        bq.Statements["BEGIN TRANSACTION"] = "BEGIN_TRANSACTION";
        using var harness = new Harness(bq);
        await harness.ConnectAsync(key);
        var tab = Tab();
        await harness.Execute(tab, "SELECT 1");
        bq.Expired.Add("sess-1");
        var rerun = await harness.Execute(tab, "SELECT 1");
        var inserts = bq.UserInserts.ToArray();
        check(rerun is { Code: "ok", Result.Status: "completed" } && Says(rerun.Result, BigQueryService.ExpiredNotice) && inserts.Length == 3 && SessionOf(inserts[1]) == "sess-1"
            && inserts[2]["configuration"]!["query"]!["createSession"]?.GetValue<bool>() == true && inserts[1]["jobReference"]!["jobId"]!.ToString() != inserts[2]["jobReference"]!["jobId"]!.ToString(),
            $"a query refused for an expired session runs once more in a new session, under a new job id, saying what was lost: {rerun.Code} {Texts(rerun.Result?.Messages ?? [])}");

        await harness.Execute(tab, "BEGIN TRANSACTION");
        bq.Expired.Add("sess-2");
        var tracked = await harness.Close(tab, "rollback");
        check(tracked is { Code: "ok", Result: { Closed: true, Note.Code: "sessionExpired" } }, $"an expired session with a tracked transaction closes at once, saying it was rolled back: {tracked.Code} {tracked.Result}");
        var idle = Tab();
        await harness.Execute(idle, "SELECT 1");
        bq.Expired.Add("sess-3");
        var quiet = await harness.Close(idle);
        check(quiet is { Code: "ok", Result: { Closed: true, Note: null } }, $"an expired idle session closes with no note: {quiet.Code} {quiet.Result}");

        var committing = Tab();
        await harness.Execute(committing, "BEGIN TRANSACTION");
        bq.Expired.Add("sess-4");
        var lost = await harness.Close(committing, "commit");
        check(lost.Code == "SESSION_LOST" && lost.Message == BigQueryService.ExpiredCommit && (await harness.State(committing)).Code == "SESSION_CLOSED",
            $"a commit on an expired session answers SESSION_LOST, and the session is gone: {lost.Code} {lost.Message}");
    }

    /// <summary>Dry runs in a tab's session (docs/bigquery.md, Cost): a tab with a BigQuery session estimates in it (its id and
    /// location), so temp tables and variables resolve; a tab without one estimates outside any session and no session is
    /// created for it; another tab's id, or an expired session, estimate without a session.</summary>
    static async Task DryRunsAsync(Action<bool, string> check, JsonObject key)
    {
        var bq = new Bq();
        using var harness = new Harness(bq);
        await harness.ConnectAsync(key);
        JsonObject Args(string tab) => new() { ["connectionId"] = harness.ConnectionId, ["sql"] = "SELECT * FROM _SESSION.t", ["sessionId"] = tab };

        var fresh = Tab();
        var before = await harness.Call("bigquery.dryRun", Args(fresh));
        var first = bq.DryRuns.Last();
        check(before.Code == "ok" && SessionOf(first) is null && first["configuration"]!["query"]!["createSession"] is null && !harness.BigQuery.OwnsSession(fresh) && bq.UserInserts.Count() == 0,
            $"a dry run for a tab with no session runs outside any session and creates none: {before.Code} {before.Message} {first.ToJsonString()}");

        var tab = Tab();
        await harness.Execute(tab, "CREATE TEMP TABLE t AS SELECT 1 AS n");
        var inSession = await harness.Call("bigquery.dryRun", Args(tab));
        var second = bq.DryRuns.Last();
        check(inSession.Code == "ok" && SessionOf(second) == "sess-1" && second["jobReference"]?["location"]?.GetValue<string>() == "US" && second["configuration"]!["query"]!["createSession"] is null,
            $"a dry run for a tab with a session runs in it, in its location: {inSession.Code} {inSession.Message} {second.ToJsonString()}");

        var other = await harness.Call("bigquery.dryRun", Args(fresh));
        check(other.Code == "ok" && SessionOf(bq.DryRuns.Last()) is null, "another tab's dry run does not use this tab's session");

        bq.Expired.Add("sess-1");
        var count = bq.DryRuns.Count;
        var expired = await harness.Call("bigquery.dryRun", Args(tab));
        var tried = bq.DryRuns.Skip(count).ToArray();
        check(expired.Code == "ok" && tried.Length == 2 && SessionOf(tried[0]) == "sess-1" && SessionOf(tried[1]) is null && bq.UserInserts.Count() == 1,
            $"a dry run refused for an expired session estimates once more outside it, starting nothing: {expired.Code} {expired.Message} {tried.Length}");
    }

    /// <summary>Stop and running jobs: JOB_RUNNING for a commit or rollback close while a job runs, jobs.cancel on Stop, a
    /// close waiting for the stopped job's DONE (outcomeUnknown when it does not come), committedBeforeCancel, the next
    /// execution waiting for the stopped job, and a plain close stopping a running query.</summary>
    static async Task StopAsync(Action<bool, string> check, JsonObject key)
    {
        var bq = new Bq();
        using var harness = new Harness(bq);
        harness.BigQuery.CloseWaitLimit = TimeSpan.FromMilliseconds(300);
        harness.BigQuery.CommitWaitLimit = TimeSpan.FromMilliseconds(300);
        await harness.ConnectAsync(key);
        var tab = Tab();
        await harness.Execute(tab, "SELECT 1");
        bq.Statements["BEGIN TRANSACTION"] = "BEGIN_TRANSACTION";
        await harness.Execute(tab, "BEGIN TRANSACTION");

        bq.HoldQueries = true;
        bq.KeepRunningAfterCancel = true;
        var args = harness.Query(tab, "SELECT slow");
        var running = harness.Call("query.execute", args);
        await Task.WhenAny(bq.Polling.Task, running).WaitAsync(TimeSpan.FromSeconds(30));
        var busy = await harness.State(tab);
        var commit = await harness.Close(tab, "commit");
        var rollback = await harness.Close(tab, "rollback");
        check(busy.Code == "SESSION_BUSY" && commit.Code == "JOB_RUNNING" && rollback.Code == "JOB_RUNNING" && commit.Message.StartsWith("The transaction was not committed: a job is still running", StringComparison.Ordinal)
            && rollback.Message.StartsWith("The transaction was not rolled back", StringComparison.Ordinal),
            $"a commit or rollback close is refused with JOB_RUNNING while the tab's job runs: {busy.Code} {commit.Code} {rollback.Code}");
        await harness.Call("query.cancel", new JsonObject { ["queryId"] = args["queryId"]!.GetValue<string>() });
        var stopped = (await running.WaitAsync(TimeSpan.FromSeconds(30))).Result as QueryResult;
        var jobId = bq.UserInserts.Last()["jobReference"]!["jobId"]!.GetValue<string>();
        var cancelled = await Poll(() => bq.Cancels.Contains(jobId));
        check(stopped is { Status: "cancelled" } && cancelled && Says(stopped, "Varia asked BigQuery to cancel job varia-alpha:US." + jobId),
            $"Stop ends the request and sends jobs.cancel: {stopped?.Status} {Texts(stopped?.Messages ?? [])}");
        var tail = await harness.State(tab);
        var waited = await harness.Close(tab, "commit");
        check(tail.State is { Checked: false } && waited.Code == "JOB_RUNNING" && bq.Commits.All(body => SessionOf(body) != "sess-1"),
            $"until the stopped job is DONE the transaction is unchecked, and a commit runs nothing: {tail.State} {waited.Code}");
        var given = await harness.Close(tab);
        check(given is { Code: "ok", Result: { Closed: true, Note: { Code: "outcomeUnknown" } note } } && note.JobId == jobId && bq.Aborts.Contains("sess-1"),
            $"a plain close whose stopped job is not DONE in time ends the session, saying the outcome is unknown: {given.Code} {given.Result}");

        // A stopped script that had committed: the close says so once the job is DONE.
        bq.Scripts["SCRIPT commits"] = [("BEGIN_TRANSACTION", null), ("INSERT", null), ("COMMIT_TRANSACTION", null)];
        bq.Polling = new(TaskCreationOptions.RunContinuationsAsynchronously);
        var scriptTab = Tab();
        bq.HoldQueries = false;
        await harness.Execute(scriptTab, "SELECT 1");
        bq.HoldQueries = true;
        var scriptArgs = harness.Query(scriptTab, "SCRIPT commits");
        var script = harness.Call("query.execute", scriptArgs);
        await Task.WhenAny(bq.Polling.Task, script).WaitAsync(TimeSpan.FromSeconds(30));
        await harness.Call("query.cancel", new JsonObject { ["queryId"] = scriptArgs["queryId"]!.GetValue<string>() });
        await script.WaitAsync(TimeSpan.FromSeconds(30));
        var scriptJob = bq.Jobs[bq.UserInserts.Last()["jobReference"]!["jobId"]!.GetValue<string>()];
        bq.Release(scriptJob);
        var committed = await harness.Close(scriptTab, "rollback");
        check(committed is { Code: "ok", Result: { Closed: true, Note: { Code: "committedBeforeCancel" } } } && committed.Result.Note.JobId == scriptJob.Id,
            $"closing after a stopped script committed says so: {committed.Code} {committed.Result}");

        // The same, but the session's end fails: abortFailed, still saying the stopped job committed.
        bq.Polling = new(TaskCreationOptions.RunContinuationsAsynchronously);
        var failTab = Tab();
        bq.HoldQueries = false;
        await harness.Execute(failTab, "SELECT 1");
        bq.HoldQueries = true;
        var failArgs = harness.Query(failTab, "SCRIPT commits");
        var failing = harness.Call("query.execute", failArgs);
        await Task.WhenAny(bq.Polling.Task, failing).WaitAsync(TimeSpan.FromSeconds(30));
        await harness.Call("query.cancel", new JsonObject { ["queryId"] = failArgs["queryId"]!.GetValue<string>() });
        await failing.WaitAsync(TimeSpan.FromSeconds(30));
        bq.Release(bq.Jobs[bq.UserInserts.Last()["jobReference"]!["jobId"]!.GetValue<string>()]);
        bq.AbortError = Failure("accessDenied", "Access Denied: Project varia-alpha.");
        var both = await harness.Close(failTab, "rollback");
        bq.AbortError = null;
        check(both is { Code: "ok", Result.Note: { Code: "abortFailed" } bothNote } && bothNote.Message!.StartsWith("The stopped job committed a transaction before it stopped.", StringComparison.Ordinal)
            && bothNote.Message.Contains("Access Denied", StringComparison.Ordinal),
            $"a failed end after a stopped script committed answers abortFailed and still says the job committed: {both.Code} {both.Result}");

        // A stopped script that committed and then began again: the refused commit that keeps the tab still says it committed.
        bq.Scripts["SCRIPT commits then begins"] = [("BEGIN_TRANSACTION", null), ("INSERT", null), ("COMMIT_TRANSACTION", null), ("BEGIN_TRANSACTION", null), ("UPDATE", null)];
        bq.Polling = new(TaskCreationOptions.RunContinuationsAsynchronously);
        var againTab = Tab();
        bq.HoldQueries = false;
        await harness.Execute(againTab, "SELECT 1");
        bq.HoldQueries = true;
        var againArgs = harness.Query(againTab, "SCRIPT commits then begins");
        var againRun = harness.Call("query.execute", againArgs);
        await Task.WhenAny(bq.Polling.Task, againRun).WaitAsync(TimeSpan.FromSeconds(30));
        await harness.Call("query.cancel", new JsonObject { ["queryId"] = againArgs["queryId"]!.GetValue<string>() });
        await againRun.WaitAsync(TimeSpan.FromSeconds(30));
        bq.Release(bq.Jobs[bq.UserInserts.Last()["jobReference"]!["jobId"]!.GetValue<string>()]);
        bq.CommitError = Failure("invalidQuery", "Transaction is aborted due to concurrent update against table t.");
        var keptRefusal = await harness.Close(againTab, "commit");
        bq.CommitError = null;
        check(keptRefusal.Code != "ok" && keptRefusal.Message.StartsWith("The stopped job committed a transaction before it stopped. The transaction was not committed", StringComparison.Ordinal),
            $"a refused commit after a stopped script committed still says the script committed: {keptRefusal.Code} {keptRefusal.Message}");
        await harness.Close(againTab, "rollback");

        // The same with a later statement failing (unchecked) and a long refusal: the joined note stays within its bound.
        bq.Scripts["SCRIPT commits then fails"] = [("BEGIN_TRANSACTION", null), ("COMMIT_TRANSACTION", null), ("BEGIN_TRANSACTION", null), ("UPDATE", Failure("invalidQuery", "Bad update."))];
        bq.Polling = new(TaskCreationOptions.RunContinuationsAsynchronously);
        var longTab = Tab();
        bq.HoldQueries = false;
        await harness.Execute(longTab, "SELECT 1");
        bq.HoldQueries = true;
        var longArgs = harness.Query(longTab, "SCRIPT commits then fails");
        var longRun = harness.Call("query.execute", longArgs);
        await Task.WhenAny(bq.Polling.Task, longRun).WaitAsync(TimeSpan.FromSeconds(30));
        await harness.Call("query.cancel", new JsonObject { ["queryId"] = longArgs["queryId"]!.GetValue<string>() });
        await longRun.WaitAsync(TimeSpan.FromSeconds(30));
        bq.Release(bq.Jobs[bq.UserInserts.Last()["jobReference"]!["jobId"]!.GetValue<string>()]);
        bq.CommitError = Failure("invalidQuery", "No transaction is active. " + new string('x', 3000));
        var joined = await harness.Close(longTab, "commit");
        bq.CommitError = null;
        check(joined is { Code: "ok", Result.Note: { Code: "commitNotApplied" } joinedNote } && joinedNote.Message!.Length <= 2001
            && joinedNote.Message.StartsWith("The stopped job committed a transaction before it stopped.", StringComparison.Ordinal),
            $"a note joined with a stopped job's commit stays within 2,001 characters: {joined.Code} {joined.Result?.Note?.Message?.Length}");

        // A stopped single statement is settled without jobs.list, so the Job User role keeps a checked transaction.
        bq.Polling = new(TaskCreationOptions.RunContinuationsAsynchronously);
        var plainTab = Tab();
        bq.HoldQueries = false;
        await harness.Execute(plainTab, "SELECT 1");
        bq.HoldQueries = true;
        var plainArgs = harness.Query(plainTab, "SELECT slow");
        var plainRun = harness.Call("query.execute", plainArgs);
        await Task.WhenAny(bq.Polling.Task, plainRun).WaitAsync(TimeSpan.FromSeconds(30));
        await harness.Call("query.cancel", new JsonObject { ["queryId"] = plainArgs["queryId"]!.GetValue<string>() });
        await plainRun.WaitAsync(TimeSpan.FromSeconds(30));
        bq.HoldQueries = false;
        bq.Release(bq.Jobs[bq.UserInserts.Last()["jobReference"]!["jobId"]!.GetValue<string>()]);
        bq.ListDenied = true;
        await harness.Execute(plainTab, "SELECT 1");
        bq.ListDenied = false;
        var plainState = await harness.State(plainTab);
        check(plainState.State is { Checked: true }, $"settling a stopped single statement needs no jobs.list: {plainState.State}");
        await harness.Close(plainTab);
        bq.HoldQueries = true;

        // The next execution waits for the stopped job's DONE.
        bq.Polling = new(TaskCreationOptions.RunContinuationsAsynchronously);
        var waitTab = Tab();
        bq.HoldQueries = false;
        await harness.Execute(waitTab, "SELECT 1");
        bq.HoldQueries = true;
        var slowArgs = harness.Query(waitTab, "SELECT slow");
        var slow = harness.Call("query.execute", slowArgs);
        await Task.WhenAny(bq.Polling.Task, slow).WaitAsync(TimeSpan.FromSeconds(30));
        await harness.Call("query.cancel", new JsonObject { ["queryId"] = slowArgs["queryId"]!.GetValue<string>() });
        await slow.WaitAsync(TimeSpan.FromSeconds(30));
        bq.HoldQueries = false;
        var stoppedId = bq.UserInserts.Last()["jobReference"]!["jobId"]!.GetValue<string>();
        await Poll(() => bq.Cancels.Contains(stoppedId));
        // Stopping the run that waits for it asks BigQuery to cancel the stopped job again.
        var gets = harness.Fake.Seen.Count(request => request.Method == "GET" && request.Url.Contains("/jobs/" + stoppedId, StringComparison.Ordinal));
        var waitingArgs = harness.Query(waitTab, "SELECT 1");
        var waiting = harness.Call("query.execute", waitingArgs);
        // Stop only once the run polls the stopped job: a Stop before that ends the run before it waits (a loaded CI runner).
        var polled = await Poll(() => harness.Fake.Seen.Count(request => request.Method == "GET" && request.Url.Contains("/jobs/" + stoppedId, StringComparison.Ordinal)) > gets, 120);
        check(polled, "the run after a Stop polls the stopped job before it starts");
        await harness.Call("query.cancel", new JsonObject { ["queryId"] = waitingArgs["queryId"]!.GetValue<string>() });
        var waitingRun = await waiting.WaitAsync(TimeSpan.FromSeconds(30));
        check(await Poll(() => bq.Cancels.Count(id => id == stoppedId) >= 2), $"a second Stop sends jobs.cancel again for the job the tab waits for: {bq.Cancels.Count(id => id == stoppedId)} "
            + $"seen {harness.Fake.Seen.Count(request => request.Method == "POST" && request.Url.Contains(stoppedId + "/cancel", StringComparison.Ordinal))} {waitingRun.Code} {(waitingRun.Result as QueryResult)?.Status} {bq.Jobs[stoppedId].State} {Texts((waitingRun.Result as QueryResult)?.Messages ?? [])}");
        bq.Release(bq.Jobs[stoppedId]);
        var next = await harness.Execute(waitTab, "SELECT 1");
        check(next is { Code: "ok", Result.Status: "completed" } && Says(next.Result, "Waiting for BigQuery job") && Says(next.Result, "runs one job at a time"),
            $"the next execution in a tab waits for its stopped job to finish: {next.Code} {Texts(next.Result?.Messages ?? [])}");

        // A plain close while a query runs never aborts the session holding its job (the safety net): the request ends detached.
        bq.HoldQueries = true;
        bq.KeepRunningAfterCancel = false;
        bq.Polling = new(TaskCreationOptions.RunContinuationsAsynchronously);
        var closeArgs = harness.Query(waitTab, "SELECT slow");
        var closing = harness.Call("query.execute", closeArgs);
        await Task.WhenAny(bq.Polling.Task, closing).WaitAsync(TimeSpan.FromSeconds(30));
        var abortsBefore = bq.Aborts.Count;
        var plain = await harness.Close(waitTab);
        var result = (await closing.WaitAsync(TimeSpan.FromSeconds(30))).Result as QueryResult;
        var closeJob = bq.UserInserts.Last()["jobReference"]!["jobId"]!.GetValue<string>();
        check(plain is { Code: "ok", Result.Closed: true } && result is { Status: "detached" } && !bq.Cancels.Contains(closeJob) && bq.Aborts.Count == abortsBefore,
            $"a plain close while the tab's job runs leaves the job and its session: {plain.Code} {plain.Result} {result?.Status} cancels {bq.Cancels.Contains(closeJob)} aborts {bq.Aborts.Count - abortsBefore}");
        bq.Release(bq.Jobs[closeJob]);
        bq.HoldQueries = false;
    }
}
