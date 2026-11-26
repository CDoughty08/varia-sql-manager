using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Varia.Backend.BigQuery;
using Varia.Backend.Live;
using Varia.Backend.Protocol;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>
/// Job History offline (docs/bigquery.md, Job History): the job JSON rules (states, previews, hidden details, bounds), the
/// bigquery.jobs source's args, the sampler's listings, refreshes and idle state, bigquery.jobs.get and bigquery.jobs.cancel, and
/// the live scope's provider gate, all on <see cref="BigQueryFake"/> with the REST fixtures. No request leaves the process.
/// </summary>
internal static class BigQueryJobHistoryChecks
{
    static readonly JsonSerializerOptions Wire = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull, UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow
    };
    const string Jobs = @"https://bigquery\.googleapis\.com/bigquery/v2/projects/varia-alpha/jobs";
    const string Session = "CgwKCnZhcmlhLWFscGhhEhBzZXNzaW9uLWZpeHR1cmU";

    public static async Task RunAsync(Action<bool, string> check)
    {
        Parsing(check);
        Arguments(check);
        Rows(check);
        Schedule(check);
        using var rsa = System.Security.Cryptography.RSA.Create(2048);
        var key = BigQueryCredentialChecks.Key(rsa.ExportPkcs8PrivateKeyPem());
        await SamplerAsync(check, key);
        await AllUsersAsync(check, key);
        await PinnedAndExpandedAsync(check, key);
        await WatermarkAsync(check, key);
        await PinnedClassifyAsync(check, key);
        await BudgetAndFollowAsync(check, key);
        await CapAndStallAsync(check, key);
        await FailuresAsync(check, key);
        await DetailsAsync(check, key);
        await CancelAsync(check, key);
        await GateAsync(check, key);
        await ExplorerAsync(check, key);
    }

    /// <summary>A fixture with its "T-n" times turned into epoch ms n seconds before <paramref name="now"/>.</summary>
    static string Timed(string name, long now) =>
        Regex.Replace(BigQueryFake.FixtureText(name), "\"T-(\\d+)\"", match => "\"" + (now - long.Parse(match.Groups[1].Value) * 1000) + "\"");

    static JsonElement Parse(string text)
    {
        using var document = JsonDocument.Parse(text);
        return document.RootElement.Clone();
    }

    static long Now => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    /// <summary>jobs.list and jobs.get JSON read into Job History's jobs: states derived from the error, previews, hidden
    /// details, the anonymous result table left out, and every count held to JavaScript's safe integers.</summary>
    static void Parsing(Action<bool, string> check)
    {
        var now = Now;
        var page = BigQueryJobHistory.Page(Parse(Timed("jobs-list", now)), 123);
        var ids = string.Join(", ", page.Items.Select(job => job.Id));
        check(ids == "varia_running, script_1, script_1_child, failed_1, cancelled_1, timed_out" && page.Next == "jobs-page-2" && page.Unreachable is ["asia-east1"] && page.Bytes == 123,
            "a jobs.list page reads its jobs (an invalid job id dropped), next page token and unreachable locations: " + ids);
        var jobs = page.Items.ToDictionary(job => job.Id);
        check(jobs["varia_running"] is { State: "running", Type: "query", Statement: "SELECT", Varia: true, Hidden: false, Location: "US", User: "ana@example.com", Open: true }
            && jobs["varia_running"].Sql == "SELECT customer, SUM(total) FROM sales.orders GROUP BY customer",
            "a running Varia query reads its state, type, statement, label and a one-line preview: " + jobs["varia_running"].Sql);
        check(jobs["failed_1"] is { State: "failed", ErrorReason: "notFound", Location: "EU" } && jobs["cancelled_1"].State == "cancelled" && jobs["timed_out"].State == "failed"
            && jobs["failed_1"].ErrorMessage!.StartsWith("Not found", StringComparison.Ordinal),
            "a DONE job's error makes it failed, or cancelled when its reason is stopped and it did not time out");
        check(jobs["script_1"] is { Script: true, Children: 2, Processed: 2048, Billed: 10485760, SlotMs: 1500, Statement: "SCRIPT" } && jobs["script_1_child"].Parent == "script_1"
            && BigQueryJobHistory.DurationOf(jobs["script_1"], now) == 9000 && BigQueryJobHistory.DurationOf(jobs["varia_running"], now) is >= 29000 and < 60000,
            "a script reads its children count and statistics, a child its parent, and a duration runs to now while the job is open");
        var second = BigQueryJobHistory.Page(Parse(Timed("jobs-list-page-2", now)), 0).Items.ToDictionary(job => job.Id);
        check(second["load_1"] is { Type: "load", Destination: "varia-alpha.sales.landing", State: "done" } && second["other_user"] is { Hidden: true, Type: "other", User: "ben@example.com", Sql: null },
            "a load reads its destination; another user's job without its configuration is marked details hidden");
        var odd = BigQueryJobHistory.Job(Parse("""
            {"jobReference":{"jobId":"j1","location":"bad location!"},"statistics":{"creationTime":"-5","totalBytesProcessed":"9007199254740993","totalSlotMs":12,"numChildJobs":"x"},
             "configuration":{"query":{"query":"SELECT 1","destinationTable":{"projectId":"varia-alpha","datasetId":"_0a1b","tableId":"anon"}}},"user_email":"a\nb"}
            """));
        check(odd is { Location: null, Created: null, Processed: null, SlotMs: 12, Destination: null, User: null, State: "done", Type: "query", Children: 0 },
            "a bad location, a negative or unsafe count, an anonymous result table and an email with a control character are left out");
        check(BigQueryJobHistory.Job(Parse("""{"jobReference":{"jobId":"a b"}}""")) is null && BigQueryJobHistory.Job(Parse("[]")) is null,
            "an item without a usable job id is no job");

        var preview = BigQueryJobHistory.Preview(new string('a', 198) + "😀tail");
        check(preview == new string('a', 198) + "…" && BigQueryJobHistory.Preview("  a \n\n\tb  ") == "a b" && BigQueryJobHistory.Preview(new string('x', 200)) == new string('x', 200)
            && BigQueryJobHistory.Preview(new string('x', 5000)).Length == 200,
            "the preview folds whitespace, keeps 200 characters and never splits a surrogate pair");

        var detail = BigQueryJobHistory.Detail(Parse(Timed("job-script", now)), "varia-alpha");
        check(detail is { Session: true, Sql: "DECLARE x INT64 DEFAULT 1;\nSELECT x;", SqlTruncated: null, Dataset: "varia-alpha.sales", MaximumBytesBilled: 1073741824, Varia: true,
            ChildCount: 2, CacheHit: false, Project: "varia-alpha" } && detail.Labels.Count == 2,
            "jobs.get's details read the whole SQL, default dataset, cap, labels and whether it ran in a session");
        check(!JsonSerializer.Serialize(detail, Wire).Contains(Session, StringComparison.Ordinal), "the session's id never leaves the backend");
        var big = new string('s', BigQueryJobHistory.DetailsChars + 10);
        var cut = BigQueryJobHistory.Detail(Parse(new JsonObject
        {
            ["jobReference"] = new JsonObject { ["jobId"] = "j2" }, ["configuration"] = new JsonObject { ["query"] = new JsonObject { ["query"] = big } }
        }.ToJsonString()), "varia-alpha");
        check(cut is { SqlTruncated: true } && cut.Sql!.Length == BigQueryJobHistory.DetailsChars, "SQL past 1,000,000 characters is cut and says so");
    }

    static bool Refused(Action action)
    {
        try { action(); return false; }
        catch (RequestException error) { return error.Code == "INVALID_PARAMS"; }
    }

    /// <summary>The source's args and the job methods' parameters are checked as main's schemas check them.</summary>
    static void Arguments(Action<bool, string> check)
    {
        var good = new BigQueryJobHistoryArgs("mine", Hours: 24, States: ["running", "failed"], Types: ["query"], Statements: ["SELECT", "CREATE_TABLE_AS_SELECT"], Varia: true,
            Expand: [new("script_1", "US")], Prices: true);
        check(BigQueryJobHistory.Check(good) == good && BigQueryJobHistory.Check(new BigQueryJobHistoryArgs("all", From: Now - 3_600_000, To: Now)) is { AllUsers: true },
            "valid args pass");
        var now = Now;
        var refused = new (string Name, BigQueryJobHistoryArgs Args)[]
        {
            ("no scope", new(null)), ("unknown scope", new("everyone")), ("hours off the list", new("mine", Hours: 2)),
            ("hours and a range", new("mine", Hours: 1, From: 1, To: 2)), ("from alone", new("mine", From: 1)), ("from after to", new("mine", From: 5, To: 5)),
            ("past retention", new("mine", From: now - BigQueryJobHistory.RetentionMs - 10, To: now)), ("repeated state", new("mine", States: ["done", "done"])),
            ("unknown state", new("mine", States: ["bogus"])), ("unknown type", new("mine", Types: ["script"])), ("lower-case statement", new("mine", Statements: ["select"])),
            ("no statements", new("mine", Statements: [])), ("varia false", new("mine", Varia: false)),
            ("too many pinned", new("mine", Pinned: [.. Enumerable.Range(0, 65).Select(index => new BigQueryJobReference("job_" + index))])),
            ("too many expanded", new("mine", Expand: [.. Enumerable.Range(0, 5).Select(index => new BigQueryJobReference("job_" + index))])),
            ("repeated pinned", new("mine", Pinned: [new("a"), new("a")])), ("bad job id", new("mine", Pinned: [new("a b")])),
            ("bad location", new("mine", Expand: [new("a", "no where")]))
        };
        var passed = refused.Where(item => !Refused(() => BigQueryJobHistory.Check(item.Args))).Select(item => item.Name).ToList();
        check(passed.Count == 0, "invalid args are INVALID_PARAMS: " + string.Join(", ", passed));
        check(good.SameListing(good with { Expand = null, Prices = false }) && !good.SameListing(good with { Scope = "all" }) && !good.SameListing(good with { Hours = 1 })
            && good.SameListing(good with { States = ["failed", "running"] }) && !good.SameListing(good with { Pinned = [new("a")] }),
            "expanded scripts and prices keep the listing; scope, range, filters and pinned jobs start a new one");
        var id = Guid.NewGuid().ToString();
        check(BigQueryJobHistory.Check(new BigQueryJobArgs(id, "script_1", "US")).JobId == "script_1" && Refused(() => BigQueryJobHistory.Check(new BigQueryJobArgs("x", "script_1")))
            && Refused(() => BigQueryJobHistory.Check(new BigQueryJobArgs(id, "a;b"))) && Refused(() => BigQueryJobHistory.Check(new BigQueryJobArgs(id, "a", "bad location"))),
            "bigquery.jobs.get and bigquery.jobs.cancel check the connection id, job id and location");

        var (min, max) = BigQueryJobsSampler.Range(new("mine", Hours: 1), now);
        var (oldMin, oldMax) = BigQueryJobsSampler.Range(new("mine", From: 0, To: 10), now);
        check(min == now - 3_600_000 && max is null && oldMin == now - BigQueryJobHistory.RetentionMs && oldMax == oldMin && BigQueryJobsSampler.Range(new("mine"), now).Min == now - 86_400_000,
            "the range counts back from now (24 hours by default) and stays within BigQuery's retention");
        check(BigQueryJobsSampler.ServerStates(new("mine", States: ["running"])) is ["pending", "running"] && BigQueryJobsSampler.ServerStates(new("mine", States: ["running", "done"])) is null
            && BigQueryJobsSampler.ServerStates(new("mine")) is null,
            "only an open-states filter narrows the listing, to both open states (a pending job starts running later); otherwise every state is listed so open jobs are followed to the end");
        var job = BigQueryJobHistory.Page(Parse(Timed("jobs-list", now)), 0).Items[0];
        check(BigQueryJobsSampler.Passes(new("mine", Types: ["query"], Statements: ["SELECT"], Varia: true), job) && !BigQueryJobsSampler.Passes(new("mine", Types: ["load"]), job)
            && !BigQueryJobsSampler.Passes(new("mine", Statements: ["INSERT"]), job) && !BigQueryJobsSampler.Passes(new("mine", Varia: true), job with { Varia = false }),
            "the type, statement and Started from Varia filters");
    }

    /// <summary>A row has the catalogue's columns in order, hides another user's hidden details, and writes no cost without prices.</summary>
    static void Rows(Action<bool, string> check)
    {
        var spec = LiveCatalog.Current.Probes[BigQueryJobsSampler.Probe];
        var columns = spec.Tables[0].Columns.Select(column => column.Id).ToList();
        int Col(string id) => columns.IndexOf(id);
        var now = Now;
        var items = BigQueryJobHistory.Page(Parse(Timed("jobs-list", now)), 0).Items.ToDictionary(job => job.Id);
        var other = BigQueryJobHistory.Page(Parse(Timed("jobs-list-page-2", now)), 0).Items.Single(job => job.Id == "other_user");
        var script = BigQueryJobsSampler.Row(items["script_1"], now, mine: true, prices: true, "▸ ", null);
        var hidden = BigQueryJobsSampler.Row(other, now, mine: false, prices: false, "", null);
        var child = BigQueryJobsSampler.Row(items["script_1_child"], now, mine: true, prices: false, "    ↳ ", "script_1");
        check(script.Cells.Length == columns.Count && script.Cells[Col("state")].Text == "Done" && script.Cells[Col("jobId")].Text == "▸ script_1" && script.Cells[Col("job")].Text == "script_1"
            && script.Cells[Col("cost")].Text is { Length: > 0 } && script.Cells[Col("children")].Text == "2" && script.Cells[Col("mine")].Text == "1",
            "a row has the catalogue's columns: state label, the job id with its script marker, its plain id, the cost and the children");
        check(hidden.Cells[Col("sql")].Text == "Details hidden by BigQuery" && hidden.Cells[Col("hidden")].Text == "1" && hidden.Cells[Col("mine")].Text == "0" && hidden.Cells[Col("cost")].Text is null,
            "another user's hidden job says so in place of its SQL; without prices no cost is written");
        check(child.Cells[Col("parent")].Text == "script_1" && child.Cells[Col("jobId")].Text == "    ↳ script_1_child"
            && BigQueryJobsSampler.Row(items["failed_1"], now, true, true, "", null).Cells[Col("tone")].Text == "error"
            && BigQueryJobsSampler.Row(items["failed_1"], now, true, true, "", null).Cells[Col("error")].Text!.StartsWith("notFound: ", StringComparison.Ordinal),
            "a child names its parent, and a failed job its error with its reason and the error tone");
    }

    /// <summary>The probe's idle interval applies while the last sample held nothing open, never below the load guard's.</summary>
    static void Schedule(Action<bool, string> check)
    {
        var spec = LiveCatalog.Current.Probes[BigQueryJobsSampler.Probe];
        var probe = new LiveProbeState(spec, 5000);
        var busy = LiveSubscription.InForce(probe);
        probe.Idle = true;
        var idle = LiveSubscription.InForce(probe);
        probe.EffectiveIntervalMs = 120_000;
        var guarded = LiveSubscription.InForce(probe);
        var plain = new LiveProbeState(LiveCatalog.Current.Probes["activity.overview"], 5000) { Idle = true };
        check(spec.IdleIntervalMs == 60_000 && busy == 5000 && idle == 60_000 && guarded == 120_000 && LiveSubscription.InForce(plain) == 5000
            && LiveCatalog.Current.Sources.Values.Where(source => source.Scope == "bigquery").All(source => source.Engines is ["bigquery"]),
            $"Job History samples every {busy} ms while a job is open and every {idle} ms otherwise; a probe without an idle interval keeps its own");
    }

    sealed class Harness : IDisposable
    {
        public BigQueryFake Fake { get; }
        public SqlService Service { get; }
        public ResultStore Store { get; }
        public string ConnectionId { get; private set; } = "";
        public long Now { get; } = BigQueryJobHistoryChecks.Now;

        public Harness()
        {
            Fake = BigQueryFake.Google()
                .On("GET", Jobs, request => new BigQueryFake.Reply(200, Timed(request.Uri.Query.Contains("parentJobId=", StringComparison.Ordinal) ? "jobs-children"
                    : request.Uri.Query.Contains("pageToken=jobs-page-2", StringComparison.Ordinal) ? "jobs-list-page-2" : "jobs-list", Now)))
                .On("GET", Jobs + "/[^/]+", BigQueryFake.Fixture("error-not-found", 404))
                .On("GET", Jobs + "/script_1", _ => new BigQueryFake.Reply(200, Timed("job-script", Now)))
                .On("POST", Jobs + "/[^/]+/cancel", request => new BigQueryFake.Reply(200, new JsonObject
                {
                    ["kind"] = "bigquery#jobCancelResponse",
                    ["job"] = new JsonObject
                    {
                        ["jobReference"] = new JsonObject { ["projectId"] = "varia-alpha", ["jobId"] = request.Url.Split('/')[^2], ["location"] = "US" },
                        ["status"] = new JsonObject { ["state"] = "DONE", ["errorResult"] = new JsonObject { ["reason"] = "stopped", ["message"] = "Job execution was cancelled" } }
                    }
                }.ToJsonString()));
            Service = new SqlService(Store = CheckStores.Unprobed(), bigQuery: new BigQueryEnvironment(null, Fake.Factory, new SubjectTokens([])));
            Service.BigQuery.RetryDelay = TimeSpan.FromMilliseconds(1);
        }

        public async Task ConnectAsync(JsonObject key)
        {
            var options = new JsonObject
            {
                ["provider"] = "bigquery", ["project"] = "varia-alpha", ["authentication"] = "serviceAccountKey", ["location"] = "US",
                ["credential"] = new JsonObject { ["source"] = "file", ["json"] = key.ToJsonString() }, ["keyFile"] = Guid.NewGuid().ToString()
            };
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

        public BigQueryJobsSampler Sampler(BigQueryJobHistoryArgs args) => new(Service.BigQuery, Store, Guid.NewGuid().ToString(), ConnectionId, args, LiveCatalog.Current.Limits);

        /// <summary>The jobs.list requests the fake saw, by their query strings.</summary>
        public List<string> Listings() => [.. Fake.To(Jobs).Where(request => request.Method == "GET").Select(request => Uri.UnescapeDataString(request.Uri.Query))];
        public int Gets(string jobId) => Fake.To(Jobs + "/" + jobId).Count(request => request.Method == "GET");

        public void Dispose() => Service.Dispose();
    }

    static LiveDue Due(int budgetMs = 30_000) => new(new LiveProbeState(LiveCatalog.Current.Probes[BigQueryJobsSampler.Probe], 5000), null, null, null, null, new Dictionary<int, LiveTrackArgs>(), BudgetMs: budgetMs);

    static async Task<LiveSampleBatch> SampleAsync(BigQueryJobsSampler sampler) => await sampler.SampleAsync([Due()], CancellationToken.None);

    static object? Status(LiveSampleBatch batch, string id) => batch.Samples.Single().Status!.Single(status => status.Id == id).Value;
    static long Rows(LiveSampleBatch batch) => batch.Samples.Single().Tables is [var table] ? table.Descriptor.RowsStored : -1;

    /// <summary>My jobs: the first sample lists the range page by page; the next asks only for new and open jobs, reads a job that
    /// finished with jobs.get, and once nothing is open the probe is idle and no DONE job is read again.</summary>
    static async Task SamplerAsync(Action<bool, string> check, JsonObject key)
    {
        using var harness = new Harness();
        await harness.ConnectAsync(key);
        using var sampler = harness.Sampler(new("mine", Hours: 24));
        var first = await SampleAsync(sampler);
        var listings = harness.Listings();
        check(first.Errors.Count == 0 && Status(first, "held") is 7 && Status(first, "open") is 1 && Status(first, "loading") is 0 && Status(first, "more") is 0
            && (string?)Status(first, "unreachable") == "asia-east1" && Rows(first) == 7 && !sampler.IsIdle(BigQueryJobsSampler.Probe),
            $"the first sample holds the range's 7 top-level jobs from both pages, one open (errors {first.Errors.Count}, rows {Rows(first)})");
        check(listings.Count == 2 && listings.All(query => query.Contains("projection=full", StringComparison.Ordinal) && query.Contains("maxResults=100", StringComparison.Ordinal)
            && query.Contains("minCreationTime=", StringComparison.Ordinal) && !query.Contains("allUsers", StringComparison.Ordinal)) && listings[1].Contains("pageToken=jobs-page-2", StringComparison.Ordinal),
            "My jobs lists with projection=full in pages of 100 over the range, without allUsers: " + string.Join(" | ", listings));

        // The running job finished: it is in no listing now, and jobs.get answers its final state.
        harness.Fake.On("GET", Jobs, BigQueryFake.Text("""{"kind":"bigquery#jobList"}"""))
            .On("GET", Jobs + "/varia_running", _ => new BigQueryFake.Reply(200, Timed("jobs-list", harness.Now).Replace("\"RUNNING\"", "\"DONE\"") is var text
                ? JsonNode.Parse(text)!["jobs"]![0]!.ToJsonString() : ""));
        var second = await SampleAsync(sampler);
        var next = harness.Listings().Skip(2).ToList();
        check(second.Errors.Count == 0 && Status(second, "held") is 7 && Status(second, "open") is 0 && harness.Gets("varia_running") == 1 && sampler.IsIdle(BigQueryJobsSampler.Probe)
            && harness.Fake.To(Jobs + "/varia_running").Single().Uri.Query.Contains("location=US", StringComparison.Ordinal),
            $"a refresh reads the open job that left the open listing with jobs.get in its location, and then nothing is open (errors {second.Errors.Count})");
        check(next.Count == 2 && next.Any(query => query.Contains("stateFilter=pending", StringComparison.Ordinal) && query.Contains("stateFilter=running", StringComparison.Ordinal))
            && next.All(query => query.Contains("minCreationTime=", StringComparison.Ordinal)),
            "a refresh asks for jobs created since the newest held and for the open jobs: " + string.Join(" | ", next));
        var third = await SampleAsync(sampler);
        check(third.Errors.Count == 0 && harness.Gets("varia_running") == 1 && harness.Listings().Count == 5 && sampler.IsIdle(BigQueryJobsSampler.Probe),
            "with nothing open a refresh asks only for new jobs and never reads a DONE job again");
        check(harness.Fake.Unmatched.IsEmpty, "every request was one the fake answers: " + string.Join(", ", harness.Fake.Unmatched.Select(request => request.Method + " " + request.Url)));
    }

    /// <summary>All users: a refusal is a status the renderer answers by turning the toggle off, never an error; an allowed listing
    /// marks the principal's own jobs with a minimal My jobs listing over their creation window.</summary>
    static async Task AllUsersAsync(Action<bool, string> check, JsonObject key)
    {
        using var harness = new Harness();
        await harness.ConnectAsync(key);
        harness.Fake.On("GET", Jobs, request => request.Uri.Query.Contains("allUsers=true", StringComparison.Ordinal) ? BigQueryFake.Fixture("error-access-denied", 403)
            : new BigQueryFake.Reply(200, Timed(request.Uri.Query.Contains("pageToken=jobs-page-2", StringComparison.Ordinal) ? "jobs-list-page-2" : "jobs-list", harness.Now)));
        using var sampler = harness.Sampler(new("all", Hours: 24));
        var denied = await SampleAsync(sampler);
        var again = await SampleAsync(sampler);
        check(denied.Errors.Count == 0 && Status(denied, "allUsersDenied") is 1 && Status(denied, "held") is 0 && Rows(denied) == 0 && Status(again, "allUsersDenied") is 1
            && harness.Listings().Count(query => query.Contains("allUsers=true", StringComparison.Ordinal)) == 1,
            "a refused All users listing is the allUsersDenied status with no rows and is not asked again under the same args");
        sampler.Apply(new BigQueryJobHistoryArgs("mine", Hours: 24));
        var mine = await SampleAsync(sampler);
        check(Status(mine, "allUsersDenied") is 0 && Status(mine, "held") is 7, "My jobs lists again once the renderer turns the toggle off");

        // A VPC Service Controls refusal is no missing bigquery.jobs.list: an error naming the perimeter, not allUsersDenied.
        using var fenced = new Harness();
        await fenced.ConnectAsync(key);
        fenced.Fake.On("GET", Jobs, BigQueryFake.Fixture("error-vpc-service-controls", 403));
        using var blocked = fenced.Sampler(new("all", Hours: 24));
        var perimeter = await SampleAsync(blocked);
        check((perimeter.Samples.Count == 0 || Status(perimeter, "allUsersDenied") is not 1) && perimeter.Errors.Any(error => error.Message.StartsWith(BigQueryErrors.PerimeterOpening, StringComparison.Ordinal)),
            "an All users listing VPC Service Controls refuses is an error naming the perimeter, not the allUsersDenied status: " + string.Join(" | ", perimeter.Errors.Select(error => error.Code + " " + error.Message)));

        using var allowed = new Harness();
        await allowed.ConnectAsync(key);
        allowed.Fake.On("GET", Jobs, request => request.Uri.Query.Contains("projection=minimal", StringComparison.Ordinal)
            ? BigQueryFake.Text("""{"jobs":[{"jobReference":{"projectId":"varia-alpha","jobId":"script_1","location":"US"},"state":"DONE"}]}""")
            : new BigQueryFake.Reply(200, Timed(request.Uri.Query.Contains("pageToken=jobs-page-2", StringComparison.Ordinal) ? "jobs-list-page-2" : "jobs-list", allowed.Now)));
        using var all = allowed.Sampler(new("all", Hours: 24));
        var listed = await SampleAsync(all);
        var queries = allowed.Listings();
        var minimal = queries.Where(query => query.Contains("projection=minimal", StringComparison.Ordinal)).ToList();
        check(listed.Errors.Count == 0 && Status(listed, "held") is 7 && queries.Count(query => query.Contains("allUsers=true", StringComparison.Ordinal)) == 2
            && minimal.Count == 1 && !minimal[0].Contains("allUsers", StringComparison.Ordinal) && minimal[0].Contains("maxCreationTime=", StringComparison.Ordinal),
            "All users lists with allUsers and marks the principal's jobs with one minimal listing without it: " + string.Join(" | ", queries));
        await SampleAsync(all);
        check(allowed.Listings().Count(query => query.Contains("projection=minimal", StringComparison.Ordinal)) == 1, "each job is classified once");
    }

    /// <summary>Pinned jobs are read with jobs.get whatever their age, a missing one is left out without asking again, and an
    /// expanded script lists its children under it once it has finished.</summary>
    static async Task PinnedAndExpandedAsync(Action<bool, string> check, JsonObject key)
    {
        using var harness = new Harness();
        await harness.ConnectAsync(key);
        using var pinned = harness.Sampler(new("mine", Pinned: [new("script_1", "US"), new("gone_1")]));
        var first = await SampleAsync(pinned);
        var second = await SampleAsync(pinned);
        check(first.Errors.Count == 0 && Status(first, "held") is 1 && Rows(first) == 1 && harness.Gets("script_1") == 1 && harness.Gets("gone_1") == 1 && Status(second, "held") is 1
            && harness.Listings().All(query => query.Contains("projection=minimal", StringComparison.Ordinal)),
            "a pinned view reads its jobs with jobs.get once each (a DONE job and a missing one are not read again) and lists only to mark the principal's");

        using var expanded = new Harness();
        await expanded.ConnectAsync(key);
        using var sampler = expanded.Sampler(new("mine", Hours: 24, Expand: [new("script_1", "US")]));
        var tree = await SampleAsync(sampler);
        var children = expanded.Listings().Where(query => query.Contains("parentJobId=script_1", StringComparison.Ordinal)).ToList();
        check(tree.Errors.Count == 0 && Rows(tree) == 9 && children.Count == 1, $"an expanded script's two children show under it ({Rows(tree)} rows, {children.Count} child listings)");
        await SampleAsync(sampler);
        check(expanded.Listings().Count(query => query.Contains("parentJobId=", StringComparison.Ordinal)) == 1, "a finished script's children are not listed again");
        sampler.Apply(new BigQueryJobHistoryArgs("mine", Hours: 24, Prices: false));
        var collapsed = await SampleAsync(sampler);
        check(Rows(collapsed) == 7 && Status(collapsed, "held") is 7, "collapsing the script drops its children without listing again");
    }

    /// <summary>The newest creation time listed moves only once a listing is whole, and every top-level job moves it, filtered out
    /// or not: a refresh stopped after its first page lists those pages again, and a rare filter never re-lists the range.</summary>
    static async Task WatermarkAsync(Action<bool, string> check, JsonObject key)
    {
        static long? MinCreated(string query) => Regex.Match(query, "minCreationTime=(\\d+)") is { Success: true } match ? long.Parse(match.Groups[1].Value) : null;
        using var harness = new Harness();
        await harness.ConnectAsync(key);
        using var sampler = harness.Sampler(new("mine", Hours: 24));
        await SampleAsync(sampler);
        // The refresh's listing of new jobs: a newer job on its first page, then a refusal on its second.
        var newer = JsonNode.Parse(Timed("jobs-list", harness.Now))!["jobs"]![0]!.DeepClone();
        newer["id"] = "varia-alpha:US.newer_1";
        newer["jobReference"]!["jobId"] = "newer_1";
        newer["statistics"]!["creationTime"] = (harness.Now - 5_000).ToString(System.Globalization.CultureInfo.InvariantCulture);
        var refused = true;
        harness.Fake.On("GET", Jobs, request => request.Uri.Query.Contains("stateFilter=", StringComparison.Ordinal) ? BigQueryFake.Text("""{"kind":"bigquery#jobList"}""")
            : request.Uri.Query.Contains("pageToken=since-2", StringComparison.Ordinal) ? refused ? BigQueryFake.Fixture("error-access-denied", 403) : BigQueryFake.Text("""{"kind":"bigquery#jobList"}""")
            : new BigQueryFake.Reply(200, new JsonObject { ["kind"] = "bigquery#jobList", ["nextPageToken"] = "since-2", ["jobs"] = new JsonArray(newer.DeepClone()) }.ToJsonString()));
        harness.Fake.On("GET", Jobs + "/varia_running", _ => new BigQueryFake.Reply(200, JsonNode.Parse(Timed("jobs-list", harness.Now).Replace("\"RUNNING\"", "\"DONE\""))!["jobs"]![0]!.ToJsonString()));
        var stopped = await SampleAsync(sampler);
        string Refresh(int from) => harness.Listings().Skip(from).FirstOrDefault(query => !query.Contains("stateFilter=", StringComparison.Ordinal)) ?? "";
        var before = harness.Listings().Count;
        refused = false;
        await SampleAsync(sampler);
        var resumed = Refresh(before);
        before = harness.Listings().Count;
        await SampleAsync(sampler);
        var next = Refresh(before);
        check(stopped.Errors is [{ Code: "PERMISSION_DENIED" }] && resumed.Contains("pageToken=since-2", StringComparison.Ordinal)
            && MinCreated(resumed) == harness.Now - 30_000 - BigQueryJobHistory.OverlapMs && MinCreated(next) == harness.Now - 5_000 - BigQueryJobHistory.OverlapMs,
            $"a refresh stopped after its first page goes on from that page in its own window, and only once whole does the next one list from the newer job ({resumed} | {next})");

        using var filtered = new Harness();
        await filtered.ConnectAsync(key);
        // Every job finished, so the newest (a query) is neither held nor followed: only "filtered out or not" moves the watermark.
        filtered.Fake.On("GET", Jobs, request => new BigQueryFake.Reply(200, Timed(request.Uri.Query.Contains("pageToken=jobs-page-2", StringComparison.Ordinal) ? "jobs-list-page-2" : "jobs-list", filtered.Now).Replace("\"RUNNING\"", "\"DONE\"").Replace("\"PENDING\"", "\"DONE\"")));
        using var loads = filtered.Sampler(new("mine", Hours: 24, Types: ["load"]));
        var first = await SampleAsync(loads);
        await SampleAsync(loads);
        var refresh = filtered.Listings().Skip(2).Where(query => !query.Contains("stateFilter=", StringComparison.Ordinal)).Select(MinCreated).FirstOrDefault();
        check(Status(first, "held") is 1 && refresh == filtered.Now - 30_000 - BigQueryJobHistory.OverlapMs,
            $"with a type filter a refresh still lists only since the newest job listed, filtered out or not ({filtered.Now - refresh} ms back)");
        check(!LiveCatalog.Current.Probes[BigQueryJobsSampler.Probe].LoadGuard && LiveCatalog.Current.Probes.Values.Where(probe => !probe.LoadGuard).Select(probe => probe.Id).Order(StringComparer.Ordinal).SequenceEqual([BigQueryJobsSampler.Probe, BigQueryExplorerSampler.Probe]) && !((ILiveSampler)loads).HasRates,
            "Job History and the Object Explorer chip (both BigQuery API reads) are the only probes out of the load guard: their cost is network and quota waits, and Job History's catalogue intervals hold");
    }

    /// <summary>Pinned jobs months apart are classified one millisecond each, never by listing every job between them; a pinned
    /// view shows its jobs whatever the state filter says; and a cancel's answer reads a timed-out job as failed.</summary>
    static async Task PinnedClassifyAsync(Action<bool, string> check, JsonObject key)
    {
        using var harness = new Harness();
        await harness.ConnectAsync(key);
        var load = JsonNode.Parse(Timed("jobs-list-page-2", harness.Now))!["jobs"]![0]!.ToJsonString();
        harness.Fake.On("GET", Jobs + "/load_1", _ => new BigQueryFake.Reply(200, load));
        using var pinned = harness.Sampler(new("mine", States: ["running"], Pinned: [new("script_1", "US"), new("load_1", "US")]));
        var batch = await SampleAsync(pinned);
        var minimal = harness.Listings().Where(query => query.Contains("projection=minimal", StringComparison.Ordinal)).ToList();
        // The fake's listing has a second page, so each window takes two requests.
        var windows = minimal.Select(query => (Min: long.Parse(Regex.Match(query, "minCreationTime=(\\d+)").Groups[1].Value), Max: long.Parse(Regex.Match(query, "maxCreationTime=(\\d+)").Groups[1].Value))).Distinct().ToList();
        check(batch.Errors.Count == 0 && windows.Count == 2 && windows.All(window => window.Max - window.Min == 1),"pinned jobs are classified with one minimal listing of each one's millisecond: " + string.Join(" | ", minimal));
        check(Rows(batch) == 2, $"a pinned view shows its jobs whatever the state filter says ({Rows(batch)} rows)");
        check(!BigQueryJobHistory.Cancelled("stopped", "Job timed out after 6 hours") && BigQueryJobHistory.Cancelled("stopped", "Job execution was cancelled")
            && !BigQueryJobHistory.Cancelled("invalidQuery", "Syntax error"), "a stopped job is cancelled unless it timed out, in the grid and in a cancel's answer alike");
    }

    /// <summary>A listing the time budget stops goes on from its page next time, never from its first page again, even when the
    /// budget's cancellation cut a request; an open job
    /// the filters leave out is still followed (the probe is not idle while it runs); and another user's finished job, where
    /// jobs.get on it is refused, is read by a done listing of its own creation millisecond.</summary>
    static async Task BudgetAndFollowAsync(Action<bool, string> check, JsonObject key)
    {
        using var harness = new Harness();
        await harness.ConnectAsync(key);
        var template = JsonNode.Parse(Timed("jobs-list", harness.Now))!["jobs"]![1]!;
        JsonNode Job(int n)
        {
            var job = template.DeepClone();
            job["id"] = "varia-alpha:US.paged_" + n;
            job["jobReference"]!["jobId"] = "paged_" + n;
            job["statistics"]!["creationTime"] = (harness.Now - n * 60_000L).ToString(System.Globalization.CultureInfo.InvariantCulture);
            job["statistics"]!.AsObject().Remove("numChildJobs");
            return job;
        }
        Func<BigQueryFake.Request, BigQueryFake.Reply> Pages(int delayMs) => request =>
        {
            Thread.Sleep(delayMs);
            var at = Regex.Match(request.Uri.Query, "pageToken=p(\\d)") is { Success: true } match ? int.Parse(match.Groups[1].Value) : 1;
            var page = new JsonObject { ["kind"] = "bigquery#jobList", ["jobs"] = new JsonArray(Job(at)) };
            if (at < 6) page["nextPageToken"] = "p" + (at + 1);
            return new BigQueryFake.Reply(200, page.ToJsonString());
        };
        List<string> Tokens(Harness of) => [.. of.Listings().Select(query => Regex.Match(query, "pageToken=(p\\d)").Groups[1].Value)];
        // Six pages of one job each, every answer 700 ms late: a 3.5 s budget stops between pages around 2.6 s, before the sixth,
        // while leaving enough headroom for page 1 on a loaded runner so the first page is never cut and asked twice.
        harness.Fake.On("GET", Jobs, Pages(700));
        using var sampler = harness.Sampler(new("mine", Hours: 24));
        var samples = 0;
        LiveSampleBatch batch;
        do batch = await sampler.SampleAsync([Due(3500)], CancellationToken.None);
        while (Status(batch, "loading") is 1 && ++samples < 30);
        var tokens = Tokens(harness);
        check(Status(batch, "loading") is 0 && Status(batch, "held") is 6 && samples >= 1 && tokens.Count(token => token == "") == 1
            && Enumerable.Range(2, 5).All(page => tokens.Contains("p" + page)),
            $"a listing the time budget stops goes on from its page over {samples + 1} samples, its first page asked once: {string.Join(",", tokens)}");

        // The budget's cancellation cuts the third page's request: the next sample asks for that page again, not the first.
        using var cut = new Harness();
        await cut.ConnectAsync(key);
        cut.Fake.On("GET", Jobs, Pages(0));
        // A starved runner may stop between pages before the third: then nothing hangs, and the check still holds.
        var firstSample = true;
        var hung = 0;
        cut.Fake.Hang = request => firstSample && request.Uri.Query.Contains("pageToken=p3", StringComparison.Ordinal) && Interlocked.Increment(ref hung) == 1;
        using var cutSampler = cut.Sampler(new("mine", Hours: 24));
        var stopped = await cutSampler.SampleAsync([Due(2500)], CancellationToken.None);
        firstSample = false;
        var resumed = await cutSampler.SampleAsync([Due()], CancellationToken.None);
        var asked = Tokens(cut);
        check(Status(stopped, "loading") is 1 && Status(resumed, "loading") is 0 && Status(resumed, "held") is 6
            && asked.Count(token => token == "") == 1 && asked.Count(token => token == "p3") == (hung > 0 ? 2 : 1) && (hung == 0 || Status(stopped, "held") is 2),
            "a request the budget's cancellation cuts loses only that page: " + string.Join(",", asked));

        using var filtered = new Harness();
        await filtered.ConnectAsync(key);
        using var loads = filtered.Sampler(new("mine", Hours: 24, Types: ["load"]));
        var first = await SampleAsync(loads);
        check(Status(first, "held") is 1 && Status(first, "open") is 0 && Rows(first) == 1 && !loads.IsIdle(BigQueryJobsSampler.Probe),
            "a running job the type filter leaves out is not a row but is still followed, so the probe is not idle");
        await SampleAsync(loads);
        var openWindow = filtered.Listings().LastOrDefault(query => query.Contains("stateFilter=pending", StringComparison.Ordinal)) ?? "";
        var runningCreated = JsonNode.Parse(Timed("jobs-list", filtered.Now))!["jobs"]![0]!["statistics"]!["creationTime"]!.ToString();
        check(Regex.Match(openWindow, "minCreationTime=(\\d+)").Groups[1].Value == runningCreated,
            "the open jobs' listing starts at the oldest open job held, not at the range's start: " + openWindow);

        using var shared = new Harness();
        await shared.ConnectAsync(key);
        var listed = false;
        var done = JsonNode.Parse(Timed("jobs-list", shared.Now).Replace("\"RUNNING\"", "\"DONE\""))!["jobs"]![0]!;
        shared.Fake.On("GET", Jobs, request =>
        {
            var query = request.Uri.Query;
            if (query.Contains("projection=minimal", StringComparison.Ordinal)) return BigQueryFake.Text("""{"kind":"bigquery#jobList"}""");
            if (query.Contains("stateFilter=done", StringComparison.Ordinal)) return new BigQueryFake.Reply(200, new JsonObject { ["jobs"] = new JsonArray(done.DeepClone()) }.ToJsonString());
            if (query.Contains("stateFilter=", StringComparison.Ordinal) || listed) return BigQueryFake.Text("""{"kind":"bigquery#jobList"}""");
            return new BigQueryFake.Reply(200, Timed(query.Contains("pageToken=jobs-page-2", StringComparison.Ordinal) ? "jobs-list-page-2" : "jobs-list", shared.Now));
        }).On("GET", Jobs + "/varia_running", BigQueryFake.Fixture("error-access-denied", 403));
        using var all = shared.Sampler(new("all", Hours: 24));
        await SampleAsync(all);
        listed = true;
        var finished = await SampleAsync(all);
        var window = shared.Listings().Where(query => query.Contains("stateFilter=done", StringComparison.Ordinal)).ToList();
        check(finished.Errors.Count == 0 && Status(finished, "open") is 0 && shared.Gets("varia_running") == 1 && window is [var only]
            && long.Parse(Regex.Match(only, "maxCreationTime=(\\d+)").Groups[1].Value) - long.Parse(Regex.Match(only, "minCreationTime=(\\d+)").Groups[1].Value) == 1,
            "another user's finished job, where jobs.get is refused, is read by a done listing of its creation millisecond: " + string.Join(" | ", window));
    }

    /// <summary>With the cap reached, an open job the filters leave out is still followed, so one that finishes into them shows;
    /// and samples the budget cuts before any answer lands fail with TIMEOUT after a few, rather than load for ever.</summary>
    static async Task CapAndStallAsync(Action<bool, string> check, JsonObject key)
    {
        using var harness = new Harness();
        await harness.ConnectAsync(key);
        var template = JsonNode.Parse(Timed("jobs-list", harness.Now))!["jobs"]!;
        static long CreatedOf(JsonNode job) => long.Parse(job["statistics"]!["creationTime"]!.ToString(), System.Globalization.CultureInfo.InvariantCulture);
        var all = new List<JsonNode>();
        for (var n = 0; n <= BigQueryJobHistory.MaxJobs; n++)
        {
            var job = template[1]!.DeepClone();
            job["id"] = "varia-alpha:US.done_" + n;
            job["jobReference"]!["jobId"] = "done_" + n;
            job["statistics"]!["creationTime"] = (harness.Now - n * 1000L).ToString(System.Globalization.CultureInfo.InvariantCulture);
            job["statistics"]!.AsObject().Remove("numChildJobs");
            all.Add(job);
        }
        // A running job five minutes old: older than the refresh's window, newer than the thousandth job shown.
        var running = template[0]!.DeepClone();
        running["statistics"]!["creationTime"] = (harness.Now - 300_500).ToString(System.Globalization.CultureInfo.InvariantCulture);
        var finished = false;
        harness.Fake.On("GET", Jobs, request =>
        {
            var query = Uri.UnescapeDataString(request.Uri.Query);
            var min = Regex.Match(query, "minCreationTime=(\\d+)") is { Success: true } match ? long.Parse(match.Groups[1].Value) : 0;
            IEnumerable<JsonNode> listed = query.Contains("stateFilter=", StringComparison.Ordinal) ? finished ? [] : [running]
                : [.. all, finished ? JsonNode.Parse(running.ToJsonString().Replace("\"RUNNING\"", "\"DONE\""))! : running];
            var jobs = listed.Where(job => CreatedOf(job) >= min).OrderByDescending(CreatedOf).ToList();
            var at = Regex.Match(query, "pageToken=c(\\d+)") is { Success: true } token ? int.Parse(token.Groups[1].Value) : 0;
            var page = new JsonObject { ["kind"] = "bigquery#jobList", ["jobs"] = new JsonArray([.. jobs.Skip(at * 100).Take(100).Select(job => job.DeepClone())]) };
            if (jobs.Count > (at + 1) * 100) page["nextPageToken"] = "c" + (at + 1);
            return new BigQueryFake.Reply(200, page.ToJsonString());
        }).On("GET", Jobs + "/varia_running", _ => new BigQueryFake.Reply(200, running.ToJsonString().Replace("\"RUNNING\"", "\"DONE\"")));
        using var sampler = harness.Sampler(new("mine", Hours: 24, States: ["done"]));
        var capped = await SampleAsync(sampler);
        var followed = !sampler.IsIdle(BigQueryJobsSampler.Probe);
        finished = true;
        var after = await SampleAsync(sampler);
        check(capped.Errors.Count == 0 && Status(capped, "held") is 1000 && Status(capped, "more") is 1 && followed
            && after.Errors.Count == 0 && Status(after, "held") is 1000 && harness.Gets("varia_running") == 1 && sampler.IsIdle(BigQueryJobsSampler.Probe),
            "with 1,000 jobs shown, a running job the state filter leaves out is still followed, and read once it finishes into the filter");

        using var stalled = new Harness();
        await stalled.ConnectAsync(key);
        stalled.Fake.Hang = request => request.Uri.AbsolutePath.EndsWith("/jobs", StringComparison.Ordinal);
        using var waiting = stalled.Sampler(new("mine", Hours: 24));
        var cut = new List<LiveSampleBatch>();
        for (var n = 0; n <= BigQueryJobsSampler.StallsBeforeTimeout; n++) cut.Add(await waiting.SampleAsync([Due(1000)], CancellationToken.None));
        var sizes = stalled.Listings().Select(query => int.Parse(Regex.Match(query, "maxResults=(\\d+)").Groups[1].Value)).ToList();
        check(cut[..^2].All(batch => batch.Errors.Count == 0 && Status(batch, "loading") is 1) && cut[^2].Errors is [{ Code: "TIMEOUT" }] && cut[^1].Errors is [{ Code: "TIMEOUT" }]
            && sizes is [100, 25, 6, 1],
            $"samples the budget cuts before any answer fail with TIMEOUT from the {BigQueryJobsSampler.StallsBeforeTimeout}rd on, each one after, so the back-off grows; each asks for a quarter of the jobs a page: {string.Join(",", sizes)}");

        // The open jobs' listing goes on from its page next time: a finished job is read once that listing is whole, and its
        // first page is never asked again.
        using var slow = new Harness();
        await slow.ConnectAsync(key);
        using var follower = slow.Sampler(new("mine", Hours: 24));
        await SampleAsync(follower);
        // Its second page hangs in the first sample until the budget's cancellation cuts it, whatever the runner's speed.
        var cutting = true;
        var hangs = 0;
        slow.Fake.Hang = request => cutting && request.Uri.Query.Contains("pageToken=o2", StringComparison.Ordinal) && Interlocked.Increment(ref hangs) > 0;
        slow.Fake.On("GET", Jobs, request =>
        {
            var query = request.Uri.Query;
            if (!query.Contains("stateFilter=", StringComparison.Ordinal) || query.Contains("pageToken=o2", StringComparison.Ordinal)) return BigQueryFake.Text("""{"kind":"bigquery#jobList"}""");
            return BigQueryFake.Text("""{"kind":"bigquery#jobList","nextPageToken":"o2"}""");
        }).On("GET", Jobs + "/varia_running", _ => new BigQueryFake.Reply(200, JsonNode.Parse(Timed("jobs-list", slow.Now).Replace("\"RUNNING\"", "\"DONE\""))!["jobs"]![0]!.ToJsonString()));
        // Two samples cut there: in the second the open listing under way goes on first, and its first request is cut.
        await follower.SampleAsync([Due(3000)], CancellationToken.None);
        await follower.SampleAsync([Due(3000)], CancellationToken.None);
        cutting = false;
        var settled = await SampleAsync(follower);
        var open = slow.Listings().Where(query => query.Contains("stateFilter=", StringComparison.Ordinal)).ToList();
        // An o2 request right after another o2 request opened its sample's open listing (the one before it was cut).
        static int Stuck(List<string> requests) => requests.Skip(1).Take(requests.Count - 2)
            .Where((query, index) => query.Contains("pageToken=o2", StringComparison.Ordinal) && requests[index].Contains("pageToken=o2", StringComparison.Ordinal)).Count();
        check(settled.Errors.Count == 0 && Status(settled, "open") is 0 && slow.Gets("varia_running") == 1
            && open.Count(query => !query.Contains("pageToken=", StringComparison.Ordinal)) == 1 && open.Count(query => query.Contains("pageToken=o2", StringComparison.Ordinal)) == hangs + 1
            // A cut page that was its listing's first request that sample made no progress, though the refresh before it
            // answered: each such cut asks for a quarter of the jobs a page after.
            && int.Parse(Regex.Match(open[^1], "maxResults=(\\d+)").Groups[1].Value) == 100 / (int)Math.Pow(4, Stuck(open)),
            "the open jobs' listing goes on from its page in the next sample, and a job it left out is read once it is whole: " + string.Join(" | ", open));

        // A refresh listing slower than a quarter of the budget: the open jobs' listing sent after it had too little time for its
        // cut to say pages are too large, and it goes first in the next sample rather than wait behind the refresh again.
        using var late = new Harness();
        await late.ConnectAsync(key);
        using var trailing = late.Sampler(new("mine", Hours: 24));
        await SampleAsync(trailing);
        var lagging = true;
        late.Fake.Hang = request => lagging && request.Uri.Query.Contains("stateFilter=", StringComparison.Ordinal);
        late.Fake.On("GET", Jobs, request =>
        {
            // The answer's latency is what this check is about: past a quarter of the budget below, with headroom for loaded runners.
            if (lagging && !request.Uri.Query.Contains("stateFilter=", StringComparison.Ordinal)) Thread.Sleep(1100);
            return BigQueryFake.Text("""{"kind":"bigquery#jobList"}""");
        }).On("GET", Jobs + "/varia_running", _ => new BigQueryFake.Reply(200, JsonNode.Parse(Timed("jobs-list", late.Now).Replace("\"RUNNING\"", "\"DONE\""))!["jobs"]![0]!.ToJsonString()));
        var before = late.Listings().Count;
        var cutLate = await trailing.SampleAsync([Due(4000)], CancellationToken.None);
        lagging = false;
        var middle = late.Listings().Count;
        var caughtUp = await SampleAsync(trailing);
        var lateListings = late.Listings().Skip(before).ToList();
        var nextSample = late.Listings().Skip(middle).ToList();
        check(cutLate.Errors.Count == 0 && Status(cutLate, "loading") is 1 && caughtUp.Errors.Count == 0 && Status(caughtUp, "open") is 0
            && nextSample.Count > 0 && nextSample[0].Contains("stateFilter=", StringComparison.Ordinal)
            && lateListings.All(query => query.Contains("maxResults=100", StringComparison.Ordinal)),
            "a late request the budget cuts keeps the page size, and the open jobs' listing it cut goes first next time: " + string.Join(" | ", lateListings));
    }

    /// <summary>BigQuery's refusals reach the probe as their liveErrorCodes.</summary>
    static async Task FailuresAsync(Action<bool, string> check, JsonObject key)
    {
        var cases = new (string Fixture, int Status, string Code)[]
        {
            ("error-access-denied", 403, "PERMISSION_DENIED"), ("error-quota-exceeded", 403, "QUOTA"), ("error-access-not-configured", 403, "API_DISABLED"),
            ("error-unauthenticated", 401, "AUTH_EXPIRED")
        };
        var wrong = new List<string>();
        foreach (var (fixture, status, code) in cases)
        {
            using var harness = new Harness();
            await harness.ConnectAsync(key);
            harness.Fake.On("GET", Jobs, BigQueryFake.Fixture(fixture, status));
            using var sampler = harness.Sampler(new("mine", Hours: 24));
            var batch = await SampleAsync(sampler);
            if (batch.Samples.Count != 0 || batch.Errors is not [var error] || error.Code != code) wrong.Add(fixture + " → " + string.Join(",", batch.Errors.Select(item => item.Code)));
        }
        check(wrong.Count == 0, "a refused listing is the probe's AUTH_EXPIRED, PERMISSION_DENIED, QUOTA or API_DISABLED error: " + string.Join("; ", wrong));

        // A 429 the client's retries absorb until the budget runs out is QUOTA at once, not "still loading" and later TIMEOUT,
        // and it keeps the page size (a refusal says nothing about how large a page may be).
        using var limited = new Harness();
        await limited.ConnectAsync(key);
        limited.Fake.On("GET", Jobs, _ => new BigQueryFake.Reply(429, """{"error":{"code":429,"message":"Exceeded rate limits: too many api requests per user per method","errors":[{"reason":"rateLimitExceeded"}]}}"""));
        using var throttled = limited.Sampler(new("mine", Hours: 24));
        var first = await throttled.SampleAsync([Due(1000)], CancellationToken.None);
        var second = await throttled.SampleAsync([Due(1000)], CancellationToken.None);
        var sizes = limited.Listings().Select(query => Regex.Match(query, "maxResults=(\\d+)").Groups[1].Value).Distinct().ToList();
        check(first.Samples.Count == 0 && first.Errors is [{ Code: "QUOTA" } quota] && quota.Message.Contains("rate limit", StringComparison.Ordinal)
            && second.Errors is [{ Code: "QUOTA" }] && limited.Listings().Count > 2 && sizes is ["100"],
            $"a rate limit retried until the budget ran out is the probe's QUOTA error from the first sample, at the same page size: {string.Join(",", first.Errors.Select(item => item.Code))} {string.Join(",", sizes)}");

        // A QUOTA sample breaks a run of stalls: BigQuery answered it, so stall, stall, QUOTA, stall is one stall, not TIMEOUT.
        using var mixed = new Harness();
        await mixed.ConnectAsync(key);
        var throttle = false;
        mixed.Fake.Hang = request => !Volatile.Read(ref throttle) && request.Uri.AbsolutePath.EndsWith("/jobs", StringComparison.Ordinal);
        mixed.Fake.On("GET", Jobs, _ => new BigQueryFake.Reply(429, """{"error":{"code":429,"message":"Exceeded rate limits: too many api requests per user per method","errors":[{"reason":"rateLimitExceeded"}]}}"""));
        using var broken = mixed.Sampler(new("mine", Hours: 24));
        var codes = new List<string>();
        for (var n = 0; n < 4; n++)
        {
            Volatile.Write(ref throttle, n == 2);
            var batch = await broken.SampleAsync([Due(1000)], CancellationToken.None);
            codes.Add(batch.Errors is [{ } error] ? error.Code : "none");
        }
        check(codes is ["none", "none", "QUOTA", "none"], "a QUOTA sample ends a run of stalled samples, so the stall after it is not TIMEOUT: " + string.Join(",", codes));

        // So does a refusal BigQuery answered at once (403 PERMISSION_DENIED).
        using var refusing = new Harness();
        await refusing.ConnectAsync(key);
        var refuse = false;
        refusing.Fake.Hang = request => !Volatile.Read(ref refuse) && request.Uri.AbsolutePath.EndsWith("/jobs", StringComparison.Ordinal);
        refusing.Fake.On("GET", Jobs, BigQueryFake.Fixture("error-access-denied", 403));
        using var denied = refusing.Sampler(new("mine", Hours: 24));
        codes.Clear();
        for (var n = 0; n < 4; n++)
        {
            Volatile.Write(ref refuse, n == 2);
            var batch = await denied.SampleAsync([Due(1000)], CancellationToken.None);
            codes.Add(batch.Errors is [{ } error] ? error.Code : "none");
        }
        check(codes is ["none", "none", "PERMISSION_DENIED", "none"], "a refusal BigQuery answered ends a run of stalled samples too: " + string.Join(",", codes));
    }

    /// <summary>bigquery.jobs.get: the job's details and a script's children in statement order; a refused children listing
    /// leaves the details and says why.</summary>
    static async Task DetailsAsync(Action<bool, string> check, JsonObject key)
    {
        using var harness = new Harness();
        await harness.ConnectAsync(key);
        var args = new JsonObject { ["connectionId"] = harness.ConnectionId, ["jobId"] = "script_1", ["location"] = "US" };
        var (code, result, message) = await harness.Call("bigquery.jobs.get", args);
        var details = result as BigQueryJobDetails;
        var order = string.Join(", ", details?.Children.Select(child => child.JobId) ?? []);
        check(code == "ok" && details is { Job: { JobId: "script_1", Session: true, ChildCount: 2 }, ChildrenMore: null, ChildrenError: null } && order == "script_1_a, script_1_b"
            && details.Children[1] is { Statement: "SELECT", DurationMs: 1000, Billed: 10485760 },
            $"jobs.get answers the script's details and its children in statement order, another script's child left out: {code} {message} {order}");
        var listing = harness.Listings().SingleOrDefault() ?? "";
        check(listing.Contains("parentJobId=script_1", StringComparison.Ordinal) && !listing.Contains("allUsers", StringComparison.Ordinal)
            && !JsonSerializer.Serialize(details, Wire).Contains(Session, StringComparison.Ordinal),
            "the children listing names the parent, without allUsers for the principal's own script; the session id stays in the backend");
        args["allUsers"] = true;
        await harness.Call("bigquery.jobs.get", args);
        check((harness.Listings().LastOrDefault() ?? "").Contains("allUsers=true", StringComparison.Ordinal), "another user's script lists its children with allUsers");

        harness.Fake.On("GET", Jobs, BigQueryFake.Fixture("error-access-denied", 403));
        var (deniedCode, denied, _) = await harness.Call("bigquery.jobs.get", new JsonObject { ["connectionId"] = harness.ConnectionId, ["jobId"] = "script_1" });
        check(deniedCode == "ok" && denied is BigQueryJobDetails { Children: [], ChildrenError: { Length: > 0 }, Job.JobId: "script_1" },
            "a refused children listing keeps the details and says why");
        var (missing, _, _) = await harness.Call("bigquery.jobs.get", new JsonObject { ["connectionId"] = harness.ConnectionId, ["jobId"] = "gone_1" });
        var (invalid, _, _) = await harness.Call("bigquery.jobs.get", new JsonObject { ["connectionId"] = harness.ConnectionId, ["jobId"] = "a b" });
        // Dispatch answers an id no engine holds as another engine's (CheckProvider); the service itself says NOT_CONNECTED.
        var (other, _, _) = await harness.Call("bigquery.jobs.get", new JsonObject { ["connectionId"] = Guid.NewGuid().ToString(), ["jobId"] = "script_1" });
        string closed;
        try { await harness.Service.BigQuery.JobDetailsAsync(new(Guid.NewGuid().ToString(), "script_1"), CancellationToken.None); closed = "ok"; }
        catch (RequestException error) { closed = error.Code; }
        check(missing == "NOT_FOUND" && invalid == "INVALID_PARAMS" && other == "UNSUPPORTED_PROVIDER" && closed == "NOT_CONNECTED",
            $"a missing job, a bad id and a closed connection fail as values: {missing} {invalid} {other} {closed}");
        check(harness.Service.LaneOf("bigquery.jobs.get") == RequestLane.Metadata && harness.Service.LaneOf("bigquery.jobs.cancel") == RequestLane.Control,
            "jobs.get waits on a metadata slot; jobs.cancel never waits behind one");
    }

    /// <summary>bigquery.jobs.cancel asks BigQuery to cancel one job in its location; a refusal is PERMISSION_DENIED.</summary>
    static async Task CancelAsync(Action<bool, string> check, JsonObject key)
    {
        using var harness = new Harness();
        await harness.ConnectAsync(key);
        var (code, result, message) = await harness.Call("bigquery.jobs.cancel", new JsonObject { ["connectionId"] = harness.ConnectionId, ["jobId"] = "varia_running", ["location"] = "US" });
        var sent = harness.Fake.To(Jobs + "/varia_running/cancel").ToList();
        check(code == "ok" && result is BigQueryJobCancelResult { Cancelled: true, State: "cancelled" } && sent is [var request] && request.Method == "POST"
            && request.Uri.Query.Contains("location=US", StringComparison.Ordinal),
            $"jobs.cancel posts once in the job's location and answers the state BigQuery reports: {code} {message}");
        harness.Fake.On("POST", Jobs + "/[^/]+/cancel", BigQueryFake.Fixture("error-access-denied", 403));
        var (denied, _, deniedMessage) = await harness.Call("bigquery.jobs.cancel", new JsonObject { ["connectionId"] = harness.ConnectionId, ["jobId"] = "other_user" });
        var (allUsers, _, _) = await harness.Call("bigquery.jobs.cancel", new JsonObject { ["connectionId"] = harness.ConnectionId, ["jobId"] = "x", ["allUsers"] = true });
        check(denied == "PERMISSION_DENIED" && deniedMessage.Contains("bigquery.jobs.update", StringComparison.Ordinal) && allUsers == "INVALID_PARAMS",
            $"cancelling another user's job without bigquery.jobs.update is PERMISSION_DENIED naming it; allUsers is no cancel parameter: {denied} {allUsers}");
        check(harness.Fake.To(Jobs + "/[^/]+/cancel").Count() == 2, "a refused cancel is not re-sent");
    }

    /// <summary>live.subscribe serves a source only on the engines it names: a SQL Server source on a BigQuery connection is
    /// UNSUPPORTED_PROVIDER, Job History on an id no engine holds is NOT_CONNECTED, and bad args are INVALID_PARAMS.</summary>
    static async Task GateAsync(Action<bool, string> check, JsonObject key)
    {
        using var harness = new Harness();
        await harness.ConnectAsync(key);
        async Task<string> Subscribe(string connectionId, string source, string probe, JsonNode? args = null)
        {
            using var context = new RequestContext(1, "live.subscribe", RequestLane.Live, 0, 16, sendCreditedEvent: (_, _) => 10);
            var body = new JsonObject
            {
                ["subscriptionId"] = Guid.NewGuid().ToString(), ["connectionId"] = connectionId, ["source"] = source,
                ["probes"] = new JsonArray(new JsonObject { ["probe"] = probe, ["intervalMs"] = 5000 })
            };
            if (args is not null) body["args"] = args;
            using var cancel = new CancellationTokenSource(TimeSpan.FromSeconds(30));
            var call = harness.Call("live.subscribe", body, context);
            if (await Task.WhenAny(call, Task.Delay(Timeout.Infinite, cancel.Token).ContinueWith(_ => { })) != call)
            {
                context.Cancel(CancelReason.User);
                return "running";
            }
            return (await call).Code;
        }
        var sql = await Subscribe(harness.ConnectionId, "activity", "activity.overview");
        var closed = await Subscribe(Guid.NewGuid().ToString(), "bigquery.jobs", BigQueryJobsSampler.Probe, new JsonObject { ["scope"] = "mine" });
        var invalid = await Subscribe(harness.ConnectionId, "bigquery.jobs", BigQueryJobsSampler.Probe, new JsonObject { ["scope"] = "everyone" });
        check(sql == "UNSUPPORTED_PROVIDER" && closed == "NOT_CONNECTED" && invalid == "INVALID_PARAMS",
            $"a SQL Server source on a BigQuery connection is UNSUPPORTED_PROVIDER, Job History on a closed id NOT_CONNECTED, bad args INVALID_PARAMS: {sql} {closed} {invalid}");
    }

    static LiveDue ExplorerDue(int budgetMs = 10_000) => new(new LiveProbeState(LiveCatalog.Current.Probes[BigQueryExplorerSampler.Probe], 10_000), null, null, null, null, new Dictionary<int, LiveTrackArgs>(), BudgetMs: budgetMs);

    /// <summary>bigquery.explorer: Object Explorer's chip counts the principal's own open top-level jobs with minimal jobs.list
    /// pages filtered to pending and running and without allUsers, stops at its cap with more = 1, and maps refusals as Job History does.</summary>
    static async Task ExplorerAsync(Action<bool, string> check, JsonObject key)
    {
        var spec = LiveCatalog.Current.Probes[BigQueryExplorerSampler.Probe];
        check(spec.Source == BigQueryExplorerSampler.Source && LiveCatalog.Current.Sources[BigQueryExplorerSampler.Source].Scope == "bigquery" && !spec.LoadGuard,
            "explorer.bigquery belongs to the bigquery-scoped bigquery.explorer source and has no load guard");

        using (var harness = new Harness())
        {
            await harness.ConnectAsync(key);
            var sampler = new BigQueryExplorerSampler(harness.Service.BigQuery, harness.ConnectionId);
            var batch = await sampler.SampleAsync([ExplorerDue()], CancellationToken.None);
            var listings = harness.Listings();
            check(batch.Errors.Count == 0 && batch.Samples is [var sample] && sample.Metrics is [1] && sample.Status is [{ Id: "more", Value: 0 }],
                $"the chip counts the one open top-level job across both pages (errors {string.Join(",", batch.Errors.Select(error => error.Code))}, metrics {string.Join(",", batch.Samples.SelectMany(item => item.Metrics ?? []))})");
            check(listings.Count == 2 && listings.All(query => query.Contains("stateFilter=pending", StringComparison.Ordinal) && query.Contains("stateFilter=running", StringComparison.Ordinal)
                && query.Contains("projection=minimal", StringComparison.Ordinal) && query.Contains("maxResults=1000", StringComparison.Ordinal) && !query.Contains("allUsers", StringComparison.Ordinal))
                && listings[1].Contains("pageToken=jobs-page-2", StringComparison.Ordinal),
                "it lists pending and running jobs, minimal, in pages of 1,000, without allUsers: " + string.Join(" | ", listings));
            check(harness.Fake.Unmatched.IsEmpty, "every explorer listing was one the fake answers");
        }

        // A listing that goes on past the cap stops there with more = 1; one that ends exactly at it is exact.
        foreach (var endsAtCap in new[] { false, true })
        {
            using var capped = new Harness();
            await capped.ConnectAsync(key);
            var page = 0;
            var pages = BigQueryExplorerSampler.MaxJobs / BigQueryExplorerSampler.PageJobs;
            capped.Fake.On("GET", Jobs, _ =>
            {
                var at = Interlocked.Increment(ref page);
                var jobs = new JsonArray();
                for (var n = 0; n < BigQueryExplorerSampler.PageJobs; n++)
                    jobs.Add(new JsonObject { ["jobReference"] = new JsonObject { ["projectId"] = "varia-alpha", ["jobId"] = $"open_{at}_{n}", ["location"] = "US" }, ["state"] = "RUNNING" });
                var list = new JsonObject { ["kind"] = "bigquery#jobList", ["jobs"] = jobs };
                if (!endsAtCap || at < pages) list["nextPageToken"] = "more-" + at;
                return new BigQueryFake.Reply(200, list.ToJsonString());
            });
            var batch = await new BigQueryExplorerSampler(capped.Service.BigQuery, capped.ConnectionId).SampleAsync([ExplorerDue(30_000)], CancellationToken.None);
            var more = endsAtCap ? 0 : 1;
            check(batch.Errors.Count == 0 && batch.Samples is [{ Metrics: [BigQueryExplorerSampler.MaxJobs], Status: [{ Id: "more" } status] }] && Equals(status.Value, more) && page == pages,
                $"a listing of {(endsAtCap ? "exactly" : "more than")} {BigQueryExplorerSampler.MaxJobs} open jobs reads {pages} pages and reports more = {more} (pages {page})");
        }

        var wrong = new List<string>();
        foreach (var (fixture, status, code) in new (string, int, string)[] { ("error-access-denied", 403, "PERMISSION_DENIED"), ("error-quota-exceeded", 403, "QUOTA"), ("error-unauthenticated", 401, "AUTH_EXPIRED") })
        {
            using var harness = new Harness();
            await harness.ConnectAsync(key);
            harness.Fake.On("GET", Jobs, BigQueryFake.Fixture(fixture, status));
            var batch = await new BigQueryExplorerSampler(harness.Service.BigQuery, harness.ConnectionId).SampleAsync([ExplorerDue()], CancellationToken.None);
            if (batch.Samples.Count != 0 || batch.Errors is not [var error] || error.Code != code || error.Probe != BigQueryExplorerSampler.Probe) wrong.Add(fixture + " → " + string.Join(",", batch.Errors.Select(item => item.Code)));
        }
        check(wrong.Count == 0, "a refused explorer listing is the probe's error by Job History's codes: " + string.Join("; ", wrong));

        using var spare = new Harness();
        var gone = await new BigQueryExplorerSampler(spare.Service.BigQuery, Guid.NewGuid().ToString()).SampleAsync([ExplorerDue()], CancellationToken.None).ContinueWith(task => task.Exception?.InnerException);
        check(gone is RequestException { Code: "NOT_CONNECTED" }, "a sample on a connection that went away ends the view as NOT_CONNECTED: " + gone?.GetType().Name);
    }
}
