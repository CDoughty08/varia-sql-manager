using System.Text.Json;
using Microsoft.Data.SqlClient;
using Varia.Backend.Protocol;
using Varia.Backend.Ssis;

namespace Varia.Backend.Tests;

/// <summary>Offline checks of ssis.execution (AG-13, the SSIS execution messages view): the catalogue's message groups, the
/// batch's statements (in the SSIS lint through SsisSql.All, and their own shape here), request validation in the service and
/// the dispatcher, parameter binding, and the refusals before any connection (old or Linux servers, sign-in failures as values).</summary>
internal static class SsisExecutionChecks
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
        UnmappedMemberHandling = System.Text.Json.Serialization.JsonUnmappedMemberHandling.Disallow
    };

    private static SsisExecutionArgs Args(long id, List<string>? groups = null, string? connectionId = null) => new(connectionId ?? Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), id, groups);

    public static async Task RunAsync(Action<bool, string> check)
    {
        var catalog = SsisCatalog.Current;
        check(catalog.MessageGroups.Select(group => group.Group).SequenceEqual(["error", "warning", "information", "other"])
            && catalog.MessageGroups[0].Types.SequenceEqual([120, 130]) && catalog.MessageGroups[1].Types.SequenceEqual([110]) && catalog.MessageGroups[2].Types.SequenceEqual([70])
            && catalog.MessageGroups[3].Types.Count == 0 && catalog.Limit("executionMessages") == 5000 && catalog.Limit("executionMessageChars") == 4000,
            "the embedded catalogue's message groups name SSMS's error, warning and information types, and Other holds the rest");

        var statements = SsisSql.Execution(catalog);
        var problems = statements.SelectMany((statement, index) => SsisSql.Lint(statement.Text, statement.List).Select(problem => "#" + index + ": " + problem)).ToList();
        check(statements.Length == 3 && !statements[0].List && statements[1].List && statements[2].List && problems.Count == 0
            && statements[0].Text.Contains("FROM [catalog].[executions] AS e WHERE e.execution_id = @execution_id;", StringComparison.Ordinal)
            && statements[1].Text.Contains("COUNT_BIG(*) FROM [catalog].[event_messages] AS m WHERE m.operation_id = @execution_id GROUP BY m.message_type", StringComparison.Ordinal)
            && statements[2].Text.Contains("(@error = 1 AND m.message_type IN (120, 130)) OR (@warning = 1 AND m.message_type IN (110)) OR (@information = 1 AND m.message_type IN (70)) OR (@other = 1 AND m.message_type NOT IN (120, 130, 110, 70))", StringComparison.Ordinal)
            && statements[2].Text.Contains("LEFT(m.message, @chars + 1)", StringComparison.Ordinal) && statements[2].Text.EndsWith("ORDER BY m.message_time DESC, m.event_message_id DESC;", StringComparison.Ordinal)
            && SsisSql.All(catalog.Views).Count(item => item.Id.StartsWith("execution #", StringComparison.Ordinal)) == 3,
            "the execution batch reads the execution by its id, counts every message by type, and lists the newest messages of the groups whose bit is on, each bounded, ordered and in the SSIS lint: "
            + string.Join("; ", problems));
        check(SsisSql.Lint(statements[2].Text.Replace("TOP (@take) ", "", StringComparison.Ordinal), true).Contains("is not a TOP (@take) listing")
            && SsisSql.Lint(statements[0].Text + " DELETE FROM [catalog].[executions];", false).Contains("is not a read: DELETE"),
            "the SSIS lint refuses an unbounded message list and a write in the execution batch");

        using var service = new SsisService(new SsisChecks.FakeHost());
        string Code(SsisExecutionArgs args)
        {
            try { service.Validate(args); return "ok"; }
            catch (RequestException error) { return error.Code; }
        }
        var cases = new (SsisExecutionArgs Args, string Expected)[]
        {
            (Args(1), "ok"), (Args(9_007_199_254_740_991), "ok"), (Args(48213, ["error", "warning"]), "ok"), (Args(5, ["other"]), "ok"),
            (Args(0), "INVALID_PARAMS"), (Args(-3), "INVALID_PARAMS"), (Args(9_007_199_254_740_992), "INVALID_PARAMS"), (Args(5, []), "INVALID_PARAMS"),
            (Args(5, ["error", "error"]), "INVALID_PARAMS"), (Args(5, ["fatal"]), "INVALID_PARAMS"), (Args(5) with { ConnectionId = "x" }, "INVALID_PARAMS"), (Args(5) with { RequestId = "y" }, "INVALID_PARAMS")
        };
        var wrong = cases.Where(item => Code(item.Args) != item.Expected).Select(item => JsonSerializer.Serialize(item.Args, Json) + " " + Code(item.Args)).ToList();
        check(wrong.Count == 0, "ssis.execution accepts a positive id that crosses JSON exactly and distinct groups of the catalogue, and refuses the rest: " + string.Join("; ", wrong));

        static object? Value(SqlParameter[] parameters, string name) => parameters.Single(parameter => parameter.ParameterName == name).Value;
        var bound = service.BindExecution(48213, ["error", "other"]);
        check(bound.Select(parameter => parameter.ParameterName).SequenceEqual(["@execution_id", "@take", "@chars", "@error", "@warning", "@information", "@other"])
            && Value(bound, "@execution_id") is 48213L && Value(bound, "@take") is 5001 && Value(bound, "@chars") is 4000
            && Value(bound, "@error") is true && Value(bound, "@warning") is false && Value(bound, "@information") is false && Value(bound, "@other") is true,
            "an execution read binds its id, one row past its bound, the message characters and one bit per group");
        check(SsisService.Clip(new string('m', 4001), 4000) is { Length: 4000 } clipped && clipped.EndsWith('…') && SsisService.Clip(new string('m', 4000), 4000).Length == 4000
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
                await Dispatch("{\"connectionId\":\"" + connection + "\",\"requestId\":\"" + Guid.NewGuid() + "\",\"executionId\":5,\"groups\":[\"nope\"]}"),
                await Dispatch("{\"connectionId\":\"" + connection + "\",\"requestId\":\"" + Guid.NewGuid() + "\",\"executionId\":5,\"extra\":1}"),
                await Dispatch("{\"connectionId\":\"" + connection + "\",\"requestId\":\"" + Guid.NewGuid() + "\",\"executionId\":5}")
            };
            check(codes[0] == "INVALID_PARAMS" && codes[1] == "INVALID_PARAMS" && codes[2] is "INVALID_PARAMS" or "JSON" && codes[3] == "NOT_CONNECTED",
                "the dispatcher validates ssis.execution before it looks for the connection, and refuses unknown members: " + string.Join(", ", codes));
        }

        var old = new SsisChecks.FakeHost(12);
        var refused = await new SsisService(old).ExecutionAsync(Args(5), CancellationToken.None);
        var linux = await new SsisService(new SsisChecks.FakeHost(17, linux: true)).ExecutionAsync(Args(5), CancellationToken.None);
        var host = new SsisChecks.FakeHost();
        var kerberos = await new SsisService(host).ExecutionAsync(Args(5), CancellationToken.None);
        check(refused.Error is { Code: "NOT_SUPPORTED" } && linux.Error is { Code: "NOT_SUPPORTED" } && old.Opens == 0 && refused.Model is null
            && kerberos.Error is { Code: "AUTH_KERBEROS" } && host.Opens == 1,
            "an execution read on a server without a catalog answers NOT_SUPPORTED without connecting, and a sign-in failure is a value");
    }
}
