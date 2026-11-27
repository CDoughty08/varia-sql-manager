using System.Globalization;
using Google.Apis.Bigquery.v2.Data;
using Varia.Backend.Explorer;
using Varia.Backend.Protocol;
using Varia.Backend.Search;
using static Varia.Backend.Tests.BigQueryReloadChecks;

namespace Varia.Backend.Tests;

/// <summary>
/// How fresh the index stays while connected (docs/object-search.md, Freshness), offline: which scripts may change objects
/// (<see cref="TsqlChanges"/>); SQL Server stale marks, kept only for databases the index holds or listed; check on use at each
/// provider's threshold, on the checks' clock (<see cref="ObjectSearchService.UtcNow"/>), never twice for one age; the status's
/// freshness fields, in invariant UTC; the check arguments' validation; a BigQuery check of due datasets that re-lists them and gets
/// nothing; details read anyway (bigquery.properties) replacing what the index holds, and saved; and the background re-read on the
/// reload fakes, which waits until details are due, gets one object at a time, rewrites only what changed, yields to a build, and
/// ends with its connection. Each wait is on a condition, never a fixed sleep.
/// </summary>
internal static class FreshnessChecks
{
    public static async Task RunAsync(Action<bool, string> check)
    {
        Scripts(check);
        SqlMarks(check);
        Skips(check);
        SqlDue(check);
        ServerDue(check);
        await Registered(check);
        await Arguments(check);
        await BigQueryDue(check);
        await DetailsRead(check);
        await Sweep(check);
    }

    private sealed class ProfileHost : IObjectSearchHost
    {
        public ServerProfile Profile(string connectionId) => new(17, null, 3, null, false, true, true, 16);
        public Microsoft.Data.SqlClient.SqlConnection Connection(string connectionId, string? database) => throw new NotSupportedException();
        public Task OpenAsync(Microsoft.Data.SqlClient.SqlConnection connection, CancellationToken token) => throw new NotSupportedException();
    }

    private sealed class Clock(DateTime now)
    {
        public DateTime Now = now;
    }

    private static readonly DateTime Start = new(2026, 11, 26, 8, 0, 0, DateTimeKind.Utc);

    private static DatabaseIndex Read(string database, DateTime? readAt = null) =>
        new(database, ObjectTable.Of([new IndexedObject("table", "tables", "dbo", database + "_orders")]), 0, 0, 0, readAt: readAt ?? Start);

    private static ObjectSearchResult Find(ObjectSearchService search, string connectionId, string text, string? database = null, string? project = null, string? dataset = null, bool bigQuery = false) =>
        search.Search(new ObjectSearchArgs(connectionId, Guid.NewGuid().ToString(), text, In: "names", Database: database, Project: project, Dataset: dataset), CancellationToken.None, bigQuery);

    private static async Task<bool> WaitUntilAsync(Func<bool> condition, int timeoutMs = 15_000)
    {
        if (condition()) return true;
        var deadline = System.Diagnostics.Stopwatch.GetTimestamp() + (long)(timeoutMs * (System.Diagnostics.Stopwatch.Frequency / 1000.0));
        await Task.Yield();
        while (!condition())
        {
            if (System.Diagnostics.Stopwatch.GetTimestamp() >= deadline) return condition();
            await Task.Delay(5);
        }
        return true;
    }

    // ---- Which scripts may change objects ----

    private static void Scripts(Action<bool, string> check)
    {
        string[] changes =
        [
            "CREATE TABLE dbo.t (id int)", "alter view v as select 1", "drop procedure p", "EXEC dbo.p", "execute('select 1')", "GRANT SELECT ON t TO u",
            "select 1; commit", "rollback tran", "ENABLE TRIGGER tr ON t", "exec sp_rename 'a', 'b'", "RESTORE DATABASE Sales FROM DISK = N'x.bak'", "DBCC CLONEDATABASE (Sales, SalesClone)", "sp_addextendedproperty 'x'", "select * into dbo.copy from t",
            "select 1 /* outer /* nested */ still a comment */ create table t (id int)", "select '--' as a; drop table t",
        ];
        string[] reads =
        [
            "select * from dbo.orders", "update t set x = 1", "insert into t values (1)", "delete from t", "select * into #t from x", "select 'create table t' as text",
            "-- drop table t\nselect 1", "/* create /* nested */ drop */ select 1", "select [create], \"drop\" from t", "merge into t using s on 1 = 0 when not matched then insert values (1);",
            "declare @t table (id int); insert into @t select 1", "select 1 into @x", "update t set x = 1 output inserted.x into #log", "",
        ];
        check(changes.All(TsqlChanges.MayChangeObjects), "a script with DDL, EXEC, permissions, a commit or rollback, a system procedure or SELECT INTO a table may change objects");
        check(!reads.Any(TsqlChanges.MayChangeObjects), "one that only reads or writes rows (keywords in strings, quoted names and nested comments aside) does not");
        check(TsqlChanges.MayChangeObjects(new string(' ', TsqlChanges.MostChars + 1)), "a script too long to scan is taken to change objects");
    }

    // ---- SQL Server stale marks ----

    private static void SqlMarks(Action<bool, string> check)
    {
        using var search = new ObjectSearchService(new ProfileHost());
        var id = Guid.NewGuid().ToString();
        search.MarkSqlStale(id, "Sales");
        check(search.IndexOf(id) is null, "DDL on a connection with no index keeps no mark (and makes no index)");
        search.Held(id).Put(Read("Sales"));
        var before = search.IndexStatus(new(id)).Status.StaleMark ?? 0;
        search.MarkSqlStale(id, "Nowhere");
        check(search.SqlStaleOf(id).Count == 0 && (search.IndexStatus(new(id)).Status.StaleMark ?? 0) == before,
            "DDL in a database the index neither holds nor listed keeps no mark, which no check would ever spend");
        search.MarkSqlStale(id, "Sales");
        search.MarkSqlStale(id, null);
        var status = search.IndexStatus(new(id)).Status;
        check(search.SqlStaleOf(id).Order(StringComparer.Ordinal).SequenceEqual([ObjectSearchService.ServerScope, "Sales"]) && status.StaleMark == before + 2 && status.Stale == 1,
            "DDL in a held database, and on the server's own objects, each make a mark the status names; the line counts only the database");
        search.MarkSqlStale(id, "Sales");
        check(search.SqlStaleOf(id).Count == 2 && search.IndexStatus(new(id)).Status is { Stale: 1 } again && again.StaleMark == before + 3,
            "DDL again in a marked database moves its mark on (a check that began before it does not spend it), counted once");
    }

    private static void Skips(Action<bool, string> check)
    {
        var skips = new SkipList(4);
        skips.Add(SkipList.Server, new("", "PERMISSION_DENIED", "denied"));
        skips.Add(SkipList.Server, new("", "CATALOG_ERROR", "list failed"));
        skips.Add(SkipList.Agent, new("", "PERMISSION_DENIED", "agent", Agent: true));
        skips.Add(0, new("Sales", "TIMEOUT", "slow"));
        skips.RemoveFixed(SkipList.Server, skip => skip.Code != "CATALOG_ERROR");
        skips.RemoveFixed(SkipList.Agent);
        skips.RemoveFixed(0);
        check(skips.ToList().Select(skip => skip.Code).SequenceEqual(["CATALOG_ERROR", "TIMEOUT"]),
            "a check replaces the server and Agent skips (never adding to them, so the list stays bounded) and leaves the databases");
    }

    // ---- Check on use ----

    private static void SqlDue(Action<bool, string> check)
    {
        var clock = new Clock(Start);
        using var search = new ObjectSearchService(new ProfileHost()) { UtcNow = () => clock.Now };
        var id = Guid.NewGuid().ToString();
        search.Held(id).Put(Read("Sales"));
        search.Held(id).Put(Read("Ops"));
        var thai = CultureInfo.CurrentCulture;
        CultureInfo.CurrentCulture = new CultureInfo("th-TH");
        try
        {
            var first = Find(search, id, "orders");
            check(first.Total == 2 && search.DueOf(id).Count == 0 && first.Index.Stale is null, "a search starts the clock of reads nothing checked yet, and marks nothing");
            check(first.Index is { ReadAt: "2026-11-26T08:00:00Z", Saved: null, CheckedAt: null, Unverified: null, Checking: null },
                "the status says when the oldest read was made, in invariant UTC whatever the culture, and that it was read rather than saved");
        }
        finally { CultureInfo.CurrentCulture = thai; }
        clock.Now = Start + ObjectSearchService.SqlCheckAfter - TimeSpan.FromMinutes(1);
        check(Find(search, id, "orders").Index.Stale is null && search.DueOf(id).Count == 0, "a read used before its threshold is not due");
        clock.Now = Start + ObjectSearchService.SqlCheckAfter;
        var due = Find(search, id, "orders", database: "Sales");
        check(search.DueOf(id) is ["Sales"] && due.Index.Stale == 1 && due.Index.StaleMark is > 0 && due.Total == 1,
            "a search of one database marks only it due once its threshold has passed, and still answers from what is held");
        var mark = due.Index.StaleMark;
        check(Find(search, id, "orders", database: "Sales").Index.StaleMark == mark, "a due database is not marked again by the next search (one check is asked per mark)");
        check(Find(search, id, "orders").Index is { Stale: 2 } all && all.StaleMark == mark + 1, "a search of every database marks the others due too");
        // No check came (or it failed): once the threshold has passed again, the next search renumbers the marks, so one is asked again.
        var waiting = Find(search, id, "orders").Index.StaleMark;
        clock.Now += ObjectSearchService.SqlCheckAfter;
        check(Find(search, id, "orders").Index is { Stale: 2 } again && again.StaleMark > waiting && Find(search, id, "orders").Index.StaleMark == again.StaleMark,
            "a due database whose check never passed is asked again once its threshold passes again, once");
        search.MarkSqlStale(id, "Ops");
        check(search.DueOf(id) is ["Sales"] && Find(search, id, "orders").Index.Stale == 2, "DDL in a due database replaces its due mark: it is counted once");
        var ddl = Find(search, id, "orders").Index.StaleMark;
        clock.Now += ObjectSearchService.SqlCheckAfter - TimeSpan.FromMinutes(1);
        var soon = Find(search, id, "orders").Index.StaleMark;
        clock.Now += TimeSpan.FromMinutes(1);
        check(soon == ddl && Find(search, id, "orders").Index.StaleMark > ddl, "a DDL mark whose check failed is asked again a threshold after it was made, not before");
    }

    private static void ServerDue(Action<bool, string> check)
    {
        var clock = new Clock(Start);
        using var search = new ObjectSearchService(new ProfileHost()) { UtcNow = () => clock.Now };
        var id = Guid.NewGuid().ToString();
        search.Held(id).Put(Read("Sales"));
        search.Held(id).PutServer(new DatabaseIndex("", ObjectTable.Of([new IndexedObject("login", "logins", "", "app_login")]), 0, 0, 0, readAt: Start));
        Find(search, id, "orders");
        clock.Now += ObjectSearchService.SqlCheckAfter;
        Find(search, id, "orders", database: "Sales");
        check(search.DueOf(id) is ["Sales"], "a search of one database leaves the server's own objects alone");
        var all = Find(search, id, "orders");
        check(search.DueOf(id).Order(StringComparer.Ordinal).SequenceEqual([ObjectSearchService.ServerScope, "Sales"]) && all.Index.Stale == 1,
            "a search of every database marks the server's own objects due too (checked with the databases, not counted as one)");
    }

    private static async Task Arguments(Action<bool, string> check)
    {
        using var search = new ObjectSearchService(new ProfileHost());
        var id = Guid.NewGuid().ToString();
        async Task<string?> Code(ObjectIndexArgs args)
        {
            try { await search.IndexAsync(args, CancellationToken.None); return null; }
            catch (RequestException error) { return error.Code; }
        }
        var request = Guid.NewGuid().ToString();
        check(await Code(new(id, request, Database: "Sales")) == "INVALID_PARAMS" && await Code(new(id, request, CheckAll: true)) == "INVALID_PARAMS"
            && await Code(new(id, request, Stale: true, Database: "Sales", CheckAll: true)) == "INVALID_PARAMS" && await Code(new(id, request, Stale: true, CheckAll: false)) == "INVALID_PARAMS"
            && await Code(new(id, request, Stale: true, Database: new string('x', 129))) == "INVALID_PARAMS",
            "a check's database or checkAll needs stale, not both, and a database name within an identifier's length");
        check(await search.IndexAsync(new(id, request, Stale: true, Database: "Sales"), CancellationToken.None) is { Status.State: "none" or "ready" },
            "a check of a connection with no index answers its status and connects to nothing");
    }

    /// <summary>A host whose connections open only when released, then fail: a check waits in its database list.</summary>
    private sealed class GatedHost : IObjectSearchHost
    {
        public readonly TaskCompletionSource Entered = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public readonly TaskCompletionSource Release = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public ServerProfile Profile(string connectionId) => new(17, null, 3, null, false, true, true, 16);
        public Microsoft.Data.SqlClient.SqlConnection Connection(string connectionId, string? database) => new();
        public async Task OpenAsync(Microsoft.Data.SqlClient.SqlConnection connection, CancellationToken token)
        {
            Entered.TrySetResult();
            await Release.Task.WaitAsync(token);
            throw new InvalidOperationException("No server in the offline checks.");
        }
    }

    private static async Task Registered(Action<bool, string> check)
    {
        var host = new GatedHost();
        using var search = new ObjectSearchService(host);
        var id = Guid.NewGuid().ToString();
        search.Held(id).Put(Read("Sales"));
        search.MarkSqlStale(id, "Sales");
        var request = Guid.NewGuid().ToString();
        var first = search.IndexAsync(new(id, request, Stale: true), CancellationToken.None);
        await host.Entered.Task.WaitAsync(TimeSpan.FromSeconds(15));
        string? code = null;
        try { await search.IndexAsync(new(id, request, Stale: true), CancellationToken.None); }
        catch (RequestException error) { code = error.Code; }
        host.Release.SetResult();
        try { await first; } catch (InvalidOperationException) { }
        var after = search.IndexStatus(new(id)).Status;
        check(code == "DUPLICATE_REQUEST" && after.Checking is null && after.State != "building",
            "a check the request registry refuses leaves the running check, and the state, as they were (" + code + ", " + after.State + ")");
    }

    // ---- BigQuery: due datasets, details read anyway, the background re-read ----

    private static async Task BigQueryDue(Action<bool, string> check)
    {
        using var folder = new Folder();
        var source = World();
        var clock = new Clock(DateTime.UtcNow);
        using var search = Session(folder);
        search.UtcNow = () => clock.Now;
        var id = Guid.NewGuid().ToString();
        await Build(search, source, id);
        var built = clock.Now;
        var status = search.IndexStatus(new(id), bigQuery: true).Status;
        check(status is { Stale: null, Saved: null, Unverified: null } && status.CheckedAt == built.ToString("yyyy-MM-ddTHH:mm:ssZ", CultureInfo.InvariantCulture),
            "a built BigQuery index says every dataset was checked when its build listed it");
        clock.Now = built + ObjectSearchService.BigQueryCheckAfter - TimeSpan.FromMinutes(1);
        check(Hits(search, id, "orders") >= 1 && search.DueOf(id).Count == 0, "a dataset used before an hour has passed is not due");
        clock.Now = built + ObjectSearchService.BigQueryCheckAfter;
        var narrowed = Find(search, id, "orders", project: Billing, dataset: "sales", bigQuery: true);
        check(search.DueOf(id) is [var key] && key == Billing + "\u0001sales" && narrowed.Index.Stale == 1, "a search narrowed to one dataset marks only it due");
        Hits(search, id, "orders");
        check(search.DueOf(id).Count == 4 && search.IndexStatus(new(id), bigQuery: true).Status.Stale == 4, "a search of every dataset marks each one due");
        source.Reset();
        clock.Now += TimeSpan.FromMinutes(1);
        var checkedStatus = (await search.IndexBigQueryAsync(new ObjectIndexArgs(id, Guid.NewGuid().ToString(), Stale: true), source, CancellationToken.None)).Status;
        check(source.ObjectCalls == 4 && source.TableCalls == 0 && source.RoutineCalls == 0, "a check of due, unchanged datasets re-lists each and gets no object's details");
        check(search.DueOf(id).Count == 0 && checkedStatus is { Stale: null, Checking: null } && checkedStatus.CheckedAt == clock.Now.ToString("yyyy-MM-ddTHH:mm:ssZ", CultureInfo.InvariantCulture),
            "once checked, nothing is due and the status says when it was checked");

        // A dataset dropped outside Varia: the check finds it gone, and its due mark goes with it.
        source.Projects["proj-b"].TryRemove("ds2", out _);
        clock.Now += ObjectSearchService.BigQueryCheckAfter;
        Hits(search, id, "orders");
        check(search.DueOf(id).Count == 4, "an hour on, every dataset is due again");
        var afterGone = (await search.IndexBigQueryAsync(new ObjectIndexArgs(id, Guid.NewGuid().ToString(), Stale: true), source, CancellationToken.None)).Status;
        check(search.DueOf(id).Count == 0 && afterGone.Stale is null && Hits(search, id, "t3") == 0, "a due dataset found gone leaves the index and its mark, so nothing stays may have changed");
        async Task<string?> Refused(ObjectIndexArgs args)
        {
            try { await search.IndexBigQueryAsync(args, source, CancellationToken.None); return null; }
            catch (RequestException error) { return error.Code; }
        }
        check(await Refused(new(id, Guid.NewGuid().ToString(), Stale: true, Database: "sales")) == "INVALID_PARAMS" && await Refused(new(id, Guid.NewGuid().ToString(), Stale: true, CheckAll: true)) == "INVALID_PARAMS",
            "BigQuery refuses SQL Server's database and checkAll");
    }

    private static Table Shaped(params string[] columns) =>
        new() { Type = "TABLE", Schema = new() { Fields = [.. columns.Select(name => new TableFieldSchema { Name = name, Type = "STRING", Mode = "NULLABLE" })] } };

    private static async Task DetailsRead(Action<bool, string> check)
    {
        using var folder = new Folder();
        var source = World();
        var id = Guid.NewGuid().ToString();
        using (var search = Session(folder))
        {
            await Build(search, source, id);
            await search.Store.Idle();
            var saved = search.Store.Counts.Saved;
            search.TableRead(id, Billing, "sales", "orders", Shaped("col_0", "col_1", "col_2"));
            search.RoutineRead(id, Billing, "sales", "fn_total", new Routine { RoutineType = "SCALAR_FUNCTION", LastModifiedTime = 1_700_000_100_000, DefinitionBody = "x + 1", Arguments = [] });
            check(search.BigQueryRefreshes.Refreshed == 0, "details read anyway that say what the index holds (a table's, a routine's) change nothing");
            search.TableRead(id, Billing, "sales", "orders", Shaped("col_0", "col_1", "col_2", "added_in_place"));
            await search.Store.Idle();
            check(search.BigQueryRefreshes.Refreshed == 1 && Hits(search, id, "added_in_place") == 1 && Hits(search, id, "customers") == 1 && search.Store.Counts.Saved == saved + 1,
                "details read anyway that differ (a column added in place) replace the object's entry, keep the rest of the dataset, and save it");
            search.TableRead(id, Billing, "sales", "nowhere", Shaped("x"));
            search.TableRead(Guid.NewGuid().ToString(), Billing, "sales", "orders", Shaped("y"));
            check(search.BigQueryRefreshes.Refreshed == 1, "details of an object or a connection the index does not hold change nothing");
        }
        source.Reset();
        source.Projects[Billing]["sales"] = [.. source.Projects[Billing]["sales"].Select(item => item.Name == "orders" ? item with { Columns = 4 } : item)];
        using (var next = Session(folder))
        {
            var again = Guid.NewGuid().ToString();
            await Build(next, source, again);
            check(Hits(next, again, "added_in_place") == 1 && source.TableCalls == 0, "a new session loads the refreshed details from the saved index, with no tables.get");
        }
    }

    private static async Task Sweep(Action<bool, string> check)
    {
        using var folder = new Folder();
        var source = World();
        var clock = new Clock(DateTime.UtcNow);
        using var search = Session(folder);
        search.UtcNow = () => clock.Now;
        search.SweepIdle = TimeSpan.FromMilliseconds(20);
        search.SweepPace = TimeSpan.FromMilliseconds(1);
        // Fewer objects a pass than the sales dataset holds: its passes go on from where the last one stopped.
        search.SweepObjects = 2;
        var id = Guid.NewGuid().ToString();
        var early = 0;
        var due = DateTime.MaxValue;
        var building = false;
        var whileBuilding = 0;
        var gate = (TaskCompletionSource?)null;
        var entered = (TaskCompletionSource?)null;
        search.SweepGetting = async (_, _, _) =>
        {
            if (clock.Now < due) Interlocked.Increment(ref early);
            if (Volatile.Read(ref building)) Interlocked.Increment(ref whileBuilding);
            if (gate is { } held) { entered?.TrySetResult(); await held.Task; }
        };
        int inflight = 0, most = 0;
        source.OnTable = async (_, _, _, _) =>
        {
            var now = Interlocked.Increment(ref inflight);
            if (now > Volatile.Read(ref most)) Volatile.Write(ref most, now);
            await Task.Yield();
            Interlocked.Decrement(ref inflight);
        };
        await Build(search, source, id);
        await search.Store.Idle();
        check(await WaitUntilAsync(() => search.Sweeps == 1) && search.BigQueryRefreshes.SweepGets == 0, "a full build starts one background re-read, which gets nothing while details are fresh");
        // The build's own gets run several at once: only the background re-read's are counted from here.
        source.Reset();
        Volatile.Write(ref most, 0);
        source.Projects[Billing]["sales"] = [.. source.Projects[Billing]["sales"].Select(item => item.Name == "orders" ? item with { Columns = 6 } : item)];
        // The reads were made after the clock was set: details are due a pass after the last of them.
        due = DateTime.UtcNow + search.SweepAfter;
        clock.Now = due;
        // A get is counted as it starts: wait for the calls themselves to have landed too.
        check(await WaitUntilAsync(() => search.BigQueryRefreshes is { SweepGets: >= 9, SweepRewrites: >= 1 } && source.TableCalls + source.RoutineCalls >= 9) && Hits(search, id, "col_5") == 1,
            "once details are due it gets every held object's details again and holds the column changed in place");
        await search.Store.Idle();
        check(Volatile.Read(ref early) == 0 && Volatile.Read(ref most) == 1 && search.BigQueryRefreshes is { SweepGets: 9, SweepRewrites: 1 } && source.TableCalls == 8 && source.RoutineCalls == 1,
            "it gets nothing before they are due, one object at a time, each object once, and rewrites only the dataset that changed ("
            + $"early {Volatile.Read(ref early)}, most {Volatile.Read(ref most)}, {search.BigQueryRefreshes}, tables {source.TableCalls}, routines {source.RoutineCalls})");

        // A build that starts mid-pass: the get under way ends, and no other is made until the build is done.
        gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        due = clock.Now + search.SweepAfter;
        clock.Now = due;
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(15));
        var listing = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        source.OnDatasets = async (_, token) => { listing.TrySetResult(); await release.Task.WaitAsync(token); };
        var rebuild = Build(search, source, id);
        await listing.Task.WaitAsync(TimeSpan.FromSeconds(15));
        Volatile.Write(ref building, true);
        var gets = search.BigQueryRefreshes.SweepGets;
        var held = gate;
        gate = null;
        held.SetResult();
        var calls = source.TableCalls + source.RoutineCalls;
        await WaitUntilAsync(() => source.TableCalls + source.RoutineCalls > calls);
        Volatile.Write(ref building, false);
        source.OnDatasets = null;
        release.SetResult();
        await rebuild;
        check(Volatile.Read(ref whileBuilding) == 0 && search.BigQueryRefreshes.SweepGets >= gets, "a build pauses the background re-read: it makes no get while the build runs");
        search.Forget(id);
        check(await WaitUntilAsync(() => search.Sweeps == 0), "closing the connection ends its background re-read");

        // A connection that closes as its build ends: no background re-read starts on what it left.
        var late = Guid.NewGuid().ToString();
        var starts = search.SweepStarts;
        search.BeforeSweep = () => search.Forget(late);
        try { await Build(search, source, late); } catch (RequestException) { }
        finally { search.BeforeSweep = null; }
        check(search.SweepStarts == starts && search.Sweeps == 0, "a connection closed as its build ends starts no background re-read");
    }
}
