using System.Text.Json;
using System.Text.Json.Nodes;
using Google.Apis.Bigquery.v2.Data;
using Varia.Backend.BigQuery;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>
/// Sort, filter and value lists of a windowed result offline (docs/bigquery.md, Sort and filter in BigQuery): the SQL
/// BigQueryViewSql writes and its fragments' lint, the scanner's determinism rule for the fallback, and results.remoteQuery's
/// view and distinct kinds and bigquery.dryRun's remote estimates through the scripted fake. No request leaves the process.
/// </summary>
internal static partial class BigQueryExecutionChecks
{
    static async Task RemoteViewsAsync(Action<bool, string> check)
    {
        ViewSqlShapes(check);
        DeterministicQueries(check);
        await RemoteViewRunsAsync(check);
        await ValueListRunsAsync(check);
        await RemoteViewRefusalsAsync(check);
        await RemoteExpiryAsync(check);
        await RemoteViewStopsAsync(check);
    }

    static readonly IReadOnlyList<BigQueryField> ViewFields = BigQueryColumnPlan.From(JsonSerializer.SerializeToElement(Schema(Field("n", "INTEGER"), Field("s", "STRING"),
        Field("odd name-x's", "STRING"), Field("tags", "STRING", "REPEATED"), Field("j", "JSON"))))!.Fields;

    static readonly TableReference ViewTable = new() { ProjectId = "varia-emulator", DatasetId = "_anon0123", TableId = "anon_result_1" };
    static readonly RemoteValueList ViewList = new(new TableReference { ProjectId = "varia-emulator", DatasetId = "_anon0123", TableId = "anon_values_2" }, 1, 1, 10, false);

    static void ViewSqlShapes(Action<bool, string> check)
    {
        var parameters = new List<QueryParameter>();
        var sql = BigQueryViewSql.View(BigQueryViewSql.Source(ViewTable), ViewFields, [new(0, true), new(2, false)], [], parameters);
        check(sql == "SELECT * FROM `varia-emulator`.`_anon0123`.`anon_result_1` ORDER BY `n` DESC NULLS LAST, `odd name-x's` ASC NULLS FIRST" && parameters.Count == 0,
            "a remote sort orders the result table by its own columns, names escaped, NULL first ascending and last descending: " + sql);
        parameters.Clear();
        sql = BigQueryViewSql.View(BigQueryViewSql.Source(ViewTable), ViewFields, [],
            [new(RemoteFilterKind.In, 1, ViewList, [3], true), new(RemoteFilterKind.NotIn, 1, ViewList, [4, 5], false), new(RemoteFilterKind.Between, 1, ViewList, [7, 2], false),
             new(RemoteFilterKind.In, 0, null, [], true), new(RemoteFilterKind.NotIn, 0, null, [], true), new(RemoteFilterKind.In, 0, null, [], false), new(RemoteFilterKind.NotIn, 0, null, [], false),
             new(RemoteFilterKind.NotIn, 1, ViewList, [6], true)], parameters);
        const string list = "`varia-emulator`.`_anon0123`.`anon_values_2`";
        var expected = "SELECT * FROM `varia-emulator`.`_anon0123`.`anon_result_1` WHERE "
            + "(`s` IS NOT NULL AND `s` IN (SELECT value FROM " + list + " WHERE value IS NOT NULL AND r IN UNNEST(@p0)) OR `s` IS NULL)"
            + " AND (`s` IS NULL OR `s` NOT IN (SELECT value FROM " + list + " WHERE value IS NOT NULL AND r IN UNNEST(@p1)))"
            + " AND (`s` IS NOT NULL AND `s` BETWEEN (SELECT value FROM " + list + " WHERE r = @p2) AND (SELECT value FROM " + list + " WHERE r = @p3))"
            + " AND (`n` IS NULL) AND (`n` IS NOT NULL) AND (FALSE) AND (TRUE)"
            + " AND (`s` IS NOT NULL AND `s` NOT IN (SELECT value FROM " + list + " WHERE value IS NOT NULL AND r IN UNNEST(@p4)))";
        check(sql == expected, "each remote filter is a predicate on the value list's own table, NULL asked apart: " + sql);
        check(parameters.Count == 5 && parameters[0] is { Name: "p0", ParameterType.Type: "ARRAY", ParameterType.ArrayType.Type: "INT64" } && parameters[0].ParameterValue.ArrayValues.Single().Value == "3"
            && parameters[1].ParameterValue.ArrayValues.Select(value => value.Value).SequenceEqual(["4", "5"]) && parameters[2] is { Name: "p2", ParameterType.Type: "INT64", ParameterValue.Value: "2" }
            && parameters[3].ParameterValue.Value == "7",
            "a filter's values go as INT64 parameters naming the value list's rows, and Between's bounds in value order: " + string.Join(", ", parameters.Select(p => p.Name + "=" + (p.ParameterValue.Value ?? "[]"))));
        parameters.Clear();
        sql = BigQueryViewSql.Values(BigQueryViewSql.Source(ViewTable), ViewFields, 1, [new(RemoteFilterKind.In, 0, null, [], true)], [new(RemoteFilterKind.NotIn, 1, ViewList, [1], false)], parameters);
        check(sql == "SELECT value, n, ROW_NUMBER() OVER (ORDER BY value ASC NULLS FIRST) - 1 AS r, k FROM (SELECT `s` AS value, COUNT(*) AS n, COALESCE(LOGICAL_OR("
            + "(`s` IS NULL OR `s` NOT IN (SELECT value FROM " + list + " WHERE value IS NOT NULL AND r IN UNNEST(@p0)))), FALSE) AS k FROM `varia-emulator`.`_anon0123`.`anon_result_1`"
            + " WHERE (`n` IS NULL) GROUP BY 1 ORDER BY 2 DESC, 1 ASC NULLS FIRST LIMIT @cap) ORDER BY r"
            && parameters.Last() is { Name: "cap", ParameterValue.Value: "100000" },
            "a value list groups the column under the other filters, ticks what the kept filters keep, and caps by count: " + sql);
        parameters.Clear();
        sql = BigQueryViewSql.Values(BigQueryViewSql.Source("SELECT n, s FROM t -- all of it\n;\n "), ViewFields, 0, [], null, parameters);
        check(sql.Contains("COALESCE(LOGICAL_OR(TRUE), FALSE) AS k FROM (SELECT n, s FROM t -- all of it\n) GROUP BY 1", StringComparison.Ordinal),
            "a fallback wraps the original query without its last semicolon, its closing parenthesis past a trailing comment: " + sql);
        check(BigQueryViewSql.Orderable(ViewFields[0]) && BigQueryViewSql.Orderable(ViewFields[1]) && !BigQueryViewSql.Orderable(ViewFields[3]) && !BigQueryViewSql.Orderable(ViewFields[4]),
            "ARRAY and JSON columns cannot be sorted or listed in BigQuery");
        var refused = false;
        try { BigQueryViewSql.View(BigQueryViewSql.Source(ViewTable), BigQueryColumnPlan.From(JsonSerializer.SerializeToElement(Schema(Field("a;b", "STRING"))))!.Fields, [new(0, false)], [], []); }
        catch (RequestException error) { refused = error.Code == "INVALID_PARAMS"; }
        check(refused, "a column name BqNames refuses never reaches the text");
        check(BigQuerySql.ViewFragments.All(fragment => !fragment.Contains('\'') && !fragment.Contains('"') && !fragment.Contains('`') && !fragment.Contains(';') && !fragment.Contains("--", StringComparison.Ordinal)
            && !fragment.Contains('#') && !fragment.Contains("/*", StringComparison.Ordinal)),
            "the remote view's fragments are constant text with no literal, quote, comment or statement separator");
    }

    static void DeterministicQueries(Action<bool, string> check)
    {
        string[] steady = ["SELECT n, s FROM t", "  (SELECT 1)", "WITH a AS (SELECT 1 AS x) SELECT * FROM a;", "FROM t |> WHERE n > 1", "SELECT 'CURRENT_DATE() and RAND()' AS s -- RAND()",
            "SELECT `limit` FROM t"];
        string[] unsteady = ["SELECT CURRENT_TIMESTAMP()", "SELECT rand()", "SELECT * FROM t LIMIT 10", "SELECT * FROM t WHERE n = @n", "SELECT 1; SELECT 2", "DECLARE x INT64; SELECT x",
            "SELECT * FROM _SESSION.temp", "SELECT * FROM t TABLESAMPLE SYSTEM (10 PERCENT)", "SELECT ANY_VALUE(s) FROM t", "INSERT t (n) VALUES (1)", "CALL p()", "", "SELECT GENERATE_UUID()",
            "SELECT SESSION_USER()", "SELECT @@script.job_id"];
        var wrongSteady = steady.Where(sql => !GoogleSqlScanner.IsDeterministicQuery(sql)).ToArray();
        var wrongUnsteady = unsteady.Where(GoogleSqlScanner.IsDeterministicQuery).ToArray();
        check(wrongSteady.Length == 0 && wrongUnsteady.Length == 0,
            "the fallback runs only one query the scanner finds deterministic: wrongly refused [" + string.Join(" | ", wrongSteady) + "], wrongly allowed [" + string.Join(" | ", wrongUnsteady) + "]");
    }

    static JsonObject View(uint resultId, JsonArray? sort = null, JsonArray? filters = null, string? queryId = null)
    {
        var request = new JsonObject { ["queryId"] = queryId ?? Guid.NewGuid().ToString(), ["resultId"] = resultId, ["generation"] = 1, ["kind"] = "view" };
        if (sort is not null) request["sort"] = sort;
        if (filters is not null) request["filters"] = filters;
        return request;
    }

    static JsonObject Key(int column, bool descending = false) => new() { ["column"] = column, ["descending"] = descending };

    /// <summary>A windowed result of 3,000 rows of (n, s), as the store too small for it windows it.</summary>
    static async Task<(Harness Harness, uint Id)> WindowedAsync(int rows = 3000)
    {
        var harness = new Harness(Lines(rows), new ResultStore(4L << 20, 32 * 1024));
        await harness.ConnectAsync();
        var (code, executed, message) = await harness.Execute("SELECT n, s FROM t");
        var set = executed?.ResultSets.Single();
        if (code != "ok" || set?.Residence != "remote") throw new InvalidOperationException("windowed: " + code + " " + message + " " + set?.Residence);
        return (harness, set.ResultId);
    }

    static string InsertedSql(Harness harness) => harness.Jobs.InsertBodies.Last()["configuration"]!["query"]!["query"]!.GetValue<string>();

    static async Task RemoteViewRunsAsync(Action<bool, string> check)
    {
        // A sort becomes a new result of the same query, read by the residence rule: a large one is windowed itself.
        {
            var (harness, id) = await WindowedAsync();
            using var _ = harness;
            var (code, result, events, message) = await Run(harness, "results.remoteQuery", View(id, sort: [Key(0, descending: true)]));
            var set = result?.ResultSets.SingleOrDefault();
            var body = harness.Jobs.InsertBodies.Last();
            var query = body["configuration"]!["query"]!;
            check(code == "ok" && result?.Status == "completed" && set is { Residence: "remote", RowsAvailable: 3000 } && set.ResultId != id && harness.Service.Results.Find(id)?.IsRemote == true
                && Types(events).Contains("resultSet.opened") && Types(events).Contains("resultSet.closed") && OfType(events, "resultSet.opened").Single().GetProperty("descriptor").GetProperty("resultId").GetUInt32() == set.ResultId,
                $"a remote sort is announced as a new result, the source kept: {code} {message} {result?.Status} {set?.Residence} {set?.RowsAvailable} {string.Join(",", Types(events))}");
            check(InsertedSql(harness) == "SELECT * FROM `varia-emulator`.`_anon0123`.`anon_result_1` ORDER BY `n` DESC NULLS LAST"
                && query["connectionProperties"] is null && query["createSession"] is null && query["parameterMode"]?.GetValue<string>() == "NAMED"
                && body["configuration"]!["labels"]?["varia_client"]?.GetValue<string>() == "varia" && result?.Job?.JobId == body["jobReference"]!["jobId"]!.GetValue<string>(),
                "the sort's job reads the result table outside any session, labelled, its id in the summary: " + body.ToJsonString());
            check(Says(result, "BigQuery job ") && Types(events).Contains("query.job"), "the sort's job is named in Messages and its query.job event: " + Texts(result?.Messages ?? []));
            // Each view is billed apart: a second one is a second job.
            var jobs = harness.Jobs.InsertedIds.Count;
            var (again, second, _, _) = await Run(harness, "results.remoteQuery", View(id, sort: [Key(1), Key(0, descending: true)]));
            check(again == "ok" && harness.Jobs.InsertedIds.Count == jobs + 1 && second?.ResultSets.Single().ResultId is { } other && other != set?.ResultId
                && InsertedSql(harness).EndsWith("ORDER BY `s` ASC NULLS FIRST, `n` DESC NULLS LAST", StringComparison.Ordinal),
                "a second sort runs its own job and makes its own result: " + InsertedSql(harness));
        }
        // A filter that leaves few rows brings its view into memory, where it reads like any result.
        {
            var (harness, id) = await WindowedAsync();
            using var _ = harness;
            harness.Jobs.Rows = [.. harness.Jobs.Rows.Take(40)];
            var (code, result, _, message) = await Run(harness, "results.remoteQuery", View(id, filters: [new JsonObject { ["op"] = "notIn", ["column"] = 1, ["rows"] = new JsonArray(), ["nulls"] = true }]));
            var set = result?.ResultSets.SingleOrDefault();
            check(code == "ok" && set is { Residence: "memory", RowsStored: 40 } && InsertedSql(harness).EndsWith("WHERE (`s` IS NOT NULL)", StringComparison.Ordinal),
                $"a filter that leaves few rows is in memory: {code} {message} {set?.Residence} {set?.RowsStored} {InsertedSql(harness)}");
            var stored = set is null ? null : harness.Service.Results.Find(set.ResultId);
            check(stored is { Derived: true, Kind: "rows" } && stored.Budget == harness.Service.Results.Find(id)?.Budget,
                "a remote view is a derived set of the source's query, released with it");
        }
    }

    /// <summary>A value list's schema and rows as BigQuery answers the distinct query: (value, n, r, k) in value order.</summary>
    static void ValueListRows(Harness harness, params (string? Value, long Count, bool Kept)[] values)
    {
        harness.Jobs.Schema = Schema(Field("value", "STRING"), Field("n", "INTEGER"), Field("r", "INTEGER"), Field("k", "BOOLEAN"));
        harness.Jobs.Rows = [.. values.Select((value, at) => Row(value.Value, value.Count.ToString(Inv), at.ToString(Inv), value.Kept ? "true" : "false"))];
    }

    static async Task ValueListRunsAsync(Action<bool, string> check)
    {
        var (harness, id) = await WindowedAsync();
        using var _ = harness;
        ValueListRows(harness, (null, 5, true), ("apple", 7, true), ("kiwi", 2, false), ("pear", 30, false));
        var distinct = new JsonObject { ["queryId"] = Guid.NewGuid().ToString(), ["resultId"] = id, ["generation"] = 1, ["kind"] = "distinct", ["column"] = 1,
            ["filters"] = new JsonArray(new JsonObject { ["op"] = "notIn", ["column"] = 0, ["rows"] = new JsonArray(), ["nulls"] = true }) };
        var (code, result, _, message) = await Run(harness, "results.remoteQuery", distinct);
        var list = result?.ResultSets.SingleOrDefault();
        var held = list is null ? null : harness.Service.Results.Find(list.ResultId);
        check(code == "ok" && list is { Residence: "memory", RowsStored: 4 } && held?.ValueList is { Column: 1, Rows: 4, Capped: false } valueList && valueList.Source == id
            && InsertedSql(harness).StartsWith("SELECT value, n, ROW_NUMBER()", StringComparison.Ordinal) && InsertedSql(harness).Contains("FROM `varia-emulator`.`_anon0123`.`anon_result_1` WHERE (`n` IS NOT NULL) GROUP BY 1", StringComparison.Ordinal),
            $"a value list is a small in-memory result marked as the column's list: {code} {message} {result?.Status} {result?.Error?.Message} {list?.Residence} {list?.RowsStored} {InsertedSql(harness)}");
        if (list is null) return;
        var (opened, snapshot, openMessage) = await harness.Call("results.distinct", new JsonObject { ["resultId"] = list!.ResultId, ["column"] = 0 });
        var answer = snapshot as ResultsDistinctResult;
        check(opened == "ok" && answer is { Distinct: 3, Nulls: 5, Rows: 44, Complete: true, Checked: 1, NullsChecked: true },
            $"results.distinct lists a value list's values with their counts and ticks, NULL apart: {opened} {openMessage} {answer}");
        var (read, window, _) = await harness.Call("results.distinctRead", new JsonObject { ["resultId"] = list.ResultId, ["snapshotId"] = answer!.SnapshotId, ["order"] = "count", ["offset"] = 0, ["count"] = 10 });
        var values = (window as ResultsDistinctReadResult)?.Values ?? [];
        check(read == "ok" && values.Select(value => value.Text + ":" + value.Count + ":" + value.Checked + ":" + value.Row).SequenceEqual(["pear:30:False:3", "apple:7:True:1", "kiwi:2:False:2"]),
            "a value list reads most frequent first, each value's row its rank in the list: " + string.Join(", ", values.Select(value => value.Text + ":" + value.Count + ":" + value.Checked + ":" + value.Row)));
        // The ticks filter the view in BigQuery: only apple and NULL ticked, so the complete list keeps them by row.
        var (filtered, view, _, viewMessage) = await Run(harness, "results.remoteQuery", View(id, filters: [new JsonObject { ["op"] = "groups", ["column"] = 1, ["list"] = list.ResultId, ["snapshotId"] = answer.SnapshotId }]));
        var parameters = harness.Jobs.InsertBodies.Last()["configuration"]!["query"]!["queryParameters"]!.AsArray();
        check(filtered == "ok" && InsertedSql(harness).EndsWith("WHERE (`s` IS NOT NULL AND `s` IN (SELECT value FROM `varia-emulator`.`_anon0123`.`anon_result_1` WHERE value IS NOT NULL AND r IN UNNEST(@p0)) OR `s` IS NULL)", StringComparison.Ordinal)
            && parameters.Single()!["parameterValue"]!["arrayValues"]!.AsArray().Select(value => value!["value"]!.GetValue<string>()).SequenceEqual(["1"]),
            $"a value list's ticks filter in BigQuery by the list's rows: {filtered} {viewMessage} {InsertedSql(harness)} {parameters.ToJsonString()}");
        var (ticked, _, tickMessage) = await harness.Call("results.distinctTick", new JsonObject { ["resultId"] = list.ResultId, ["snapshotId"] = answer.SnapshotId, ["checked"] = true, ["all"] = true });
        check(ticked == "INVALID_PARAMS" && view?.Status == "completed", "a value list's snapshot is frozen once it filters, as a local one is: " + ticked + " " + tickMessage);
        // A list cut at the cap is not complete, so its ticks drop the cleared values and keep those never listed.
        harness.Service.Results.Find(list.ResultId)!.ValueList = held!.ValueList! with { Capped = true };
        var (_, cut, _) = await harness.Call("results.distinct", new JsonObject { ["resultId"] = list.ResultId, ["column"] = 0 });
        var cutAnswer = (ResultsDistinctResult)cut!;
        await Run(harness, "results.remoteQuery", View(id, filters: [new JsonObject { ["op"] = "groups", ["column"] = 1, ["list"] = list.ResultId, ["snapshotId"] = cutAnswer.SnapshotId }]));
        check(!cutAnswer.Complete && InsertedSql(harness).EndsWith("WHERE (`s` IS NULL OR `s` NOT IN (SELECT value FROM `varia-emulator`.`_anon0123`.`anon_result_1` WHERE value IS NOT NULL AND r IN UNNEST(@p0)))", StringComparison.Ordinal),
            "a cut value list filters by the values it clears, so values it never listed stay: " + InsertedSql(harness));
        // Equals and Between name the list's rows.
        await Run(harness, "results.remoteQuery", View(id, filters: [new JsonObject { ["op"] = "between", ["column"] = 1, ["list"] = list.ResultId, ["rows"] = new JsonArray(3, 1) }]));
        check(InsertedSql(harness).EndsWith("WHERE (`s` IS NOT NULL AND `s` BETWEEN (SELECT value FROM `varia-emulator`.`_anon0123`.`anon_result_1` WHERE r = @p0) AND (SELECT value FROM `varia-emulator`.`_anon0123`.`anon_result_1` WHERE r = @p1))", StringComparison.Ordinal),
            "Between names its bounds by their rows in the value list: " + InsertedSql(harness));
        // The list's ticks come from the kept filters, asked with LOGICAL_OR.
        distinct["queryId"] = Guid.NewGuid().ToString();
        distinct["kept"] = new JsonArray(new JsonObject { ["op"] = "in", ["column"] = 1, ["list"] = list.ResultId, ["rows"] = new JsonArray(1) });
        var (keptCode, _, _, keptMessage) = await Run(harness, "results.remoteQuery", distinct);
        check(keptCode == "ok" && InsertedSql(harness).Contains("COALESCE(LOGICAL_OR((`s` IS NOT NULL AND `s` IN (SELECT value FROM", StringComparison.Ordinal),
            $"a value list's ticks are the kept filters' rows: {keptCode} {keptMessage} {InsertedSql(harness)}");
        // A snapshot the list cannot keep (past its 24) returns its memory once: the budget's count stays true.
        {
            using var roomy = new Harness(Lines(3000), new ResultStore(256L << 20, 64L << 20));
            await roomy.ConnectAsync();
            var (_, executed, _) = await roomy.Execute("SELECT n, s FROM t", Windowed);
            var roomyId = executed!.ResultSets.Single().ResultId;
            ValueListRows(roomy, (null, 5, true), ("apple", 7, true), ("kiwi", 2, false));
            var (_, listed, _, _) = await Run(roomy, "results.remoteQuery", new JsonObject { ["queryId"] = Guid.NewGuid().ToString(), ["resultId"] = roomyId, ["generation"] = 1, ["kind"] = "distinct", ["column"] = 1 });
            var roomyList = listed!.ResultSets.Single().ResultId;
            string full = "ok", refusal = "";
            long before = 0;
            for (var open = 0; open <= ViewSorter.MaxDistinctSnapshots && full == "ok"; open++)
            {
                before = roomy.Service.Results.UsedBytes;
                var answered = await roomy.Call("results.distinct", new JsonObject { ["resultId"] = roomyList, ["column"] = 0 });
                (full, refusal) = (answered.Item1, answered.Item3);
            }
            check(full == "TOO_LARGE" && refusal.Contains("as many value lists", StringComparison.Ordinal) && roomy.Service.Results.UsedBytes == before,
                $"a value list's snapshot past the limit returns its memory once: {full} {refusal} {before} -> {roomy.Service.Results.UsedBytes}");
        }
        // Values that do not fit the store are refused whole, never kept in part.
        {
            var (small, smallId) = await WindowedAsync();
            using var __ = small;
            ValueListRows(small, [.. Enumerable.Range(0, 3000).Select(i => ((string?)("value " + i + new string('x', 200)), (long)i, true))]);
            var (refused, refusedResult, _, refusedMessage) = await Run(small, "results.remoteQuery", new JsonObject
            {
                ["queryId"] = Guid.NewGuid().ToString(), ["resultId"] = smallId, ["generation"] = 1, ["kind"] = "distinct", ["column"] = 1
            });
            check(refused == "ok" && refusedResult is { Status: "failed", Error.Code: "TOO_LARGE" } && refusedResult.ResultSets.Count == 0
                && small.Service.Results.Find(smallId)?.IsRemote == true && small.Service.Results.Find(smallId + 1) is null,
                $"a value list too large for the store is refused whole: {refused} {refusedMessage} {refusedResult?.Status} {refusedResult?.Error?.Code} {refusedResult?.ResultSets.Count}");
            // ...and stops only itself: the result sorts in BigQuery after it, its budget not stopped.
            var (after, afterResult, _, afterMessage) = await Run(small, "results.remoteQuery", View(smallId, sort: [Key(0)]));
            check(after == "ok" && afterResult?.Status == "completed" && small.Service.Results.Find(smallId)!.Budget.Stopped == TruncationReason.None,
                $"a refused value list leaves its result's budget running: {after} {afterMessage} {afterResult?.Status} {afterResult?.Error?.Code}");
        }
    }

    static async Task RemoteViewRefusalsAsync(Action<bool, string> check)
    {
        var (harness, id) = await WindowedAsync();
        using var _ = harness;
        var inserts = harness.Jobs.InsertedIds.Count;
        async Task<string> Refused(JsonObject request) => (await Run(harness, "results.remoteQuery", request)).Code;
        var empty = await Refused(View(id));
        var tooMany = await Refused(View(id, sort: [.. Enumerable.Range(0, 17).Select(i => (JsonNode)Key(0))]));
        var twice = await Refused(View(id, sort: [Key(0), Key(0, true)]));
        var outside = await Refused(View(id, sort: [Key(5)]));
        var keepRows = await Refused(View(id, filters: [new JsonObject { ["op"] = "keepRows", ["column"] = 0, ["rows"] = new JsonArray(1) }]));
        var noList = await Refused(View(id, filters: [new JsonObject { ["op"] = "in", ["column"] = 1, ["rows"] = new JsonArray(1) }]));
        var notAList = await Refused(View(id, filters: [new JsonObject { ["op"] = "in", ["column"] = 1, ["list"] = id, ["rows"] = new JsonArray(1) }]));
        var load = await Refused(new JsonObject { ["queryId"] = Guid.NewGuid().ToString(), ["resultId"] = id, ["generation"] = 1, ["kind"] = "load", ["sort"] = new JsonArray(Key(0)) });
        var kind = await Refused(new JsonObject { ["queryId"] = Guid.NewGuid().ToString(), ["resultId"] = id, ["generation"] = 1, ["kind"] = "sample" });
        check(empty == "INVALID_PARAMS" && tooMany == "INVALID_PARAMS" && twice == "INVALID_PARAMS" && outside == "INVALID_PARAMS" && keepRows == "INVALID_PARAMS" && noList == "INVALID_PARAMS"
            && notAList == "INVALID_PARAMS" && load == "INVALID_PARAMS" && kind == "INVALID_PARAMS" && harness.Jobs.InsertedIds.Count == inserts,
            $"a malformed remote view is refused before any job: {empty} {tooMany} {twice} {outside} {keepRows} {noList} {notAList} {load} {kind}");
        // A value list's rows are its own, and only its column's.
        ValueListRows(harness, ("a", 1, true), ("b", 2, true));
        var (_, made, _, _) = await Run(harness, "results.remoteQuery", new JsonObject { ["queryId"] = Guid.NewGuid().ToString(), ["resultId"] = id, ["generation"] = 1, ["kind"] = "distinct", ["column"] = 1 });
        if (made?.ResultSets.SingleOrDefault() is not { } madeList) { check(false, "a value list to refuse filters against: " + made?.Status + " " + made?.Error?.Message); return; }
        var listId = madeList.ResultId;
        inserts = harness.Jobs.InsertedIds.Count;
        var pastEnd = await Refused(View(id, filters: [new JsonObject { ["op"] = "in", ["column"] = 1, ["list"] = listId, ["rows"] = new JsonArray(2) }]));
        var otherColumn = await Refused(View(id, filters: [new JsonObject { ["op"] = "in", ["column"] = 0, ["list"] = listId, ["rows"] = new JsonArray(0) }]));
        var closedSnapshot = await Refused(View(id, filters: [new JsonObject { ["op"] = "groups", ["column"] = 1, ["list"] = listId, ["snapshotId"] = 99 }]));
        await harness.Call("results.close", new JsonObject { ["resultIds"] = new JsonArray(listId) });
        var closedList = await Refused(View(id, filters: [new JsonObject { ["op"] = "in", ["column"] = 1, ["list"] = listId, ["rows"] = new JsonArray(0) }]));
        check(pastEnd == "INVALID_PARAMS" && otherColumn == "INVALID_PARAMS" && closedSnapshot == "VIEW_NOT_FOUND" && closedList == "VIEW_NOT_FOUND" && harness.Jobs.InsertedIds.Count == inserts,
            $"a filter's value list must hold its rows, be its column's and still be open: {pastEnd} {otherColumn} {closedSnapshot} {closedList}");
        // An ARRAY or JSON column cannot be sorted or listed in BigQuery, and says so.
        {
            using var typed = new Harness(new Jobs { Schema = Schema(Field("tags", "STRING", "REPEATED"), Field("j", "JSON")), Rows = [.. Enumerable.Range(0, 3000).Select(i => Row(new JsonArray(), "{}"))], Destination = Destination },
                new ResultStore(4L << 20, 32 * 1024));
            await typed.ConnectAsync();
            var (_, executed, _) = await typed.Execute("SELECT tags, j FROM t", Windowed);
            var typedId = executed!.ResultSets.Single().ResultId;
            var (array, _, _, arrayMessage) = await Run(typed, "results.remoteQuery", View(typedId, sort: [Key(0)]));
            var (json, _, _, _) = await Run(typed, "results.remoteQuery", new JsonObject { ["queryId"] = Guid.NewGuid().ToString(), ["resultId"] = typedId, ["generation"] = 1, ["kind"] = "distinct", ["column"] = 1 });
            check(array == "INVALID_PARAMS" && arrayMessage.Contains("ARRAY<STRING>", StringComparison.Ordinal) && json == "INVALID_PARAMS", $"ARRAY and JSON columns are refused with why: {array} {arrayMessage} {json}");
        }
        // Only a windowed result: one in memory sorts in the grid.
        {
            using var memory = new Harness(Lines(20));
            await memory.ConnectAsync();
            var (_, executed, _) = await memory.Execute("SELECT n, s FROM t");
            var (code, _, _, _) = await Run(memory, "results.remoteQuery", View(executed!.ResultSets.Single().ResultId, sort: [Key(0)]));
            check(code == "INVALID_PARAMS", "a remote view of a result in memory is refused: " + code);
        }
    }

    static JsonObject DryRun(Harness harness, uint id, string kind = "view") => new()
    {
        ["connectionId"] = harness.ConnectionId,
        ["remote"] = new JsonObject { ["resultId"] = id, ["generation"] = 1, ["kind"] = kind, ["sort"] = new JsonArray(Key(0)) }
    };

    static async Task RemoteExpiryAsync(Action<bool, string> check)
    {
        // A result table that expired answers REMOTE_EXPIRED for a query the scanner cannot run again ...
        {
            var harness = new Harness(Lines(3000), new ResultStore(4L << 20, 32 * 1024));
            using var _ = harness;
            await harness.ConnectAsync();
            var (_, executed, _) = await harness.Execute("SELECT n, s, CURRENT_TIMESTAMP() FROM t");
            var id = executed!.ResultSets.Single().ResultId;
            harness.Jobs.TableDataStatus = 404;
            var (dry, _, dryMessage) = await harness.Call("bigquery.dryRun", DryRun(harness, id));
            harness.Jobs.Failure = new JsonObject { ["reason"] = "notFound", ["message"] = "Not found: Table varia-emulator:_anon0123.anon_result_1 was not found in location US" };
            var (code, result, _, message) = await Run(harness, "results.remoteQuery", View(id, sort: [Key(0)]));
            check(dry == "REMOTE_EXPIRED" && code == "ok" && result is { Status: "failed", Error.Code: "REMOTE_EXPIRED" } && result.ResultSets.Count == 0,
                $"an expired result table answers REMOTE_EXPIRED when its query cannot run again: {dry} {dryMessage} {code} {message} {result?.Status} {result?.Error?.Code}");
            var refusedFallback = View(id, sort: [Key(0)]);
            refusedFallback["fallback"] = true;
            var (fallback, _, _, _) = await Run(harness, "results.remoteQuery", refusedFallback);
            check(fallback == "REMOTE_EXPIRED", "a fallback is refused for a non-deterministic query: " + fallback);
        }
        // ... and estimates and runs the original query again for one it can (emulator mode has no sessions).
        {
            var (harness, id) = await WindowedAsync();
            using var _ = harness;
            harness.Jobs.TableDataStatus = 404;
            var (dry, estimate, dryMessage) = await harness.Call("bigquery.dryRun", DryRun(harness, id));
            check(dry == "ok" && estimate is BigQueryDryRunResult { Fallback: true, Faked: true }, $"a remote estimate says when it runs the original query again: {dry} {dryMessage} {estimate}");
            harness.Jobs.TableDataStatus = 0;
            var request = View(id, sort: [Key(0, descending: true)]);
            request["fallback"] = true;
            var (code, result, _, message) = await Run(harness, "results.remoteQuery", request);
            var query = harness.Jobs.InsertBodies.Last()["configuration"]!["query"]!;
            check(code == "ok" && result?.Status == "completed" && InsertedSql(harness) == "SELECT * FROM (SELECT n, s FROM t\n) ORDER BY `n` DESC NULLS LAST"
                && query["defaultDataset"]?["datasetId"]?.GetValue<string>() == "varia_fixture" && Says(result, "the original query runs again"),
                $"a fallback wraps the original query in its default dataset and says so: {code} {message} {InsertedSql(harness)} {query.ToJsonString()}");
        }
        // The estimate of a remote view: free, through the dry run (faked by the emulator), and checked like the run.
        {
            var (harness, id) = await WindowedAsync();
            using var _ = harness;
            var (dry, estimate, dryMessage) = await harness.Call("bigquery.dryRun", DryRun(harness, id));
            var mixed = DryRun(harness, id);
            mixed["sql"] = "SELECT 1";
            var (both, _, _) = await harness.Call("bigquery.dryRun", mixed);
            var (badKind, _, _) = await harness.Call("bigquery.dryRun", DryRun(harness, id, kind: "load"));
            check(dry == "ok" && estimate is BigQueryDryRunResult { Faked: true, Fallback: null } && both == "INVALID_PARAMS" && badKind == "INVALID_PARAMS" && harness.Jobs.InsertedIds.Count == 1,
                $"a remote estimate runs no job and is checked like the query: {dry} {dryMessage} {estimate} {both} {badKind}");
            // A request the backend refuses asks nothing of BigQuery: not even the free probe of its table.
            var reads = harness.Jobs.TableReads.Count;
            var badColumn = DryRun(harness, id);
            badColumn["remote"]!["sort"] = new JsonArray(Key(99));
            var (refused, _, _) = await harness.Call("bigquery.dryRun", badColumn);
            check(refused == "INVALID_PARAMS" && harness.Jobs.TableReads.Count == reads, $"a refused remote estimate probes no table: {refused} {harness.Jobs.TableReads.Count - reads}");
        }
        // A view that names no value list never blames one for a missing table: BigQuery's own words stand.
        {
            var (harness, id) = await WindowedAsync();
            using var _ = harness;
            harness.Jobs.Failure = new JsonObject { ["reason"] = "notFound", ["message"] = "Not found: Table varia-emulator:other.missing was not found in location US" };
            var (_, result, _, _) = await Run(harness, "results.remoteQuery", View(id, sort: [Key(0)]));
            check(result is { Status: "failed" } && result.Error?.Message.Contains("value list", StringComparison.Ordinal) == false && result.Error.Code != "REMOTE_EXPIRED",
                $"a missing table is no value list's when the view names none: {result?.Error?.Code} {result?.Error?.Message}");
        }
        // ... nor one whose filter names a list but no values, so reads none.
        {
            var (harness, id) = await WindowedAsync();
            using var _ = harness;
            harness.Jobs.Failure = new JsonObject { ["reason"] = "notFound", ["message"] = "Not found: Table varia-emulator:other.missing was not found in location US" };
            var unread = new JsonArray(new JsonObject { ["op"] = "in", ["column"] = 0, ["list"] = 999_999, ["rows"] = new JsonArray(), ["nulls"] = true });
            var (_, result, _, _) = await Run(harness, "results.remoteQuery", View(id, filters: unread));
            check(result is { Status: "failed" } && result.Error?.Message.Contains("value list", StringComparison.Ordinal) == false && result.Error.Code != "REMOTE_EXPIRED",
                $"a missing table is no value list's when the view's list filter reads none: {result?.Error?.Code} {result?.Error?.Message}");
        }
        // An ORDER BY BigQuery had no resources for says to filter first.
        {
            var (harness, id) = await WindowedAsync();
            using var _ = harness;
            harness.Jobs.Failure = new JsonObject { ["reason"] = "resourcesExceeded", ["message"] = "Resources exceeded during query execution." };
            var (_, result, _, _) = await Run(harness, "results.remoteQuery", View(id, sort: [Key(0)]));
            check(result is { Status: "failed" } && result.Error?.Message.Contains("Filter the result first", StringComparison.Ordinal) == true,
                "a sort BigQuery had no resources for suggests filtering first: " + result?.Error?.Message);
        }
    }

    static async Task RemoteViewStopsAsync(Action<bool, string> check)
    {
        // Stop cancels the job; the source's release does too, and no derived result is left.
        foreach (var release in new[] { false, true })
        {
            var (harness, id) = await WindowedAsync();
            using var _ = harness;
            harness.Jobs.Polling = new(TaskCreationOptions.RunContinuationsAsynchronously);
            harness.Jobs.Hang = true;
            var queryId = Guid.NewGuid().ToString();
            var running = Run(harness, "results.remoteQuery", View(id, sort: [Key(0)], queryId: queryId));
            var held = await Task.WhenAny(harness.Jobs.Polling.Task, Task.Delay(15_000)) == harness.Jobs.Polling.Task;
            if (release) await harness.Call("results.close", new JsonObject { ["resultIds"] = new JsonArray(id) });
            else await harness.Call("query.cancel", new JsonObject { ["queryId"] = queryId });
            var (code, result, _, message) = await running;
            var job = harness.Jobs.InsertedIds.Last();
            // jobs.cancel goes out best-effort, after the run answers.
            var cancelled = await BigQuerySessionChecks.Poll(() => harness.Jobs.Cancels.Contains(job));
            check(held && code == "ok" && result?.Status == (release ? "failed" : "cancelled") && (!release || result?.Error?.Code == "RESULT_RELEASED") && result?.ResultSets.Count == 0
                && cancelled && harness.Service.Results.Find(id + 1) is null,
                $"{(release ? "closing the source" : "Stop")} cancels a remote view's job and keeps no result: {held} {code} {message} {result?.Status} {result?.Error?.Code} {string.Join(",", harness.Jobs.Cancels)}");
        }
    }
}
