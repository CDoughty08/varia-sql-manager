using System.Text.Json;
using Microsoft.Data.SqlClient;
using Varia.Backend.Protocol;
using Varia.Backend.Ssis;

namespace Varia.Backend.Tests;

/// <summary>Offline checks of the Integration Services document's reads, ssis.execution (the run page) and ssis.packageRuns (the
/// package step): the catalogue's message types and count types, the batches' statements (in the SSIS lint through SsisSql.All, and
/// their own shape here), request validation in the service and the dispatcher, parameter binding, the usual-duration median, and
/// the refusals before any connection (old or Linux servers, sign-in failures as values).</summary>
internal static class SsisExecutionChecks
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
        UnmappedMemberHandling = System.Text.Json.Serialization.JsonUnmappedMemberHandling.Disallow
    };

    private static SsisExecutionArgs Args(long id, List<int>? types = null, string? source = null) => new(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), id, types, source);
    private static SsisPackageRunsArgs Runs(string folder = "Finance", string project = "Loads", string package = "Daily.dtsx") => new(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), folder, project, package);

    public static async Task RunAsync(Action<bool, string> check)
    {
        var catalog = SsisCatalog.Current;
        check(catalog.MessageTypes.Keys.Order().SequenceEqual([-1, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 200, 400])
            && catalog.ErrorMessageTypes.SequenceEqual([120]) && catalog.WarningMessageTypes.SequenceEqual([110]) && catalog.SucceededStatus == 7
            && catalog.Limit("executionMessages") == 5000 && catalog.Limit("executionMessageChars") == 4000 && catalog.Limit("executionTasks") == 1000
            && catalog.Limit("executionParameters") == 1000 && catalog.Limit("executionRuns") == 16 && catalog.Limit("packageRuns") == 1000,
            "the embedded catalogue names SSIS's message types (PreValidate through NonDiagnostic, and Unknown), the run counts' error and warning types, and the reads' bounds");

        var statements = SsisSql.Execution(catalog);
        var runs = SsisSql.PackageRuns(catalog);
        var problems = statements.Concat(runs).SelectMany((statement, index) => SsisSql.Lint(statement.Text, statement.List).Select(problem => "#" + index + ": " + problem)).ToList();
        check(statements.Length == 10 && statements.Select(statement => statement.List).SequenceEqual([false, false, true, true, true, true, true, false, true, false]) && problems.Count == 0
            && statements[0].Text.Contains("SELECT @folder = e.folder_name, @project = e.project_name, @package = e.package_name FROM [catalog].[executions] AS e WHERE e.execution_id = @execution_id;", StringComparison.Ordinal)
            && statements[1].Text.Contains("FROM [catalog].[executions] AS e WHERE e.execution_id = @execution_id;", StringComparison.Ordinal)
            && statements[2].Text.Contains("COUNT_BIG(*) FROM [catalog].[event_messages] AS m WHERE m.operation_id = @execution_id GROUP BY m.message_type", StringComparison.Ordinal)
            && statements[3].Text.Contains("(@tunknown = 1 AND m.message_type NOT IN (10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 200, 400)) OR (@t10 = 1 AND m.message_type = 10) OR ", StringComparison.Ordinal)
            && statements[3].Text.Contains("(@source IS NULL OR m.message_source_name = @source)", StringComparison.Ordinal)
            && statements[3].Text.Contains("LEFT(m.message, @chars + 1)", StringComparison.Ordinal) && statements[3].Text.EndsWith("ORDER BY m.message_time DESC, m.event_message_id DESC;", StringComparison.Ordinal)
            && statements[4].Text.Contains("FROM [catalog].[executables] AS x OUTER APPLY", StringComparison.Ordinal) && statements[4].Text.Contains("SUM(CAST(s.execution_duration AS bigint))", StringComparison.Ordinal)
            && statements[5].Text.Contains("CASE WHEN p.sensitive = 1 THEN NULL ELSE LEFT(CONVERT(nvarchar(4000), p.parameter_value), @chars + 1) END", StringComparison.Ordinal)
            && statements[6].Text.Contains("(SELECT TOP (@runs) e.execution_id", StringComparison.Ordinal) && statements[6].Text.Contains("e.execution_id <= @execution_id", StringComparison.Ordinal)
            && statements[7].Text.Contains("e.execution_id > @execution_id ORDER BY e.execution_id;", StringComparison.Ordinal)
            && statements[8].Text.Contains("e.status = @succeeded AND e.execution_id < @execution_id", StringComparison.Ordinal) && statements[8].Text.Contains("s.execution_result = 0", StringComparison.Ordinal)
            && statements[8].Text.Contains("SUM(CAST(s.execution_duration AS bigint))", StringComparison.Ordinal) && statements[8].Text.Contains("GROUP BY s.execution_id, x.executable_id", StringComparison.Ordinal)
            && statements[9].Text.Contains("TOP (1)", StringComparison.Ordinal) && statements[9].Text.Contains("m.message_type IN (120)", StringComparison.Ordinal)
            && statements[9].Text.EndsWith("ORDER BY m.message_time ASC, m.event_message_id ASC;", StringComparison.Ordinal)
            && runs.Length == 1 && runs[0].List && runs[0].Text.Contains("m.message_type IN (120)", StringComparison.Ordinal) && runs[0].Text.Contains("m.message_type IN (110)", StringComparison.Ordinal)
            && runs[0].Text.EndsWith("e.package_name = @package ORDER BY e.execution_id DESC;", StringComparison.Ordinal)
            && SsisSql.All(catalog.Views).Count(item => item.Id.StartsWith("execution #", StringComparison.Ordinal)) == 10
            && SsisSql.All(catalog.Views).Count(item => item.Id.StartsWith("packageRuns #", StringComparison.Ordinal)) == 1,
            "the run page's batch looks up the package, reads the execution, counts its messages by type, lists the newest messages of the types whose bit is on and of @source's task, "
            + "the executables with their statistics summed, the parameters (a sensitive value never read), the package's runs up to this one and the next, and the usual durations' history; "
            + "the package step lists one package's runs with their counts; each bounded, ordered and in the SSIS lint: " + string.Join("; ", problems));
        check(SsisSql.Lint(statements[3].Text.Replace("TOP (@take) ", "", StringComparison.Ordinal), true).Contains("is not a TOP (@take) listing")
            && SsisSql.Lint(statements[1].Text + " DELETE FROM [catalog].[executions];", false).Contains("is not a read: DELETE")
            && SsisSql.TypeParameter(-1) == "@tunknown" && SsisSql.TypeParameter(130) == "@t130",
            "the SSIS lint refuses an unbounded message list and a write in the execution batch, and each message type has its own bit parameter");

        using var service = new SsisService(new SsisChecks.FakeHost());
        string Code(SsisExecutionArgs args)
        {
            try { service.Validate(args); return "ok"; }
            catch (RequestException error) { return error.Code; }
        }
        var cases = new (SsisExecutionArgs Args, string Expected)[]
        {
            (Args(1), "ok"), (Args(9_007_199_254_740_991), "ok"), (Args(48213, [120, 110]), "ok"), (Args(5, [-1]), "ok"), (Args(5, source: "Load facts"), "ok"),
            (Args(5, source: new string('s', 4000)), "ok"),
            (Args(0), "INVALID_PARAMS"), (Args(-3), "INVALID_PARAMS"), (Args(9_007_199_254_740_992), "INVALID_PARAMS"), (Args(5, []), "INVALID_PARAMS"),
            (Args(5, [120, 120]), "INVALID_PARAMS"), (Args(5, [121]), "INVALID_PARAMS"), (Args(5, source: ""), "INVALID_PARAMS"), (Args(5, source: new string('s', 4001)), "INVALID_PARAMS"),
            (Args(5) with { ConnectionId = "x" }, "INVALID_PARAMS"), (Args(5) with { RequestId = "y" }, "INVALID_PARAMS")
        };
        var wrong = cases.Where(item => Code(item.Args) != item.Expected).Select(item => JsonSerializer.Serialize(item.Args, Json) + " " + Code(item.Args)).ToList();
        check(wrong.Count == 0, "ssis.execution accepts a positive id that crosses JSON exactly, distinct message types of the catalogue and a bounded task, and refuses the rest: " + string.Join("; ", wrong));
        string RunsCode(SsisPackageRunsArgs args)
        {
            try { service.Validate(args); return "ok"; }
            catch (RequestException error) { return error.Code; }
        }
        var runCases = new (SsisPackageRunsArgs Args, string Expected)[]
        {
            (Runs(), "ok"), (Runs(new string('f', 128), new string('p', 128), new string('k', 260)), "ok"), (Runs(""), "INVALID_PARAMS"), (Runs(project: ""), "INVALID_PARAMS"),
            (Runs(package: ""), "INVALID_PARAMS"), (Runs(new string('f', 129)), "INVALID_PARAMS"), (Runs(package: new string('k', 261)), "INVALID_PARAMS"), (Runs() with { RequestId = "y" }, "INVALID_PARAMS")
        };
        var wrongRuns = runCases.Where(item => RunsCode(item.Args) != item.Expected).Select(item => item.Args.Folder.Length + "/" + item.Args.Project.Length + "/" + item.Args.Package.Length + " " + RunsCode(item.Args)).ToList();
        check(wrongRuns.Count == 0, "ssis.packageRuns accepts a folder, project and package within their bounds and refuses the rest: " + string.Join("; ", wrongRuns));

        static object? Value(SqlParameter[] parameters, string name) => parameters.Single(parameter => parameter.ParameterName == name).Value;
        var bound = service.BindExecution(48213, [120, -1], "Load facts");
        var every = service.BindExecution(48213, null, null);
        check(bound.Take(6).Select(parameter => parameter.ParameterName).SequenceEqual(["@execution_id", "@take", "@chars", "@runs", "@succeeded", "@source"]) && bound.Length == 6 + 17
            && Value(bound, "@execution_id") is 48213L && Value(bound, "@take") is 5001 && Value(bound, "@chars") is 4000 && Value(bound, "@runs") is 16 && Value(bound, "@succeeded") is 7
            && Value(bound, "@source") is "Load facts" && Value(bound, "@t120") is true && Value(bound, "@tunknown") is true && Value(bound, "@t110") is false && Value(bound, "@t10") is false
            && Value(every, "@source") == DBNull.Value && every.Skip(6).All(parameter => parameter.Value is true),
            "an execution read binds its id, one row past its bound, the characters, the runs, the succeeded status, its task or NULL, and one bit per message type (every bit without a filter)");
        var runsBound = service.BindPackageRuns(Runs());
        check(runsBound.Select(parameter => parameter.ParameterName).SequenceEqual(["@take", "@folder", "@project", "@package"]) && Value(runsBound, "@take") is 1001
            && Value(runsBound, "@package") is "Daily.dtsx" && runsBound[3].Size == 260,
            "the package step binds one run past its bound and the package's names as parameters");
        check(SsisService.Median([30, 10, 20]) == 20 && SsisService.Median([40, 10, 30, 20]) == 20 && SsisService.Median([5]) == 5,
            "a usual duration is the median of the earlier runs, the lower middle one for an even count");
        check(SsisService.Clip(new string('m', 4001), 4000) is { Length: 4000 } clipped && clipped.EndsWith('…') && SsisService.Clip(new string('m', 4000), 4000).Length == 4000
            && SsisService.Clip(new string('m', 3998) + "\uD83D\uDE00" + "tail", 4000) == new string('m', 3998) + "…"
            && SsisService.ExecutionGone(7).StartsWith("Execution 7 is not in the SSIS Catalog: the catalog's retention cleanup may have removed it", StringComparison.Ordinal),
            "a message one character past its bound is cut with an ellipsis, and a purged execution's message says the retention cleanup may have removed it");

        using (var sql = new SqlService())
        {
            async Task<string> Dispatch(string body)
            {
                try { await sql.DispatchAsync("ssis.execution", JsonDocument.Parse(body).RootElement, Json); return "ok"; }
                catch (RequestException error) { return error.Code; }
                catch (JsonException) { return "JSON"; }
            }
            var connection = Guid.NewGuid().ToString();
            var codes = new[]
            {
                await Dispatch("{\"connectionId\":\"" + connection + "\",\"requestId\":\"" + Guid.NewGuid() + "\",\"executionId\":0}"),
                await Dispatch("{\"connectionId\":\"" + connection + "\",\"requestId\":\"" + Guid.NewGuid() + "\",\"executionId\":5,\"types\":[7]}"),
                await Dispatch("{\"connectionId\":\"" + connection + "\",\"requestId\":\"" + Guid.NewGuid() + "\",\"executionId\":5,\"extra\":1}"),
                await Dispatch("{\"connectionId\":\"" + connection + "\",\"requestId\":\"" + Guid.NewGuid() + "\",\"executionId\":5}")
            };
            var runCodes = new[]
            {
                await RunsDispatch("{\"connectionId\":\"" + connection + "\",\"requestId\":\"" + Guid.NewGuid() + "\",\"folder\":\"\",\"project\":\"p\",\"package\":\"k\"}"),
                await RunsDispatch("{\"connectionId\":\"" + connection + "\",\"requestId\":\"" + Guid.NewGuid() + "\",\"folder\":\"f\",\"project\":\"p\",\"package\":\"k\"}")
            };
            check(codes[0] == "INVALID_PARAMS" && codes[1] == "INVALID_PARAMS" && codes[2] is "INVALID_PARAMS" or "JSON" && codes[3] == "NOT_CONNECTED"
                && runCodes[0] == "INVALID_PARAMS" && runCodes[1] == "NOT_CONNECTED",
                "the dispatcher validates ssis.execution and ssis.packageRuns before it looks for the connection, and refuses unknown members: " + string.Join(", ", codes.Concat(runCodes)));
            async Task<string> RunsDispatch(string body)
            {
                try { await sql.DispatchAsync("ssis.packageRuns", JsonDocument.Parse(body).RootElement, Json); return "ok"; }
                catch (RequestException error) { return error.Code; }
                catch (JsonException) { return "JSON"; }
            }
        }

        var old = new SsisChecks.FakeHost(12);
        using var oldService = new SsisService(old);
        var refused = await oldService.ExecutionAsync(Args(5), CancellationToken.None);
        using var linuxService = new SsisService(new SsisChecks.FakeHost(17, linux: true));
        var linux = await linuxService.ExecutionAsync(Args(5), CancellationToken.None);
        var host = new SsisChecks.FakeHost();
        using var hostService = new SsisService(host);
        var kerberos = await hostService.ExecutionAsync(Args(5), CancellationToken.None);
        var oldRuns = await oldService.PackageRunsAsync(Runs(), CancellationToken.None);
        var kerberosRuns = await hostService.PackageRunsAsync(Runs(), CancellationToken.None);
        check(refused.Error is { Code: "NOT_SUPPORTED" } && linux.Error is { Code: "NOT_SUPPORTED" } && old.Opens == 0 && refused.Model is null
            && oldRuns.Error is { Code: "NOT_SUPPORTED" } && kerberos.Error is { Code: "AUTH_KERBEROS" } && kerberosRuns.Error is { Code: "AUTH_KERBEROS" } && host.Opens == 2,
            "the run page's and package step's reads on a server without a catalog answer NOT_SUPPORTED without connecting, and a sign-in failure is a value");
    }
}
