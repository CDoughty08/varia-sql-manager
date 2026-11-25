using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Google;
using Google.Apis.Bigquery.v2.Data;
using Varia.Backend.BigQuery;

namespace Varia.Backend.Tests;

/// <summary>
/// The guarded checks only a real BigQuery project can answer (docs/testing.md, Real BigQuery project): opt-in, run by hand
/// with <c>-- --bigquery-real-project</c>, never in CI and never by <c>npm run check</c>. They follow the open real-project
/// checklist (R1 to R21) in three tiers that <c>VARIA_TEST_BIGQUERY_TIER</c> picks, each including the ones before it:
/// <c>free</c> (the default: metadata and dry runs, no job), <c>zero</c> (jobs that read no table and bill nothing) and
/// <c>billed</c> (jobs that scan a small public table, 10 MiB minimum each). Every job passes <see cref="Budget"/>: a dry run
/// first, refused over 100 MiB, the run stopped before 1 GiB in total (past it by at most one job's cap), only the small public tables in
/// <see cref="PublicTables"/> (and the run's own result tables), and a <c>maximumBytesBilled</c> of at most 100 MiB on every
/// job, which the run verifies afterwards for every job it created and fails if one billed without it.
/// </summary>
internal static partial class BigQueryRealProjectChecks
{
    public const string Argument = "--bigquery-real-project";
    public const long JobCapBytes = 100L * 1024 * 1024;
    public const long RunCapBytes = 1024L * 1024 * 1024;
    /// <summary>BigQuery bills at least 10 MiB for each query that reads a table, whatever its estimate.</summary>
    public const long MinimumBilledBytes = 10L * 1024 * 1024;
    /// <summary>The only tables a check may read: small public tables (shakespeare is about 6 MB).</summary>
    public static readonly string[] PublicTables = ["bigquery-public-data.samples.shakespeare"];
    /// <summary>The only INFORMATION_SCHEMA view a check may read: the public dataset's own table list (Show CREATE Statement).</summary>
    public static readonly string[] PublicViews = ["`bigquery-public-data.samples.INFORMATION_SCHEMA.TABLES`"];
    public static readonly string[] Tiers = ["free", "zero", "billed"];

    /// <summary>A comment unique to a run, which keeps BigQuery's query cache (24 hours) from answering a rerun for 0 bytes. A
    /// block comment on the statement's line: a line comment would swallow a script's following separator.</summary>
    public static string Nonce(Guid run) => $" /* varia check {run:N} */";
    const string Shakespeare = "`bigquery-public-data.samples.shakespeare`";

    static readonly JsonSerializerOptions Wire = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull, UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow
    };

    /// <summary>Why the run may not start, or null: the project and a confirmation repeating it, a known tier, no emulator, not CI.</summary>
    public static string? Refusal(Func<string, string?> environment)
    {
        var project = environment("VARIA_TEST_BIGQUERY_PROJECT");
        if (string.IsNullOrWhiteSpace(project)) return "Set VARIA_TEST_BIGQUERY_PROJECT to the project the checks may bill.";
        if (!BigQueryLimits.IsProject(project)) return "VARIA_TEST_BIGQUERY_PROJECT is not a Google Cloud project id.";
        if (environment("VARIA_TEST_BIGQUERY_CONFIRM") != project)
            return "Set VARIA_TEST_BIGQUERY_CONFIRM to the same project id to confirm the run may bill it (at most 100 MiB a job, 1 GiB in all).";
        if (environment("VARIA_TEST_BIGQUERY_TIER") is { } tier && !Tiers.Contains(tier, StringComparer.Ordinal)) return "VARIA_TEST_BIGQUERY_TIER is free (the default), zero or billed.";
        if (!string.IsNullOrEmpty(environment("VARIA_TEST_BIGQUERY_ENDPOINT"))) return "Unset VARIA_TEST_BIGQUERY_ENDPOINT: these checks run against Google, not the emulator.";
        if (!string.IsNullOrEmpty(environment("CI"))) return "The real-project checks never run in CI.";
        return null;
    }

    /// <summary>A check the budget refused: it is skipped and the run goes on.</summary>
    public sealed class RefusedException(string message) : Exception(message);
    /// <summary>The run's total would pass 1 GiB: it stops.</summary>
    public sealed class StopException(string message) : Exception(message);
    /// <summary>A job billed without a maximumBytesBilled within the job cap: the run fails.</summary>
    public sealed class UncappedException(string message) : Exception(message);

    /// <summary>The spending guard every job passes before and after it runs.</summary>
    public sealed partial class Budget
    {
        readonly HashSet<string> results = new(StringComparer.Ordinal);
        public long Billed { get; private set; }

        /// <summary>A result table this run's own job wrote (an anonymous destination table): later checks may read it.</summary>
        public void AllowResult(string table) => results.Add(table);

        /// <summary>Before a job: its text reads only <see cref="PublicTables"/>, <see cref="PublicViews"/> and the run's
        /// result tables, and its dry run is real, complete and within the job cap. What it may bill (at least 10 MiB when it
        /// reads anything, and at least <paramref name="floor"/>) must keep the run within 1 GiB.</summary>
        public void Admit(string name, string sql, BigQueryEstimate estimate, long floor = 0)
        {
            foreach (var table in Tables(sql))
                if (!PublicTables.Contains(table, StringComparer.Ordinal) && !results.Contains(table)) throw new RefusedException($"{name}: reads {table}, which is not one of the small public tables the checks may read.");
            var views = PublicViews.Aggregate(sql, (text, view) => text.Replace(view, "", StringComparison.Ordinal));
            if (views.Contains("INFORMATION_SCHEMA", StringComparison.OrdinalIgnoreCase)) throw new RefusedException($"{name}: reads an INFORMATION_SCHEMA view other than the public dataset's table list.");
            if (estimate.Faked) throw new RefusedException($"{name}: the estimate is faked (emulator mode).");
            if (estimate.Incomplete is not null) throw new RefusedException($"{name}: the dry run is incomplete ({estimate.Incomplete}); dry-run each statement on its own.");
            if (estimate.BytesProcessed > JobCapBytes) throw new RefusedException($"{name}: estimated at {estimate.BytesProcessed:N0} bytes, over the 100 MiB a job may process.");
            // INFORMATION_SCHEMA estimates 0 bytes but bills the 10 MiB minimum.
            var reads = estimate.BytesProcessed > 0 || views.Length != sql.Length;
            var charge = Math.Max(floor, reads ? Math.Max(estimate.BytesProcessed, MinimumBilledBytes) : 0);
            if (Billed + charge > RunCapBytes) throw new StopException($"{name}: would take the run past 1 GiB ({Billed:N0} bytes billed so far).");
        }

        /// <summary>After a job: it carried a cap no higher than the job cap, it billed no more than that cap (a script's cap
        /// may apply to each of its <paramref name="statements"/>, never past the job cap), and its bytes billed keep the run
        /// within 1 GiB.</summary>
        public void Record(string name, long? maximumBytesBilled, long billed, int statements = 1)
        {
            // Counted first: a job that broke its cap still billed, and the total is what matters once a guard trips.
            Billed += billed;
            if (maximumBytesBilled is not { } cap || cap <= 0 || cap > JobCapBytes) throw new UncappedException($"{name}: the job carried no maximumBytesBilled within 100 MiB ({maximumBytesBilled?.ToString() ?? "none"}).");
            var allowed = Math.Min(JobCapBytes, cap * Math.Max(1, statements));
            if (billed > allowed) throw new UncappedException($"{name}: billed {billed:N0} bytes, past the {allowed:N0} its cap allows.");
            if (Billed > RunCapBytes) throw new StopException($"{name}: the run has billed {Billed:N0} bytes, past 1 GiB.");
        }

        /// <summary>The tables a dry run says the query reads (statistics.query.referencedTables): each must be allowed. With
        /// <paramref name="temporary"/> (a check reading its own session's or script's temp tables, named by one part), tables
        /// in the project's hidden underscore datasets are allowed too.</summary>
        public void AdmitReferenced(string name, IEnumerable<string> tables, string? temporary = null)
        {
            foreach (var table in tables)
                if (!PublicTables.Contains(table, StringComparer.Ordinal) && !results.Contains(table) && !(temporary is not null && table.StartsWith(temporary + "._", StringComparison.Ordinal))) throw new RefusedException($"{name}: its dry run reads {table}, which is not one of the small public tables the checks may read.");
        }

        /// <summary>The project.dataset.table names a query names in backticks, whole (`p.d.t`) or by part (`p`.`d`.`t`).</summary>
        public static IEnumerable<string> Tables(string sql) => TableName().Matches(sql).Select(match => string.Join('.', match.Groups[1].Captures.Select(part => part.Value)).Replace("`", "", StringComparison.Ordinal))
            .Where(name => name.Count(character => character == '.') == 2);

        [GeneratedRegex(@"(?:`([^`]+)`(?:\.(?=`)|(?!\.`)))+")]
        private static partial Regex TableName();
    }

    /// <summary>The guard's rules offline (an offline suite): no real project is involved.</summary>
    public static void RunOffline(Action<bool, string> check)
    {
        string? Env(Dictionary<string, string> values, string name) => values.GetValueOrDefault(name);
        // Bills a budget up to a total in jobs of at most the job cap, as a run would.
        static void Fill(Budget budget, long total)
        {
            for (var left = total; left > 0; left -= JobCapBytes) budget.Record("earlier", JobCapBytes, Math.Min(left, JobCapBytes));
        }
        var ok = new Dictionary<string, string> { ["VARIA_TEST_BIGQUERY_PROJECT"] = "my-project", ["VARIA_TEST_BIGQUERY_CONFIRM"] = "my-project" };
        check(Refusal(name => Env(ok, name)) is null, "real project: the project and a confirmation repeating it let the run start");
        check(Refusal(_ => null)!.Contains("VARIA_TEST_BIGQUERY_PROJECT", StringComparison.Ordinal), "real project: no project, no run");
        check(Refusal(name => name == "VARIA_TEST_BIGQUERY_PROJECT" ? "my-project" : null)!.Contains("VARIA_TEST_BIGQUERY_CONFIRM", StringComparison.Ordinal), "real project: no confirmation, no run");
        check(Refusal(name => name == "VARIA_TEST_BIGQUERY_CONFIRM" ? "other-project" : Env(ok, name)) is not null, "real project: a confirmation naming another project refuses");
        check(Refusal(name => name == "VARIA_TEST_BIGQUERY_CONFIRM" ? "1" : Env(ok, name)) is not null, "real project: a bare yes is no confirmation");
        check(Refusal(name => name == "VARIA_TEST_BIGQUERY_ENDPOINT" ? "http://127.0.0.1:9050" : Env(ok, name)) is not null, "real project: never beside the emulator endpoint");
        check(Refusal(name => name == "CI" ? "true" : Env(ok, name)) is not null, "real project: never in CI");
        check(Refusal(name => name.StartsWith("VARIA_TEST_BIGQUERY_", StringComparison.Ordinal) ? "not a project!" : null) is not null, "real project: an invalid project id refuses");
        check(Refusal(name => name == "VARIA_TEST_BIGQUERY_TIER" ? "all" : Env(ok, name)) is not null && Refusal(name => name == "VARIA_TEST_BIGQUERY_TIER" ? "billed" : Env(ok, name)) is null,
            "real project: the tier is free, zero or billed");

        var nonce = Nonce(Guid.NewGuid());
        check(!nonce.Contains('\n', StringComparison.Ordinal) && !nonce.Contains("--", StringComparison.Ordinal) && nonce.TrimEnd().EndsWith("*/", StringComparison.Ordinal)
            && string.Join(";\n", ["SELECT 1" + nonce, "SELECT 2" + nonce]).Split('\n').All(line => line.EndsWith("*/;", StringComparison.Ordinal) || line.EndsWith("*/", StringComparison.Ordinal)),
            "real project: the run's cache-busting comment closes on its line, so a script's separators stay outside it");
        check(Budget.Tables($"SELECT * FROM {Shakespeare} JOIN `a`.`b`.`c` USING (x) JOIN `t` USING (y)").SequenceEqual(["bigquery-public-data.samples.shakespeare", "a.b.c"]),
            "real project: the guard reads whole and per-part table names, and leaves one-part names alone");
        Exception? Admit(Budget budget, string sql, BigQueryEstimate estimate, long floor = 0)
        {
            try { budget.Admit("check", sql, estimate, floor); return null; } catch (Exception error) { return error; }
        }
        var budget = new Budget();
        check(Admit(budget, $"SELECT word FROM {Shakespeare}", new(5_000_000)) is null, "real project: a small public table within the job cap is admitted");
        check(Admit(budget, "SELECT * FROM `my-project.private.big`", new(1)) is RefusedException, "real project: a table off the allowlist is refused");
        check(Admit(budget, "SELECT * FROM `region-us`.INFORMATION_SCHEMA.JOBS", new(0)) is RefusedException, "real project: INFORMATION_SCHEMA is refused");
        check(Admit(budget, $"SELECT ddl FROM {PublicViews[0]} JOIN `region-us`.INFORMATION_SCHEMA.JOBS ON TRUE", new(0)) is RefusedException
            && Admit(budget, $"SELECT ddl FROM {PublicViews[0]} WHERE table_name = 'shakespeare'", new(0)) is null, "real project: only the public dataset's table list is admitted from INFORMATION_SCHEMA");
        var results = new Budget();
        check(Admit(results, "SELECT * FROM `my-project`.`_anon1`.`anon2`", new(1)) is RefusedException, "real project: a result table is refused until this run's own job wrote it");
        results.AllowResult("my-project._anon1.anon2");
        check(Admit(results, "SELECT * FROM `my-project`.`_anon1`.`anon2`", new(1)) is null, "real project: this run's own result table is admitted");
        Exception? Referenced(Budget budget, params string[] tables)
        {
            try { budget.AdmitReferenced("check", tables); return null; } catch (Exception error) { return error; }
        }
        check(Referenced(budget, "bigquery-public-data.samples.shakespeare") is null && Referenced(budget, "my-project.private.big") is RefusedException,
            "real project: a table the dry run reports reading must be on the allowlist, however the query names it");
        Exception? Temporary(string table, string? project)
        {
            try { new Budget().AdmitReferenced("check", [table], project); return null; } catch (Exception error) { return error; }
        }
        check(Temporary("my-project._5b3f.varia_check", null) is RefusedException && Temporary("my-project._5b3f.varia_check", "my-project") is null
            && Temporary("other-project._5b3f.t", "my-project") is RefusedException && Temporary("my-project.private.t", "my-project") is RefusedException,
            "real project: a temp table is admitted only where the check expects one, and only in the project's hidden datasets");
        check(Admit(budget, $"SELECT word FROM {Shakespeare}", new(JobCapBytes + 1)) is RefusedException, "real project: an estimate over 100 MiB is refused");
        check(Admit(budget, $"SELECT word FROM {Shakespeare}", new(0, Faked: true)) is RefusedException, "real project: a faked estimate is refused");
        check(Admit(budget, $"SELECT 1; SELECT word FROM {Shakespeare}", new(1, Incomplete: "script")) is RefusedException, "real project: an incomplete estimate is refused");
        Fill(budget, RunCapBytes - MinimumBilledBytes + 1);
        check(Admit(budget, $"SELECT word FROM {Shakespeare}", new(1)) is StopException, "real project: a job that may bill its 10 MiB minimum past 1 GiB stops the run");
        check(Admit(budget, $"SELECT ddl FROM {PublicViews[0]}", new(0)) is StopException, "real project: INFORMATION_SCHEMA counts its 10 MiB minimum though it estimates 0 bytes");
        check(Admit(budget, "SELECT 1", new(0)) is null, "real project: a job that reads nothing still runs near the run cap");
        check(Admit(budget, "SELECT 1", new(0), floor: MinimumBilledBytes) is StopException, "real project: a job's floor counts toward the run cap");
        Exception? Record(Budget budget, long? cap, long billed)
        {
            try { budget.Record("check", cap, billed); return null; } catch (Exception error) { return error; }
        }
        check(Record(new Budget(), null, 0) is UncappedException && Record(new Budget(), JobCapBytes + 1, 0) is UncappedException && Record(new Budget(), 0, 0) is UncappedException,
            "real project: a job without a maximumBytesBilled within 100 MiB fails the run");
        check(Record(new Budget(), MinimumBilledBytes, MinimumBilledBytes + 1) is UncappedException, "real project: a job that billed past its own cap fails the run");
        var broken = new Budget();
        check(Record(broken, null, MinimumBilledBytes) is UncappedException && broken.Billed == MinimumBilledBytes, "real project: an uncapped job's bytes still count in the run's total");
        Exception? Script(long cap, long billed, int statements)
        {
            try { new Budget().Record("check", cap, billed, statements); return null; } catch (Exception error) { return error; }
        }
        check(Script(15L * 1024 * 1024, 20L * 1024 * 1024, 2) is null && Script(15L * 1024 * 1024, 31L * 1024 * 1024, 2) is UncappedException && Script(60L * 1024 * 1024, JobCapBytes + 1, 4) is UncappedException,
            "real project: a script may bill its cap for each statement, never past the job cap");
        var nearly = new Budget();
        Fill(nearly, RunCapBytes - 1);
        check(Record(nearly, JobCapBytes, 2) is StopException, "real project: billing past 1 GiB stops the run");
    }

    public static async Task RunAsync(Action<bool, string> check)
    {
        if (Refusal(Environment.GetEnvironmentVariable) is { } refusal) throw new InvalidOperationException(refusal);
        var project = Environment.GetEnvironmentVariable("VARIA_TEST_BIGQUERY_PROJECT")!;
        var secrets = new List<string> { project };
        string Redact(string text) => secrets.Where(secret => secret.Length > 0).Aggregate(text, (redacted, secret) => redacted.Replace(secret, "<redacted>", StringComparison.OrdinalIgnoreCase));
        var unredacted = check;
        check = (ok, name) => unredacted(ok, Redact(name));
        var tier = Array.IndexOf(Tiers, Environment.GetEnvironmentVariable("VARIA_TEST_BIGQUERY_TIER") ?? "free");
        var (authentication, keyFile, credential) = Credential();
        var budget = new Budget();
        var started = DateTimeOffset.UtcNow.AddMinutes(-10);
        var skipped = new List<string>();
        var destinations = new Dictionary<string, TableReference>(StringComparer.Ordinal);
        // The jobs this run created, the ones Reconcile counted, and each counted job's BigQuery session.
        var created = new HashSet<string>(StringComparer.Ordinal);
        var counted = new HashSet<string>(StringComparer.Ordinal);
        var sessions = new Dictionary<string, string>(StringComparer.Ordinal);
        var runSessions = new HashSet<string>(StringComparer.Ordinal);
        // The statements in each script job the run created, which bound what its cap allows it to bill.
        var scripts = new Dictionary<string, int>(StringComparer.Ordinal);
        // Printed lines may be pasted into a PR or a fixture: the project id never appears in them.
        void Note(string text) => Console.WriteLine("Real project: " + Redact(text));
        void Skip(string text)
        {
            skipped.Add(text);
            Note("skipped " + text);
        }
        using var service = new SqlService(CheckStores.Unprobed(), bigQuery: BigQueryEnvironment.FromEnvironment());
        async Task<(string Code, object? Result, string Message)> Call(string method, JsonNode parameters)
        {
            using var document = JsonDocument.Parse(parameters.ToJsonString());
            try { return ("ok", await service.DispatchAsync(method, document.RootElement.Clone(), Wire), ""); }
            catch (RequestException error) { return (error.Code, null, error.Message); }
        }
        JsonObject Material() => new() { ["source"] = credential.Source, ["json"] = credential.Json };

        // R2. Connect: sign-in, the identity pin (tokeninfo for a gcloud user) and the probe (a free dry run). Every job of
        // this connection carries the job cap.
        var account = await Call("bigquery.account", new JsonObject { ["authentication"] = authentication, ["keyFile"] = keyFile, ["credential"] = Material() });
        check(account is { Code: "ok", Result: BigQueryAccount { Kind: "user" or "serviceAccount" or "impersonated" or "external" or "externalUser" } }, $"real project: R2 bigquery.account names the account: {account.Code} {account.Message}");
        var connect = await Call("connections.connect", new JsonObject
        {
            ["provider"] = "bigquery", ["project"] = project, ["authentication"] = authentication, ["keyFile"] = keyFile, ["maximumBytesBilled"] = JobCapBytes, ["credential"] = Material()
        });
        var info = connect.Result as ConnectionInfo;
        check(connect.Code == "ok" && info?.PrincipalId is { } pin && Regex.IsMatch(pin, "^bigquery:(user|serviceAccount|impersonated|external|externalUser):"), $"real project: R2 connect pins the verified principal after its dry-run probe: {connect.Code} {connect.Message}");
        // The account BigQuery records as the jobs' user: the impersonated service account when there is one.
        var me = account.Result is BigQueryAccount signedIn ? signedIn.Impersonated ?? signedIn.Account : null;
        if (account.Result is BigQueryAccount named) secrets.AddRange([named.Account, named.Impersonated ?? ""]);
        var connection = info is null ? null : service.BigQuery.Find(info.Id);
        if (connection is null) return;
        var api = connection.Client.Service;

        // Every job this run created, once: its cap and its bytes billed (a script's children are billed in their parent).
        // jobs.list without allUsers lists only the caller's own jobs (an impersonated run's are the service account's); of
        // those, the run counts the ids it created and Varia's jobs in this run's sessions (its session close), not another
        // Varia window's or tool's. It prints job ids and statement types, never query text.
        async Task Reconcile(string step)
        {
            var jobs = new List<JobList.JobsData>();
            string? page = null;
            for (var pages = 0; pages < 20; pages++)
            {
                var request = api.Jobs.List(project);
                request.MinCreationTime = (ulong)started.ToUnixTimeMilliseconds();
                request.Projection = Google.Apis.Bigquery.v2.JobsResource.ListRequest.ProjectionEnum.Full;
                request.MaxResults = 200;
                request.PageToken = page;
                var answer = await request.ExecuteAsync();
                jobs.AddRange(answer.Jobs ?? []);
                if ((page = answer.NextPageToken) is null) break;
            }
            foreach (var job in jobs.Where(job => job.Status?.State == "DONE" && job.JobReference?.JobId is { } id && !counted.Contains(id)))
            {
                if (job.Statistics?.ParentJobId is not null) continue;
                var ours = created.Contains(job.JobReference!.JobId) || job.Statistics?.SessionInfo?.SessionId is { } inSession && runSessions.Contains(inSession)
                    && job.Configuration?.Labels is { } labels && BigQueryService.Labels.All(label => labels.TryGetValue(label.Key, out var value) && value == label.Value);
                if (!ours) continue;
                counted.Add(job.JobReference.JobId);
                if (job.Statistics?.SessionInfo?.SessionId is { } jobSession) sessions[job.JobReference.JobId] = jobSession;
                var billed = job.Statistics?.Query?.TotalBytesBilled ?? 0;
                var cap = job.Configuration?.Query?.MaximumBytesBilled;
                if (job.Configuration?.Query is { Query: { } text, DestinationTable: { } destination }) destinations[text] = destination;
                Note($"{step}: job {job.JobReference!.JobId} ({job.Statistics?.Query?.StatementType}) billed {billed:N0} bytes under a cap of {cap?.ToString("N0") ?? "none"}.");
                // Every job fails the run in Record without the cap, Varia's own COMMIT and ABORT_SESSION included (10 MiB).
                budget.Record(step + " " + job.JobReference.JobId, cap, billed, scripts.GetValueOrDefault(job.JobReference.JobId, 1));
            }
        }
        async Task AwaitCounted(string step, string jobId)
        {
            for (var attempt = 0; ; attempt++)
            {
                await Reconcile(step);
                if (counted.Contains(jobId)) return;
                if (attempt >= 12) throw new StopException($"{step}: job {jobId} is still running or not yet listed, so its bill is unknown; the run stops rather than admit more jobs.");
                await Task.Delay(TimeSpan.FromSeconds(5));
            }
        }
        IList<ConnectionProperty>? InSession(string? sessionId) => sessionId is null ? null : [new ConnectionProperty { Key = "session_id", Value = sessionId }];
        // A dry run straight through the API (free): parameters and a session id, which Varia's estimate does not send.
        async Task<long?> DryRun(string name, string sql, IList<QueryParameter>? parameters = null, string? sessionId = null, bool temporary = false)
        {
            try
            {
                var answer = await api.Jobs.Insert(new Job
                {
                    Configuration = new JobConfiguration
                    {
                        DryRun = true,
                        Query = new JobConfigurationQuery { Query = sql, UseLegacySql = false, QueryParameters = parameters, ParameterMode = parameters is null ? null : "NAMED", ConnectionProperties = InSession(sessionId) }
                    }
                }, project).ExecuteAsync();
                budget.AdmitReferenced(name, answer.Statistics?.Query?.ReferencedTables?.Select(table => $"{table.ProjectId}.{table.DatasetId}.{table.TableId}") ?? [], temporary ? project : null);
                return answer.Statistics?.TotalBytesProcessed ?? 0;
            }
            catch (RefusedException error)
            {
                Note("the guard refused " + error.Message);
                return null;
            }
            catch (GoogleApiException error)
            {
                Note($"{name}: the dry run is refused ({(int)error.HttpStatusCode} {error.Error?.Errors?.FirstOrDefault()?.Reason}): {error.Error?.Message}");
                return null;
            }
        }
        // A job straight through the API: dry-run and admitted first, with the given cap (at most the job cap) and labels.
        // A script's dry run may not cover every statement, so a script runs only with script: true from a caller that admitted
        // each statement reading a table on its own (or whose statements read only temp tables, with temporary: true).
        async Task<Job?> Run(string name, string sql, long cap = JobCapBytes, IList<QueryParameter>? parameters = null, string? sessionId = null, bool createSession = false, long floor = 0, bool script = false, bool temporary = false)
        {
            if (cap is <= 0 or > JobCapBytes) throw new ArgumentOutOfRangeException(nameof(cap), $"{name}: a cap of {cap:N0} bytes is outside the job cap.");
            if (!script && sql.TrimEnd().TrimEnd(';').Contains(';', StringComparison.Ordinal)) throw new ArgumentException($"{name}: a script runs only with script: true.", nameof(sql));
            if (await DryRun(name, sql, parameters, sessionId, temporary) is not { } bytes)
            {
                Skip(name + ": the dry run failed");
                return null;
            }
            try { budget.Admit(name, sql, new BigQueryEstimate(bytes), floor); }
            catch (RefusedException error)
            {
                Skip(error.Message);
                return null;
            }
            var jobId = "varia_check_" + Guid.NewGuid().ToString("N");
            created.Add(jobId);
            if (script) scripts[jobId] = sql.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Length;
            Job inserted;
            try
            {
                inserted = await api.Jobs.Insert(new Job
                {
                    JobReference = new JobReference { ProjectId = project, JobId = jobId },
                    Configuration = new JobConfiguration
                    {
                        Labels = new Dictionary<string, string>(BigQueryService.Labels),
                        Query = new JobConfigurationQuery
                        {
                            Query = sql, UseLegacySql = false, MaximumBytesBilled = cap, QueryParameters = parameters, ParameterMode = parameters is null ? null : "NAMED",
                            ConnectionProperties = InSession(sessionId), CreateSession = createSession ? true : null
                        }
                    }
                }, project).ExecuteAsync();
            }
            // A definite refusal created no job; anything else (a lost answer) may have, so the id stays to be counted.
            catch (GoogleApiException error) when ((int)error.HttpStatusCode is >= 400 and < 500 and not 409)
            {
                created.Remove(jobId);
                Skip($"{name}: jobs.insert is refused ({(int)error.HttpStatusCode} {error.Error?.Errors?.FirstOrDefault()?.Reason})");
                return null;
            }
            var done = await WaitDone(api, project, jobId, inserted.JobReference?.Location);
            await AwaitCounted(name, jobId);
            return done;
        }
        // Varia's estimate, then a direct dry run for the tables it reads. Text that reads the tab session's temp tables is
        // estimated by the direct dry run alone, with the session's id (Varia's estimate does not send one).
        async Task<bool> Admit(string name, string sql, string? sessionId = null)
        {
            try
            {
                if (sessionId is null) budget.Admit(name, sql, await service.BigQuery.EstimateAsync(connection, sql, CancellationToken.None));
                if (await DryRun(name, sql, sessionId: sessionId, temporary: sessionId is not null) is not { } bytes) throw new RefusedException($"{name}: its tables could not be checked");
                if (sessionId is not null) budget.Admit(name, sql, new BigQueryEstimate(bytes));
                return true;
            }
            catch (RefusedException error) { Skip(error.Message); return false; }
            catch (RequestException error) { Skip($"{name}: the dry run failed ({error.Code})"); return false; }
        }
        var session = Guid.NewGuid().ToString();
        var sessionOpen = false;
        async Task<QueryResult?> Execute(string name, string sql, string? sessionId = null)
        {
            if (!await Admit(name, sql, sessionId)) return null;
            var (code, result, message) = await Call("query.execute", new JsonObject
            {
                ["connectionId"] = connection.Id, ["sessionId"] = session, ["queryId"] = Guid.NewGuid().ToString(), ["sql"] = sql, ["maxRows"] = 0, ["timeoutSeconds"] = 120,
                ["maximumBytesBilled"] = JobCapBytes
            });
            sessionOpen = true;
            if (result is QueryResult { Job.JobId: { } varia })
            {
                created.Add(varia);
                await AwaitCounted(name, varia);
            }
            else await Reconcile(name);
            check(code == "ok", $"real project: {name} answers: {code} {message}");
            return result as QueryResult;
        }
        QueryParameter Parameter(string name, string type, string value) => new() { Name = name, ParameterType = new QueryParameterType { Type = type }, ParameterValue = new QueryParameterValue { Value = value } };
        async Task<string> Rows(Job job)
        {
            var request = api.Jobs.GetQueryResults(project, job.JobReference.JobId);
            request.Location = job.JobReference.Location;
            var answer = await request.ExecuteAsync();
            return api.Serializer.Serialize(new { answer.Schema, answer.Rows });
        }
        var nonce = Nonce(Guid.NewGuid());
        var failures = new List<string>();
        void Later(bool ok, string name)
        {
            if (!ok) failures.Add(Redact(name));
        }
        var aggregate = $"SELECT corpus, SUM(word_count) AS words FROM {Shakespeare} GROUP BY corpus ORDER BY corpus" + nonce;

        try
        {
            // ---- Free: metadata and dry runs, no job. ----
            // A dry run's estimate through Varia: free, complete, small.
            var estimate = await service.BigQuery.EstimateAsync(connection, aggregate, CancellationToken.None);
            check(!estimate.Faked && estimate.Incomplete is null && estimate.BytesProcessed is > 0 and < JobCapBytes, $"real project: a dry run estimates a small public query: {estimate.BytesProcessed:N0} bytes, {estimate.Incomplete}");

            // R1. jobs.list: which fields other users' jobs leave out (refused without the permission), and whether a smaller
            // maxResults is accepted with a page token from a bigger page.
            try
            {
                var all = api.Jobs.List(project);
                all.AllUsers = true;
                all.MaxResults = 20;
                all.Projection = Google.Apis.Bigquery.v2.JobsResource.ListRequest.ProjectionEnum.Full;
                var others = ((await all.ExecuteAsync()).Jobs ?? []).Where(job => job.UserEmail != me).ToList();
                Note($"R1 All users lists {others.Count} other users' jobs; with query text: {others.Count(job => job.Configuration?.Query?.Query is not null)}, with statistics: {others.Count(job => job.Statistics is not null)}, with a user email: {others.Count(job => job.UserEmail is not null)}.");
            }
            catch (GoogleApiException error) { Note($"R1 All users is refused ({(int)error.HttpStatusCode}), as the Job History document says."); }
            var big = api.Jobs.List(project);
            big.MaxResults = 10;
            var first = await big.ExecuteAsync();
            if (first.NextPageToken is { } token)
            {
                var small = api.Jobs.List(project);
                small.MaxResults = 3;
                small.PageToken = token;
                try { Note($"R1 a page token from a 10-job page with maxResults 3 lists {(await small.ExecuteAsync()).Jobs?.Count ?? 0} jobs."); }
                catch (GoogleApiException error) { Note($"R1 a page token from a 10-job page with maxResults 3 is refused ({(int)error.HttpStatusCode}): {error.Error?.Message}"); }
            }
            else Note("R1 the project lists fewer than 11 jobs: no page token to try with a smaller maxResults (run again after the zero tier).");

            // R5. tables.get with `fields` (what Explorer and the index ask for) and with selectedFields (which drops columns).
            var get = api.Tables.Get("bigquery-public-data", "samples", "shakespeare");
            get.Fields = "schema,numRows,numBytes,type";
            var table = await get.ExecuteAsync();
            check(table.Schema?.Fields?.Count == 4 && table.NumRows > 0, $"real project: R5 tables.get with fields answers the columns, rows and size: {table.Schema?.Fields?.Count} columns, {table.NumRows} rows, {table.NumBytes} bytes");
            var selected = api.Tables.Get("bigquery-public-data", "samples", "shakespeare");
            selected.SelectedFields = "word";
            Note($"R5 tables.get with selectedFields=word answers {(await selected.ExecuteAsync()).Schema?.Fields?.Count ?? 0} column(s).");

            // R8. INFORMATION_SCHEMA estimates 0 bytes, though it bills the 10 MiB minimum.
            var ddl = $"SELECT ddl FROM {PublicViews[0]} WHERE table_name = 'shakespeare'" + nonce;
            Note($"R8 an INFORMATION_SCHEMA dry run estimates {(await DryRun("R8", ddl))?.ToString("N0") ?? "nothing"} bytes.");
            // R9. A value-list filter's list subqueries inside LOGICAL_OR.
            var list = $"SELECT word FROM {Shakespeare} WHERE (SELECT LOGICAL_OR(word = value) FROM UNNEST(['king', 'queen']) AS value) OR (SELECT LOGICAL_OR(corpus = value) FROM UNNEST(['hamlet']) AS value)";
            check(await DryRun("R9", list) is not null, "real project: R9 a value-list filter's LOGICAL_OR subqueries pass a dry run");
            // R10. TABLESAMPLE with a FLOAT64 percent and LIMIT @rows: accepted, and are the bytes the whole table's?
            var sample = $"SELECT * FROM {Shakespeare} TABLESAMPLE SYSTEM (@percent PERCENT) LIMIT @rows";
            var sampled = await DryRun("R10", sample, [Parameter("percent", "FLOAT64", "1.5"), Parameter("rows", "INT64", "1000")]);
            check(sampled is not null, "real project: R10 TABLESAMPLE with @percent FLOAT64 and LIMIT @rows passes a dry run");
            Note($"R10 the sample's dry run estimates {sampled?.ToString("N0") ?? "nothing"} bytes; the whole table is {table.NumBytes:N0}.");
            Note("By hand (free): R3 Google's error bodies for a disabled API, disabled billing, quota and SERVICE_DISABLED; R4 impersonation with delegates and one STS exchange per federation source; R6 a persistent UDAF's routines.get type (needs one created).");
            if (tier < 1) return;

            // ---- Zero: jobs that read no table and bill nothing. ----
            // R11. jobTimeoutMs and maximumBytesBilled as JSON numbers, and the 409 body for a repeated client job id.
            if (await DryRun("R11", "SELECT 1") is { } nothing)
            {
                budget.Admit("R11", "SELECT 1", new BigQueryEstimate(nothing));
                var jobId = "varia_check_" + Guid.NewGuid().ToString("N");
                var json = JsonSerializer.Serialize(new
                {
                    jobReference = new { projectId = project, jobId },
                    configuration = new { labels = BigQueryService.Labels, jobTimeoutMs = 60000, query = new { query = "SELECT 1", useLegacySql = false, maximumBytesBilled = JobCapBytes } }
                });
                using var content = new StringContent(json, Encoding.UTF8, "application/json");
                using var posted = await api.HttpClient.PostAsync(new Uri(api.BaseUri + $"projects/{Uri.EscapeDataString(project)}/jobs"), content);
                check(posted.IsSuccessStatusCode, $"real project: R11 jobTimeoutMs and maximumBytesBilled are accepted as JSON numbers: {(int)posted.StatusCode}");
                if (posted.IsSuccessStatusCode)
                {
                    created.Add(jobId);
                    using var again = new StringContent(json, Encoding.UTF8, "application/json");
                    using var repeated = await api.HttpClient.PostAsync(new Uri(api.BaseUri + $"projects/{Uri.EscapeDataString(project)}/jobs"), again);
                    check((int)repeated.StatusCode == 409, $"real project: R11 inserting a job id again answers 409: {(int)repeated.StatusCode}");
                    Note("R11 the 409 body: " + await repeated.Content.ReadAsStringAsync());
                    var location = JsonNode.Parse(await posted.Content.ReadAsStringAsync())?["jobReference"]?["location"]?.GetValue<string>();
                    await WaitDone(api, project, jobId, location);
                    await AwaitCounted("R11", jobId);
                }
            }

            // R12. The REST shape of RANGE<TIMESTAMP>, DATETIME and TIME (INTERVAL's Arrow shape needs Storage Read: by hand).
            if (await Run("R12", "SELECT RANGE(TIMESTAMP '2024-01-01 00:00:00 UTC', TIMESTAMP '2024-02-01 00:00:00 UTC') AS r, DATETIME '2024-01-02 03:04:05.123456' AS dt, TIME '01:02:03.5' AS t, INTERVAL 1 DAY AS i") is { } types)
                Note("R12 REST rows: " + await Rows(types));

            // R7 and R13. A session: does a dry run accept its id; ABORT_SESSION with a STRING parameter; the errorResult of a
            // failure inside a session transaction; the children's minimal projection.
            if (await Run("R7 session", "SELECT 1 AS x", createSession: true) is { Statistics.SessionInfo.SessionId: { } sessionId })
            {
                runSessions.Add(sessionId);
                var ended = false;
                try
                {
                    var made = await Run("R7 temp table", "CREATE TEMP TABLE varia_check AS SELECT 1 AS x", sessionId: sessionId);
                    if (made is null) Note("R7 the session's CREATE TEMP TABLE was skipped: a dry run with the session id is refused (the lines above say why).");
                    if (made is not null) Note($"R7 a dry run of the session's temp table with the session id {(await DryRun("R7 read", "SELECT x FROM varia_check", sessionId: sessionId, temporary: true) is not null ? "is accepted" : "is not (the line above says who refused it)")}.");
                    if (await Run("R13 transaction", "BEGIN TRANSACTION;\nSELECT ERROR('varia check');\nCOMMIT TRANSACTION;", sessionId: sessionId, script: true, temporary: true) is { } failed)
                    {
                        Note($"R13 a failure inside a session transaction: {failed.Status?.ErrorResult?.Reason}: {failed.Status?.ErrorResult?.Message}");
                        var children = api.Jobs.List(project);
                        children.ParentJobId = failed.JobReference.JobId;
                        children.Projection = Google.Apis.Bigquery.v2.JobsResource.ListRequest.ProjectionEnum.Minimal;
                        var listed = (await children.ExecuteAsync()).Jobs ?? [];
                        Note($"R13 the minimal projection of its {listed.Count} children carries statementType on {listed.Count(child => child.Statistics?.Query?.StatementType is not null)}, numDmlAffectedRows on {listed.Count(child => child.Statistics?.Query?.NumDmlAffectedRows is not null)}.");
                    }
                    var aborted = await Run("R13 abort", "CALL BQ.ABORT_SESSION(@session)", parameters: [Parameter("session", "STRING", sessionId)]);
                    ended = aborted is { Status.ErrorResult: null };
                    if (aborted is null) Note("R13 CALL BQ.ABORT_SESSION with a STRING parameter was skipped (the line above says why).");
                    else check(ended, $"real project: R13 CALL BQ.ABORT_SESSION takes a STRING parameter: {aborted.Status?.ErrorResult?.Message ?? "ok"}");
                }
                finally
                {
                    // Skipped, stopped or failed part way: end the session with the literal form rather than leave it for a day.
                    if (!ended)
                        try { await Run("R7 end", $"CALL BQ.ABORT_SESSION('{sessionId}')"); }
                        catch (Exception error) when (error is GoogleApiException or StopException) { Note("R7 the session could not be ended; it expires by itself."); }
                }
            }
            Note("By hand (zero): R13 a second query in a busy session and how soon a cancelled job frees it; R14 the wording for a session idle 24 hours.");

            // Varia's own tab session: query.execute makes it; it ends with query.session.close below.
            // A standalone CREATE TEMP TABLE cannot be dry-run outside a session, so a plain query opens the tab's session first.
            var tabSession = await Execute("session open", "SELECT 1 AS opened" + nonce) is { Job.JobId: { } openJob } ? sessions.GetValueOrDefault(openJob) : null;
            if (tabSession is null) Skip("session create: the first job reported no session");
            else
            {
                runSessions.Add(tabSession);
                if (await Execute("session create", "CREATE TEMP TABLE varia_check AS SELECT 42 AS answer", tabSession) is null) tabSession = null;
            }
            if (tier < 2) return;

            // ---- Billed: jobs that scan a small public table (10 MiB minimum each). ----
            // R15. A query through query.execute: rows, statistics and the bytes billed (at least BigQuery's 10 MiB minimum).
            if (await Execute("R15 query", aggregate) is { } query)
            {
                check(query.Status == "completed" && query.ResultSets.SingleOrDefault()?.RowsStored == 42, $"real project: R15 the query answers shakespeare's 42 corpora: {query.Status} {query.Error?.Message}");
                check(query.Job is { BytesBilled: >= MinimumBilledBytes, BytesProcessed: > 0 }, $"real project: R15 the job reports bytes processed and billed: {query.Job?.BytesProcessed} {query.Job?.BytesBilled}");
            }

            // R17. TABLESAMPLE over that query's anonymous result table, as every windowed result's random sample does.
            if (destinations.GetValueOrDefault(aggregate) is { } result)
            {
                budget.AllowResult($"{result.ProjectId}.{result.DatasetId}.{result.TableId}");
                var over = $"SELECT * FROM `{result.ProjectId}`.`{result.DatasetId}`.`{result.TableId}` TABLESAMPLE SYSTEM (@percent PERCENT) LIMIT @rows";
                var rows = await Run("R17 sample", over, parameters: [Parameter("percent", "FLOAT64", "50"), Parameter("rows", "INT64", "1000")]);
                if (rows is null) Note("R17 TABLESAMPLE over the anonymous result table was skipped (the lines above say why).");
                else check(rows.Status?.ErrorResult is null, $"real project: R17 TABLESAMPLE works on an anonymous result table: {rows.Status?.ErrorResult?.Message ?? "ok"}");
            }
            else Skip("R17: the query's result table was not found");

            // R18. Show CREATE Statement's INFORMATION_SCHEMA read: estimate (0) against billed (the 10 MiB minimum).
            if (await Execute("R18 show create", ddl) is { } shown) Note($"R18 Show CREATE Statement estimated 0 bytes and billed {shown.Job?.BytesBilled:N0}.");

            // The tab's session keeps its temp table between runs (dry-run with the session id that the create job reported).
            if (tabSession is null) Skip("session read: the tab session has no temp table");
            else if (await Execute("session read", "SELECT answer FROM varia_check", tabSession) is { } read)
                check(read.Status == "completed" && read.ResultSets.SingleOrDefault()?.RowsStored == 1, $"real project: a session keeps its temp table between runs: {read.Status} {read.Error?.Message}");

            // R15. Whether a script's maximumBytesBilled caps each statement or the script: two statements of 10 MiB each under 15 MiB.
            string[] statements = [$"SELECT SUM(word_count) AS words FROM {Shakespeare}" + nonce, $"SELECT MAX(word) AS last FROM {Shakespeare}" + nonce];
            var admitted = true;
            foreach (var (statement, index) in statements.Select((statement, index) => (statement, index))) admitted &= await Admit($"R15 script statement {index + 1}", statement);
            if (admitted && await Run("R15 script", string.Join(";\n", statements) + ";", cap: 15L * 1024 * 1024, floor: 2 * MinimumBilledBytes, script: true) is { } done)
            {
                var children = api.Jobs.List(project);
                children.ParentJobId = done.JobReference.JobId;
                children.Projection = Google.Apis.Bigquery.v2.JobsResource.ListRequest.ProjectionEnum.Full;
                var listed = (await children.ExecuteAsync()).Jobs ?? [];
                // A whole-script stop may carry a generic reason on the parent and the specific one on the child.
                var reason = done.Status?.ErrorResult is null ? null : listed.Select(child => child.Status?.ErrorResult?.Reason).FirstOrDefault(found => found == "bytesBilledLimitExceeded") ?? done.Status.ErrorResult.Reason;
                check(reason is null or "bytesBilledLimitExceeded", $"real project: R15 a capped script either succeeds or stops at its cap: {reason}");
                Note($"R15 a script's maximumBytesBilled applies {(reason is null ? "per statement (two 10 MiB statements ran under 15 MiB)" : "to the whole script (it stopped past 15 MiB)")}; slots: {done.Statistics?.TotalSlotMs} ms.");
                check(reason is not null || listed.Count == 2 && listed.All(child => child.Statistics?.Query?.StatementType == "SELECT"), $"real project: R15 a script's children list with their statement types: {listed.Count}");
                Note($"R15 the script's children carry maximumBytesBilled {string.Join(", ", listed.Select(child => child.Configuration?.Query?.MaximumBytesBilled?.ToString() ?? "none"))}.");
            }

            // R20. A script with DML on a temp table: each child's statementType and DML row count. Four statements under 25 MiB
            // keep within the job cap even where a script's cap applies to each statement.
            var dml = "CREATE TEMP TABLE varia_dml AS SELECT 1 AS x UNION ALL SELECT 2;\nUPDATE varia_dml SET x = 3 WHERE x = 2;\nDELETE FROM varia_dml WHERE x = 1;\nSELECT x FROM varia_dml;";
            if (await Run("R20 DML script", dml, cap: 25L * 1024 * 1024, floor: 4 * MinimumBilledBytes, script: true, temporary: true) is { } changed)
            {
                var children = api.Jobs.List(project);
                children.ParentJobId = changed.JobReference.JobId;
                children.Projection = Google.Apis.Bigquery.v2.JobsResource.ListRequest.ProjectionEnum.Full;
                var listed = (await children.ExecuteAsync()).Jobs ?? [];
                Note("R20 children: " + string.Join(", ", listed.Select(child => $"{child.Statistics?.Query?.StatementType} {child.Statistics?.Query?.NumDmlAffectedRows?.ToString() ?? "-"}")) + $"; error: {changed.Status?.ErrorResult?.Message ?? "none"}.");
            }
            Note("By hand (billed): R16 a Storage Read of a temp result table of 20 MB or more is free (check the billing report); R19 the bulk index's INFORMATION_SCHEMA rows (30 to 50 MiB a location); R21 fixtures change only by hand, from what this run printed.");
        }
        // A failed check throws, and so may a Google call: whatever ends the checks is kept, with the closing steps' failures,
        // and reported after the summary has printed (after a guard trips, the uncounted jobs and the total matter most).
        catch (StopException stop) { Later(false, "real project: the run stopped at its 1 GiB limit: " + stop.Message); }
        catch (UncappedException uncappedJob) { Later(false, "real project: a job billed without the job cap: " + uncappedJob.Message); }
        catch (Exception error) { Later(false, $"real project: the checks ended early: {error.GetType().Name}: {error.Message}"); }
        finally
        {
            // Ending the tab's session runs ABORT_SESSION, outside the session, capped and billing nothing: the run does not count it.
            if (sessionOpen)
            {
                var closed = await Call("query.session.close", new JsonObject { ["sessionId"] = session });
                Later(closed.Code == "ok", $"real project: the session closes: {closed.Code} {closed.Message}");
            }
            // jobs.list can lag jobs.get: reconcile until every job the run created is counted, for up to a minute.
            for (var attempt = 0; attempt < 12; attempt++)
            {
                try { await Reconcile("closing"); }
                catch (StopException stop)
                {
                    // Past 1 GiB: keep counting what finished, so the total printed below is whole.
                    Later(false, "real project: the run stopped at its 1 GiB limit: " + stop.Message);
                    continue;
                }
                catch (UncappedException uncappedJob)
                {
                    Later(false, "real project: a job billed without the job cap: " + uncappedJob.Message);
                    continue;
                }
                catch (GoogleApiException error) { Later(false, $"real project: the closing jobs.list failed ({(int)error.HttpStatusCode})"); break; }
                if (created.All(counted.Contains)) break;
                await Task.Delay(TimeSpan.FromSeconds(5));
            }
            await Call("connections.disconnect", new JsonObject { ["connectionId"] = connection.Id });
            var missed = created.Where(id => !counted.Contains(id)).ToList();
            Later(missed.Count == 0, $"real project: every job the run created was counted against its caps (not counted, perhaps still running: {string.Join(", ", missed)})");
            Later(budget.Billed <= RunCapBytes, $"real project: the run billed at most 1 GiB: {budget.Billed:N0} bytes");
            Note($"billed {budget.Billed:N0} bytes in all; skipped {skipped.Count} check(s){(skipped.Count > 0 ? ": " + string.Join(" | ", skipped) : "")}.");
            foreach (var failure in failures) Note("FAILED " + failure);
            if (failures.Count > 0) check(false, failures[0]);
        }
    }

    static async Task<Job> WaitDone(Google.Apis.Bigquery.v2.BigqueryService api, string project, string jobId, string? location)
    {
        for (var attempt = 0; ; attempt++)
        {
            var request = api.Jobs.Get(project, jobId);
            request.Location = location;
            var job = await request.ExecuteAsync();
            if (job.Status?.State == "DONE" || attempt >= 120) return job;
            await Task.Delay(TimeSpan.FromMilliseconds(Math.Min(2000, 250 * (attempt + 1))));
        }
    }

    /// <summary>The credential main would send: a service account key from VARIA_TEST_BIGQUERY_KEY_FILE, else ADC's file
    /// (GOOGLE_APPLICATION_CREDENTIALS, else gcloud's application_default_credentials.json). Never printed.</summary>
    static (string Authentication, string? KeyFile, BigQueryCredentialMaterial Credential) Credential()
    {
        if (Environment.GetEnvironmentVariable("VARIA_TEST_BIGQUERY_KEY_FILE") is { Length: > 0 } key)
            return ("serviceAccountKey", Guid.NewGuid().ToString(), new("file", File.ReadAllText(key)));
        var folder = Environment.GetEnvironmentVariable("CLOUDSDK_CONFIG") is { Length: > 0 } config ? config
            : OperatingSystem.IsWindows() ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "gcloud")
            : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".config", "gcloud");
        var adc = Environment.GetEnvironmentVariable("GOOGLE_APPLICATION_CREDENTIALS") is { Length: > 0 } named ? named : Path.Combine(folder, "application_default_credentials.json");
        if (!File.Exists(adc)) throw new InvalidOperationException("No credentials: set VARIA_TEST_BIGQUERY_KEY_FILE, or run gcloud auth application-default login.");
        return ("gcloud", null, new("adc", File.ReadAllText(adc)));
    }
}
