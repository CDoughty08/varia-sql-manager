using Microsoft.Data.SqlClient;
using Varia.Backend.Activity;
using Varia.Backend.Explorer;
using Varia.Backend.Live;

namespace Varia.Backend.Tests;

/// <summary>Offline checks of the Activity Monitor's resources probe (Resource Waits and Data File I/O): per-type wait deltas
/// over the sample clock, no rate on a first sample, after a reset (restart, pause, reconnect) or cleared statistics, types
/// new since the last sample counted from zero, the roll-up to categories (Unknown kept, benign names in Idle), Hide benign
/// waits, the 1-minute mean, the wait.* series, file deltas and latencies, names that fall back to ids, row tones by the
/// filter's thresholds and Data File I/O's chips; and the reader end to end (its statements' parameters, its tables and series).
/// Results are built by hand, as the statements return them.</summary>
internal static class ActivityResourceChecks
{
    private static readonly ActivityCatalog Catalog = ActivityCatalog.Current;
    private static readonly LiveProbeJson Spec = LiveCatalog.Current.Probes[ActivityReader.ResourcesProbe];
    private static readonly string[] Series = [.. Spec.Series.Select(series => series.Id)];

    public static void Run(Action<bool, string> check)
    {
        Waits(check);
        Categories(check);
        Files(check);
        Reader(check);
    }

    private static ActivityStatement Statement(string id) => ActivitySql.Statements(ActivityReader.ResourcesProbe, new(17, "box")).Single(statement => statement.Id == id);

    private static ActivityResult Result(ActivityStatement statement, IEnumerable<Dictionary<string, object?>> rows) =>
        new(statement.Columns, [.. rows.Select(row => statement.Columns.Select(column => row.GetValueOrDefault(column)).ToArray())]);

    /// <summary>A sys.dm_os_wait_stats row.</summary>
    private static Dictionary<string, object?> Wait(string type, long tasks, long waitMs, long signalMs = 0, long maxMs = 0) => new()
    {
        ["wait_type"] = type, ["waiting_tasks_count"] = tasks, ["wait_time_ms"] = waitMs, ["signal_wait_time_ms"] = signalMs, ["max_wait_time_ms"] = maxMs
    };

    private static Dictionary<string, ActivityResult> WaitResults(IEnumerable<Dictionary<string, object?>> stats, params (string Type, int Waiters)[] waiters) => new()
    {
        ["waitStats"] = Result(Statement("waitStats"), stats),
        ["waiters"] = Result(Statement("waiters"), waiters.Select(waiter => new Dictionary<string, object?> { ["wait_type"] = waiter.Type, ["waiters"] = waiter.Waiters, ["wait_ms"] = 10L, ["max_wait_ms"] = 10L }))
    };

    private static string? Cell(ActivityRowWriter writer, LiveRow row, string column) => writer.Reader(row)(column);
    private static LiveRow? Row(ActivityRowWriter writer, IEnumerable<LiveRow>? rows, string column, string value) => rows?.FirstOrDefault(row => Cell(writer, row, column) == value);
    private static double? SeriesOf(ActivityResourcesSample sample, string id) => sample.Series[Array.IndexOf(Series, id)];

    private static void Waits(Action<bool, string> check)
    {
        var rows = new ActivityResourceRows(Catalog);
        var types = rows.TypesWriter;
        var first = rows.Build(WaitResults([Wait("LCK_M_X", 10, 1_000, 0, 400), Wait("SOS_SCHEDULER_YIELD", 100, 2_000, 2_000)], ("LCK_M_X", 2)), 10_000, Series, 20, 50);
        var firstLock = Row(types, first.Types, "waitType", "LCK_M_X");
        check(first.Types is { Count: 2 } && firstLock is not null && Cell(types, firstLock, "waitRate") is null && Cell(types, firstLock, "cumulativeSeconds") == "1.000"
            && Cell(types, firstLock, "currentWaiters") == "2" && Cell(types, firstLock, "maxWaitMs") == "400" && first.Series.All(value => value is null),
            "a first resources sample has no rate (blank rates, null series) and shows every type with time since SQL Server started, with its waiters and cumulative time");

        // Five seconds on the sample clock: LCK_M_X waited 5,000 ms (500 of it signal) over 10 waits; a type new since counts from zero.
        var second = rows.Build(WaitResults([Wait("LCK_M_X", 20, 6_000, 500, 900), Wait("SOS_SCHEDULER_YIELD", 100, 2_000, 2_000), Wait("PAGEIOLATCH_SH", 5, 2_500)]), 15_000, Series, 20, 50);
        var locks = Row(types, second.Types, "waitType", "LCK_M_X");
        var io = Row(types, second.Types, "waitType", "PAGEIOLATCH_SH");
        check(locks is not null && Cell(types, locks, "waitRate") == "900.0" && Cell(types, locks, "signalRate") == "100.0" && Cell(types, locks, "waitsRate") == "2.0"
            && Cell(types, locks, "averageWaitMs") == "500.0" && Cell(types, locks, "currentWaiters") == "0" && Cell(types, locks, "category") == "Lock"
            && io is not null && Cell(types, io, "waitRate") == "500.0",
            "wait rates are per type over the sample clock: wait less signal, signal and waits per second, and wait per wait; a type new since the last sample counts from zero");
        check(second.Types!.Count == 2 && Row(types, second.Types, "waitType", "SOS_SCHEDULER_YIELD") is null && Cell(types, second.Types[0], "waitType") == "LCK_M_X",
            "with a rate, wait types show only those with time in the interval or a waiter now, largest first");
        check(SeriesOf(second, "wait.lock") == 900 && SeriesOf(second, "wait.bufferIo") == 500 && SeriesOf(second, "wait.signal") == 100 && SeriesOf(second, "wait.cpu") == 0,
            "the wait.<category> series are each category's wait less signal per second, and wait.signal every type's signal wait per second");

        // DBCC SQLPERF cleared the statistics: counters went down, so this sample has no rate at all; the next one does again.
        var cleared = rows.Build(WaitResults([Wait("LCK_M_X", 1, 100), Wait("PAGEIOLATCH_SH", 5, 2_600)]), 20_000, Series, 20, 50);
        var after = rows.Build(WaitResults([Wait("LCK_M_X", 2, 600), Wait("PAGEIOLATCH_SH", 5, 2_600)]), 25_000, Series, 20, 50);
        check(cleared.Types!.All(row => Cell(types, row, "waitRate") is null) && cleared.Series.All(value => value is null)
            && Cell(types, Row(types, after.Types, "waitType", "LCK_M_X")!, "waitRate") == "100.0",
            "cleared wait statistics (a counter that went down) give that sample no rate, never a negative or partial one, and the next sample rates from the new baseline");

        // A restart, a resume or a lost connection resets the rows: the next sample is a baseline.
        rows.Reset();
        var restarted = rows.Build(WaitResults([Wait("LCK_M_X", 50, 90_000)]), 30_000, Series, 20, 50);
        check(restarted.Types!.All(row => Cell(types, row, "waitRate") is null) && restarted.Series.All(value => value is null),
            "after a restart (or a resume, or a reconnect) the resources probe has no rate until it has a new baseline");

        // A sample whose wait statements failed leaves the baseline alone: the next rate spans its own time.
        var missed = rows.Build(new Dictionary<string, ActivityResult>(), 35_000, Series, 20, 50);
        var spanned = rows.Build(WaitResults([Wait("LCK_M_X", 50, 100_000)]), 40_000, Series, 20, 50);
        check(missed.Types is null && missed.Categories is null && Cell(types, spanned.Types!.Single(), "waitRate") == "1000.0",
            "a sample without the wait statistics sends no wait tables, and the next rate spans the ten seconds since the last one read, never two intervals over one");

        // The waiters statement failed alone: rates still arrive, and current waiters are unknown (blank), not none.
        var noWaiters = rows.Build(new Dictionary<string, ActivityResult> { ["waitStats"] = Result(Statement("waitStats"), [Wait("LCK_M_X", 60, 105_000)]) }, 45_000, Series, 20, 50);
        var onlyWaiters = rows.Build(new Dictionary<string, ActivityResult> { ["waiters"] = WaitResults([], ("LCK_M_X", 3))["waiters"] }, 50_000, Series, 20, 50);
        var lockType = noWaiters.Types!.Single();
        var lockCategory = Row(rows.CategoriesWriter, noWaiters.Categories, "categoryId", "lock")!;
        check(Cell(types, lockType, "waitRate") == "1000.0" && Cell(types, lockType, "currentWaiters") is null && Cell(rows.CategoriesWriter, lockCategory, "currentWaiters") is null
            && onlyWaiters.Types is null && onlyWaiters.Categories is null && onlyWaiters.Series.All(value => value is null),
            "without the waiters statement wait rates still arrive with current waiters blank; without the wait statistics no wait table or series is sent, waiters alone giving no rate");
    }

    private static void Categories(Action<bool, string> check)
    {
        var rows = new ActivityResourceRows(Catalog);
        var categories = rows.CategoriesWriter;
        var types = rows.TypesWriter;
        rows.Build(WaitResults([Wait("LCK_M_S", 1, 0), Wait("LCK_M_X", 1, 0), Wait("MADE_UP_WAIT", 1, 0), Wait("SOS_WORK_DISPATCHER", 1, 0), Wait("SLEEP_TASK", 1, 0)]), 0, Series, 20, 50);
        var sample = rows.Build(WaitResults([Wait("LCK_M_S", 3, 2_000), Wait("LCK_M_X", 3, 8_000, 1_000), Wait("MADE_UP_WAIT", 2, 4_000), Wait("SOS_WORK_DISPATCHER", 9, 90_000), Wait("SLEEP_TASK", 9, 30_000)],
            ("LCK_M_X", 2), ("LCK_M_S", 1), ("MADE_UP_WAIT", 1)), 10_000, Series, 20, 50);
        var lockRow = Row(categories, sample.Categories, "categoryId", "lock");
        var unknown = Row(categories, sample.Categories, "categoryId", "unknown");
        var idle = Row(categories, sample.Categories, "categoryId", "idle");
        check(lockRow is not null && Cell(categories, lockRow, "category") == "Lock" && Cell(categories, lockRow, "waitRate") == "900.0" && Cell(categories, lockRow, "signalRate") == "100.0"
            && Cell(categories, lockRow, "averageWaiters") == "0.900" && Cell(categories, lockRow, "currentWaiters") == "3" && Cell(categories, lockRow, "topWaitType") == "LCK_M_X"
            && Cell(categories, lockRow, "cumulativeSeconds") == "9.000",
            "wait types roll up to their category: rates, average waiters (rate / 1,000), waiters now, cumulative time and the largest type in the interval");
        check(unknown is not null && Cell(categories, unknown, "category") == "Unknown" && Cell(categories, unknown, "waitRate") == "400.0"
            && Cell(types, Row(types, sample.Types, "waitType", "MADE_UP_WAIT")!, "category") == "Unknown" && !sample.Benign.Contains(unknown),
            "a wait type the catalogue does not know is counted in Unknown, shown and never dropped, and is not benign");
        var dispatcher = Row(types, sample.Types, "waitType", "SOS_WORK_DISPATCHER")!;
        check(idle is not null && sample.Benign.Contains(idle) && sample.Benign.Contains(dispatcher) && Cell(types, dispatcher, "benign") == "1" && Cell(types, dispatcher, "category") == "Idle"
            && sample.Categories!.Count == 3 && Row(categories, sample.Categories, "categoryId", "cpu") is null,
            "benign names (SOS_WORK_DISPATCHER) and Idle's own types (SLEEP_%) count in Idle and are marked benign; categories that never waited are left out");

        var hide = ActivityFilter.Compile(Catalog, new("waitCategories"));
        var show = ActivityFilter.Compile(Catalog, new("waitTypes", HideBenign: false));
        check(!hide.Matches(categories.Reader(idle!), benign: true) && hide.Matches(categories.Reader(lockRow!), benign: false) && show.Matches(types.Reader(dispatcher), benign: true),
            "Hide benign waits (on by default) leaves out the Idle category and benign types; turned off it shows them");

        // The 1-Minute Average: wait time over the time the samples of the last minute span.
        var later = rows.Build(WaitResults([Wait("LCK_M_S", 3, 2_000), Wait("LCK_M_X", 3, 11_000, 1_000), Wait("MADE_UP_WAIT", 2, 4_000)]), 40_000, Series, 20, 50);
        var latest = Row(categories, later.Categories, "categoryId", "lock")!;
        var gone = rows.Build(WaitResults([Wait("LCK_M_S", 3, 2_000), Wait("LCK_M_X", 3, 11_000, 1_000)]), 80_000, Series, 20, 50);
        check(Cell(categories, latest, "waitRate") == "100.0" && Cell(categories, latest, "minuteAverage") == "300.0"
            && Cell(categories, Row(categories, gone.Categories, "categoryId", "lock")!, "minuteAverage") == "33.3",
            "the 1-Minute Average weighs each sample by its span (12,000 ms over 40 s is 300 ms/s), drops samples that ended a minute or more ago, and counts a sample "
            + "that began before the minute only for its part inside it (2,000 of 3,000 ms over 60 s)");
    }

    /// <summary>A sys.dm_io_virtual_file_stats row (with names unless hidden).</summary>
    private static Dictionary<string, object?> File(int database, int file, long reads, long readStall, long writes = 0, long writeStall = 0, string? type = "ROWS", bool named = true) => new()
    {
        ["database_id"] = database, ["file_id"] = file, ["num_of_reads"] = reads, ["num_of_bytes_read"] = reads * 65_536, ["io_stall_read_ms"] = readStall,
        ["num_of_writes"] = writes, ["num_of_bytes_written"] = writes * 8_192, ["io_stall_write_ms"] = writeStall, ["io_stall_queued_read_ms"] = 0L, ["io_stall_queued_write_ms"] = 0L,
        ["size_on_disk_bytes"] = 8L * 1024 * 1024, ["type_desc"] = named ? type : null, ["file_name"] = named ? "data" + file : null,
        ["physical_name"] = named ? "/var/opt/mssql/data/db" + database + "_" + file + ".mdf" : null, ["database_name"] = named ? "db" + database : null
    };

    private static Dictionary<string, ActivityResult> FileResults(params Dictionary<string, object?>[] files) => new() { ["files"] = Result(Statement("files"), files) };

    private static void Files(Action<bool, string> check)
    {
        var rows = new ActivityResourceRows(Catalog);
        var files = rows.FilesWriter;
        var tone = files.Count - 1;
        var first = rows.Build(FileResults(File(5, 1, 100, 1_000), File(5, 2, 0, 0, 100, 100, "LOG"), File(7, 2, 10, 0, named: false)), 0, Series, 20, 50);
        var hidden = Row(files, first.Files, "databaseId", "7")!;
        check(first.Files is { Count: 3 } && first.Files.All(row => Cell(files, row, "readMbRate") is null && row.Cells[tone].Text is null)
            && Cell(files, hidden, "database") == "database 7" && Cell(files, hidden, "file") == "file 2" && Cell(files, hidden, "type") is null && Cell(files, hidden, "sizeMb") == "8.00"
            && files.Count == Spec.Tables[2].Columns.Count && Spec.Tables[2].Columns[^1].Role == "tone",
            "a first file sample has no rates and no tone; without VIEW ANY DEFINITION a file shows as \"database 7\" and \"file 2\"; rows end with the live table's tone column");

        // Ten seconds: file 5/1 read 100 times at 30 ms each, the log wrote 1,000 times at 60 ms each, 7/2 read at 2 ms.
        var second = rows.Build(FileResults(File(5, 1, 200, 4_000), File(5, 2, 0, 0, 1_100, 60_100, "LOG"), File(7, 2, 20, 20, named: false)), 10_000, Series, 20, 50);
        var data = Row(files, second.Files, "fileId", "1")!;
        var log = Row(files, second.Files, "type", "Log")!;
        var quiet = Row(files, second.Files, "databaseId", "7")!;
        check(Cell(files, data, "readsRate") == "10.0" && Cell(files, data, "readMbRate") == "0.625" && Cell(files, data, "readLatencyMs") == "30.0" && Cell(files, data, "writeLatencyMs") is null
            && Cell(files, data, "responseTimeMs") == "30.0" && Cell(files, data, "database") == "db5" && Cell(files, data, "type") == "Rows" && Cell(files, log, "writeLatencyMs") == "60.0"
            && Cell(files, log, "writesRate") == "100.0" && Cell(files, log, "totalMbRate") == "0.781",
            "file rates are per file over the sample clock: MB and I/Os per second, and read, write and response latency as stall per I/O in the interval (blank with none)");
        check(data.Cells[tone].Text == "warning" && log.Cells[tone].Text == "error" && quiet.Cells[tone].Text is null,
            "a file is toned warning when its read or write latency reaches the warning threshold, error from the error threshold");

        var all = ActivityFilter.Compile(Catalog, new("files"));
        var logs = ActivityFilter.Compile(Catalog, new("files", FileView: "log"));
        var dataFiles = ActivityFilter.Compile(Catalog, new("files", FileView: "rows"));
        var over = ActivityFilter.Compile(Catalog, new("files", FileView: "overThreshold"));
        int Shown(ActivityFilter filter) => second.Files!.Count(row => filter.Matches(files.Reader(row), file: second.FileFacts[row]));
        check(all.LatencyWarningMs == 20 && all.LatencyErrorMs == 50 && Shown(all) == 3 && Shown(logs) == 1 && Shown(dataFiles) == 1 && Shown(over) == 2,
            "Data File I/O's chips show every file, data files, log files, or files over the warning threshold (the catalogue's 20 and 50 ms by default)");

        // The settings' thresholds travel in the files filter.
        var custom = ActivityFilter.Compile(Catalog, new("files", LatencyWarningMs: 40, LatencyErrorMs: 100));
        var third = rows.Build(FileResults(File(5, 1, 300, 7_000), File(5, 2, 0, 0, 1_200, 66_100, "LOG"), File(7, 2, 30, 40, named: false)), 20_000, Series, custom.LatencyWarningMs, custom.LatencyErrorMs);
        check(Row(files, third.Files, "fileId", "1")!.Cells[tone].Text is null && Row(files, third.Files, "type", "Log")!.Cells[tone].Text == "warning",
            "the files filter's latency thresholds (the activityMonitor.fileLatency* settings) tone the rows in place of the defaults");

        // A database dropped and another made under its id, with lower counters: no rate, never a negative one.
        // The settings are independent: an error threshold below the warning one acts as the warning one, so Over threshold and
        // every tone still start at the warning threshold (log: 60 ms; data: 30 ms).
        var inverted = rows.Build(FileResults(File(5, 1, 400, 10_000), File(5, 2, 0, 0, 1_300, 72_100, "LOG"), File(7, 2, 40, 60, named: false)), 25_000, Series, 50, 10);
        check(Row(files, inverted.Files, "type", "Log")!.Cells[tone].Text == "error" && inverted.FileFacts[Row(files, inverted.Files, "type", "Log")!].OverThreshold
            && Row(files, inverted.Files, "fileId", "1")!.Cells[tone].Text is null && !inverted.FileFacts[Row(files, inverted.Files, "fileId", "1")!].OverThreshold,
            "with an error threshold below the warning one, a file under the warning threshold is neither toned nor over threshold, and one past it is an error");

        var reused = rows.Build(FileResults(File(5, 1, 3, 9)), 30_000, Series, 20, 50);
        check(Cell(files, reused.Files!.Single(), "readsRate") is null && reused.Files!.Single().Cells[tone].Text is null,
            "a file whose counters went down (its database dropped and another made under its id) has no rate");

        static bool Refused(ActivityFilterDto dto)
        {
            try { ActivityFilter.Compile(Catalog, dto); return false; }
            catch (RequestException error) { return error.Code == "INVALID_PARAMS"; }
        }
        check(Refused(new("files", FileView: "big")) && Refused(new("sessions", FileView: "log")) && Refused(new("waitTypes", LatencyWarningMs: 5)) && Refused(new("files", LatencyWarningMs: 0))
            && Refused(new("files", LatencyErrorMs: (int)Catalog.Limit("fileLatencyMs") + 1)) && !Refused(new("files", LatencyErrorMs: (int)Catalog.Limit("fileLatencyMs"))),
            "only Data File I/O takes a file view and latency thresholds, each a known chip and within 1 to 10,000 ms, as zod checks them");
    }

    private static readonly ServerProfile Box = new(17, "17.0.1000.0", 3, "app_user", false, true, false);

    /// <summary>A live host the reader never calls.</summary>
    private sealed class NoHost : ILiveHost
    {
        public bool TestHooks => false;
        public bool IsConnected(string connectionId) => false;
        public string? ServerOf(string connectionId) => null;
        public Varia.Backend.Results.ResultStore Store => throw new NotSupportedException();
        public ServerProfile? Profile(string connectionId) => null;
        public SqlConnection PoolConnection(string connectionId, string? database, string suffix) => throw new NotSupportedException();
        public Task OpenAsync(SqlConnection connection, CancellationToken token) => throw new NotSupportedException();
    }

    private static void Reader(Action<bool, string> check)
    {
        var parameters = new Dictionary<string, object>();
        var ran = new List<string>();
        long ticks = 10_000;
        long lockWait = 1_000;
        long start = 1;
        var reader = new ActivityReader(new NoHost(), "c", new ActivityLiveArgs([new ActivityFilterDto("files", LatencyWarningMs: 200, LatencyErrorMs: 300)]))
        {
            TestRun = (statement, values) =>
            {
                ran.Add(statement.Id);
                foreach (var (name, value) in values) parameters[statement.Id + " " + name] = value;
                IEnumerable<Dictionary<string, object?>> rows = statement.Id switch
                {
                    "capabilities" => [new() { ["spid"] = 99, ["server_state"] = 1, ["alter_any_connection"] = 0, ["view_any_definition"] = 1, ["spills"] = 1 }],
                    "clock" => [new() { ["ms_ticks"] = ticks, ["sqlserver_start_time_ms_ticks"] = start }],
                    "waitStats" => [Wait("LCK_M_X", 10, lockWait), Wait("SOS_WORK_DISPATCHER", 10, lockWait * 10)],
                    "waiters" => [],
                    "files" => [File(1, 1, ticks / 100, ticks)],
                    _ => []
                };
                return Task.FromResult(Result(statement, rows));
            }
        };
        check(reader.Unavailable(Spec, Box) is null, "the resources probe opens on a box server: no catalogue entry holds it back any more");
        var connection = new SqlConnection();
        reader.SessionAsync(connection, "", "VIEW SERVER PERFORMANCE STATE", CancellationToken.None).GetAwaiter().GetResult();
        LiveReaderSample Read(string? gap) =>
            reader.ReadAsync(connection, "", new LiveDue(new LiveProbeState(Spec, 5_000), gap, null, null, null, new Dictionary<int, LiveTrackArgs>(), TakenAt: ticks), null, CancellationToken.None).GetAwaiter().GetResult();
        var baseline = Read("baseline");
        (ticks, lockWait) = (15_000, 6_000);
        var next = Read(null);
        var lockSeries = Array.IndexOf(Series, "wait.lock");
        var idleSeries = Array.IndexOf(Series, "wait.idle");
        var tables = next.Tables.Select(table => Spec.Tables[table.Table].Id).ToList();
        var categories = next.Tables.Single(table => Spec.Tables[table.Table].Id == "waitCategories");
        var fileRow = next.Tables.Single(table => Spec.Tables[table.Table].Id == "files").Rows.Single();
        check(ran.SequenceEqual(["capabilities", "clock", "waitStats", "waiters", "files", "clock", "waitStats", "waiters", "files"]) && parameters["files @rowCap"] is int cap && cap == Catalog.Limit("files") + 1,
            "the resources probe runs its four statements in order, the files statement reading one row past Data File I/O's cap");
        check(baseline.Raw!.Values.All(value => value is null) && next.Raw is { MsTicks: 15_000, StartTicks: 1 } raw && raw.Values[lockSeries] == 1_000 && raw.Values[idleSeries] == 10_000
            && tables.SequenceEqual(["waitCategories", "waitTypes", "files"]) && next.Errors.Count == 0,
            "the reader sends the wait series (null on its baseline) with the server's clock, and the three tables");
        check(categories.View is { } view && categories.Rows.Count(view) == 1 && categories.FacetScope is not null && fileRow.Cells[^1].Text is null,
            "the reader applies Hide benign waits by default (Idle hidden), and tones rows by the files filter's thresholds, not the defaults (100 ms is under a 200 ms warning)");
        // A restart (new start ticks) and a resume restart the resources rows through the reader, even with counters still rising:
        // the 1-Minute Average then holds only the newest interval (2,000 ms/s), not the 1,000 ms/s ones from before.
        (ticks, lockWait, start) = (20_000, 11_000, 2);
        var restarted = Read(null);
        (ticks, lockWait) = (25_000, 16_000);
        var resumed = Read("resumed");
        (ticks, lockWait) = (30_000, 26_000);
        var after = Read(null);
        var writer = new ActivityResourceRows(Catalog).CategoriesWriter;
        var lockRow = after.Tables.Single(table => Spec.Tables[table.Table].Id == "waitCategories").Rows.FirstOrDefault(row => Cell(writer, row, "categoryId") == "lock");
        check(restarted.Raw!.Values.All(value => value is null) && resumed.Raw!.Values.All(value => value is null) && after.Raw!.Values[lockSeries] == 2_000
            && lockRow is not null && Cell(writer, lockRow, "minuteAverage") == "2000.0",
            "a restart or a resume gives the resources probe a fresh baseline and an empty 1-Minute Average though no counter fell, and the next sample rates again");
    }
}
