using System.Data;
using System.Globalization;
using Microsoft.Data.SqlClient;
using Varia.Backend.Actions;
using Varia.Backend.Activity;
using Varia.Backend.Live;

namespace Varia.Backend.Tests;

/// <summary>Live checks of the query statistics probe (Recent Expensive Queries), through the reader on a real connection:
/// a baseline sample, then a parameterized statement run 20 times on another connection (a marker column name makes its plan
/// this run's own), then a sample that ranks it with its executions, rates, text and database, the rows in CPU order. No objects
/// are created; only this run's statement is asserted, so other work on the server does not matter.</summary>
internal static class ActivityQueryLiveChecks
{
    private const int Runs = 20;

    public static async Task RunAsync(Action<bool, string> check, SqlService service, ConnectionInfo info)
    {
        var host = (IActionHost)service;
        var profile = host.Profile(info.Id);
        if (ActivitySql.BandOf(profile.Major, profile.EngineEdition, profile.CatalogBand) is null)
        {
            Console.WriteLine("Activity Monitor query statistics live checks skipped: the server is not one the monitor serves yet.");
            return;
        }
        var spec = LiveCatalog.Current.Probes[ActivityReader.QueriesProbe];
        var reader = new ActivityReader(service, info.Id);
        check(reader.Unavailable(spec, profile) is null, "the query statistics probe runs on the live server");
        await using var monitor = host.Connection(info.Id);
        await host.OpenAsync(monitor, CancellationToken.None);
        var (_, serverState) = await reader.SessionAsync(monitor, ActivitySql.Prologue, profile.Major >= 16 ? "VIEW SERVER PERFORMANCE STATE" : "VIEW SERVER STATE", CancellationToken.None);
        if (!serverState)
        {
            Console.WriteLine("Activity Monitor query statistics live checks skipped: the test login does not read server state.");
            return;
        }
        var clock = System.Diagnostics.Stopwatch.StartNew();
        async Task<LiveReaderSample> Read(string? gap) =>
            await reader.ReadAsync(monitor, ActivitySql.Prologue, new LiveDue(new LiveProbeState(spec, 30_000), gap, null, null, null, new Dictionary<int, LiveTrackArgs>(), TakenAt: clock.ElapsedMilliseconds),
                null, CancellationToken.None);

        var first = await Read("baseline");
        check(first is { Sampled: true, Errors: [] } && first.Tables is [{ Table: 0 }], "a first query statistics sample reads the plan cache's recent statements: "
            + string.Join(",", first.Errors.Select(error => error.Code)));

        var marker = "varia_am5_" + Guid.NewGuid().ToString("N");
        await using (var worker = host.Connection(info.Id))
        {
            await host.OpenAsync(worker, CancellationToken.None);
            for (var run = 0; run < Runs; run++)
            {
                // A parameter makes it one prepared statement, so every run shares one plan and one query_hash; the marker is a column
                // name, since a statement's text (its offsets) leaves out a trailing comment.
                await using var command = new SqlCommand($"SELECT COUNT_BIG(*) AS {marker} FROM sys.all_objects AS o CROSS JOIN sys.all_objects AS p WHERE o.object_id > @n AND p.object_id > @n", worker) { CommandTimeout = 60 };
                command.Parameters.Add(new SqlParameter("@n", SqlDbType.Int) { Value = run });
                await command.ExecuteScalarAsync();
            }
        }

        var second = await Read(null);
        var table = second.Tables.SingleOrDefault();
        var columns = spec.Tables[0].Columns;
        string? Cell(LiveRow row, string column) => row.Cells[columns.FindIndex(entry => entry.Id == column)].Text;
        var rows = table?.Rows ?? [];
        var ours = rows.FindIndex(row => Cell(row, "query")?.Contains(marker, StringComparison.Ordinal) == true);
        var row = ours >= 0 ? rows[ours] : null;
        static double Number(string? text) => text is null ? double.NaN : double.Parse(text, CultureInfo.InvariantCulture);
        check(second is { Sampled: true, Errors: [] } && row is not null && Number(Cell(row, "executionsPerMinute")) > 0 && Number(Cell(row, "cpuRate")) >= 0
            && Number(Cell(row, "rowsPerExecution")) == 1 && Cell(row, "planCount") == "1" && Cell(row, "database") is { Length: > 0 } && Cell(row, "queryHash")?.StartsWith("0x", StringComparison.Ordinal) == true,
            $"the statement run {Runs} times since the first sample is ranked in the next, with its executions per minute, CPU, rows per execution, one plan, its text and database: rank {ours} of {rows.Count}");
        var cpu = rows.Select(entry => Number(Cell(entry, "cpuRate"))).ToList();
        check(cpu.Count > 0 && cpu.Zip(cpu.Skip(1)).All(pair => pair.First >= pair.Second), "the rows arrive most CPU in the window first");
        check(rows.Count <= ActivityCatalog.Current.Limit("shownHashes") && rows.All(entry => Cell(entry, "query") is not ActivityQueryRows.Loading || rows.Count > ActivityCatalog.Current.Limit("textBatch") * ActivityCatalog.Current.Limit("textBatchesPerTick")),
            "at most shownHashes rows, each with its text once the sample's text statements have run");
    }
}
