using System.Data;
using System.Globalization;
using System.Text;
using Microsoft.Data.SqlClient;
using Varia.Backend.Explorer;
using Varia.Backend.Ssis;

namespace Varia.Backend.Live;

/// <summary>ssis.operations' filters as the reader binds them: the kinds' operation types (null: every type) and whether Other
/// adds every type no kind names, the statuses (null: every status), LIKE patterns for the names (wildcards escaped, a
/// trailing % for a prefix), the caller, the window in hours and the row limit.</summary>
internal sealed record SsisOperationsFilter(int[]? Types, bool Other, int[]? Statuses, string? Folder, string? Project, string? Package, string? Caller, int WindowHours, int Limit)
{
    /// <summary>The filters of checked args (SsisOperationsArgs.Check), with the catalogue's defaults for what they leave out.</summary>
    public static SsisOperationsFilter Of(SsisOperationsLiveArgs? args, SsisCatalog catalog)
    {
        var kinds = args?.Kinds;
        int[]? types = kinds is null ? null : [.. kinds.Where(kind => kind != "other").SelectMany(kind => catalog.OperationKinds[kind]).Distinct().Order()];
        string? Like(string? text) => text is null ? null : Escape(text) + (args?.Prefix == true ? "%" : "");
        return new(types, kinds?.Contains("other") == true, args?.Statuses is { } statuses ? [.. statuses.Order()] : null, Like(args?.Folder), Like(args?.Project), Like(args?.Package), args?.Caller,
            args?.WindowHours ?? catalog.Limit("operationsDefaultWindowHours"), args?.Limit ?? catalog.Limit("operationsDefaultRows"));
    }

    /// <summary>The text with LIKE's wildcards and the escape character escaped (ESCAPE N'\'), so it matches only itself.</summary>
    internal static string Escape(string text)
    {
        var escaped = new StringBuilder(text.Length + 2);
        foreach (var character in text)
        {
            if (character is '%' or '_' or '[' or '\\') escaped.Append('\\');
            escaped.Append(character);
        }
        return escaped.ToString();
    }

    /// <summary>Whether a status passes the status filter (every status without one).</summary>
    public bool Keeps(int status) => Statuses is null || Array.IndexOf(Statuses, status) >= 0;
}

/// <summary>Checks ssis.operations' args as main's schema does (src/shared/ssis/schema.ts ssisOperationsArgsSchema).</summary>
internal static class SsisOperationsArgs
{
    public static SsisOperationsLiveArgs Check(SsisOperationsLiveArgs args, SsisCatalog catalog)
    {
        static RequestException Invalid() => new("INVALID_PARAMS", "Invalid arguments for this source.");
        static bool Name(string? text, int max) => text is null || text.Length >= 1 && text.Length <= max;
        if (args.Kinds is { } kinds && (kinds.Length is 0 || kinds.Length > catalog.OperationKinds.Count || kinds.Any(kind => kind is null || !catalog.OperationKinds.ContainsKey(kind))
            || kinds.Distinct(StringComparer.Ordinal).Count() != kinds.Length)) throw Invalid();
        if (args.Statuses is { } statuses && (statuses.Length is 0 || statuses.Length > catalog.OperationStatuses.Count || statuses.Any(status => !catalog.OperationStatuses.ContainsKey(status))
            || statuses.Distinct().Count() != statuses.Length)) throw Invalid();
        if (!Name(args.Folder, catalog.Limit("name")) || !Name(args.Project, catalog.Limit("name")) || !Name(args.Package, catalog.Limit("packageName")) || !Name(args.Caller, catalog.Limit("name"))) throw Invalid();
        if (args.WindowHours is < 1 || args.WindowHours > catalog.Limit("operationsWindowHours") || args.Limit is < 1 || args.Limit > catalog.Limit("operationsRows")) throw Invalid();
        return args;
    }
}

/// <summary>One operation as the window holds it: catalog.operations' row, with an execution's folder, project and package
/// (catalog.executions shares its id), and its duration in ms as the server measured it (to its own time while it runs).</summary>
internal sealed record SsisOperation(long Id, int Type, int Status, DateTimeOffset? Created, DateTimeOffset? Start, DateTimeOffset? End, string? Object, string? Folder, string? Project,
    string? Package, string? Caller, string? StoppedBy, string? Server, string? Machine, long? DurationMs);

/// <summary>An open operation read again: what can still change.</summary>
internal sealed record SsisOperationUpdate(long Id, int Status, DateTimeOffset? Start, DateTimeOffset? End, string? StoppedBy, long? DurationMs);

/// <summary>The Operations view's window (D-ssis 5.3, a snapshot table materialised from backend state), kept by id: the operations
/// of the view's scope (kinds, names, caller) that it shows, `limit` of those that pass the status filter and are open or were
/// created in the last hours (the open ones first, then the newest), and those it follows unseen, the open ones the status
/// filter hides, which can still end in a status it shows. A baseline replaces it; each later sample merges the operations read above the settled id (read again until
/// they settle, since an id is assigned before its row commits, so a lower one can appear after a higher one; a row read twice
/// replaces itself) and the open ones read again (a row no longer found leaves: the catalog's cleanup removed it, or a dirty read
/// was rolled back), then drops what it neither shows nor follows and what passes the limit, oldest first. Its settle window is
/// the catalogue's (the operations table's settle). The settled id assumes that no row turns up below it, which a commit that
/// outlasts the settle window breaks (the catalog's high-water mark settles whatever the scope, so in a filtered view that is
/// any in-scope insert held open while another operation commits above it), as does a login newly allowed to read a folder:
/// every <c>rebaseMs</c> the next sample reads the window from scratch again (<see cref="Begin"/>), which finds such a row.
/// Pure: the checks drive it without SQL Server.</summary>
internal sealed class SsisOperationsWindow(SsisCatalog catalog, LiveSettleJson settle, long rebaseMs)
{
    /// <summary>The operations table's settle window in the live catalogue.</summary>
    public static LiveSettleJson CatalogueSettle => LiveCatalog.Current.Probes[LiveSql.OperationsProbe].Tables[0].Settle
        ?? throw new InvalidOperationException("The operations table names no settle window.");

    private readonly SortedDictionary<long, SsisOperation> rows = [];
    /// <summary>Ids above the settled one, with the tick and time they were first seen.</summary>
    private readonly Dictionary<long, (long Tick, long Ms)> seen = [];
    /// <summary>The catalog's high-water marks above the settled id (its highest id when a sample read it), with the tick and time
    /// each was first seen: they settle like a row's id, so the settled id follows the catalog even when the scope matches none
    /// of its new operations, and the window's read stays a range above the newest ones.</summary>
    private readonly SortedDictionary<long, (long Tick, long Ms)> marks = [];
    /// <summary>At most this many marks wait to settle (one a sample); past it the lowest go, which only settles later.</summary>
    internal const int MaxMarks = 64;
    /// <summary>The ids the window shows, as the last trim left them (the newest `limit` that pass its filters).</summary>
    private readonly HashSet<long> shown = [];
    private long settled, ticks;
    /// <summary>When the last baseline read the window (the reader's monotonic ms clock).</summary>
    private long baselinedAt;
    private DateTimeOffset since = DateTimeOffset.MinValue;
    /// <summary>Where the next sample's turn of open ids starts (more than one sample's worth take turns).</summary>
    private long refreshFrom = long.MaxValue;

    public SsisOperationsFilter Filter { get; private set; } = SsisOperationsFilter.Of(null, catalog);
    /// <summary>The next sample reads the window from scratch (the first, new filters, a lost connection).</summary>
    public bool NeedsBaseline { get; private set; } = true;
    /// <summary>Every id up to this one is final: the next sample reads the ones above it.</summary>
    public long SettledId => settled;
    /// <summary>The rows a sample reads at most: the shown ones and as many followed unseen.</summary>
    public int Take => 2 * Filter.Limit;
    /// <summary>The newest operation shown (0 for none).</summary>
    public long Newest => shown.DefaultIfEmpty().Max();
    /// <summary>Every id held, shown or followed.</summary>
    public IReadOnlyCollection<long> Ids => rows.Keys;
    /// <summary>The high-water marks waiting to settle.</summary>
    internal int Marks => marks.Count;

    private bool Open(SsisOperation row) => catalog.OpenStatuses.Contains(row.Status);
    /// <summary>Shown: it passes the status filter, and is open or was created inside the window.</summary>
    private bool Shown(SsisOperation row) => Filter.Keeps(row.Status) && (Open(row) || row.Created is { } created && created >= since);

    /// <summary>New filters: the next sample reads the window again under them.</summary>
    public void Use(SsisOperationsFilter filter)
    {
        Filter = filter;
        NeedsBaseline = true;
    }

    /// <summary>A lost connection may reach another server (a failover): the next sample reads everything again.</summary>
    public void Reset() => NeedsBaseline = true;

    /// <summary>Before a sample at <paramref name="nowMs"/>: a window last read from scratch a rebase interval ago is read from
    /// scratch again, since its read above the settled id never finds a row that turned up below it.</summary>
    public void Begin(long nowMs)
    {
        if (!NeedsBaseline && nowMs - baselinedAt >= rebaseMs) NeedsBaseline = true;
    }

    /// <summary>The open ids the next sample reads again: all of them up to <paramref name="max"/>, else the next <paramref name="max"/>
    /// in turn, newest first, so every open operation is read again within a few samples.</summary>
    public long[] OpenIds(int max)
    {
        var open = rows.Values.Where(row => catalog.OpenStatuses.Contains(row.Status)).Select(row => row.Id).OrderDescending().ToList();
        if (open.Count <= max) return [.. open];
        var start = open.FindIndex(id => id < refreshFrom);
        if (start < 0) start = 0;
        var turn = open.Skip(start).Take(max).ToList();
        if (turn.Count < max) turn.AddRange(open.Take(max - turn.Count));
        refreshFrom = turn.Count == max && start + max < open.Count ? open[start + max - 1] : long.MaxValue;
        return [.. turn];
    }

    /// <summary>The window read from scratch: these rows, nothing else. Rows created within the settle window of the server's time
    /// are read again until they settle; every older id is settled at once. The catalog's high-water mark (<paramref name="highWater"/>,
    /// null when the login sees no operation) settles like an id first seen now.</summary>
    public void Baseline(IReadOnlyList<SsisOperation> read, DateTimeOffset serverNow, long nowMs, long? highWater = null)
    {
        rows.Clear();
        seen.Clear();
        marks.Clear();
        ticks++;
        refreshFrom = long.MaxValue;
        foreach (var row in read) rows[row.Id] = row;
        var recent = serverNow.AddMilliseconds(-settle.Ms);
        settled = read.Where(row => row.Created is { } created && created <= recent).Select(row => row.Id).DefaultIfEmpty().Max();
        foreach (var row in read) if (row.Id > settled) seen[row.Id] = (ticks, nowMs);
        Mark(highWater, nowMs);
        Trim(serverNow);
        baselinedAt = nowMs;
        NeedsBaseline = false;
    }

    /// <summary>One later sample: the rows read above the settled id, the open ids it asked for with what came back, and the
    /// catalog's high-water mark.</summary>
    public void Merge(IReadOnlyList<SsisOperation> read, IReadOnlyCollection<long> asked, IReadOnlyList<SsisOperationUpdate> updates, DateTimeOffset serverNow, long nowMs, long? highWater = null)
    {
        ticks++;
        var found = new HashSet<long>();
        foreach (var update in updates)
        {
            found.Add(update.Id);
            if (rows.TryGetValue(update.Id, out var row)) rows[update.Id] = row with { Status = update.Status, Start = update.Start, End = update.End, StoppedBy = update.StoppedBy, DurationMs = update.DurationMs };
        }
        foreach (var id in asked) if (!found.Contains(id)) rows.Remove(id);
        foreach (var row in read)
        {
            rows[row.Id] = row;
            seen.TryAdd(row.Id, (ticks, nowMs));
        }
        Mark(highWater, nowMs);
        Settle(nowMs);
        Trim(serverNow);
    }

    private void Mark(long? highWater, long nowMs)
    {
        if (highWater is not { } id || id <= settled) return;
        marks.TryAdd(id, (ticks, nowMs));
        while (marks.Count > MaxMarks) marks.Remove(marks.Keys.First());
    }

    /// <summary>Settles the highest id or mark first seen at least the settle window ago; ids at or below it are not read again.</summary>
    private void Settle(long nowMs)
    {
        var next = settled;
        bool Due((long Tick, long Ms) first) => ticks - first.Tick >= settle.Ticks && nowMs - first.Ms >= settle.Ms;
        foreach (var (id, first) in seen) if (id > next && Due(first)) next = id;
        foreach (var (id, first) in marks) if (id > next && Due(first)) next = id;
        // Bounded: an id the window no longer holds needs no second look.
        foreach (var id in seen.Keys.Where(id => id <= next || !rows.ContainsKey(id)).ToList()) seen.Remove(id);
        foreach (var id in marks.Keys.Where(id => id <= next).ToList()) marks.Remove(id);
        settled = next;
    }

    /// <summary>Picks the rows shown, the open ones first and then the newest, up to the limit (an open operation is what Stop
    /// Operation acts on, so a busy hour of finished ones never hides it), then drops what the window neither shows nor follows:
    /// an ended operation the status filter hides, created before its hours by the server's clock, or past the limit, and the
    /// oldest of the open ones it follows unseen past the limit.</summary>
    private void Trim(DateTimeOffset serverNow)
    {
        since = serverNow.AddHours(-Filter.WindowHours);
        shown.Clear();
        var newest = rows.Values.Reverse().ToList();
        foreach (var row in newest) if (shown.Count < Filter.Limit && Open(row) && Shown(row)) shown.Add(row.Id);
        foreach (var row in newest) if (shown.Count < Filter.Limit && !Open(row) && Shown(row)) shown.Add(row.Id);
        var followed = 0;
        foreach (var row in newest) if (!shown.Contains(row.Id) && (!Open(row) || ++followed > Filter.Limit)) rows.Remove(row.Id);
    }

    /// <summary>The operations shown, as table rows, newest first, in the catalogue's column order: labels for codes, times to the
    /// second with their offset (the catalog's fractions are not worth a column's width; each time sorts by its full value), the
    /// duration as h:mm:ss.fff (sorting by its ms), and the row's tone by its status.</summary>
    public List<LiveRow> Rows()
    {
        var list = new List<LiveRow>(shown.Count);
        foreach (var row in rows.Values.Reverse()) if (shown.Contains(row.Id)) list.Add(Row(row));
        return list;
    }

    private LiveRow Row(SsisOperation row)
    {
        static LiveCell Time(DateTimeOffset? value) => value is { } some ? LiveCell.Offset(some, 0) : LiveCell.Null;
        string Label(IReadOnlyDictionary<int, string> labels, int code) => labels.TryGetValue(code, out var label) ? label : "Unknown (" + code.ToString(CultureInfo.InvariantCulture) + ")";
        return new LiveRow([
            LiveCell.Of(row.Id), LiveCell.Of(Label(catalog.OperationTypes, row.Type)), LiveCell.Of(Label(catalog.OperationStatuses, row.Status)),
            LiveCell.Of(row.Folder), LiveCell.Of(row.Project), LiveCell.Of(row.Package), LiveCell.Of(row.Object), Time(row.Start), Time(row.End),
            row.DurationMs is { } ms and >= 0 ? new LiveCell(ms, Duration(ms)) : LiveCell.Null,
            LiveCell.Of(row.Caller), LiveCell.Of(row.StoppedBy), LiveCell.Of(row.Server), LiveCell.Of(row.Machine),
            catalog.OperationTones.TryGetValue(row.Status, out var tone) ? LiveCell.Of(tone) : LiveCell.Null
        ]);
    }

    /// <summary>h:mm:ss.fff, hours past 24 included.</summary>
    internal static string Duration(long ms) => (ms / 3_600_000).ToString(CultureInfo.InvariantCulture) + ":" + (ms / 60_000 % 60).ToString("00", CultureInfo.InvariantCulture) + ":"
        + (ms / 1000 % 60).ToString("00", CultureInfo.InvariantCulture) + "." + (ms % 1000).ToString("000", CultureInfo.InvariantCulture);
}

/// <summary>Where the tiles' counts start reading catalog.operations (LiveSql.Operations' @openFrom and @countFrom), so a sample
/// reads a range of the clustered key above them, not every operation the catalog keeps. Below <see cref="OpenFrom"/> every
/// operation has ended (an ended one never opens again); below <see cref="CountFrom"/> every operation was created before the
/// 24 hours began (created times never change, and the hours only move on while the server's clock does). Neither passes the
/// settled id plus one: an id above it may still commit, open and new. Both are 0 after a baseline (new args, a lost
/// connection), and the 24-hour one also when the server's clock goes back, since the hours then reach rows it skipped.
/// Both also assume the rows below them never change, which a login newly allowed to read a folder, or a commit that outlasts
/// the settle window, breaks: every <c>rebaseMs</c> one sample reads both counts from 0 again. It also says when a sample
/// counts the 24 hours (every <c>countMs</c>, and at once after a baseline, a rebase or a clock gone back).
/// A Created operation can stay Created for as long as the catalog keeps it (create_execution with no start_execution), and
/// would hold <see cref="OpenFrom"/> at its id, so every sample would count from there up. Once it is the lowest open id and
/// settled it moves to <see cref="Created"/> instead, one a sample: the sample reads those ids by key (LiveSql.Operations'
/// @created), counts the ones that started since, and the range starts above them. At most <see cref="MaxCreated"/> are held;
/// past that the lowest one left holds the watermark, as any open operation does. Pure: the checks drive it without SQL Server.</summary>
internal sealed class SsisOperationsWatermarks(long countMs, long rebaseMs)
{
    /// <summary>At most this many Created operations are read by key below the open watermark.</summary>
    internal const int MaxCreated = 16;

    /// <summary>The open operations below <see cref="OpenFrom"/>, with the status each was last read in: each was Created when
    /// the watermark passed it.</summary>
    private readonly SortedDictionary<long, int> created = [];
    private DateTimeOffset lastNow = DateTimeOffset.MinValue;
    // Null: the next sample counts the 24 hours, or reads both counts from 0. Never a sentinel: `at - long.MinValue` wraps.
    private long? countedAt;
    private long? rebasedAt;

    public long OpenFrom { get; private set; }
    public long CountFrom { get; private set; }
    /// <summary>The ids the next sample reads by key (@created), all below <see cref="OpenFrom"/>.</summary>
    public IReadOnlyCollection<long> Created => created.Keys;

    public void Reset()
    {
        OpenFrom = 0;
        CountFrom = 0;
        created.Clear();
        lastNow = DateTimeOffset.MinValue;
        countedAt = null;
        rebasedAt = null;
    }

    /// <summary>Before a sample at <paramref name="at"/> (a monotonic ms clock): reads both counts from 0 when a rebase is due,
    /// and says whether this sample counts the 24 hours.</summary>
    public bool Begin(long at)
    {
        if (rebasedAt is not { } rebased || at - rebased >= rebaseMs)
        {
            OpenFrom = 0;
            CountFrom = 0;
            // The count from 0 reads them in its range again.
            created.Clear();
            rebasedAt = at;
            countedAt = null;
        }
        return countedAt is not { } counted || at - counted >= countMs;
    }

    /// <summary>A sample read <see cref="Created"/> by key, each id found with its status: the ones still open stay; an ended
    /// one, or one no longer found (the catalog's cleanup removed it), leaves.</summary>
    public void Read(IEnumerable<(long Id, int Status)> found, IReadOnlySet<int> openStatuses)
    {
        var open = found.Where(row => created.ContainsKey(row.Id) && openStatuses.Contains(row.Status)).ToList();
        created.Clear();
        foreach (var (id, status) in open) created[id] = status;
    }

    /// <summary>How many of the operations the last sample read by key are in these statuses: a tile's count adds them to its
    /// range's, since they are below it.</summary>
    public int Listed(IReadOnlyCollection<int> statuses) => created.Values.Count(statuses.Contains);

    /// <summary>After a sample: the lowest id its open count found that is Running, Pending or Stopping, the lowest it found
    /// Created (null for none) and the settled id once it merged. A settled Created id below every other open one is read by
    /// key from the next sample on, and the watermark passes it. Whether the server's clock went back since the last sample,
    /// so the next sample counts the 24 hours from the start.</summary>
    public bool Opened(long? lowestOpen, long? lowestCreated, long settled, DateTimeOffset serverNow)
    {
        var from = Math.Min(lowestOpen ?? long.MaxValue, settled + 1);
        if (lowestCreated is { } id && id < from) from = created.Count < MaxCreated && created.TryAdd(id, SsisCatalog.CreatedStatus) ? id + 1 : id;
        OpenFrom = from;
        var back = serverNow < lastNow;
        lastNow = serverNow;
        if (back)
        {
            CountFrom = 0;
            countedAt = null;
        }
        return back;
    }

    /// <summary>After a sample at <paramref name="at"/> that counted the 24 hours: the lowest id created within them (null for none).</summary>
    public void Counted(long? lowestRecent, long settled, long at)
    {
        CountFrom = Math.Min(lowestRecent ?? long.MaxValue, settled + 1);
        countedAt = at;
    }
}

/// <summary>ssis.operations (D-ssis 5.3) on SqlSampler's connection in the catalog's database: one batch a sample
/// (LiveSql.Operations) for the window (SsisOperationsWindow), the server's time and the running and pending counts, and every
/// operationsCountMs the 24-hour counts, which samples in between repeat. The counts ignore the filters and the limit, and read from their watermarks (SsisOperationsWatermarks; every operationsRebaseMs from 0, when the window is read
/// from scratch too). The session probe reads whether the catalog's
/// database has READ_COMMITTED_SNAPSHOT on, which picks the prologue (owner decision 4). New args and a lost connection read
/// the window again and reset the watermarks. It never writes and never logs names or values.</summary>
internal sealed class SsisOperationsReader(SsisCatalog catalog, SsisOperationsLiveArgs? args, Func<string> catalogDatabase, bool ignoreLinux = false, Func<long>? clock = null) : ILiveSqlReader
{
    private readonly Lock gate = new();
    private readonly SsisOperationsWindow window = new(catalog, SsisOperationsWindow.CatalogueSettle, catalog.Limit("operationsRebaseMs"));
    private readonly SsisOperationsWatermarks watermarks = new(catalog.Limit("operationsCountMs"), catalog.Limit("operationsRebaseMs"));
    private readonly Func<long> now = clock ?? (() => Environment.TickCount64);
    private SsisOperationsFilter pending = SsisOperationsFilter.Of(args, catalog);
    private bool changed = true;
    private string? prologue;
    private double?[] counts = [];

    public string? Prologue => prologue;
    internal SsisOperationsWindow Window => window;
    internal SsisOperationsWatermarks Watermarks => watermarks;

    public async Task<(int Spid, bool ServerState)> SessionAsync(SqlConnection connection, string scopePrologue, string permission, CancellationToken token)
    {
        await using var command = connection.CreateCommand();
        command.CommandTimeout = 0;
        command.CommandText = scopePrologue + LiveSql.SsisSession;
        command.Parameters.Add(new SqlParameter("@catalog", SqlDbType.NVarChar, 128) { Value = catalogDatabase() });
        await using var reader = await command.ExecuteReaderAsync(CommandBehavior.SingleRow, token).ConfigureAwait(false);
        if (!await reader.ReadAsync(token).ConfigureAwait(false)) throw new InvalidOperationException("The session probe returned no row.");
        var spid = Convert.ToInt32(reader.GetValue(0), CultureInfo.InvariantCulture);
        var rcsi = !reader.IsDBNull(1) && Convert.ToInt32(reader.GetValue(1), CultureInfo.InvariantCulture) == 1;
        prologue = LiveSql.Prologue("ssisdb", rcsi);
        // Catalog views need no server permission: row-level security shows the login what it may read.
        return (spid, true);
    }

    public (string Reason, string Note)? Unavailable(LiveProbeJson spec, ServerProfile profile) =>
        profile.Linux && !ignoreLinux ? ("NOT_SUPPORTED", "The SSIS Catalog isn't supported on SQL Server on Linux.")
        : profile.EngineEdition != 5 && profile.EngineEdition != 8 && profile.Major is > 0 and < 13 ? ("NOT_SUPPORTED", "The SSIS Catalog needs SQL Server 2016 or later.")
        : null;

    public void Apply(object value)
    {
        lock (gate)
        {
            pending = SsisOperationsFilter.Of((SsisOperationsLiveArgs)value, catalog);
            changed = true;
        }
    }

    public void Reset()
    {
        lock (gate) changed = true;
    }

    public async Task<LiveReaderSample> ReadAsync(SqlConnection connection, string scopePrologue, LiveDue item, Func<string, string, string>? testText, CancellationToken token)
    {
        SsisOperationsFilter filter;
        lock (gate)
        {
            if (changed) window.Use(pending);
            changed = false;
            filter = window.Filter;
        }
        var at = now();
        window.Begin(at);
        var baseline = window.NeedsBaseline;
        if (baseline) watermarks.Reset();
        var count = watermarks.Begin(at);
        long[] open = baseline ? [] : window.OpenIds(catalog.Limit("operationsRefresh"));
        await using var command = connection.CreateCommand();
        command.CommandTimeout = 0;
        var text = (prologue ?? scopePrologue) + LiveSql.Operations(count, baseline);
        command.CommandText = testText?.Invoke(item.Probe.Spec.Id, text) ?? text;
        Bind(command, filter, baseline ? 0 : window.SettledId, open, watermarks);
        var read = new List<SsisOperation>();
        var updates = new List<SsisOperationUpdate>();
        DateTimeOffset serverNow;
        var tiles = catalog.OperationTiles;
        var values = new double?[tiles.Count];
        long? lowestOpen, lowestCreated, highWater, lowestRecent = null;
        await using (var reader = await command.ExecuteReaderAsync(token).ConfigureAwait(false))
        {
            while (await reader.ReadAsync(token).ConfigureAwait(false)) read.Add(Operation(reader));
            await reader.NextResultAsync(token).ConfigureAwait(false);
            if (baseline)
            {
                // The open operations of any age, which the newest finished ones may have crowded out of the first read.
                var held = read.Select(row => row.Id).ToHashSet();
                while (await reader.ReadAsync(token).ConfigureAwait(false)) if (Operation(reader) is var row && held.Add(row.Id)) read.Add(row);
                await reader.NextResultAsync(token).ConfigureAwait(false);
            }
            while (await reader.ReadAsync(token).ConfigureAwait(false))
                updates.Add(new(reader.GetInt64(0), reader.GetInt32(1), Offset(reader, 2), Offset(reader, 3), Text(reader, 4), Long(reader, 5)));
            await reader.NextResultAsync(token).ConfigureAwait(false);
            if (!await reader.ReadAsync(token).ConfigureAwait(false)) throw new InvalidOperationException("The operations sample returned no server time.");
            serverNow = reader.GetDateTimeOffset(0);
            await reader.NextResultAsync(token).ConfigureAwait(false);
            // The Created operations below the open watermark, as they are now.
            var listed = new List<(long, int)>();
            while (await reader.ReadAsync(token).ConfigureAwait(false)) listed.Add((reader.GetInt64(0), reader.GetInt32(1)));
            watermarks.Read(listed, catalog.OpenStatuses);
            await reader.NextResultAsync(token).ConfigureAwait(false);
            if (!await reader.ReadAsync(token).ConfigureAwait(false)) throw new InvalidOperationException("The operations sample returned no open counts.");
            var next = 0;
            for (var i = 0; i < tiles.Count; i++)
                if (tiles[i].LastHours is null) values[i] = Long(reader, next++) + watermarks.Listed(tiles[i].Statuses);
            lowestOpen = Long(reader, next);
            lowestCreated = Long(reader, next + 1);
            highWater = Long(reader, next + 2);
            if (count)
            {
                await reader.NextResultAsync(token).ConfigureAwait(false);
                if (!await reader.ReadAsync(token).ConfigureAwait(false)) throw new InvalidOperationException("The operations sample returned no 24-hour counts.");
                var column = 0;
                var fresh = new double?[tiles.Count];
                for (var i = 0; i < tiles.Count; i++) if (tiles[i].LastHours is not null) fresh[i] = Long(reader, column++);
                lowestRecent = Long(reader, column);
                counts = fresh;
            }
        }
        if (baseline) window.Baseline(read, serverNow, at, highWater);
        else window.Merge(read, open, updates, serverNow, at, highWater);
        if (count) watermarks.Counted(lowestRecent, window.SettledId, at);
        // A clock gone back reaches 24-hour rows below the watermark: the next sample counts them all again.
        watermarks.Opened(lowestOpen, lowestCreated, window.SettledId, serverNow);
        // The final tiles repeat their last count between reads.
        for (var i = 0; i < tiles.Count; i++) if (tiles[i].LastHours is not null) values[i] = i < counts.Length ? counts[i] : null;
        var raw = new LiveRawSample(null, null, values, new double?[values.Length]);
        return new(raw, [new LiveReaderTable(0, window.Rows())], [], Status: [new LiveStatus("newest", window.Newest)]);
    }

    private void Bind(SqlCommand command, SsisOperationsFilter filter, long after, long[] open, SsisOperationsWatermarks marks)
    {
        static string Xml(IEnumerable<long> values) => string.Concat(values.Select(value => "<i>" + value.ToString(CultureInfo.InvariantCulture) + "</i>"));
        static SqlParameter Text(string name, int size, string? value) => new(name, SqlDbType.NVarChar, size) { Value = (object?)value ?? DBNull.Value };
        // A LIKE pattern doubles at most every character and adds a %.
        var name = 2 * catalog.Limit("name") + 1;
        command.Parameters.Add(new SqlParameter("@after", SqlDbType.BigInt) { Value = after });
        command.Parameters.Add(new SqlParameter("@take", SqlDbType.Int) { Value = window.Take });
        command.Parameters.Add(new SqlParameter("@window", SqlDbType.Int) { Value = filter.WindowHours });
        command.Parameters.Add(new SqlParameter("@types", SqlDbType.Xml) { Value = filter.Types is { } types ? Xml(types.Select(type => (long)type)) : DBNull.Value });
        command.Parameters.Add(new SqlParameter("@other", SqlDbType.Bit) { Value = filter.Other });
        command.Parameters.Add(new SqlParameter("@statuses", SqlDbType.Xml) { Value = filter.Statuses is { } statuses ? Xml(statuses.Select(status => (long)status)) : DBNull.Value });
        command.Parameters.Add(Text("@folder", name, filter.Folder));
        command.Parameters.Add(Text("@project", name, filter.Project));
        command.Parameters.Add(Text("@package", 2 * catalog.Limit("packageName") + 1, filter.Package));
        command.Parameters.Add(Text("@caller", catalog.Limit("name"), filter.Caller));
        command.Parameters.Add(new SqlParameter("@open", SqlDbType.Xml) { Value = Xml(open) });
        command.Parameters.Add(new SqlParameter("@created", SqlDbType.Xml) { Value = Xml(marks.Created) });
        command.Parameters.Add(new SqlParameter("@openFrom", SqlDbType.BigInt) { Value = marks.OpenFrom });
        command.Parameters.Add(new SqlParameter("@countFrom", SqlDbType.BigInt) { Value = marks.CountFrom });
    }

    private static SsisOperation Operation(SqlDataReader reader) => new(reader.GetInt64(0), Convert.ToInt32(reader.GetValue(1), CultureInfo.InvariantCulture), reader.GetInt32(2),
        Offset(reader, 3), Offset(reader, 4), Offset(reader, 5), Text(reader, 6), Text(reader, 7), Text(reader, 8), Text(reader, 9), Text(reader, 10), Text(reader, 11), Text(reader, 12),
        Text(reader, 13), Long(reader, 14));

    private static DateTimeOffset? Offset(SqlDataReader reader, int ordinal) => reader.IsDBNull(ordinal) ? null : reader.GetDateTimeOffset(ordinal);
    private static string? Text(SqlDataReader reader, int ordinal) => reader.IsDBNull(ordinal) ? null : reader.GetString(ordinal);
    private static long? Long(SqlDataReader reader, int ordinal) => reader.IsDBNull(ordinal) ? null : Convert.ToInt64(reader.GetValue(ordinal), CultureInfo.InvariantCulture);
}
