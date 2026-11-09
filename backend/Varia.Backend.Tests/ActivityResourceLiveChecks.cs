using System.Text.Json;
using Varia.Backend.Actions;
using Varia.Backend.Activity;
using Varia.Backend.Live;
using Varia.Backend.Protocol;

namespace Varia.Backend.Tests;

/// <summary>Live checks of the Activity Monitor's resources probe (VARIA_TEST_SQL_SERVER), through LiveService as main drives
/// it: two samples of Resource Waits and Data File I/O, the first without a rate and the second with one, a WAITFOR run between
/// them counted in User Wait, every wait type the server reports classified (Unknown ones shown), and master's data and log
/// files with names, sizes and a tone column. Creates nothing.</summary>
internal static class ActivityResourceLiveChecks
{
    private static uint next = 9800;

    public static async Task RunAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, JsonSerializerOptions json)
    {
        var profile = ((IActionHost)service).Profile(info.Id);
        if (ActivitySql.BandOf(profile.Major, profile.EngineEdition, profile.CatalogBand) is null)
        {
            Console.WriteLine("Activity Monitor resources live checks skipped: the server is not one the monitor serves yet.");
            return;
        }
        var spec = LiveCatalog.Current.Probes[ActivityReader.ResourcesProbe];
        var series = spec.Series.Select(entry => entry.Id).ToList();
        using var recorder = new LiveRecorder(Interlocked.Increment(ref next));
        // Hide benign waits off, so Idle shows too.
        var args = new { filters = new object[] { new { table = "waitCategories", hideBenign = false } } };
        var subscription = service.Live.SubscribeAsync(new LiveSubscribeArgs(Guid.NewGuid().ToString(), info.Id, "activity", [new LiveProbeArgs(ActivityReader.ResourcesProbe, 5_000)],
            JsonSerializer.SerializeToElement(args, json)), recorder.Context, json);
        List<LiveSample> Samples() => [.. recorder.Ticks.SelectMany(tick => tick.Samples).Where(sample => sample.Probe == ActivityReader.ResourcesProbe)];
        try
        {
            var first = await recorder.WaitAsync(_ => Samples().Count >= 1, 30_000);
            // A wait between the two samples: WAITFOR's time is counted when the wait ends, well before the next sample.
            var session = Guid.NewGuid().ToString();
            await service.DispatchAsync("query.execute", JsonSerializer.SerializeToElement(
                new QueryArgs(info.Id, session, "master", "WAITFOR DELAY '00:00:01'; SELECT COUNT(*) FROM sys.objects;", Guid.NewGuid().ToString(), 1000, 60, StopOnError: true), json), json);
            await service.DispatchAsync("query.session.close", JsonSerializer.SerializeToElement(new SessionArgs(session), json), json);
            var userWait = series.IndexOf("wait.userWait");
            var rated = await recorder.WaitAsync(_ => Samples().Skip(1).Any(sample => sample.Metrics?[userWait] > 0), 30_000);
            // Hold the stream (the next sample is 5 s away), then read the newest sample's tables while they stay readable.
            recorder.Acknowledge = false;
            var samples = Samples();
            var latest = samples[^1];
            var errors = recorder.Ticks.SelectMany(tick => tick.Errors ?? []).Select(error => error.Code + " " + error.Message).ToList();
            check(first && recorder.Opened is { Probes: [{ State: "ok" }] } && errors.Count == 0 && samples[0] is { Gap: "baseline" } && samples[0].Metrics!.All(value => value is null)
                && samples.All(sample => sample.Tables?.Select(table => table.Table).Order().SequenceEqual([0, 1, 2]) == true),
                "the resources probe opens and samples Resource Waits (categories and types) and Data File I/O, its first sample without a rate: " + string.Join("; ", errors));
            check(rated && latest.Metrics!.All(value => value is >= 0),
                "a later sample has a rate for every category and the signal wait, never negative, and counts a WAITFOR between samples in User Wait");

            Dictionary<string, string?>[] Rows(string table)
            {
                var index = spec.Tables.FindIndex(entry => entry.Id == table);
                var columns = spec.Tables[index].Columns;
                var snapshot = latest.Tables!.Single(entry => entry.Table == index);
                return [.. LiveResultChecks.RowsOf(service.Live.Store, snapshot.Descriptor).Select(row => columns.Select((column, at) => (column.Id, row[at])).ToDictionary(cell => cell.Id, cell => cell.Item2))];
            }
            var categories = Rows("waitCategories");
            var types = Rows("waitTypes");
            var files = Rows("files");
            var known = ActivityCatalog.Current.WaitLabels.Values.ToHashSet(StringComparer.Ordinal);
            check(categories.Length > 0 && categories.All(row => known.Contains(row["category"]!) && row["waitRate"] is not null && row["cumulativeSeconds"] is not null)
                && categories.Any(row => row["categoryId"] == "idle") && types.Length > 0 && types.All(row => known.Contains(row["typeCategory"]!) && row["typeBenign"] is "0" or "1"),
                "every wait category and type the server reports is classified (Unknown shown, never dropped), with rates and cumulative time, and Idle shows with Hide benign waits off: "
                + categories.Length + " categories, " + types.Length + " types");
            var master = files.Where(row => row["ioDatabaseId"] == "1").ToList();
            check(master.Any(row => row["ioType"] == "Rows") && master.Any(row => row["ioType"] == "Log") && master.All(row => row["ioDatabase"] == "master" && row["ioFileName"] is { Length: > 0 }
                && row["ioSizeMb"] is not null && row["ioReadsRate"] is not null) && files.All(row => row.ContainsKey("ioTone") && row["ioTone"] is null or "warning" or "error"),
                "Data File I/O shows master's data and log files with names, sizes and rates, and each row's tone (none, warning or error)");
        }
        finally
        {
            recorder.Context.Cancel(CancelReason.User);
            await subscription.WaitAsync(TimeSpan.FromSeconds(10));
        }
    }
}
