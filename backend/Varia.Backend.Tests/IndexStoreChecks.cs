using System.Text;
using System.Text.Json;
using Varia.Backend.Protocol;
using Varia.Backend.Search;
using World = Varia.Backend.Tests.IndexFileChecks.World;

namespace Varia.Backend.Tests;

/// <summary>
/// The saved Search Objects index (docs/object-search.md, Saved index) on a temporary folder: how files are named and whose
/// they are, what a build on the fakes saves and what it must not, the queue (one entry per unit, a newer read or a deletion
/// in its place, a disconnect and a stop during a save), every rule of the delete-only sweep, the modes (encrypted, clear
/// text by choice, off), and what main may configure. No check sleeps: each waits for the store's own idle signal, and a
/// save is held where a check needs it by the store's hook.
/// </summary>
internal static class IndexStoreChecks
{
    private static readonly byte[] Key = [.. Enumerable.Range(0, 32).Select(at => (byte)(at * 5 + 11))];
    private static readonly byte[] OtherKey = [.. Enumerable.Range(0, 32).Select(at => (byte)(at * 3 + 7))];
    private const string Server = "PRODSQL-DISTINCTIVE\\INST1", Login = "sid:0105000000000005150000004c6f67696e", Database = "Sales";
    private const int MiB = 1024 * 1024;

    public static async Task RunAsync(Action<bool, string> check)
    {
        Names(check);
        Configuration(check);
        await SqlServerBuild(check);
        await BigQueryBuild(check);
        await NotSaved(check);
        await Queue(check);
        await Sweep(check);
        await Modes(check);
        await Opened(check);
        await Instances(check);
        await Clear(check);
        await Dispatch(check);
    }

    // ---- Helpers ----

    private sealed class Folder : IDisposable
    {
        public Folder()
        {
            Root = Directory.CreateTempSubdirectory("varia-index-store-").FullName;
            Path = System.IO.Path.Combine(Root, IndexStoreLimits.FolderName);
        }

        public string Root { get; }
        public string Path { get; }
        public string[] Files => Directory.Exists(Path) ? [.. Directory.GetFiles(Path).Select(System.IO.Path.GetFileName).OfType<string>().Order(StringComparer.Ordinal)] : [];
        public string[] Units => [.. Files.Where(name => IndexStoreNames.IsUnit(name))];
        public string File(string name) => System.IO.Path.Combine(Path, name);

        public void Dispose()
        {
            try { Directory.Delete(Root, recursive: true); }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
        }
    }

    private static IndexStoreConfigureArgs Args(Folder folder, string mode = "encrypted", byte[]? key = null, int limitMiB = IndexStoreLimits.DefaultDiskMiB) =>
        new(mode, folder.Path, limitMiB, mode is "encrypted" or "clearText" ? Convert.ToBase64String(key ?? Key) : null);

    private static async Task<IndexStore> Open(Folder folder, string mode = "encrypted", byte[]? key = null, int limitMiB = IndexStoreLimits.DefaultDiskMiB)
    {
        var store = new IndexStore();
        store.Configure(Args(folder, mode, key, limitMiB));
        await store.Idle();
        return store;
    }

    private static IndexStoreScope Scope(string server = Server, string login = Login) => IndexStoreScope.SqlServer(server, login)!;

    /// <summary>A world whose connection saves to <paramref name="store"/> as <paramref name="scope"/>.</summary>
    private static World Connected(IndexStore store, IndexStoreScope? scope = null)
    {
        var world = new World();
        world.Connection.Sink = store.Sink(scope ?? Scope());
        return world;
    }

    private static bool Holds(byte[] content, string text) =>
        content.AsSpan().IndexOf(Encoding.UTF8.GetBytes(text)) >= 0 || content.AsSpan().IndexOf(Encoding.Unicode.GetBytes(text)) >= 0;

    private static bool Refused(Action configure)
    {
        try { configure(); return false; }
        catch (RequestException error) { return error.Code == "INVALID_PARAMS"; }
    }

    /// <summary>Holds the store's writing thread at its next save until released: what a check queues meanwhile is queued
    /// behind a save in flight.</summary>
    private sealed class Held : IDisposable
    {
        private readonly ManualResetEventSlim entered = new(false), release = new(false);
        private readonly IndexStore store;
        private int armed = 1;

        public Held(IndexStore store)
        {
            this.store = store;
            store.Saving = _ =>
            {
                if (Interlocked.Exchange(ref armed, 0) == 0) return;
                entered.Set();
                release.Wait();
            };
        }

        public void WaitEntered() => entered.Wait();
        public void Release() => release.Set();
        public void Dispose() { release.Set(); store.Saving = null; }
    }

    // ---- Names ----

    private static void Names(Action<bool, string> check)
    {
        var nameKey = IndexStoreNames.NameKey(Key);
        string Name(IndexStoreScope scope, IndexUnitKind kind, string database, string? dataset = null, byte[]? under = null)
        {
            var scopeId = IndexStoreNames.ScopeId(under ?? nameKey, scope);
            return IndexStoreNames.FileName(scopeId, IndexStoreNames.UnitId(under ?? nameKey, scopeId, kind, database, dataset));
        }
        var name = Name(Scope(), IndexUnitKind.Database, Database);
        check(IndexStoreNames.IsUnit(name) && name.Length == IndexStoreNames.NameChars && !IndexStoreNames.IsTemporary(name)
            && new[] { "prodsql", "distinctive", "inst1", "sales", "0105", "6c6f67696e" }.All(part => !name.Contains(part, StringComparison.OrdinalIgnoreCase)),
            "a unit's file name is two hex tags and the extension, with nothing of the server's, login's or database's name in it");
        check(Name(Scope(), IndexUnitKind.Database, Database) == name && Name(Scope("  prodsql-distinctive\\inst1 "), IndexUnitKind.Database, Database) == name,
            "the same server and login name the same file, however the server's own name was cased or padded (two profiles share it)");
        var others = new[]
        {
            Name(Scope("OTHERSQL\\INST1"), IndexUnitKind.Database, Database), Name(Scope(login: "sid:0106"), IndexUnitKind.Database, Database),
            Name(Scope(), IndexUnitKind.Database, "sales"), Name(Scope(), IndexUnitKind.Server, Database), Name(Scope(), IndexUnitKind.Agent, Database),
            Name(IndexStoreScope.SqlServer(Server, Login, ownDatabase: true, database: "AppDb")!, IndexUnitKind.Database, Database),
            Name(IndexStoreScope.SqlServer(Server, Login, ownDatabase: true, database: "OtherDb")!, IndexUnitKind.Database, Database),
            Name(IndexStoreScope.BigQuery("bigquery:user:a@example.com")!, IndexUnitKind.Dataset, Database, "ds"),
            Name(IndexStoreScope.BigQuery("bigquery:user:b@example.com")!, IndexUnitKind.Dataset, Database, "ds"),
            Name(IndexStoreScope.BigQuery("bigquery:user:a@example.com")!, IndexUnitKind.Dataset, Database, "other"),
            Name(IndexStoreScope.BigQuery("bigquery:user:a@example.com")!, IndexUnitKind.Dataset, "Other", "ds"),
            Name(Scope(), IndexUnitKind.Database, Database, under: IndexStoreNames.NameKey(OtherKey))
        };
        check(others.All(other => other != name) && others.Distinct(StringComparer.Ordinal).Count() == others.Length,
            "another server, login, contained user's database, principal, kind, database, project or dataset, and another store's key, each names another file");
        check(Name(Scope(), IndexUnitKind.Database, "a", null) != Name(Scope(), IndexUnitKind.Database, "", "a")
            && IndexStoreNames.ScopeTag(IndexStoreNames.ScopeId(nameKey, IndexStoreScope.SqlServer("A", "BC")!)) != IndexStoreNames.ScopeTag(IndexStoreNames.ScopeId(nameKey, IndexStoreScope.SqlServer("AB", "C")!)),
            "names are length-prefixed before they are hashed, so no two lists of names run together into one");
        // A BigQuery scope has no billing project in it at all: only the principal.
        var principal = IndexStoreScope.BigQuery("bigquery:serviceAccount:reader@example.iam.gserviceaccount.com")!;
        check(Name(principal, IndexUnitKind.Dataset, "shared-project", "ds") == Name(IndexStoreScope.BigQuery("bigquery:serviceAccount:reader@example.iam.gserviceaccount.com")!, IndexUnitKind.Dataset, "shared-project", "ds"),
            "a BigQuery dataset's file is its principal's, whatever billing project a connection uses");
        var resourceScope = IndexStoreNames.ScopeId(nameKey, IndexStoreScope.Resource);
        var resource = IndexStoreNames.FileName(resourceScope, IndexStoreNames.UnitId(nameKey, resourceScope, IndexFileChecks.ResourceKey));
        check(resource == IndexStoreNames.FileName(resourceScope, IndexStoreNames.UnitId(nameKey, resourceScope, IndexFileChecks.ResourceKey with { }))
            && new[] { IndexFileChecks.ResourceKey with { Version = "17.0.1000.8" }, IndexFileChecks.ResourceKey with { Edition = 5 }, IndexFileChecks.ResourceKey with { Count = 5 },
                IndexFileChecks.ResourceKey with { Latest = null }, IndexFileChecks.ResourceKey with { Checksum = 43 }, IndexFileChecks.ResourceKey with { Definitions = false } }
                .All(key => IndexStoreNames.FileName(resourceScope, IndexStoreNames.UnitId(nameKey, resourceScope, key)) != resource),
            "the shared resource set is named by its key alone, every field of it");
        check(IndexStoreScope.SqlServer(null, Login) is null && IndexStoreScope.SqlServer(" ", Login) is null && IndexStoreScope.SqlServer(Server, null) is null
            && IndexStoreScope.SqlServer(Server, "") is null && IndexStoreScope.SqlServer(Server, Login, ownDatabase: true) is null && IndexStoreScope.BigQuery(null) is null
            && IndexStoreScope.BigQuery("") is null && new IndexStore().Sink(null) is null,
            "a connection whose server or account was not established, or a contained user whose database is unknown, has no scope, and nothing of it is saved");
        var temporary = name + ".0123456789abcdef" + IndexFile.TemporaryExtension;
        check(IndexStoreNames.IsTemporary(temporary) && !IndexStoreNames.IsUnit(temporary)
            && new[] { name.ToUpperInvariant(), name[1..], "x" + name, name.Replace('-', '_'), name[..^5] + ".idx", name + ".tmp", name + ".0123456789abcdeg.tmp", name + ".0123456789abcdef.bak",
                "notes.txt", "", new string('a', 70) }.All(other => !IndexStoreNames.IsUnit(other) && !IndexStoreNames.IsTemporary(other)),
            "only the store's own names are a unit's or a temporary file's: lower-case hex, the hyphen, the extensions, nothing else");
        var surrogate = "sales_\uD83D";
        var own = new byte[] { 1, 2, 3 };
        check(IndexStoreNames.TryReadSync(IndexStoreNames.Sync(surrogate, null, own), out var database, out var dataset, out var read) && database == surrogate && dataset is null && read.SequenceEqual(own)
            && IndexStoreNames.TryReadSync(IndexStoreNames.Sync("proj", "ds_İ", []), out database, out dataset, out read) && database == "proj" && dataset == "ds_İ" && read.Length == 0
            && !IndexStoreNames.TryReadSync([], out _, out _, out _) && !IndexStoreNames.TryReadSync([2, 0, 0, 0], out _, out _, out _) && !IndexStoreNames.TryReadSync([1, 9, 0, 65, 0, 0], out _, out _, out _)
            && !IndexStoreNames.TryReadSync(IndexStoreNames.Sync("proj", "ds", [])[..^1], out _, out _, out _),
            "a header's sync state carries the unit's names (an unpaired surrogate as it was) before the builder's bytes, and anything else is refused");
        var sync = new BigQuerySync(true, 7, 2, 3);
        check(BigQuerySync.From(sync.ToBytes()) == sync && BigQuerySync.From(new BigQuerySync(false, 0, 0, 0).ToBytes()) == new BigQuerySync(false, 0, 0, 0)
            && BigQuerySync.From([]) is null && BigQuerySync.From([.. sync.ToBytes(), 0]) is null && BigQuerySync.From([1, .. sync.ToBytes()[1..]]) is null && BigQuerySync.From([3, .. sync.ToBytes()[1..]]) is null
            && BigQuerySync.From((sync with { Listing = "00112233445566778899aabbccddeeff" }).ToBytes()) is { Listing: "00112233445566778899aabbccddeeff" },
            "a BigQuery dataset's sync state round-trips, and bytes another version wrote read as none");
    }

    // ---- What main may configure ----

    private static void Configuration(Action<bool, string> check)
    {
        using var folder = new Folder();
        var store = new IndexStore();
        var key = Convert.ToBase64String(Key);
        check(store.Status is null && store.Mode is null, "a store main has not configured has no status and saves nothing");
        var hostile = new (string What, IndexStoreConfigureArgs Args)[]
        {
            ("an unknown mode", new("plain", folder.Path, 2048, key)), ("the mode unavailable, which only the store answers", new("unavailable", folder.Path, 2048)),
            ("a relative folder", new("encrypted", IndexStoreLimits.FolderName, 2048, key)), ("a folder of another name", new("encrypted", folder.Root, 2048, key)),
            ("a folder reached through ..", new("encrypted", Path.Combine(folder.Root, "x", "..", IndexStoreLimits.FolderName), 2048, key)),
            ("a folder with a trailing separator", new("encrypted", folder.Path + Path.DirectorySeparatorChar, 2048, key)),
            ("a folder holding a NUL", new("encrypted", folder.Path.Insert(3, "\0"), 2048, key)), ("an empty folder", new("encrypted", "", 2048, key)),
            ("a folder past the limit", new("encrypted", Path.Combine(folder.Root, new string('d', IndexStoreLimits.FolderChars), IndexStoreLimits.FolderName), 2048, key)),
            ("no key for a mode that saves", new("encrypted", folder.Path, 2048)), ("no key for clear text", new("clearText", folder.Path, 2048)),
            ("a key with saving off", new("disabled", folder.Path, 2048, key)), ("a key without a key store", new("noKeyStore", folder.Path, 2048, key)),
            ("a short key", new("encrypted", folder.Path, 2048, Convert.ToBase64String(Key[..31]))), ("a long key", new("encrypted", folder.Path, 2048, Convert.ToBase64String([.. Key, 1]))),
            ("a key that is not base64", new("encrypted", folder.Path, 2048, new string('!', IndexStoreLimits.KeyChars))),
            ("a limit below the least", new("encrypted", folder.Path, IndexStoreLimits.MinDiskMiB - 1, key)), ("a limit above the most", new("encrypted", folder.Path, IndexStoreLimits.MaxDiskMiB + 1, key)),
            ("no limit", new("encrypted", folder.Path, null, key)), ("a negative limit", new("encrypted", folder.Path, -2048, key))
        };
        foreach (var (what, args) in hostile)
            check(Refused(() => store.Configure(args)) && store.Status is null && !Directory.Exists(folder.Path), "the store refuses " + what + " before it touches anything");
        var least = store.Configure(new("encrypted", folder.Path, IndexStoreLimits.MinDiskMiB, key));
        check(least is { Mode: "encrypted", Files: 0, Bytes: 0 } && least.LimitBytes == (long)IndexStoreLimits.MinDiskMiB * MiB && Directory.Exists(folder.Path)
            && store.Configure(new("encrypted", folder.Path, IndexStoreLimits.MaxDiskMiB, key)).LimitBytes == (long)IndexStoreLimits.MaxDiskMiB * MiB,
            "the store takes its least and its most limit, and makes its folder");
        if (!OperatingSystem.IsWindows())
            check(File.GetUnixFileMode(folder.Path) == (UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute), "the store's folder is the user's alone");
        store.Dispose();

        // A folder that is not a directory of its own: nothing is saved there, and nothing in it is deleted.
        using var blocked = new Folder();
        File.WriteAllText(blocked.Path, "a file where the folder should be");
        var onFile = new IndexStore();
        check(onFile.Configure(Args(blocked)).Mode == "unavailable" && onFile.Sink(Scope()) is not null && File.Exists(blocked.Path), "a store whose folder is a file is unavailable, and the file stays");
        onFile.Dispose();
        using var linked = new Folder();
        var target = Directory.CreateDirectory(Path.Combine(linked.Root, "elsewhere")).FullName;
        var victim = Path.Combine(target, new string('a', 32) + "-" + new string('b', 32) + IndexStoreNames.Extension);
        File.WriteAllBytes(victim, new byte[200]);
        File.SetLastWriteTimeUtc(victim, DateTime.UtcNow.AddDays(-90));
        try
        {
            Directory.CreateSymbolicLink(linked.Path, target);
            var onLink = new IndexStore();
            var status = onLink.Configure(Args(linked));
            onLink.Idle().Wait();
            check(status.Mode == "unavailable" && File.Exists(victim), "a store whose folder is a link to another folder is unavailable: the sweep never runs through the link");
            onLink.Dispose();
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or PlatformNotSupportedException)
        {
            Console.WriteLine("SKIP IndexStore: this account may not create a symbolic link to a folder (" + error.GetType().Name + ")");
        }
    }

    // ---- A SQL Server-shaped build on the fakes ----

    private static async Task SqlServerBuild(Action<bool, string> check)
    {
        using var folder = new Folder();
        using var store = await Open(folder);
        var world = Connected(store);
        var database = await IndexFileChecks.Database(world);
        ObjectSearchService.Holding(world.Connection, children: true)(database);
        var server = await IndexFileChecks.Server(world);
        world.Connection.PutServer(server);
        var agent = await IndexFileChecks.Agent(world);
        world.Connection.PutAgent(agent);
        var set = await world.Catalog.AcquireAsync(IndexFileChecks.ResourceKey, _ => IndexFileChecks.ResourceObjects(world));
        world.Connection.PutResource(set);
        await store.Idle();
        var listed = store.List(Scope());
        check(folder.Units.Length == 4 && folder.Files.Length == 4 && store.Counts is { Saved: 4, Failed: 0 } && store.Status is { Mode: "encrypted", Files: 4 } status
            && status.Bytes == folder.Units.Sum(name => new FileInfo(folder.File(name)).Length),
            "a build's database, server objects, Agent objects and shared resource set are each saved to a file of their own, and the status counts them");
        check(listed.Count == 3 && listed.Select(unit => (unit.Kind, unit.Database, unit.Dataset)).Order().SequenceEqual(new (IndexUnitKind, string, string?)[]
            { (IndexUnitKind.Database, Database, null), (IndexUnitKind.Server, ObjectSearchService.ServerScope, null), (IndexUnitKind.Agent, "msdb", null) }.Order())
            && listed.All(unit => unit.Header is { Encrypted: true, Definitions: true, Children: true } && unit.Sync.Length == 0 && unit.FileBytes > 0)
            && listed.Single(unit => unit.Kind == IndexUnitKind.Database).Header.Objects == database.Table.Count,
            "a connection's saved units are listed by their headers: kind, names, what each holds, and no fingerprint yet for SQL Server");
        // Every unit loads back equal, through IndexFile.LoadFile, into another process's world.
        var equal = true;
        var again = new World();
        foreach (var (unit, original) in new[] { (IndexUnitKind.Database, database), (IndexUnitKind.Server, server), (IndexUnitKind.Agent, agent) })
        {
            var saved = listed.Single(item => item.Kind == unit);
            var loaded = store.Load(saved, again.Connection, again.Limits, again.Pool);
            equal &= loaded.Problem == IndexFileProblem.None && loaded.Value is { } read && IndexFileChecks.Dump(read) == IndexFileChecks.Dump(original);
            if (loaded.Value is { } held) again.Hold(held, unit);
        }
        var resource = store.LoadResource(IndexFileChecks.ResourceKey, long.MaxValue);
        equal &= resource.Problem == IndexFileProblem.None && resource.Value is { } loadedSet && loadedSet.Key == IndexFileChecks.ResourceKey
            && IndexFileChecks.Dump(loadedSet.Read.Table) == IndexFileChecks.Dump(set.Table);
        check(equal, "each saved unit loads back equal to the read that was saved");
        var savedSoFar = store.Counts.Saved;
        await store.Idle();
        check(store.Counts.Saved == savedSoFar && again.Connection.Held.Count == 3 && again.Connection.Held.All(read => !read.SaveWhenHeld), "holding a loaded unit does not save it again");
        check(store.Find(Scope(), IndexUnitKind.Database, Database) is { Kind: IndexUnitKind.Database } && store.Find(Scope(), IndexUnitKind.Database, "sales") is null
            && store.Find(Scope("OTHERSQL"), IndexUnitKind.Database, Database) is null && store.List(Scope(login: "sid:0199")).Count == 0 && store.List(Scope("OTHERSQL")).Count == 0
            && store.LoadResource(IndexFileChecks.ResourceKey with { Checksum = 7 }, long.MaxValue).Value is null,
            "another server or login finds none of it, and a unit is found by its own names only");
        var distinctive = new[] { "usp_long", "trg_logon", "Nightly", "sp_who", "Orders", "PRODSQL", "DISTINCTIVE", "Sales", "msdb", "0105000000000005150000004c6f67696e" };
        check(folder.Units.All(name => File.ReadAllBytes(folder.File(name)) is var content && distinctive.All(text => !Holds(content, text))),
            "no saved file holds an object's, a database's, the server's or the login's name in UTF-8 or UTF-16");
        // A listing reads headers only: a body damaged after the header still lists, and only its load fails.
        var path = folder.File(NameOf(IndexUnitKind.Server));
        var bytes = File.ReadAllBytes(path);
        bytes[^20] ^= 0x55;
        File.WriteAllBytes(path, bytes);
        var damaged = store.Load(store.List(Scope()).Single(unit => unit.Kind == IndexUnitKind.Server), again.Connection, again.Limits, again.Pool);
        check(store.List(Scope()).Count == 3 && damaged.Value is null && damaged.Problem == IndexFileProblem.Corrupt, "a listing reads no body: a damaged body still lists, and its load fails as a value");

        // Mark used moves the file's last use; a listing does not.
        var databaseUnit = store.List(Scope()).Single(unit => unit.Kind == IndexUnitKind.Database);
        var databasePath = folder.File(NameOf(IndexUnitKind.Database));
        File.SetLastWriteTimeUtc(databasePath, DateTime.UtcNow.AddDays(-10));
        var beforeList = File.GetLastWriteTimeUtc(databasePath);
        store.List(Scope());
        var afterList = File.GetLastWriteTimeUtc(databasePath);
        var marked = store.MarkUsed(databaseUnit);
        check(afterList == beforeList && marked && DateTime.UtcNow - File.GetLastWriteTimeUtc(databasePath) < TimeSpan.FromMinutes(5), "listing a unit does not count as using it; marking it used does");
        File.SetLastWriteTimeUtc(databasePath, DateTime.UtcNow.AddDays(-10));
        var reloaded = store.Load(databaseUnit, again.Connection, again.Limits, again.Pool);
        if (reloaded.Value is { } loadedAgain) again.Connection.Abandon(loadedAgain);
        check(reloaded.Problem == IndexFileProblem.None && DateTime.UtcNow - File.GetLastWriteTimeUtc(databasePath) < TimeSpan.FromMinutes(5), "loading a unit counts as using it");

        // The same set held by a second build is not written again; a rebuilt database is.
        var savedBefore = store.Counts.Saved;
        world.Connection.PutResource(await world.Catalog.AcquireAsync(IndexFileChecks.ResourceKey, _ => IndexFileChecks.ResourceObjects(world)));
        var rebuilt = await IndexFileChecks.Database(world, credit: database);
        ObjectSearchService.Holding(world.Connection, children: true)(rebuilt);
        await store.Idle();
        check(store.Counts.Saved == savedBefore + 1 && folder.Units.Length == 4, "a rebuild saves its database again in place, and marks the shared set it still holds used rather than writing it again");
        // The shared set's file gone (another Varia's sweep, a Clear elsewhere): the next build that holds the set saves it again.
        var resourceFile = folder.Units.Single(name => name != NameOf(IndexUnitKind.Server) && name != NameOf(IndexUnitKind.Agent) && name != NameOf(IndexUnitKind.Database));
        File.Delete(folder.File(resourceFile));
        var savedBeforeGone = store.Counts.Saved;
        world.Connection.PutResource(await world.Catalog.AcquireAsync(IndexFileChecks.ResourceKey, _ => IndexFileChecks.ResourceObjects(world)));
        await store.Idle();
        check(store.Counts.Saved == savedBeforeGone + 1 && folder.Units.Contains(resourceFile), "a shared set whose file has gone is saved again by the next build that holds it");

        // A database the listing no longer names is dropped from the index and from the store; a disconnect keeps the files.
        world.Connection.Keep(new HashSet<string>(StringComparer.Ordinal));
        await store.Idle();
        check(folder.Units.Length == 3 && store.Find(Scope(), IndexUnitKind.Database, Database) is null && store.Status is { Files: 3 }, "a database the server no longer lists has its file deleted");
        world.Connection.Dispose();
        await store.Idle();
        check(folder.Units.Length == 3 && store.List(Scope()).Count == 2, "a disconnect deletes nothing that was saved");
        again.Connection.Dispose();

        static string NameOf(IndexUnitKind kind)
        {
            var nameKey = IndexStoreNames.NameKey(Key);
            var scopeId = IndexStoreNames.ScopeId(nameKey, Scope());
            var database = kind == IndexUnitKind.Database ? Database : kind == IndexUnitKind.Agent ? "msdb" : ObjectSearchService.ServerScope;
            return IndexStoreNames.FileName(scopeId, IndexStoreNames.UnitId(nameKey, scopeId, kind, database, null));
        }
    }

    // ---- A BigQuery build on the fakes ----

    private static async Task BigQueryBuild(Action<bool, string> check)
    {
        using var folder = new Folder();
        const string Principal = "bigquery:user:indexer-distinctive@example.com";
        var scope = IndexStoreScope.BigQuery(Principal)!;
        var source = new BigQueryIndexChecks.FakeBudgetSource(discoveredProjects: ["disc-01", "disc-02"], tablesPerDiscovered: 3, columnsPerTable: 4) { PrincipalId = Principal };
        using var search = new ObjectSearchService(new BigQueryIndexChecks.UnusedHost());
        search.Store.Configure(Args(folder));
        var id = Guid.NewGuid().ToString();

        // Pass 2 is held at the first discovered table: what pass 1 held is saved meanwhile, and says details are still to read.
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        source.OnTableAsync = async (_, token) => { entered.TrySetResult(); await release.Task.WaitAsync(token); };
        var build = search.IndexBigQueryAsync(new ObjectIndexArgs(id, Guid.NewGuid().ToString()), source, CancellationToken.None);
        await entered.Task;
        await search.Store.Idle();
        var early = search.Store.List(scope);
        var pending = early.Where(unit => unit.Database.StartsWith("disc-", StringComparison.Ordinal)).Select(unit => BigQuerySync.From(unit.Sync)).ToList();
        check(early.Count == 3 && pending.Count == 2 && pending.All(sync => sync is { Pending: 3, Failed: 0, ListingCut: false }),
            "a dataset is saved as soon as its names are held, and its file says how many objects' details are still to read");
        release.SetResult();
        await build;
        await search.Store.Idle();
        var held = search.HeldOf(id).Where(read => read.Dataset is not null).ToList();
        var listed = search.Store.List(scope);
        var again = new World();
        var equal = listed.Count == held.Count && held.Count == 3;
        foreach (var read in held)
        {
            var unit = listed.SingleOrDefault(item => item.Database == read.Database && item.Dataset == read.Dataset);
            equal &= unit is { Kind: IndexUnitKind.Dataset } && BigQuerySync.From(unit.Sync) is { Pending: 0, Failed: 0, LeftOut: 0, ListingCut: false };
            if (unit is null) continue;
            var loaded = search.Store.Load(unit, again.Connection, again.Limits, again.Pool, discovered: read.Database != "varia-alpha");
            equal &= loaded.Value is { } value && IndexFileChecks.Dump(value) == IndexFileChecks.Dump(read) && value.Detailed;
            if (loaded.Value is { } put) again.Connection.Put(put);
        }
        check(equal && folder.Units.Length == 3, "every dataset a BigQuery build holds is saved once its details are read, says nothing is left to read, and loads back equal");
        check(folder.Units.All(name => File.ReadAllBytes(folder.File(name)) is var content
            && new[] { "disc-01", "varia-alpha", "sales", "disc-01_tbl_0", "col_disc-01_0", "indexer-distinctive" }.All(text => !Holds(content, text) && !name.Contains(text, StringComparison.OrdinalIgnoreCase))),
            "no dataset's file or file name holds a project's, a dataset's, a table's, a column's or the principal's name");
        check(search.Store.List(IndexStoreScope.BigQuery("bigquery:user:someone-else@example.com")!).Count == 0, "another principal finds none of them");
        again.Connection.Dispose();

        // DDL marks a dataset stale: its file goes until a build has read it again.
        search.MarkStale(id, "disc-01", "ds");
        await search.Store.Idle();
        check(folder.Units.Length == 2 && search.Store.Find(scope, IndexUnitKind.Dataset, "disc-01", "ds") is null, "a dataset DDL marked stale has its file deleted");
        await search.IndexBigQueryAsync(new ObjectIndexArgs(id, Guid.NewGuid().ToString(), Stale: true), source, CancellationToken.None);
        await search.Store.Idle();
        check(folder.Units.Length == 3 && search.Store.Find(scope, IndexUnitKind.Dataset, "disc-01", "ds") is not null, "the build that reads a stale dataset again saves it again");
        search.MarkProjectStale(id, "disc-02");
        await search.Store.Idle();
        check(folder.Units.Length == 2 && search.Store.Find(scope, IndexUnitKind.Dataset, "disc-02", "ds") is null, "DDL that may have touched a whole project deletes the files of the datasets held of it");
        await search.IndexBigQueryAsync(new ObjectIndexArgs(id, Guid.NewGuid().ToString(), Stale: true), source, CancellationToken.None);
        await search.Store.Idle();

        // DDL that lands while a dataset is being read: the read may predate it, so it is held but no file stands for it.
        var marking = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var marked = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        source.OnTableAsync = null;
        source.OnDatasetObjectsAsync = async (project, _, token) =>
        {
            if (project != "disc-01") return;
            marking.TrySetResult();
            await marked.Task.WaitAsync(token);
        };
        var racing = search.IndexBigQueryAsync(new ObjectIndexArgs(id, Guid.NewGuid().ToString(), Scope: new("disc-01", "ds")), source, CancellationToken.None);
        await marking.Task;
        search.MarkStale(id, "disc-01", "ds");
        marked.SetResult();
        await racing;
        await search.Store.Idle();
        source.OnDatasetObjectsAsync = null;
        check(search.HeldOf(id).Any(read => read is { Database: "disc-01", Dataset: "ds" }) && search.Store.Find(scope, IndexUnitKind.Dataset, "disc-01", "ds") is null
            && search.StaleOf(id).Contains(("disc-01", "ds")), "a dataset DDL marked stale while it was being read is held but not saved");
        await search.IndexBigQueryAsync(new ObjectIndexArgs(id, Guid.NewGuid().ToString(), Stale: true), source, CancellationToken.None);
        await search.Store.Idle();
        check(search.Store.Find(scope, IndexUnitKind.Dataset, "disc-01", "ds") is not null && folder.Units.Length == 3, "and is saved by the build that reads it after the mark");

        // The files are the principal's: DDL from any of its connections, indexing the project or not (SqlService's Record calls
        // MarkSavedStale for every mark), deletes the file and keeps every connection's read begun before it from being saved.
        search.MarkSavedStale(Principal, "disc-01", "ds");
        await search.Store.Idle();
        check(search.Store.Find(scope, IndexUnitKind.Dataset, "disc-01", "ds") is null && folder.Units.Length == 2, "DDL from a connection that does not index the dataset deletes the principal's file of it");
        await search.IndexBigQueryAsync(new ObjectIndexArgs(id, Guid.NewGuid().ToString(), Scope: new("disc-01", "ds")), source, CancellationToken.None);
        await search.Store.Idle();
        var other = Guid.NewGuid().ToString();
        var otherMarking = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var otherMarked = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        source.OnDatasetObjectsAsync = async (project, _, token) =>
        {
            if (project != "disc-01") return;
            otherMarking.TrySetResult();
            await otherMarked.Task.WaitAsync(token);
        };
        var otherBuild = search.IndexBigQueryAsync(new ObjectIndexArgs(other, Guid.NewGuid().ToString(), Scope: new("disc-01", "ds")), source, CancellationToken.None);
        await otherMarking.Task;
        // DDL run from the first connection while the second one reads the dataset.
        search.MarkStaleIfTracked(id, "varia-alpha", "disc-01", "ds");
        search.MarkSavedStale(Principal, "disc-01", "ds");
        otherMarked.SetResult();
        await otherBuild;
        await search.Store.Idle();
        source.OnDatasetObjectsAsync = null;
        check(search.HeldOf(other).Any(read => read is { Database: "disc-01", Dataset: "ds" }) && search.Store.Find(scope, IndexUnitKind.Dataset, "disc-01", "ds") is null,
            "a read another connection of the principal began before DDL from this one is held but not saved");
        await search.IndexBigQueryAsync(new ObjectIndexArgs(other, Guid.NewGuid().ToString(), Scope: new("disc-01", "ds")), source, CancellationToken.None);
        await search.Store.Idle();
        check(search.Store.Find(scope, IndexUnitKind.Dataset, "disc-01", "ds") is not null, "and a read begun after the mark is saved");
        search.Forget(other);
        search.MarkSavedStale(Principal, "disc-02", null);
        await search.Store.Idle();
        check(search.Store.Find(scope, IndexUnitKind.Dataset, "disc-02", "ds") is null && search.Store.Find(scope, IndexUnitKind.Dataset, "disc-01", "ds") is not null,
            "DDL that may have touched a whole project deletes the principal's files of that project's datasets, and only those");
        await search.IndexBigQueryAsync(new ObjectIndexArgs(id, Guid.NewGuid().ToString(), Scope: new("disc-02", "ds")), source, CancellationToken.None);
        await search.Store.Idle();
        check(folder.Units.Length == 3, "and the next read of it saves it again");
        search.MarkSavedStale("bigquery:user:someone-else@example.com", "disc-01", "ds");
        await search.Store.Idle();
        check(folder.Units.Length == 3, "another principal's DDL deletes none of this principal's files");

        // A dataset gone from its project's listing loses its file; a project that only left what this connection indexes keeps its files.
        source.CustomDatasets = new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal) { ["disc-02"] = [] };
        await search.IndexBigQueryAsync(new ObjectIndexArgs(id, Guid.NewGuid().ToString()), source, CancellationToken.None);
        await search.Store.Idle();
        check(search.Store.Find(scope, IndexUnitKind.Dataset, "disc-02", "ds") is null && folder.Units.Length == 2, "a dataset its project no longer lists has its file deleted");
        await search.IndexBigQueryAsync(new ObjectIndexArgs(id, Guid.NewGuid().ToString(), AllProjects: false), source, CancellationToken.None);
        await search.Store.Idle();
        check(!search.HeldOf(id).Any(read => read.Database == "disc-01") && search.Store.Find(scope, IndexUnitKind.Dataset, "disc-01", "ds") is not null,
            "a project that left what this connection indexes is dropped from its index, and its datasets' files stay for the principal's other connections");

        // DDL on a whole project while the writer is busy, then a stop: the project's dataset files go all the same.
        var alpha = search.Store.List(scope).FirstOrDefault(unit => unit.Database == "varia-alpha");
        using (var stopping = new IndexStore())
        {
            stopping.Configure(Args(folder));
            await stopping.Idle();
            var busy = Connected(stopping);
            using var blocked = new ManualResetEventSlim(false);
            using var writing = new ManualResetEventSlim(false);
            stopping.Saving = _ => { writing.Set(); blocked.Wait(); };
            busy.Connection.Put(await IndexFileChecks.Database(busy, name: "Busy"));
            writing.Wait();
            stopping.MarkStale(scope, "varia-alpha", null);
            stopping.Dispose();
            blocked.Set();
        }
        check(alpha is not null && search.Store.List(scope).All(unit => unit.Database != "varia-alpha"), "DDL on a project just before a stop deletes that project's dataset files even so");

        // DDL on a whole project before main configures a store: the project's dataset files go once it saves.
        using (var later = new IndexStore())
        {
            later.MarkStale(scope, "disc-01", null);
            later.Configure(Args(folder));
            await later.Idle();
        }
        check(search.Store.Find(scope, IndexUnitKind.Dataset, "disc-01", "ds") is null, "DDL on a project before the store saves deletes that project's dataset files once it does");

        // A detail read that fails is counted in the dataset's file; the dataset's names are saved all the same.
        using var failing = new Folder();
        using var failed = new ObjectSearchService(new BigQueryIndexChecks.UnusedHost());
        failed.Store.Configure(Args(failing));
        var failSource = new BigQueryIndexChecks.FakeBudgetSource(discoveredProjects: ["disc-01"], tablesPerDiscovered: 2, columnsPerTable: 2) { PrincipalId = Principal, FailTableForProject = "disc-01" };
        var failId = Guid.NewGuid().ToString();
        await failed.IndexBigQueryAsync(new ObjectIndexArgs(failId, Guid.NewGuid().ToString()), failSource, CancellationToken.None);
        await failed.Store.Idle();
        var partial = failed.Store.Find(scope, IndexUnitKind.Dataset, "disc-01", "ds");
        check(partial is not null && BigQuerySync.From(partial.Sync) is { Failed: 2, Pending: 0 } && partial.Header.Objects >= 3,
            "a dataset whose details could not be read is saved with its names, and its file counts the objects left without details");

        // A connection with no verified principal saves nothing.
        using var anonymous = new Folder();
        using var unnamed = new ObjectSearchService(new BigQueryIndexChecks.UnusedHost());
        unnamed.Store.Configure(Args(anonymous));
        await unnamed.IndexBigQueryAsync(new ObjectIndexArgs(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), AllProjects: false),
            new BigQueryIndexChecks.FakeBudgetSource(discoveredProjects: [], tablesPerDiscovered: 1, columnsPerTable: 1), CancellationToken.None);
        await unnamed.Store.Idle();
        check(anonymous.Files.Length == 0, "a BigQuery connection without a verified principal saves nothing");
    }

    // ---- What must not be saved, and what is saved as what it is ----

    private static async Task NotSaved(Action<bool, string> check)
    {
        using var folder = new Folder();
        using var store = await Open(folder);
        var world = Connected(store);

        // A read that failed part way is held when nothing was held before, and never saved.
        var partial = new DatabaseReader(Database, world.Limits, world.Pool);
        var broken = IndexFileChecks.DatabaseBatch(children: true, definitions: true);
        broken.FailAtResult = 1;
        try { await partial.ReadAsync(broken, true, CancellationToken.None); }
        catch (InvalidOperationException) { }
        ObjectSearchService.KeepPartial(partial, held: false, ObjectSearchService.Holding(world.Connection, children: true));
        await store.Idle();
        check(world.Connection.Get(Database) is { FailedPart: true } && folder.Files.Length == 0 && store.Counts.Saved == 0, "a read that failed part way is held and not saved");

        // A read its builder marks as not to be saved, a BigQuery project's own entry, and a read with too large a sync state.
        var unsaved = await IndexFileChecks.Database(world, name: "Unsaved");
        unsaved.SaveWhenHeld = false;
        world.Connection.Put(unsaved);
        var heavy = await IndexFileChecks.Database(world, name: "Heavy");
        heavy.Sync = new byte[IndexStoreLimits.SyncBytes + 1];
        world.Connection.Put(heavy);
        var bigQuery = Connected(store, IndexStoreScope.BigQuery("bigquery:user:a@example.com"));
        bigQuery.Connection.Put(await IndexFileChecks.Database(bigQuery, name: "a-project"));
        var mixed = IndexFileChecks.Dataset(world, IndexFileChecks.DatasetEntries());
        world.Connection.Put(mixed);
        await store.Idle();
        check(folder.Files.Length == 0 && store.Counts.Saved == 0, "a read marked as not to be saved, one whose sync state is past the limit, a BigQuery project's own entry, and a dataset on a SQL Server connection are not saved");

        // A read without children and a read without definitions are saved, and their headers say so.
        var bare = await IndexFileChecks.Database(world, children: false, name: "Bare");
        ObjectSearchService.Holding(world.Connection, children: false)(bare);
        var names = await IndexFileChecks.Database(world, definitions: false, name: "NamesOnly");
        ObjectSearchService.Holding(world.Connection, children: true)(names);
        var withSync = await IndexFileChecks.Database(world, name: "Fingerprinted");
        withSync.Sync = new byte[] { 9, 8, 7 };
        withSync.Extra = new byte[] { 1, 2, 3, 4 };
        world.Connection.Put(withSync);
        await store.Idle();
        var saved = store.List(Scope());
        var again = new World();
        var loadedExtra = store.Load(saved.Single(unit => unit.Database == "Fingerprinted"), again.Connection, again.Limits, again.Pool);
        check(saved.Count == 3 && saved.Single(unit => unit.Database == "Bare").Header is { Children: false, Definitions: true }
            && saved.Single(unit => unit.Database == "NamesOnly").Header is { Children: true, Definitions: false }
            && saved.Single(unit => unit.Database == "Fingerprinted").Sync.SequenceEqual(new byte[] { 9, 8, 7 }) && loadedExtra.Extra is { } extra && extra.SequenceEqual(new byte[] { 1, 2, 3, 4 }),
            "a read without children and a read without definitions are saved as such in their headers, and a builder's sync state and extra bytes come back with the unit");
        if (loadedExtra.Value is { } value) again.Connection.Abandon(value);

        // A connection with no scope, a disconnected index, and a store that is not configured or does not save.
        var before = store.Counts.Saved;
        var scopeless = new World();
        scopeless.Connection.Sink = store.Sink(IndexStoreScope.SqlServer(null, Login));
        scopeless.Connection.Put(await IndexFileChecks.Database(scopeless));
        var gone = Connected(store, Scope("GONE"));
        gone.Connection.Dispose();
        gone.Connection.Put(await IndexFileChecks.Database(gone));
        await store.Idle();
        check(store.Counts.Saved == before && store.List(Scope("GONE")).Count == 0, "a connection without a scope and a disconnected index save nothing");
        using var unconfigured = new IndexStore();
        var silent = Connected(unconfigured);
        silent.Connection.Put(await IndexFileChecks.Database(silent));
        await unconfigured.Idle();
        check(unconfigured.Counts.Saved == 0 && unconfigured.List(Scope()).Count == 0 && unconfigured.Find(Scope(), IndexUnitKind.Database, Database) is null
            && (await unconfigured.ClearAsync()) is { Files: 0, Bytes: 0, Kept: 0 }, "a store main has not configured saves, lists and clears nothing");
    }

    // ---- The queue ----

    private static async Task Queue(Action<bool, string> check)
    {
        // One entry per unit: reads of a unit queued behind a save in flight are written once, the newest.
        {
            using var folder = new Folder();
            using var store = await Open(folder);
            var world = Connected(store);
            using var held = new Held(store);
            world.Connection.Put(await IndexFileChecks.Database(world, name: "First"));
            held.WaitEntered();
            DatabaseIndex? last = null;
            for (var round = 0; round < 3; round++)
            {
                last = await IndexFileChecks.Database(world, credit: last, extraTables: round, name: "Busy");
                world.Connection.Put(last);
            }
            held.Release();
            await store.Idle();
            var saved = store.Find(Scope(), IndexUnitKind.Database, "Busy");
            check(store.Counts.Saved == 2 && folder.Units.Length == 2 && saved?.Header.ReadAt == last!.ReadAt && saved.Header.Objects == last.Table.Count,
                "three reads of a database queued behind a save are written once, as the newest");
        }
        // A newer read of the unit being written stops that write and takes its place.
        {
            using var folder = new Folder();
            using var store = await Open(folder);
            var world = Connected(store);
            using var held = new Held(store);
            var first = await IndexFileChecks.Database(world);
            world.Connection.Put(first);
            held.WaitEntered();
            var second = await IndexFileChecks.Database(world, credit: first, extraTables: 2);
            world.Connection.Put(second);
            held.Release();
            await store.Idle();
            var saved = store.Find(Scope(), IndexUnitKind.Database, Database);
            check(store.Counts is { Saved: 1, Failed: 0 } && folder.Files.Length == 1 && saved?.Header.Objects == second.Table.Count && saved.Header.ReadAt == second.ReadAt,
                "a newer read of the unit being written stops that write (no failure, no temporary file left) and is the one saved");
        }
        // A unit dropped as gone while its save is queued, or being written, is not saved.
        {
            using var folder = new Folder();
            using var store = await Open(folder);
            var world = Connected(store);
            using var held = new Held(store);
            world.Connection.Put(await IndexFileChecks.Database(world, name: "Writing"));
            held.WaitEntered();
            world.Connection.Put(await IndexFileChecks.Database(world, name: "Queued"));
            world.Connection.Keep(new HashSet<string>(StringComparer.Ordinal));
            held.Release();
            await store.Idle();
            check(folder.Files.Length == 0 && store.Counts is { Saved: 0, Failed: 0 } && store.Status is { Files: 0, Bytes: 0 },
                "a database dropped as gone while its save is queued or being written leaves no file");
        }
        // A disconnect during a save gives the memory back at once and keeps nothing alive the budget no longer counts: the read
        // being written is written whole (it loads back), and the one queued is withdrawn.
        {
            using var folder = new Folder();
            using var store = await Open(folder);
            var world = Connected(store);
            using var held = new Held(store);
            var writing = await IndexFileChecks.Database(world, name: "Writing");
            var writingDump = IndexFileChecks.Dump(writing);
            world.Connection.Put(writing);
            held.WaitEntered();
            var queued = await IndexFileChecks.Database(world, name: "Queued", extraTables: 1);
            var queuedDump = IndexFileChecks.Dump(queued);
            world.Connection.Put(queued);
            world.Connection.Dispose();
            var freed = world.Budget.Used;
            held.Release();
            await store.Idle();
            var again = new World();
            var loaded = store.List(Scope()).ToDictionary(unit => unit.Database, unit => store.Load(unit, again.Connection, again.Limits, again.Pool));
            check(freed == 0 && store.Counts is { Saved: 1, Failed: 0 } && loaded.Count == 1 && loaded["Writing"].Value is { } one && IndexFileChecks.Dump(one) == writingDump
                && !loaded.ContainsKey("Queued") && queuedDump.Length > 0,
                "a disconnect during a save gives the index's memory back at once, finishes the write in progress whole, and withdraws the save still queued");
            foreach (var load in loaded.Values) if (load.Value is { } value) again.Connection.Abandon(value);
        }
        // A stop during a save leaves the earlier file, and no temporary file.
        {
            using var folder = new Folder();
            var store = await Open(folder);
            var world = Connected(store);
            var first = await IndexFileChecks.Database(world);
            world.Connection.Put(first);
            await store.Idle();
            var before = File.ReadAllBytes(folder.File(folder.Units.Single()));
            using var held = new Held(store);
            world.Connection.Put(await IndexFileChecks.Database(world, credit: first, extraTables: 3));
            world.Connection.Put(await IndexFileChecks.Database(world, name: "Never"));
            held.WaitEntered();
            var stopping = Task.Run(store.Dispose);
            while (!store.Stopped) await Task.Yield();
            held.Release();
            await stopping;
            await store.Idle();
            check(folder.Files.Length == 1 && File.ReadAllBytes(folder.File(folder.Units.Single())).SequenceEqual(before) && store.Counts.Saved == 1,
                "a stop during a save leaves the earlier file as it was, writes nothing queued, and leaves no temporary file");
            world.Connection.Put(await IndexFileChecks.Database(world, name: "AfterStop"));
            await store.Idle();
            check(folder.Files.Length == 1 && store.Configure(Args(folder)).Mode == "unavailable", "a stopped store queues nothing more, and cannot be configured again");
        }
    }

    // ---- The sweep ----

    /// <summary>A file of <paramref name="bytes"/> zeros named as a unit's: enough for a rule that reads no header.</summary>
    private static string Fake(Folder folder, int number, long bytes, TimeSpan age)
    {
        var name = number.ToString("x32") + "-" + number.ToString("x32") + IndexStoreNames.Extension;
        using (var stream = new FileStream(folder.File(name), FileMode.CreateNew)) stream.SetLength(bytes);
        File.SetLastWriteTimeUtc(folder.File(name), DateTime.UtcNow - age);
        return name;
    }

    private static async Task<string[]> SaveSome(Folder folder, byte[]? key = null, string mode = "encrypted", params string[] names)
    {
        using var store = await Open(folder, mode, key);
        var world = Connected(store);
        foreach (var name in names) world.Connection.Put(await IndexFileChecks.Database(world, name: name));
        await store.Idle();
        var nameKey = IndexStoreNames.NameKey(key ?? Key);
        var scopeId = IndexStoreNames.ScopeId(nameKey, Scope());
        return [.. names.Select(name => IndexStoreNames.FileName(scopeId, IndexStoreNames.UnitId(nameKey, scopeId, IndexUnitKind.Database, name, null)))];
    }

    private static async Task Sweep(Action<bool, string> check)
    {
        // Temporary files, age, and files that do not open: the opening sweep.
        {
            using var folder = new Folder();
            var saved = await SaveSome(folder, null, "encrypted", "Fresh", "Old", "AlmostOld", "Renamed", "Versioned", "Cut");
            var (fresh, old, almost, renamed, versioned, cut) = (saved[0], saved[1], saved[2], saved[3], saved[4], saved[5]);
            File.SetLastWriteTimeUtc(folder.File(old), DateTime.UtcNow.AddDays(-IndexStoreLimits.UnusedDays - 1));
            File.SetLastWriteTimeUtc(folder.File(almost), DateTime.UtcNow.AddDays(-IndexStoreLimits.UnusedDays + 1));
            var oldTemporary = fresh + ".00112233aabbccdd.tmp";
            var youngTemporary = fresh + ".ffeeddccbbaa0099.tmp";
            File.WriteAllBytes(folder.File(oldTemporary), new byte[300]);
            File.SetLastWriteTimeUtc(folder.File(oldTemporary), DateTime.UtcNow - IndexStoreLimits.TemporaryGrace - TimeSpan.FromMinutes(5));
            File.WriteAllBytes(folder.File(youngTemporary), new byte[300]);
            // A crash right after the temporary file was made leaves it empty: it goes all the same.
            var emptyTemporary = fresh + ".0f0f0f0f0f0f0f0f.tmp";
            File.WriteAllBytes(folder.File(emptyTemporary), []);
            File.SetLastWriteTimeUtc(folder.File(emptyTemporary), DateTime.UtcNow - IndexStoreLimits.TemporaryGrace - TimeSpan.FromMinutes(5));
            // Another unit's content under this unit's name; another format version; a file cut inside its header; garbage.
            var moved = new string('c', 32) + "-" + new string('d', 32) + IndexStoreNames.Extension;
            File.Move(folder.File(renamed), folder.File(moved));
            var bytes = File.ReadAllBytes(folder.File(versioned));
            bytes[8] ^= 0x7f;
            File.WriteAllBytes(folder.File(versioned), bytes);
            File.WriteAllBytes(folder.File(cut), File.ReadAllBytes(folder.File(cut))[..60]);
            var garbage = new string('e', 32) + "-" + new string('f', 32) + IndexStoreNames.Extension;
            File.WriteAllBytes(folder.File(garbage), [.. Enumerable.Range(0, 400).Select(at => (byte)at)]);
            // Written under another key, and in clear text.
            using var elsewhere = new Folder();
            var foreignKey = (await SaveSome(elsewhere, OtherKey, "encrypted", "OtherKey"))[0];
            File.Copy(elsewhere.File(foreignKey), folder.File(foreignKey));
            using var clear = new Folder();
            var clearText = (await SaveSome(clear, null, "clearText", "ClearText"))[0];
            File.Copy(clear.File(clearText), folder.File(clearText));
            // Not the store's: other names, a directory with a unit's name, a file shorter than a header.
            var foreign = new[] { "notes.txt", "x" + IndexStoreNames.Extension, fresh.ToUpperInvariant() + ".bak", fresh + ".tmp", fresh[..^5] + ".IDX" };
            foreach (var name in foreign) File.WriteAllText(folder.File(name), "not the store's");
            foreach (var name in foreign) File.SetLastWriteTimeUtc(folder.File(name), DateTime.UtcNow.AddDays(-400));
            var directory = new string('1', 32) + "-" + new string('2', 32) + IndexStoreNames.Extension;
            Directory.CreateDirectory(folder.File(directory));
            File.WriteAllText(Path.Combine(folder.File(directory), "inside.txt"), "kept");
            var stub = new string('3', 32) + "-" + new string('4', 32) + IndexStoreNames.Extension;
            File.WriteAllBytes(folder.File(stub), new byte[IndexFileContainer.PrefixBytes - 1]);
            File.SetLastWriteTimeUtc(folder.File(stub), DateTime.UtcNow.AddDays(-400));
            // A link named as a unit's, to an old file elsewhere: neither followed nor deleted.
            var outside = Path.Combine(folder.Root, "outside.bin");
            File.WriteAllBytes(outside, new byte[500]);
            File.SetLastWriteTimeUtc(outside, DateTime.UtcNow.AddDays(-400));
            var link = new string('5', 32) + "-" + new string('6', 32) + IndexStoreNames.Extension;
            var linkedFile = false;
            try
            {
                File.CreateSymbolicLink(folder.File(link), outside);
                linkedFile = true;
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException or PlatformNotSupportedException)
            {
                Console.WriteLine("SKIP IndexStore: this account may not create a symbolic link to a file (" + error.GetType().Name + ")");
            }

            using var store = await Open(folder);
            var left = folder.Files;
            check(left.Contains(fresh) && left.Contains(almost) && !left.Contains(old), "the sweep removes a file not used for 30 days and keeps one used a day less than that ago");
            check(!left.Contains(oldTemporary) && !left.Contains(emptyTemporary) && left.Contains(youngTemporary), "the sweep removes a temporary file a crash left, empty or not, and leaves a young one another Varia may still be writing");
            check(!left.Contains(foreignKey) && !left.Contains(clearText) && !left.Contains(versioned) && !left.Contains(cut) && !left.Contains(garbage) && !left.Contains(moved),
                "the sweep removes what does not open here: another key's file, a clear text file, another format version, a cut header, garbage, and a file under another unit's name");
            check(foreign.All(left.Contains) && Directory.Exists(folder.File(directory)) && File.Exists(Path.Combine(folder.File(directory), "inside.txt")) && left.Contains(stub),
                "the sweep leaves everything that is not the store's own: other names, a directory, and a file shorter than a header, however old");
            if (linkedFile)
                check(new FileInfo(folder.File(link)).LinkTarget is not null && File.Exists(outside) && File.ReadAllBytes(outside).Length == 500,
                    "the sweep neither follows nor deletes a link with a unit's name, and its target is untouched");
            check(store.Status is { Files: 2 } status && status.Bytes == new FileInfo(folder.File(fresh)).Length + new FileInfo(folder.File(almost)).Length && store.List(Scope()).Count == 2,
                "after the sweep the status counts only the units that are left");
        }
        // The limit: least recently used first, by lowering the limit and by a save that passes it.
        {
            using var folder = new Folder();
            using var store = await Open(folder, limitMiB: 128);
            var fakes = Enumerable.Range(1, 5).Select(number => Fake(folder, number, 20L * MiB, TimeSpan.FromHours(10 - number))).ToArray();
            store.Configure(Args(folder, limitMiB: 64));
            await store.Idle();
            check(folder.Units.Order().SequenceEqual(fakes[2..].Order()) && store.Status is { Files: 3 } trimmed && trimmed.Bytes == 60L * MiB && trimmed.LimitBytes == 64L * MiB,
                "lowering the disk limit deletes the least recently used files first, down to the limit, at once");
            // Using the oldest of the three keeps it; a save that takes the store past the limit deletes the next oldest.
            File.SetLastWriteTimeUtc(folder.File(fakes[2]), DateTime.UtcNow);
            var world = Connected(store);
            Fake(folder, 9, 10L * MiB, TimeSpan.FromMinutes(1));
            world.Connection.Put(await IndexFileChecks.Database(world));
            await store.Idle();
            check(!folder.Units.Contains(fakes[3]) && folder.Units.Contains(fakes[2]) && folder.Units.Contains(fakes[4]) && store.Find(Scope(), IndexUnitKind.Database, Database) is not null
                && store.Status is { } after && after.Bytes <= after.LimitBytes && after.Files == folder.Units.Length,
                "a save that takes the store past its limit deletes the least recently used file, never the one just used or just saved");
        }
        // A file that cannot be deleted is skipped as a value, and the rest of the sweep goes on.
        {
            using var folder = new Folder();
            var saved = await SaveSome(folder, null, "encrypted", "Stuck", "Loose");
            foreach (var name in saved) File.SetLastWriteTimeUtc(folder.File(name), DateTime.UtcNow.AddDays(-60));
            var store = new IndexStore { DeleteFile = path => { if (Path.GetFileName(path) == saved[0]) throw new IOException("in use"); File.Delete(path); } };
            store.Configure(Args(folder));
            await store.Idle();
            check(folder.Units.SequenceEqual([saved[0]]) && store.Counts is { Skipped: 1, Deleted: 1, Failed: 0 } && store.Status is { Files: 1 },
                "a file the sweep cannot delete is skipped and still counted, and the others go");
            store.Dispose();
            if (OperatingSystem.IsWindows())
            {
                using var real = new Folder();
                var locked = (await SaveSome(real, null, "encrypted", "Locked"))[0];
                File.SetLastWriteTimeUtc(real.File(locked), DateTime.UtcNow.AddDays(-60));
                using var handle = new FileStream(real.File(locked), FileMode.Open, FileAccess.Read, FileShare.Read);
                using var second = await Open(real);
                check(real.Units.SequenceEqual([locked]) && second.Counts.Skipped == 1, "on Windows a file another program holds open is skipped by the sweep");
            }
        }
    }

    // ---- Modes ----

    private static async Task Modes(Action<bool, string> check)
    {
        // Saving off: nothing is saved, and what was saved is deleted (the user's other files are not).
        {
            using var folder = new Folder();
            await SaveSome(folder, null, "encrypted", "One", "Two");
            File.WriteAllText(folder.File("notes.txt"), "kept");
            using var store = await Open(folder, "disabled");
            var world = Connected(store);
            world.Connection.Put(await IndexFileChecks.Database(world));
            await store.Idle();
            check(folder.Files.SequenceEqual(["notes.txt"]) && store.Status is { Mode: "disabled", Files: 0, Bytes: 0 } && store.Counts.Saved == 0 && store.List(Scope()).Count == 0,
                "with saving turned off nothing is saved and every saved index is deleted");
        }
        // No key store, no opt-in: nothing is saved; clear text left from an earlier opt-in goes, encrypted files wait for the key store.
        {
            using var folder = new Folder();
            var encrypted = await SaveSome(folder, null, "encrypted", "Encrypted");
            using var clear = new Folder();
            var clearText = (await SaveSome(clear, null, "clearText", "ClearText"))[0];
            File.Copy(clear.File(clearText), folder.File(clearText));
            using var store = await Open(folder, "noKeyStore");
            var world = Connected(store);
            world.Connection.Put(await IndexFileChecks.Database(world));
            await store.Idle();
            check(folder.Units.SequenceEqual(encrypted) && store.Status is { Mode: "noKeyStore", Files: 1 } && store.Counts.Saved == 0 && store.List(Scope()).Count == 0,
                "without a key store and without the opt-in nothing is saved, an unencrypted index left on disk is deleted, and encrypted files wait for the key store");
            using var back = await Open(folder);
            check(back.List(Scope()).Count == 1, "and open again once the key store is back");
        }
        // The clear text opt-in: saved, readable without a key, loads back; back under a key, the clear text files go.
        {
            using var folder = new Folder();
            using (var store = await Open(folder, "clearText"))
            {
                var world = Connected(store);
                var database = await IndexFileChecks.Database(world);
                world.Connection.Put(database);
                await store.Idle();
                var unit = store.List(Scope()).Single();
                var again = new World();
                var loaded = store.Load(unit, again.Connection, again.Limits, again.Pool);
                var content = File.ReadAllBytes(folder.File(folder.Units.Single()));
                check(store.Status is { Mode: "clearText", Files: 1 } && unit.Header.Encrypted == false && loaded.Value is { } value && IndexFileChecks.Dump(value) == IndexFileChecks.Dump(database)
                    && Holds(content, Database) && !folder.Units.Single().Contains("sales", StringComparison.OrdinalIgnoreCase),
                    "with the clear text opt-in the index is saved unencrypted (its header names its database), under a hashed file name, and loads back equal");
                if (loaded.Value is { } put) again.Connection.Abandon(put);
            }
            using var encrypted = await Open(folder);
            check(folder.Units.Length == 0 && encrypted.Status is { Mode: "encrypted", Files: 0 }, "once a key store is back the unencrypted files are deleted");
        }
        // Deletions asked for before main configures the store (a database the server stopped listing, DDL on a BigQuery
        // project) are done once it saves: a file an earlier session wrote never outlives what made it stale.
        {
            using var folder = new Folder();
            var names = await SaveSome(folder, null, "encrypted", "Kept", "Dropped");
            using var store = new IndexStore();
            var world = Connected(store);
            world.Connection.Put(await IndexFileChecks.Database(world, name: "Dropped"));
            world.Connection.Keep(new HashSet<string>(StringComparer.Ordinal));
            store.MarkStale(IndexStoreScope.BigQuery("bigquery:user:someone@example.com")!, "some-project", null);
            store.Configure(Args(folder));
            await store.Idle();
            check(folder.Units.Contains(names[0]) && !folder.Units.Contains(names[1]) && store.Status is { Files: 1 },
                "a unit dropped before main configured the store has its earlier file deleted once the store saves, and nothing else goes");
        }
        // A deletion goes before the saves queued ahead of it, and a stop still does the deletions queued.
        {
            using var folder = new Folder();
            var names = await SaveSome(folder, null, "encrypted", "StaleFirst", "StaleLast", "Kept");
            using var store = await Open(folder);
            var world = Connected(store);
            var order = new List<string>();
            using var entered = new ManualResetEventSlim(false);
            using var go = new ManualResetEventSlim(false);
            store.Saving = name => { lock (order) order.Add(name); if (order.Count == 1) { entered.Set(); go.Wait(); } };
            world.Connection.Put(await IndexFileChecks.Database(world, name: "Busy"));
            entered.Wait();
            world.Connection.Put(await IndexFileChecks.Database(world, name: "QueuedOne"));
            world.Connection.Put(await IndexFileChecks.Database(world, name: "QueuedTwo"));
            store.Drop(Scope(), IndexUnitKind.Database, "StaleFirst", null);
            var deletedBefore = store.Counts.Deleted;
            var firstGone = false;
            store.Saving = name =>
            {
                lock (order) { order.Add(name); if (order.Count == 2) firstGone = !File.Exists(folder.File(names[0])); }
            };
            go.Set();
            await store.Idle();
            check(firstGone && !folder.Units.Contains(names[0]) && store.Counts.Deleted == deletedBefore + 1,
                "a queued deletion is done before the saves queued ahead of it");
            using var blocked = new ManualResetEventSlim(false);
            store.Saving = _ => blocked.Wait();
            world.Connection.Put(await IndexFileChecks.Database(world, name: "BusyAgain"));
            store.Drop(Scope(), IndexUnitKind.Database, "StaleLast", null);
            store.Dispose();
            blocked.Set();
            check(!folder.Units.Contains(names[1]) && folder.Units.Contains(names[2]), "a stop still does the deletions queued, and only those");
        }
        // A deletion queued when another configuration comes is done when the same key saves again.
        {
            using var folder = new Folder();
            var names = await SaveSome(folder, null, "encrypted", "Kept", "Dropped");
            using var store = await Open(folder);
            var world = Connected(store);
            using var go = new ManualResetEventSlim(false);
            using var entered = new ManualResetEventSlim(false);
            store.Saving = _ => { entered.Set(); go.Wait(); };
            world.Connection.Put(await IndexFileChecks.Database(world, name: "Busy"));
            entered.Wait();
            store.Drop(Scope(), IndexUnitKind.Database, "Dropped", null);
            store.Configure(Args(folder, "noKeyStore"));
            store.Saving = null;
            go.Set();
            await store.Idle();
            var keptMeanwhile = folder.Units.Contains(names[1]);
            store.Configure(Args(folder));
            await store.Idle();
            check(keptMeanwhile && !folder.Units.Contains(names[1]) && folder.Units.Contains(names[0]),
                "a deletion queued when the store stopped saving is done once the same key saves again");
        }
        // The folder deleted under a saving store: saves fail as values, and the writer goes idle rather than sweep again and again.
        {
            using var folder = new Folder();
            using var store = await Open(folder);
            var world = Connected(store);
            // The first save is written; the folder goes as the second is about to be, so the queue runs dry with a sweep owed.
            var saves = 0;
            using var entered = new ManualResetEventSlim(false);
            using var queued = new ManualResetEventSlim(false);
            store.Saving = _ =>
            {
                if (++saves == 1) { entered.Set(); queued.Wait(); }
                else if (saves == 2) Directory.Delete(folder.Path, recursive: true);
            };
            var before = await IndexFileChecks.Database(world, name: "Before");
            var after = await IndexFileChecks.Database(world, name: "After");
            world.Connection.Put(before);
            entered.Wait();
            world.Connection.Put(after);
            queued.Set();
            var idleTask = store.Idle();
            var idle = await Task.WhenAny(idleTask, Task.Delay(TimeSpan.FromSeconds(60))) == idleTask;
            Directory.CreateDirectory(folder.Path);
            store.Saving = null;
            check(idle && saves == 2 && store.Counts is { Saved: 1, Failed: 1 }, "a store whose folder was deleted fails its saves and goes idle, never spinning on the sweep");
        }
        // Without a key store but opted in to clear text, encrypted files wait for the key store as they do without the opt-in.
        {
            using var folder = new Folder();
            var names = await SaveSome(folder, null, "encrypted", "Sealed");
            using var store = await Open(folder, "clearText");
            check(folder.Units.SequenceEqual(names) && store.List(Scope()).Count == 0, "the clear text mode keeps the encrypted files, which open again once the key store is back");
        }
        // A new key (the keychain was reset): the old files no longer open, and the sweep removes them.
        {
            using var folder = new Folder();
            await SaveSome(folder, null, "encrypted", "One", "Two");
            using var store = await Open(folder, key: OtherKey);
            check(folder.Units.Length == 0 && store.Status is { Files: 0 } && store.Counts.Deleted == 2, "after a new key is made the files written under the old one are swept");
        }
        // The same configuration again changes nothing queued; a new key drops what was queued under the old one.
        {
            using var folder = new Folder();
            using var store = await Open(folder);
            var world = Connected(store);
            using var held = new Held(store);
            world.Connection.Put(await IndexFileChecks.Database(world, name: "Writing"));
            held.WaitEntered();
            world.Connection.Put(await IndexFileChecks.Database(world, name: "Queued"));
            store.Configure(Args(folder));
            store.Configure(Args(folder, key: OtherKey));
            held.Release();
            await store.Idle();
            check(folder.Files.Length == 0 && store.Counts.Saved == 0, "a new key stops the write in progress and drops what was queued under the old one");
            world.Connection.Put(await IndexFileChecks.Database(world, name: "Later"));
            await store.Idle();
            check(folder.Units.Length == 1 && store.List(Scope()).Single().Database == "Later", "and what is held after that is saved under the new key");
        }
    }

    // ---- What was held before the store was told where it is, or under another key ----

    private static async Task Opened(Action<bool, string> check)
    {
        // A connection's index: reads held while the store is not configured are saved when it is, and again under a new key.
        {
            using var folder = new Folder();
            using var store = new IndexStore();
            var world = Connected(store);
            store.Opened = () => world.Connection.Announce(_ => true);
            world.Connection.Put(await IndexFileChecks.Database(world));
            world.Connection.PutServer(await IndexFileChecks.Server(world));
            world.Connection.PutResource(await world.Catalog.AcquireAsync(IndexFileChecks.ResourceKey, _ => IndexFileChecks.ResourceObjects(world)));
            var partial = await IndexFileChecks.Database(world, name: "Partial");
            partial.FailedPart = true;
            world.Connection.Put(partial);
            await store.Idle();
            var before = folder.Files.Length;
            store.Configure(Args(folder));
            await store.Idle();
            check(before == 0 && folder.Units.Length == 3 && store.List(Scope()).Select(unit => unit.Database).Order().SequenceEqual(new[] { ObjectSearchService.ServerScope, Database }.Order())
                && store.LoadResource(IndexFileChecks.ResourceKey, long.MaxValue).Value is not null,
                "reads an index held before the store was configured are saved once it is, but for the one that failed part way");
            var earlier = folder.Units;
            store.Configure(Args(folder, key: OtherKey));
            await store.Idle();
            check(folder.Units.Length == 3 && !folder.Units.Intersect(earlier).Any() && store.List(Scope()).Count == 2, "after a new key the files under the old one are swept and what is held is saved under the new one");
            store.Configure(Args(folder, "disabled"));
            await store.Idle();
            store.Configure(Args(folder, key: OtherKey));
            await store.Idle();
            check(folder.Units.Length == 3, "turning saving off deletes the files, and turning it on again saves what is held without a rebuild");
            world.Connection.Dispose();
            store.Configure(Args(folder));
            await store.Idle();
            check(folder.Units.Length == 0, "a disconnected index announces nothing");
        }
        // The service wires it: a BigQuery index built before main configured the store is saved when it does, but for a dataset
        // DDL marked stale since its read.
        {
            using var folder = new Folder();
            const string Principal = "bigquery:user:early@example.com";
            var scope = IndexStoreScope.BigQuery(Principal)!;
            var source = new BigQueryIndexChecks.FakeBudgetSource(discoveredProjects: ["disc-01", "disc-02"], tablesPerDiscovered: 2, columnsPerTable: 2) { PrincipalId = Principal };
            using var search = new ObjectSearchService(new BigQueryIndexChecks.UnusedHost());
            var id = Guid.NewGuid().ToString();
            await search.IndexBigQueryAsync(new ObjectIndexArgs(id, Guid.NewGuid().ToString()), source, CancellationToken.None);
            search.MarkStale(id, "disc-02", "ds");
            await search.Store.Idle();
            var before = folder.Files.Length;
            search.Store.Configure(Args(folder));
            await search.Store.Idle();
            var saved = search.Store.List(scope);
            check(before == 0 && search.HeldOf(id).Count(read => read.Dataset is not null) == 3 && saved.Count == 2 && saved.All(unit => unit.Database != "disc-02")
                && saved.All(unit => BigQuerySync.From(unit.Sync) is { Pending: 0 }),
                "a BigQuery index built before the store was configured is saved once it is, but for a dataset marked stale since its read");
            await search.IndexBigQueryAsync(new ObjectIndexArgs(id, Guid.NewGuid().ToString(), Stale: true), source, CancellationToken.None);
            await search.Store.Idle();
            check(search.Store.List(scope).Count == 3, "the stale dataset is saved by the build that reads it again");
        }
    }

    // ---- Two Varias on one user-data directory ----

    private static async Task Instances(Action<bool, string> check)
    {
        using var folder = new Folder();
        using var first = await Open(folder);
        using var second = await Open(folder);
        var one = Connected(first);
        var two = Connected(second, Scope("SECOND"));
        var shared = Connected(second);
        var saves = new List<Task>();
        for (var round = 0; round < 6; round++)
        {
            var at = round;
            saves.Add(Task.Run(async () => one.Connection.Put(await IndexFileChecks.Database(one, name: "Mine" + at, extraTables: at))));
            saves.Add(Task.Run(async () => two.Connection.Put(await IndexFileChecks.Database(two, name: "Yours" + at, extraTables: at))));
            // Both write the same unit, again and again.
            saves.Add(Task.Run(async () => one.Connection.Put(await IndexFileChecks.Database(one, name: "Both", extraTables: at))));
            saves.Add(Task.Run(async () => shared.Connection.Put(await IndexFileChecks.Database(shared, name: "Both", extraTables: at + 1))));
        }
        await Task.WhenAll(saves);
        await Task.WhenAll(first.Idle(), second.Idle());
        using var third = await Open(folder);
        var mine = third.List(Scope());
        var yours = third.List(Scope("SECOND"));
        var again = new World();
        var whole = mine.Concat(yours).All(unit =>
        {
            var loaded = third.Load(unit, again.Connection, again.Limits, again.Pool);
            if (loaded.Value is { } value) again.Connection.Abandon(value);
            return loaded.Problem == IndexFileProblem.None;
        });
        check(mine.Count == 7 && yours.Count == 6 && whole && folder.Files.Length == 13 && first.Counts.Failed == 0 && second.Counts.Failed == 0 && third.Counts.Deleted == 0,
            "two stores on one folder, saving the same and different units at once, leave every file whole and no temporary file");
        // Each sees the other's files in its tally once it lists the folder again.
        first.Configure(Args(folder, limitMiB: IndexStoreLimits.DefaultDiskMiB - 1));
        await first.Idle();
        check(first.Status is { Files: 13 }, "a store counts the files another Varia saved the next time it lists its folder");
    }

    // ---- Clear Saved Search Indexes ----

    private static async Task Clear(Action<bool, string> check)
    {
        using var folder = new Folder();
        using var store = await Open(folder);
        var world = Connected(store);
        var database = await IndexFileChecks.Database(world);
        world.Connection.Put(database);
        var set = await world.Catalog.AcquireAsync(IndexFileChecks.ResourceKey, _ => IndexFileChecks.ResourceObjects(world));
        world.Connection.PutResource(set);
        await store.Idle();
        File.WriteAllText(folder.File("notes.txt"), "kept");
        var temporary = folder.Units[0] + ".0011223344556677.tmp";
        File.WriteAllBytes(folder.File(temporary), new byte[100]);
        var bytes = folder.Units.Sum(name => new FileInfo(folder.File(name)).Length) + 100;
        using (var held = new Held(store))
        {
            // A save in flight and one queued when the clear is asked for are not written after it.
            world.Connection.Put(await IndexFileChecks.Database(world, name: "Writing"));
            held.WaitEntered();
            world.Connection.Put(await IndexFileChecks.Database(world, name: "Queued"));
            var clearing = store.ClearAsync();
            held.Release();
            var cleared = await clearing;
            await store.Idle();
            check(cleared is { Files: 3, Kept: 0 } && cleared.Bytes == bytes && folder.Files.SequenceEqual(["notes.txt"]) && store.Status is { Files: 0, Bytes: 0, Mode: "encrypted" },
                "Clear Saved Search Indexes deletes every unit and temporary file, stops what was being saved, and leaves files that are not the store's");
        }
        check(world.Connection.Get(Database) is not null && IndexFileChecks.Dump(world.Connection.Get(Database)!) == IndexFileChecks.Dump(database), "clearing the saved index leaves the index in memory as it was");
        // The next build saves again, the shared set it still holds included.
        world.Connection.Put(await IndexFileChecks.Database(world, credit: database));
        world.Connection.PutResource(await world.Catalog.AcquireAsync(IndexFileChecks.ResourceKey, _ => IndexFileChecks.ResourceObjects(world)));
        await store.Idle();
        check(folder.Units.Length == 2 && store.LoadResource(IndexFileChecks.ResourceKey, long.MaxValue).Value is not null, "the next build after a clear saves its reads again, the shared set included");
        var stuck = new IndexStore { DeleteFile = _ => throw new UnauthorizedAccessException() };
        stuck.Configure(Args(folder));
        await stuck.Idle();
        var kept = await stuck.ClearAsync();
        check(kept is { Files: 0, Bytes: 0, Kept: 2 } && folder.Units.Length == 2 && stuck.Status is { Files: 2 }, "a clear that cannot delete a file says how many it left");
        stuck.Dispose();
    }

    // ---- Through the service, as main sends it ----

    private static async Task Dispatch(Action<bool, string> check)
    {
        using var folder = new Folder();
        var json = new JsonSerializerOptions(JsonSerializerDefaults.Web)
        {
            DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
            UnmappedMemberHandling = System.Text.Json.Serialization.JsonUnmappedMemberHandling.Disallow
        };
        var events = new List<object>();
        using var service = new SqlService(publish: value => { lock (events) events.Add(value); return true; });
        check(SqlService.MethodNames.Contains("explorer.indexStore.configure") && SqlService.MethodNames.Contains("explorer.indexStore.clear")
            && service.Sensitive("explorer.indexStore.configure") && !service.Sensitive("explorer.indexStore.clear")
            && service.LaneOf("explorer.indexStore.configure") == RequestLane.Control && service.LaneOf("explorer.indexStore.clear") == RequestLane.Control
            && Providers.Of("explorer.indexStore.configure").Count == 2 && Providers.Of("explorer.indexStore.clear").Count == 2,
            "the store's two methods are announced, served on the control lane for both engines, and the one that carries the key is sensitive");
        async Task<string?> Code(string method, string body)
        {
            try { await service.DispatchAsync(method, JsonDocument.Parse(body).RootElement, json); return null; }
            catch (RequestException error) { return error.Code; }
            catch (JsonException) { return "JSON"; }
        }
        var folderJson = JsonSerializer.Serialize(folder.Path);
        var key = Convert.ToBase64String(Key);
        check(await Code("explorer.indexStore.configure", "{}") is not null
            && await Code("explorer.indexStore.configure", $$"""{"mode":"encrypted","folder":{{folderJson}},"limitMiB":2048,"key":"{{key}}","path":"x"}""") is not null
            && await Code("explorer.indexStore.configure", $$"""{"mode":"encrypted","folder":{{folderJson}},"limitMiB":2048.5,"key":"{{key}}"}""") is not null
            && await Code("explorer.indexStore.configure", $$"""{"mode":"encrypted","folder":{{folderJson}},"limitMiB":2048,"key":42}""") is not null
            && await Code("explorer.indexStore.clear", """{"all":true}""") is not null && service.Search.Store.Status is null,
            "the service refuses a configuration with missing, unknown or mistyped members, and a clear with any member");
        check(await Code("explorer.indexStore.clear", "{}") == "NOT_READY", "a clear before main has configured the store is refused, not answered as nothing to clear");
        var configured = (IndexStoreStatus)await service.DispatchAsync("explorer.indexStore.configure",
            JsonDocument.Parse($$"""{"mode":"encrypted","folder":{{folderJson}},"limitMiB":2048,"key":"{{key}}"}""").RootElement, json);
        await service.Search.Store.Idle();
        service.ReportIndexMemory();
        IndexMemoryEvent? sent;
        lock (events) sent = events.OfType<IndexMemoryEvent>().LastOrDefault();
        var wire = sent is null ? "" : JsonSerializer.Serialize(sent, json);
        check(configured is { Mode: "encrypted", Files: 0 } && sent?.Store is { Mode: "encrypted", Files: 0, Bytes: 0 } store && store.LimitBytes == 2048L * MiB
            && wire.Contains("\"store\":{\"mode\":\"encrypted\",\"files\":0,\"bytes\":0,\"limitBytes\":2147483648}", StringComparison.Ordinal)
            && !wire.Contains(key, StringComparison.Ordinal) && !wire.Contains(IndexStoreLimits.FolderName, StringComparison.Ordinal),
            "once configured, the index's memory event carries the store's mode, files, bytes and limit, and neither the key nor the folder");
        var world = Connected(service.Search.Store);
        world.Connection.Put(await IndexFileChecks.Database(world));
        await service.Search.Store.Idle();
        service.ReportIndexMemory();
        lock (events) sent = events.OfType<IndexMemoryEvent>().LastOrDefault();
        check(sent?.Store is { Files: 1, Bytes: > 0 }, "a save sends the event again with the store's new figures");
        var cleared = (IndexStoreClearResult)await service.DispatchAsync("explorer.indexStore.clear", JsonDocument.Parse("{}").RootElement, json);
        service.ReportIndexMemory();
        lock (events) sent = events.OfType<IndexMemoryEvent>().LastOrDefault();
        check(cleared is { Files: 1, Kept: 0 } && folder.Files.Length == 0 && sent?.Store is { Files: 0, Bytes: 0 }, "the clear answers what it deleted, and the event follows");
        var unconfigured = new IndexMemoryEvent(1, 2, 3, new IndexMemoryDetail(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0));
        check(!JsonSerializer.Serialize(unconfigured, json).Contains("store", StringComparison.Ordinal), "before main configures the store the event has no store member");
    }
}
