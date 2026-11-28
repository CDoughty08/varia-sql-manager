using System.Collections.Concurrent;
using Google.Apis.Bigquery.v2.Data;
using Varia.Backend.Protocol;
using Varia.Backend.Search;

namespace Varia.Backend.Tests;

/// <summary>
/// A BigQuery index reloaded from the saved index (docs/object-search.md, Saved index) on a counting fake and a temporary
/// folder: each "start" is a new service on the same folder and key, as a new session is. A second start of an unchanged
/// project makes no tables.get or routines.get call and saves nothing, and its search answers before any listing; a table
/// created again, a routine changed, a dataset dropped and one added cost only their own calls; a file whose details were
/// pending resumes them; a dataset DDL marked stale is never loaded; a corrupt file, a file under another key and a file that
/// does not fit fall back to the usual read. No check sleeps: each waits on the fake's own signals or the store's idle one.
/// </summary>
internal static class BigQueryReloadChecks
{
    private static readonly byte[] Key = [.. Enumerable.Range(0, 32).Select(at => (byte)(at * 7 + 3))];
    private static readonly byte[] OtherKey = [.. Enumerable.Range(0, 32).Select(at => (byte)(at * 11 + 5))];
    private const string Principal = "bigquery:user:reload-checks@example.com";
    internal const string Billing = "varia-alpha";

    public static async Task RunAsync(Action<bool, string> check)
    {
        await Sessions(check);
        await StaleMarked(check);
        await MarkedElsewhere(check);
        await StoppedWhileLoading(check);
        await Superseded(check);
        await Unchecked(check);
        await Rewritten(check);
        await Vanished(check);
        await Replaced(check);
        await Damaged(check);
        await Budget(check);
    }

    // ---- The fake ----

    internal sealed record Item(string Kind, string Name, long Created, long? Modified = null, int Columns = 3);

    /// <summary>Projects, their datasets and objects; counts every call by kind. The billing project is varia-alpha; discovery
    /// answers every other project.</summary>
    internal sealed class Source : IBigQueryIndexSource
    {
        public ConcurrentDictionary<string, ConcurrentDictionary<string, List<Item>>> Projects { get; } = new(StringComparer.Ordinal);
        private int datasets, objects, tables, routines;
        public int DatasetCalls => Volatile.Read(ref datasets);
        public int ObjectCalls => Volatile.Read(ref objects);
        public int TableCalls => Volatile.Read(ref tables);
        public int RoutineCalls => Volatile.Read(ref routines);
        public readonly ConcurrentDictionary<string, int> TablesOf = new(StringComparer.Ordinal);
        public Func<string, CancellationToken, Task>? OnDatasets { get; set; }
        public Func<string, string, string, CancellationToken, Task>? OnTable { get; set; }

        public void Reset()
        {
            (datasets, objects, tables, routines) = (0, 0, 0, 0);
            TablesOf.Clear();
        }
        public void Add(string project, string dataset, params Item[] items) => Projects.GetOrAdd(project, _ => new(StringComparer.Ordinal))[dataset] = [.. items];

        public string BillingProject(string connectionId) => Billing;
        public string? Principal(string connectionId) => BigQueryReloadChecks.Principal;
        public Task<BigQueryProjectDiscovery> AccessibleProjectsAsync(string connectionId, int maxProjects, CancellationToken token) =>
            Task.FromResult(new BigQueryProjectDiscovery([.. Projects.Keys.Where(project => project != Billing).Order(StringComparer.Ordinal)], false));
        public async Task<BigQueryDatasetList> DatasetsAsync(string connectionId, string project, CancellationToken token)
        {
            Interlocked.Increment(ref datasets);
            if (OnDatasets is not null) await OnDatasets(project, token);
            return new([.. (Projects.TryGetValue(project, out var sets) ? sets.Keys : []).Order(StringComparer.Ordinal)], false);
        }
        public Task<BigQueryListing> ObjectsAsync(string connectionId, string project, string dataset, CancellationToken token)
        {
            Interlocked.Increment(ref objects);
            if (!Projects.TryGetValue(project, out var sets) || !sets.TryGetValue(dataset, out var items)) throw new RequestException("NOT_FOUND", "Not found.");
            var listed = items.Where(item => item.Kind is "TABLE" or "VIEW").Select(item => new TableList.TablesData
            {
                TableReference = new() { ProjectId = project, DatasetId = dataset, TableId = item.Name }, Type = item.Kind, CreationTime = item.Created
            }).ToList();
            var routinesListed = items.Where(item => item.Kind == "ROUTINE").Select(item => new Routine
            {
                RoutineReference = new() { ProjectId = project, DatasetId = dataset, RoutineId = item.Name }, RoutineType = "SCALAR_FUNCTION", CreationTime = item.Created, LastModifiedTime = item.Modified
            }).ToList();
            var models = items.Where(item => item.Kind == "MODEL").Select(item => new Model
            {
                ModelReference = new() { ProjectId = project, DatasetId = dataset, ModelId = item.Name }, CreationTime = item.Created, LastModifiedTime = item.Modified
            }).ToList();
            return Task.FromResult(new BigQueryListing(listed, routinesListed, models, false));
        }
        public async Task<Table> TableAsync(string connectionId, string project, string dataset, string table, CancellationToken token)
        {
            if (OnTable is not null) await OnTable(project, dataset, table, token);
            Interlocked.Increment(ref tables);
            TablesOf.AddOrUpdate(project + "." + dataset, 1, (_, count) => count + 1);
            var item = Projects[project][dataset].Single(entry => entry.Name == table);
            var fields = Enumerable.Range(0, item.Columns).Select(at => new TableFieldSchema { Name = "col_" + at, Type = "STRING", Mode = "NULLABLE" }).ToList();
            return new Table { Type = item.Kind, Schema = new() { Fields = fields }, View = item.Kind == "VIEW" ? new() { Query = "SELECT 1 AS reload_view_marker" } : null };
        }
        public Task<Routine> RoutineAsync(string connectionId, string project, string dataset, string routine, CancellationToken token)
        {
            Interlocked.Increment(ref routines);
            var item = Projects[project][dataset].Single(entry => entry.Name == routine);
            return Task.FromResult(new Routine { RoutineType = "SCALAR_FUNCTION", LastModifiedTime = item.Modified, DefinitionBody = "x + 1", Arguments = [] });
        }
        public IAsyncEnumerable<BigQueryBulkDataset> BulkAsync(string connectionId, string project, string location, bool definitions, long? cap, BigQueryBulkBudget budget,
            Func<string, string, bool> wanted, CancellationToken token) => throw new NotSupportedException();
        public Exception Map(Exception error, string project, string? permission, CancellationToken token) => error;
    }

    // ---- Helpers ----

    internal sealed class Folder : IDisposable
    {
        public Folder()
        {
            Root = Directory.CreateTempSubdirectory("varia-index-reload-").FullName;
            Path = System.IO.Path.Combine(Root, IndexStoreLimits.FolderName);
        }

        public string Root { get; }
        public string Path { get; }
        public string[] Units => Directory.Exists(Path) ? [.. Directory.GetFiles(Path).Select(System.IO.Path.GetFileName).OfType<string>().Where(name => IndexStoreNames.IsUnit(name))] : [];

        public void Dispose()
        {
            try { Directory.Delete(Root, recursive: true); }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
        }
    }

    private static IndexStoreScope Scope => IndexStoreScope.BigQuery(Principal)!;

    /// <summary>A new session's service on the folder, saving and reading under <paramref name="key"/>.</summary>
    internal static ObjectSearchService Session(Folder folder, byte[]? key = null, ObjectIndexLimits? limits = null)
    {
        var search = new ObjectSearchService(new BigQueryIndexChecks.UnusedHost(), limits);
        search.Store.Configure(new("encrypted", folder.Path, IndexStoreLimits.DefaultDiskMiB, Convert.ToBase64String(key ?? Key)));
        return search;
    }

    internal static Task<ObjectIndexResult> Build(ObjectSearchService search, Source source, string connectionId, CancellationToken token = default, Action<object>? progress = null) =>
        search.IndexBigQueryAsync(new ObjectIndexArgs(connectionId, Guid.NewGuid().ToString()), source, token, progress);

    internal static int Hits(ObjectSearchService search, string connectionId, string text) =>
        search.Search(new ObjectSearchArgs(connectionId, Guid.NewGuid().ToString(), text, WholeWord: true, In: "names"), CancellationToken.None, bigQuery: true).Total;

    /// <summary>Whether a unit loads whole into an index of its own.</summary>
    private static bool Loads(ObjectSearchService search, SavedUnit unit)
    {
        var budget = new IndexBudget(search.Limits.MemoryBytes);
        var pool = new StringPool(budget);
        var index = new ConnectionIndex(budget, null, pool);
        var loaded = search.Store.Load(unit, index, search.Limits, pool);
        if (loaded.Value is { } read) index.Abandon(read);
        return loaded.Value is not null;
    }

    private static SavedUnit? Unit(ObjectSearchService search, string project, string dataset) => search.Store.Find(Scope, IndexUnitKind.Dataset, project, dataset);

    internal static Source World()
    {
        var source = new Source();
        source.Add(Billing, "sales", new Item("TABLE", "orders", 1_700_000_000_000), new Item("TABLE", "customers", 1_700_000_000_000), new Item("VIEW", "v_orders", 1_700_000_000_000),
            new Item("ROUTINE", "fn_total", 1_700_000_000_000, 1_700_000_100_000), new Item("MODEL", "churn", 1_700_000_000_000, 1_700_000_100_000));
        source.Add(Billing, "ops", new Item("TABLE", "events", 1_700_000_000_000), new Item("TABLE", "logs", 1_700_000_000_000));
        source.Add("proj-b", "ds1", new Item("TABLE", "t1", 1_700_000_000_000), new Item("TABLE", "t2", 1_700_000_000_000));
        source.Add("proj-b", "ds2", new Item("TABLE", "t3", 1_700_000_000_000));
        return source;
    }

    // ---- Sessions: unchanged, changed, pending details ----

    private static async Task Sessions(Action<bool, string> check)
    {
        using var folder = new Folder();
        var source = World();
        using (var first = Session(folder))
        {
            await Build(first, source, Guid.NewGuid().ToString());
            await first.Store.Idle();
            check(folder.Units.Length == 4 && source.TableCalls == 8 && source.RoutineCalls == 1 && first.SavedLoads.Loaded == 0,
                "a first session reads every object's details and saves each dataset");
        }

        // A second session of the same, unchanged project: searchable before any call, then zero details calls and no file written.
        source.Reset();
        using (var second = Session(folder))
        {
            var id = Guid.NewGuid().ToString();
            var listing = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            source.OnDatasets = async (_, token) => { listing.TrySetResult(); await release.Task.WaitAsync(token); };
            var events = new ConcurrentQueue<object>();
            var build = Build(second, source, id, progress: events.Enqueue);
            await listing.Task;
            var during = second.IndexStatus(new(id), bigQuery: true).Status;
            check(Hits(second, id, "orders") >= 1 && Hits(second, id, "t3") == 1 && source.ObjectCalls == 0 && source.DatasetCalls == 1,
                "a saved BigQuery index is searchable before the build has listed anything");
            check(during is { State: "building", SavedAt: { Length: 20 } at } && at.EndsWith('Z') && DateTime.TryParse(at, System.Globalization.CultureInfo.InvariantCulture,
                System.Globalization.DateTimeStyles.AdjustToUniversal | System.Globalization.DateTimeStyles.AssumeUniversal, out var when) && DateTime.UtcNow - when < TimeSpan.FromHours(1)
                && events.OfType<BigQueryIndexProgress>().Any(item => item.SavedAt == at) && events.OfType<BigQueryIndexProgress>().All(item => item.Full == true),
                "while it checks, the status and the progress say when the saved index was read (UTC, invariant)");
            release.SetResult();
            source.OnDatasets = null;
            var done = await build;
            await second.Store.Idle();
            check(source.TableCalls == 0 && source.RoutineCalls == 0 && source.ObjectCalls == 4, "an unchanged project costs only its listings: no tables.get or routines.get");
            check(second.Store.Counts.Saved == 0 && second.SavedLoads is { Loaded: 4, Unchanged: 4, Refused: 0, Budget: 0, Stale: 0 } && folder.Units.Length == 4,
                "an unchanged dataset is not saved again: its file is only marked used");
            check(done.Status.SavedAt is null && done.Status.Indexed == 4 && Hits(second, id, "fn_total") == 1, "once every dataset is checked, the status says nothing of a saved age");
        }

        // One table created again, one routine changed, one dataset dropped and one added.
        source.Reset();
        var sales = source.Projects[Billing]["sales"];
        source.Projects[Billing]["sales"] = [.. sales.Select(item => item.Name switch
        {
            "orders" => item with { Created = item.Created + 1 },
            "fn_total" => item with { Modified = item.Modified + 1 },
            _ => item
        })];
        source.Projects[Billing].TryRemove("ops", out _);
        source.Add(Billing, "fresh", new Item("TABLE", "brand_new", 1_700_000_000_000));
        using (var third = Session(folder))
        {
            var id = Guid.NewGuid().ToString();
            await Build(third, source, id);
            await third.Store.Idle();
            check(source.TableCalls == 2 && source.TablesOf.GetValueOrDefault(Billing + ".sales") == 1 && source.TablesOf.GetValueOrDefault(Billing + ".fresh") == 1 && source.RoutineCalls == 1,
                "only a re-created table, a changed routine and a new dataset's objects cost details calls");
            check(Unit(third, Billing, "ops") is null && Unit(third, Billing, "fresh") is not null && folder.Units.Length == 4 && Hits(third, id, "events") == 0 && Hits(third, id, "brand_new") == 1,
                "a dataset its project no longer lists loses its file and leaves the index; a new one is read and saved");
            check(third.SavedLoads is { Loaded: 4, Unchanged: 2, Pruned: 0 } && Unit(third, Billing, "sales") is { } changed && BigQuerySync.From(changed.Sync) is { Whole: true, Listing: not null },
                "a changed dataset is saved in place, whole; the unchanged ones are not");
        }

        // Pass 2 stopped after pass 1 saved a dataset: the next session reads just the details still pending.
        source.Reset();
        source.Add("proj-b", "ds2", new Item("TABLE", "t3", 1_700_000_000_000), new Item("TABLE", "t4", 1_700_000_000_000), new Item("TABLE", "t5", 1_700_000_000_000), new Item("TABLE", "t6", 1_700_000_000_000));
        using (var fourth = Session(folder))
        {
            using var stop = new CancellationTokenSource();
            var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            source.OnTable = async (project, dataset, _, token) =>
            {
                if (dataset != "ds2") return;
                entered.TrySetResult();
                await Task.Delay(Timeout.Infinite, token);
            };
            var build = Build(fourth, source, Guid.NewGuid().ToString(), stop.Token);
            await entered.Task;
            await fourth.Store.Idle();
            stop.Cancel();
            try { await build; } catch (RequestException) { }
            await fourth.Store.Idle();
            source.OnTable = null;
            check(Unit(fourth, "proj-b", "ds2") is { } pending && BigQuerySync.From(pending.Sync) is { Pending: 3 }, "a build stopped in pass 2 leaves the file pass 1 saved, its details pending");
        }
        source.Reset();
        using (var fifth = Session(folder))
        {
            var id = Guid.NewGuid().ToString();
            await Build(fifth, source, id);
            await fifth.Store.Idle();
            check(source.TableCalls == 3 && source.TablesOf.GetValueOrDefault("proj-b.ds2") == 3 && source.RoutineCalls == 0 && Unit(fifth, "proj-b", "ds2") is { } resumed
                && BigQuerySync.From(resumed.Sync) is { Whole: true } && fifth.SavedLoads.Unchanged == 3,
                "the next session reads the pending objects' details alone, and saves the dataset whole");
        }
    }

    // ---- A dataset DDL marked stale is never served from disk ----

    private static async Task StaleMarked(Action<bool, string> check)
    {
        using var folder = new Folder();
        var source = World();
        using (var first = Session(folder))
        {
            await Build(first, source, Guid.NewGuid().ToString());
            await first.Store.Idle();
        }
        using var search = Session(folder);
        await search.Store.Idle();
        // DDL marks sales stale; its file's deletion is held on the writer, so the file is still there when the next build lists.
        var deleting = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var deleted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        search.Store.DeleteFile = path =>
        {
            deleting.TrySetResult();
            deleted.Task.Wait();
            File.Delete(path);
        };
        search.MarkSavedStale(Principal, Billing, "sales");
        await deleting.Task;
        check(folder.Units.Length == 4, "the stale dataset's file is still on disk while its deletion runs");
        source.Reset();
        var id = Guid.NewGuid().ToString();
        await Build(search, source, id);
        deleted.SetResult();
        await search.Store.Idle();
        check(search.SavedLoads is { Stale: 1, Loaded: 3 } && source.TablesOf.GetValueOrDefault(Billing + ".sales") == 3 && source.RoutineCalls == 1 && source.TableCalls == 3,
            "a dataset DDL marked stale is not loaded from its file: it is read again whole, and only it");
        check(Hits(search, id, "orders") >= 1 && Unit(search, Billing, "sales") is not null, "and the read after the mark is saved");
    }

    // ---- DDL from another connection of the principal, after a dataset loaded ----

    private static async Task MarkedElsewhere(Action<bool, string> check)
    {
        using var folder = new Folder();
        var source = World();
        using (var first = Session(folder))
        {
            await Build(first, source, Guid.NewGuid().ToString());
            await first.Store.Idle();
        }
        source.Reset();
        using var search = Session(folder);
        var id = Guid.NewGuid().ToString();
        var listing = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        source.OnDatasets = async (_, token) => { listing.TrySetResult(); await release.Task.WaitAsync(token); };
        var build = Build(search, source, id);
        await listing.Task;
        // Another connection's DDL marks only the store (MarkSavedStale), never this connection's own marks.
        search.MarkSavedStale(Principal, Billing, "ops");
        release.SetResult();
        await build;
        source.OnDatasets = null;
        await search.Store.Idle();
        check(search.SavedLoads is { Loaded: 4, Unchanged: 3 } && source.TablesOf.GetValueOrDefault(Billing + ".ops") == 2 && source.TableCalls == 2,
            "a loaded dataset that another connection's DDL marks stale is read whole by its listing, and only it");
        check(Unit(search, Billing, "ops") is { } saved && BigQuerySync.From(saved.Sync) is { Whole: true }, "and the read after the mark is saved");
    }

    // ---- A build stopped while it loads leaves the rest to the next ----

    private static async Task StoppedWhileLoading(Action<bool, string> check)
    {
        using var folder = new Folder();
        var source = World();
        using (var first = Session(folder))
        {
            await Build(first, source, Guid.NewGuid().ToString());
            await first.Store.Idle();
        }
        source.Reset();
        using var search = Session(folder);
        var id = Guid.NewGuid().ToString();
        using var stop = new CancellationTokenSource();
        var loads = 0;
        search.SavedLoading = (_, _) => { if (++loads == 2) stop.Cancel(); };
        try { await Build(search, source, id, stop.Token); } catch (Exception error) when (error is OperationCanceledException or RequestException) { }
        search.SavedLoading = null;
        source.Reset();
        await Build(search, source, id);
        await search.Store.Idle();
        check(source.TableCalls == 0 && source.RoutineCalls == 0 && Hits(search, id, "t3") == 1 && search.SavedLoads.Stale == 0,
            "a build stopped while it loaded the saved index leaves the rest to the next full build, which loads it (what is held counts as nothing stale)");
    }

    // ---- A build that replaces the one loading loads in its place ----

    private static async Task Superseded(Action<bool, string> check)
    {
        using var folder = new Folder();
        var source = World();
        using (var first = Session(folder))
        {
            await Build(first, source, Guid.NewGuid().ToString());
            await first.Store.Idle();
        }
        source.Reset();
        using var search = Session(folder);
        var id = Guid.NewGuid().ToString();
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new ManualResetEventSlim();
        var calls = 0;
        search.SavedLoading = (_, _) =>
        {
            if (Interlocked.Increment(ref calls) != 1) return;
            entered.TrySetResult();
            release.Wait(TimeSpan.FromSeconds(60));
        };
        var replaced = Build(search, source, id);
        await entered.Task;
        // A rebuild while the first build is still inside a load: it does not wait for that build to notice it was replaced.
        await Build(search, source, id);
        release.Set();
        try { await replaced; } catch (Exception error) when (error is OperationCanceledException or RequestException) { }
        search.SavedLoading = null;
        await search.Store.Idle();
        check(source.TableCalls == 0 && source.RoutineCalls == 0 && Hits(search, id, "t3") == 1,
            "a build that replaces one still loading the saved index loads it itself, rather than reading every dataset again");
    }

    // ---- What a build leaves unchecked: the status says so; a refresh does not claim to check it ----

    private static async Task Unchecked(Action<bool, string> check)
    {
        using var folder = new Folder();
        var source = World();
        using (var first = Session(folder))
        {
            await Build(first, source, Guid.NewGuid().ToString());
            await first.Store.Idle();
        }
        source.Reset();
        using var search = Session(folder);
        var id = Guid.NewGuid().ToString();
        source.OnDatasets = (project, _) => project == "proj-b" ? Task.FromException(new RequestException("BIGQUERY_ERROR", "unavailable")) : Task.CompletedTask;
        var done = await Build(search, source, id);
        check(done.Status.SavedAt is not null && Hits(search, id, "t3") == 1, "a build whose listing of a project failed leaves its loaded datasets unchecked, and its status says when they were saved");
        source.OnDatasets = null;
        var events = new ConcurrentQueue<object>();
        await search.IndexBigQueryAsync(new ObjectIndexArgs(id, Guid.NewGuid().ToString(), Scope: new(Billing, "sales")), source, CancellationToken.None, events.Enqueue);
        check(events.OfType<BigQueryIndexProgress>().Any() && events.OfType<BigQueryIndexProgress>().All(item => item.SavedAt is null && item.Full is null),
            "a refresh of another dataset does not say it is checking the saved index");
        await search.Store.Idle();
    }

    // ---- A file written again between the listing and its load ----

    private static async Task Rewritten(Action<bool, string> check)
    {
        using var folder = new Folder();
        var source = World();
        using (var first = Session(folder))
        {
            await Build(first, source, Guid.NewGuid().ToString());
            await first.Store.Idle();
        }
        var before = folder.Units.ToDictionary(name => name, name => File.ReadAllBytes(Path.Combine(folder.Path, name)), StringComparer.Ordinal);
        var sales = source.Projects[Billing]["sales"];
        source.Projects[Billing]["sales"] = [.. sales.Select(item => item.Name == "orders" ? item with { Created = item.Created + 1 } : item)];
        using (var second = Session(folder))
        {
            await Build(second, source, Guid.NewGuid().ToString());
            await second.Store.Idle();
        }
        var salesFile = folder.Units.Single(name => !before[name].AsSpan().SequenceEqual(File.ReadAllBytes(Path.Combine(folder.Path, name))));
        source.Reset();
        using var search = Session(folder);
        var id = Guid.NewGuid().ToString();
        // Between the listing (which read the newer header) and the load, the file holds another read of the dataset (as another
        // connection's save would leave it): the older read stands here for any other.
        search.SavedLoading = (_, dataset) => { if (dataset == "sales") File.WriteAllBytes(Path.Combine(folder.Path, salesFile), before[salesFile]); };
        await Build(search, source, id);
        search.SavedLoading = null;
        await search.Store.Idle();
        check(search.SavedLoads is { Loaded: 3, Stale: 1 } && source.TablesOf.GetValueOrDefault(Billing + ".sales") == 3 && source.TableCalls == 3,
            "a file written again between the listing and its load is not held with the listed one's sync bytes: the dataset is read whole");
    }

    // ---- A file deleted between the listing and its load ----

    private static async Task Vanished(Action<bool, string> check)
    {
        using var folder = new Folder();
        var source = World();
        using (var first = Session(folder))
        {
            await Build(first, source, Guid.NewGuid().ToString());
            await first.Store.Idle();
        }
        source.Reset();
        using var search = Session(folder);
        var id = Guid.NewGuid().ToString();
        // As DDL from another connection or a prune would: the file goes after the listing, before its load.
        search.SavedLoading = (_, dataset) =>
        {
            if (dataset != "ops" || Unit(search, Billing, "ops") is not { } unit) return;
            search.Store.Delete(unit);
            search.Store.Idle().GetAwaiter().GetResult();
        };
        await Build(search, source, id);
        search.SavedLoading = null;
        await search.Store.Idle();
        check(search.SavedLoads is { Loaded: 3, Stale: 1, Refused: 0 } && source.TablesOf.GetValueOrDefault(Billing + ".ops") == 2 && Hits(search, id, "events") == 1,
            "a file deleted after it was listed counts as gone, not unreadable, and its dataset is read again");
    }

    // ---- A loaded read a new read replaces is forgotten at once ----

    private static async Task Replaced(Action<bool, string> check)
    {
        using var folder = new Folder();
        var source = World();
        using (var first = Session(folder))
        {
            await Build(first, source, Guid.NewGuid().ToString());
            await first.Store.Idle();
        }
        // The billing project's listing fails, so its two (older) datasets stay unchecked; proj-b's ds2 changed and is read anew.
        source.Reset();
        source.Projects["proj-b"]["ds2"] = [new Item("TABLE", "t3", 1_700_000_000_001)];
        using var search = Session(folder);
        var id = Guid.NewGuid().ToString();
        source.OnDatasets = (project, _) => project == Billing ? Task.FromException(new RequestException("BIGQUERY_ERROR", "unavailable")) : Task.CompletedTask;
        var done = await Build(search, source, id);
        source.OnDatasets = null;
        check(done.Status.SavedAt is not null && source.TablesOf.GetValueOrDefault("proj-b.ds2") == 1 && search.SavedEntries(id) == 2,
            "a loaded read that a new read replaces is forgotten at once, even behind an older unchecked one");
        await search.Store.Idle();
    }

    // ---- Corrupt files and another key's file ----

    private static async Task Damaged(Action<bool, string> check)
    {
        using var folder = new Folder();
        var source = World();
        using (var first = Session(folder))
        {
            await Build(first, source, Guid.NewGuid().ToString());
            await first.Store.Idle();
            foreach (var dataset in new[] { "ds1", "ds2" })
            {
                var path = Path.Combine(folder.Path, Unit(first, "proj-b", dataset)!.Name);
                var bytes = File.ReadAllBytes(path);
                for (var at = bytes.Length - 24; at < bytes.Length; at++) bytes[at] ^= 0x5A;
                File.WriteAllBytes(path, bytes);
            }
        }
        // ds1 is still listed and is read as if nothing were saved; ds2 is gone, and so goes its file, which never loaded.
        source.Projects["proj-b"].TryRemove("ds2", out _);
        source.Reset();
        using (var second = Session(folder))
        {
            var id = Guid.NewGuid().ToString();
            await Build(second, source, id);
            await second.Store.Idle();
            check(second.SavedLoads is { Refused: 2, Loaded: 2, Pruned: 1 } && source.TableCalls == 2 && source.TablesOf.GetValueOrDefault("proj-b.ds1") == 2 && Hits(second, id, "t1") == 1,
                "a corrupt file is counted and its dataset read as if nothing were saved");
            check(Unit(second, "proj-b", "ds2") is null && folder.Units.Length == 3 && Unit(second, "proj-b", "ds1") is { } again
                && Loads(second, again),
                "the file of a dataset no longer listed goes though it never loaded, and the corrupt file of a listed one is saved anew");
        }

        // A file under another key, where this key's file of the dataset belongs.
        using var other = new Folder();
        var lone = new Source();
        lone.Add(Billing, "sales", new Item("TABLE", "orders", 1_700_000_000_000));
        using (var a = Session(other, OtherKey))
        {
            await Build(a, lone, Guid.NewGuid().ToString());
            await a.Store.Idle();
        }
        using var b = new Folder();
        using (var c = Session(b))
        {
            await Build(c, lone, Guid.NewGuid().ToString());
            await c.Store.Idle();
        }
        var targetUnit = Path.Combine(b.Path, b.Units.Single());
        lone.Reset();
        using (var d = Session(b))
        {
            // Let the opening sweep finish before replacing the file under another key, so the sweep does not remove it before Build lists.
            await d.Store.Idle();
            File.Copy(Path.Combine(other.Path, other.Units.Single()), targetUnit, overwrite: true);
            var id = Guid.NewGuid().ToString();
            await Build(d, lone, id);
            await d.Store.Idle();
            check(d.SavedLoads is { Refused: 1, Loaded: 0 } && lone.TableCalls == 1 && Hits(d, id, "orders") == 1, "a file under another key is counted and its dataset read as usual");
        }
    }

    // ---- What does not fit stays on disk ----

    private static async Task Budget(Action<bool, string> check)
    {
        using var folder = new Folder();
        var source = new Source();
        source.Add(Billing, "sales", new Item("TABLE", "orders", 1_700_000_000_000));
        source.Add("proj-b", "huge", [.. Enumerable.Range(0, 2000).Select(at => new Item("TABLE", "wide_table_with_a_long_name_" + at.ToString(System.Globalization.CultureInfo.InvariantCulture), 1_700_000_000_000, Columns: 8))]);
        source.Add("proj-b", "small", new Item("TABLE", "tiny", 1_700_000_000_000));
        long billingBytes, hugeBytes;
        using (var first = Session(folder))
        {
            await Build(first, source, Guid.NewGuid().ToString());
            await first.Store.Idle();
            billingBytes = Unit(first, Billing, "sales")!.Header.MemoryBytes;
            hugeBytes = Unit(first, "proj-b", "huge")!.Header.MemoryBytes;
        }
        var limit = billingBytes * 4;
        check(hugeBytes > limit && folder.Units.Length == 3, "the budget check's world: one discovered dataset larger than the whole limit");
        source.Reset();
        using var second = Session(folder, limits: new ObjectIndexLimits { MemoryBytes = limit, NamesReserveBytes = limit / ObjectIndexLimits.NamesReserveShare });
        var id = Guid.NewGuid().ToString();
        var result = await Build(second, source, id);
        await second.Store.Idle();
        check(second.SavedLoads is { Loaded: 1, Budget: 2, Refused: 0 } && Hits(second, id, "orders") == 1 && result.Status.State == "ready",
            "a load past the memory limit stays on disk, counted; once one discovered dataset does not fit, no other is tried");
        check(Unit(second, "proj-b", "huge") is not null && folder.Units.Length == 3, "what does not fit keeps its file");
    }
}
