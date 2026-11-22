using System.Diagnostics;
using System.Globalization;
using System.Net;
using Google;
using Google.Apis.Bigquery.v2.Data;
using Varia.Backend.BigQuery;
using Varia.Backend.Protocol;
using Varia.Backend.Results;

namespace Varia.Backend;

/// <summary>
/// Where a BigQuery result's rows live (docs/bigquery.md, Residence): in memory, as SQL Server's do, or windowed in the job's
/// destination table and read in blocks through <see cref="RemoteResult"/>. The residence is chosen once the job is done,
/// from the first page's measured row size and the room the query may still take (queryResults.bigQuery.residence); an
/// Automatic in-memory read that the budget refuses part way switches to windowed instead of truncating, and Load into
/// memory (results.remoteQuery, kind load) switches a windowed result back. Every switch bumps the result's revision and
/// sends resultSet.residence.
/// </summary>
internal sealed partial class SqlService
{
    /// <summary>How long one results.read waits for a windowed result's blocks before it answers with the rows it has: inside
    /// results.read's 60 s deadline, so the grid draws the rest as loading and reads again rather than failing.</summary>
    internal TimeSpan RemoteReadWait { get; set; } = TimeSpan.FromSeconds(20);

    /// <summary>What a windowed BigQuery result reads from: its job and destination table, and what decided its blocks.</summary>
    internal sealed record BigQueryWindow(QueryArgs Args, BigQueryConnection Connection, string Project, string JobId, string? Location, TableReference Table,
        BigQueryColumnPlan Plan, double RowCost, long TotalRows, bool Child, long CacheBytes);

    internal enum BigQueryResidence { Automatic, Memory, Windowed }

    internal static BigQueryResidence ResidenceOf(string? setting) => setting switch
    {
        null or "automatic" => BigQueryResidence.Automatic,
        "memory" => BigQueryResidence.Memory,
        "windowed" => BigQueryResidence.Windowed,
        _ => throw new RequestException("INVALID_PARAMS", "A result residence is automatic, memory or windowed.")
    };

    /// <summary>The block cache's limit for a query (queryResults.bigQuery.windowCacheMiB, 16 to 4,096 MiB; 64 by default).</summary>
    internal static long CacheBytesOf(int? mib) => mib is null ? RemoteResult.DefaultCacheBytes
        : mib is >= 16 and <= 4096 ? mib.Value * (1L << 20) : throw new RequestException("INVALID_PARAMS", "The window cache is 16 to 4,096 MiB.");

    /// <summary>A windowed result's own error value, answered before any work by every reader of stored pages (the
    /// architecture's page-access invariant): its rows stay in BigQuery, so these features wait until it is loaded into
    /// memory (results.remoteQuery, kind load).</summary>
    internal static RequestException RemoteRefused() =>
        new("REMOTE_RESULT", "This result is windowed in BigQuery: its rows are not in memory, so this is not available for it yet.");

    /// <summary>Refuses a windowed result before a reader of stored pages does any work (REMOTE_RESULT).</summary>
    internal static ResultSetBuffer Stored(ResultSetBuffer set) => set.IsRemote ? throw RemoteRefused() : set;

    /// <summary>
    /// Decides a result's residence after its first page (docs/bigquery.md, Residence: Deciding), before the set is
    /// announced. In memory when the rows arrived whole, under Always in memory, or when the projection from the first page's
    /// measured row cost fits in half of what the query may still take; then null, and an Automatic read switches to
    /// windowed if the budget refuses it later (<paramref name="window"/>). Otherwise the set becomes windowed here, its first
    /// page kept in the cache, and the window is returned. A result whose destination table cannot be read stays in memory.
    /// </summary>
    private async Task<RemoteResult?> DecideResidenceAsync(QueryArgs args, BigQueryConnection connection, string project, string jobId, string? location, Job? job, bool child,
        BigQueryColumnPlan plan, BigQueryPage first, ResultSetBuffer set, QueryBudget budget, QueryMessages messages, Action<BigQueryWindow?> window, CancellationToken token)
    {
        var residence = ResidenceOf(args.Residence);
        var total = first.TotalRows ?? first.RowCount;
        set.InMemory(total);
        window(null);
        if (residence == BigQueryResidence.Memory || first.PageToken is null || first.RowCount == 0) return null;
        // The first page's rows as pages: what a row costs in the store, and the cache's first block.
        var measured = new RemoteBlockWriter(set.ResultId, set.Wires, 0);
        // Its values' read warnings go to Messages here: the column plan says each once, so no later read of this page would.
        WriteRows(first, plan, measured, int.MaxValue, warn: text => messages.Add(text));
        var pages = measured.Finish();
        var rowCost = (double)pages.Sum(page => page.Cost) / Math.Max(1, measured.Rows);
        var wanted = Wanted(args, total);
        var room = Math.Min(store.QueryLimit(budget) - budget.UsedBytes, store.GlobalBytes - store.UsedBytes);
        var fits = FitsInMemory(rowCost, wanted, room);
        if (residence == BigQueryResidence.Automatic && fits) return await KeepInMemoryAsync();
        var table = await DestinationAsync(connection, project, jobId, location, job, token);
        if (table is null) return null;
        var context = new BigQueryWindow(args, connection, project, jobId, location, table, plan, rowCost, total, child, CacheBytesOf(args.WindowCacheMiB));
        var remote = Window(context, set);
        // The first page stays readable at once: rebuilt per block, so each page lies inside one.
        var seed = new List<RemotePage>();
        // Only the rows the result keeps (Maximum rows may cap it inside the first page): a page past its last block is refused.
        for (long from = 0; from < Math.Min(measured.Rows, remote.Rows); from += remote.BlockRows)
        {
            var writer = new RemoteBlockWriter(set.ResultId, set.Wires, from);
            WriteRows(first, plan, writer, (int)Math.Min(remote.BlockRows, remote.Rows - from), skip: (int)from);
            seed.AddRange(writer.Finish());
        }
        remote.Seed(seed);
        if (!store.Demote(set, remote, total, bump: false)) return null;
        if (CapNoteFor(args, total) is { } capped) messages.Add(capped);
        return remote;

        async Task<RemoteResult?> KeepInMemoryAsync()
        {
            // An Automatic read may still switch: the destination table is found now, while the job is fresh.
            var found = await DestinationAsync(connection, project, jobId, location, job, token);
            if (found is not null)
            {
                window(new BigQueryWindow(args, connection, project, jobId, location, found, plan, rowCost, total, child, CacheBytesOf(args.WindowCacheMiB)));
                set.SwitchesOnRefusal = true;
            }
            return null;
        }
    }

    /// <summary>The row cap's note (decision 31): the grid's 32-bit row indexes show this many, and the rest are a filter away.</summary>
    internal static string CapNote(long total) => "The grid shows the first " + RemoteResult.MaxRows.ToString("N0", CultureInfo.InvariantCulture) + " of "
        + total.ToString("N0", CultureInfo.InvariantCulture) + " rows, the most it can address. Add a WHERE clause to the query, or LIMIT with OFFSET, to see the rest.";

    /// <summary>The rows a result shows before the grid's own cap: BigQuery's total, within Maximum rows when one is set.</summary>
    private static long Wanted(QueryArgs args, long total) => args.MaxRows > 0 ? Math.Min(total, args.MaxRows) : total;

    /// <summary>The cap note when the grid's 32-bit cap, not Maximum rows, keeps rows from a windowed result; null otherwise.</summary>
    internal static string? CapNoteFor(QueryArgs args, long total) => Wanted(args, total) is var wanted && wanted > RemoteResult.MaxRows ? CapNote(wanted) : null;

    /// <summary>A windowed result over <paramref name="context"/>'s destination table for the set, its blocks sized by the
    /// measured row cost and read on the connection's fetch lane.</summary>
    private RemoteResult Window(BigQueryWindow context, ResultSetBuffer set)
    {
        var rows = Math.Min(Wanted(context.Args, context.TotalRows), RemoteResult.MaxRows);
        return RemoteResult.Create(store, set.ResultId, set.Wires, rows, context.TotalRows > rows, context.RowCost, context.CacheBytes, context.Connection.FetchLane,
            BigQueryFetch(context), context, new BigQueryRemoteRows(this, context, set));
    }

    /// <summary>
    /// Switches an Automatic in-memory read that the budget refused to windowed (docs/bigquery.md, Residence: Misestimate): its pages
    /// are released, it gets a new revision, and resultSet.residence tells the grid. Messages says why. False when the set
    /// was released meanwhile.
    /// </summary>
    private bool SwitchToWindowed(ResultSetBuffer set, BigQueryWindow context, QueryEventSink events, QueryMessages messages, TruncationReason? reason = null)
    {
        // Why, before Demote clears the set's refusal: a page or batch refused names its own reason, a row the set's.
        set.SwitchedFor = reason ?? set.Refusal;
        var remote = Window(context, set);
        if (!store.Demote(set, remote, context.TotalRows)) return false;
        events.Residence(set);
        // A load says itself that the result stays windowed; this is the query's own estimate being wrong.
        if (!set.Budget.Loading) messages.Add("The result was larger than estimated and did not fit in memory, so it is now windowed in BigQuery: rows are read as you scroll.");
        if (CapNoteFor(context.Args, context.TotalRows) is { } capped) messages.Add(capped);
        return true;
    }

    /// <summary>Whether a refusal of a page or batch should switch the set to windowed rather than stop it: low system memory
    /// stops a query's own read (it is no misestimate), while a load into memory still switches back, its rows windowed.</summary>
    private static bool SwitchesOn(ResultSetBuffer set, TruncationReason refusal) =>
        set.SwitchesOnRefusal && (refusal != TruncationReason.SystemMemory || set.Budget.Loading);

    /// <summary>Whether a refusal the set saw should switch it to windowed rather than stop it.</summary>
    private static bool Switches(ResultSetBuffer set, BigQueryWindow? context) =>
        context is not null && set.SwitchesOnRefusal && set.Refusal != TruncationReason.None && set.IsOpen;

    /// <summary>The job's destination table when BigQuery names one Varia can read (jobs.get, free); null otherwise.</summary>
    private async Task<TableReference?> DestinationAsync(BigQueryConnection connection, string project, string jobId, string? location, Job? job, CancellationToken token)
    {
        try { job ??= await bigQuery.GetJobAsync(connection, project, jobId, location, token); }
        catch (Exception error) when (!token.IsCancellationRequested && error is GoogleApiException or TimeoutException or HttpRequestException or IOException) { return null; }
        return job.Configuration?.Query?.DestinationTable is { } table && BigQueryLimits.IsProject(table.ProjectId)
            && table.DatasetId is { Length: > 0 and <= BigQueryLimits.Dataset } dataset && BigQueryLimits.DatasetId().IsMatch(dataset)
            && table.TableId is { } tableId && StorageTableId().IsMatch(tableId) ? table : null;
    }

    /// <summary>Writes a page's rows (after <paramref name="skip"/>, at most <paramref name="max"/>) into a block writer.</summary>
    private static void WriteRows(BigQueryPage page, BigQueryColumnPlan plan, RemoteBlockWriter writer, int max, int skip = 0, Action<string>? warn = null)
    {
        if (page.Rows.ValueKind != System.Text.Json.JsonValueKind.Array) return;
        var at = 0;
        var written = 0;
        foreach (var row in page.Rows.EnumerateArray())
        {
            if (at++ < skip) continue;
            if (written++ >= max) break;
            var builder = writer.BeginRow();
            try { plan.ReadRow(row, builder, warn ?? NoWarning); }
            catch { writer.AbortRow(); throw; }
            writer.CommitRow();
        }
    }

    /// <summary>A windowed read's cell warnings go nowhere: the query's Messages said them for the first page already.</summary>
    private static readonly Action<string> NoWarning = _ => { };

    /// <summary>The most attempts a block's read makes while BigQuery answers rateLimitExceeded, backing off with jitter.</summary>
    internal int RateLimitAttempts { get; set; } = 12;

    /// <summary>
    /// A block's rows through tabledata.list (free, random access): from its first row, following page tokens, decoded by the
    /// query's column plan. A 404 means BigQuery's result table is gone (REMOTE_EXPIRED). A rate limit backs off with jitter
    /// and tries again, never as an error, for no longer in all (by the clock; the call itself does not retry a rate limit) than a read
    /// waits (<see cref="RemoteReadWait"/>) and within the attempts: past that it would hold a slot of the connection's lane
    /// for no one, so it stops (<see cref="RemoteRetryException"/>), a read that joined it answers short, and the next read
    /// asks again.
    /// </summary>
    private RemoteFetch BigQueryFetch(BigQueryWindow context) => async (firstRow, rows, writer, token) =>
    {
        // Fetches of one result run side by side: each decodes with its own fork of the plan.
        var plan = context.Plan.Fork();
        string? pageToken = null;
        var clock = System.Diagnostics.Stopwatch.StartNew();
        for (var attempt = 1; writer.Rows < rows; )
        {
            BigQueryPage page;
            try
            {
                page = await bigQuery.TableRowsAsync(context.Connection, context.Table, pageToken is null ? firstRow + writer.Rows : null, (int)Math.Min(rows - writer.Rows, bigQuery.PageRows), pageToken, token);
            }
            catch (Exception error) when (!token.IsCancellationRequested && NotFound(error)) { throw new RemoteExpiredException(error); }
            catch (Exception error) when (!token.IsCancellationRequested && RateLimited(error))
            {
                var delay = bigQuery.RetryDelay * (1 << Math.Min(attempt - 1, 5)) * (0.5 + Random.Shared.NextDouble());
                if (attempt >= RateLimitAttempts || clock.Elapsed + delay > RemoteReadWait) throw new RemoteRetryException(error);
                await Task.Delay(delay, token);
                attempt++;
                continue;
            }
            catch (ObjectDisposedException) when (!token.IsCancellationRequested) { throw new RequestException("NOT_CONNECTED", "The connection was closed."); }
            using (page)
            {
                var count = page.RowCount;
                WriteRows(page, plan, writer, (int)(rows - writer.Rows));
                pageToken = page.PageToken;
                if (count == 0 || pageToken is null) break;
            }
        }
    };

    private static bool NotFound(Exception error)
    {
        for (var current = error; current is not null; current = current.InnerException)
            if (current is GoogleApiException api) return api.HttpStatusCode == HttpStatusCode.NotFound;
        return false;
    }

    private static bool RateLimited(Exception error) => BigQueryService.RateLimited(error);

    /// <summary>A windowed read waits for its blocks within <see cref="RemoteReadWait"/>, ending 5 s inside its deadline so its
    /// rows go back before the request times out.</summary>
    internal static TimeSpan ReadWait(TimeSpan limit, TimeSpan? remaining) =>
        remaining is { } left ? TimeSpan.FromTicks(Math.Min(limit.Ticks, Math.Max(0, (left - TimeSpan.FromSeconds(5)).Ticks))) : limit;

    /// <summary>
    /// results.read of a windowed result: the cached pages that cover the window, fetching the blocks it lacks (and its
    /// viewer's read-ahead) on the fetch lane. It waits within <see cref="RemoteReadWait"/> and its credit, then answers with
    /// the rows sent; rows not sent yet draw as loading and are read again. REMOTE_EXPIRED once the destination table is gone.
    /// </summary>
    private async Task<ResultsReadResult> ReadRemoteAsync(ResultsReadArgs args, ResultSetBuffer set, RemoteResult remote, RequestContext context)
    {
        var wait = ReadWait(RemoteReadWait, context.Remaining);
        int pages = 0, rows = 0;
        long next;
        try
        {
            next = await remote.ReadAsync(args.FirstRow, args.MaxRows, args.Viewer ?? 0, async body =>
            {
                if (set.IsReleased) throw Unavailable(args.ResultId);
                await context.SendDataAsync(body);
                pages++;
            }, wait, context.Token);
        }
        catch (RemoteExpiredException) { throw Expired(); }
        catch (ObjectDisposedException) { throw Unavailable(args.ResultId); }
        catch (OperationCanceledException) when (!context.Token.IsCancellationRequested && set.IsReleased) { throw Unavailable(args.ResultId); }
        catch (Exception error) when (!context.Token.IsCancellationRequested && error is not RequestException)
        {
            throw BigQueryErrors.Map(error, (remote.Source as BigQueryWindow)?.Project ?? "") as RequestException
                ?? new RequestException("BACKEND_ERROR", "BigQuery's rows could not be read: " + BigQueryErrors.Sanitize(error.Message));
        }
        // The cache answers with the rows it sent once it is disposed: a release is RESULT_RELEASED, while Load into memory
        // (a new revision, its resultSet.residence on the way) answers short, and the grid reads again.
        if (pages == 0 && set.IsReleased) throw Unavailable(args.ResultId);
        rows = (int)Math.Max(0, Math.Min(next, args.FirstRow + args.MaxRows) - args.FirstRow);
        var available = remote.Rows;
        return new ResultsReadResult(Math.Max(next, args.FirstRow), available, next >= available, pages, rows);
    }

    /// <summary>Automatic keeps a result in memory when its estimate fits in half of the room the query may still take
    /// (docs/bigquery.md, Residence): the other half is for a misestimate and the query's other results.</summary>
    internal static bool FitsInMemory(double rowCost, long rows, long room) => rowCost * rows <= room / 2.0;

    internal static RequestException Expired() =>
        new("REMOTE_EXPIRED", "BigQuery no longer has this result: its temporary result table expired. Run the query again to see the rest of the rows.");

    /// <summary>Checks only: called as a load is about to promote its set, after its checks.</summary>
    internal Action? LoadPromoting { get; set; }

    /// <summary>Checks only: runs after a load finds its connection, before it registers.</summary>
    internal Action? LoadRegistering { get; set; }

    /// <summary>
    /// results.remoteQuery (docs/ipc.md): a query over a windowed result's rows, run like query.execute (unary with EVENTs,
    /// its own queryId for query.cancel). Only the load kind exists so far: Load into memory reads the destination table into
    /// the same result, which switches to memory under a new revision (resultSet.residence), then completes (resultSet.closed).
    /// A refusal part way switches it back to windowed, as an Automatic query's read would, and so does Stop: the result stays
    /// whole either way. The answer is a query summary.
    /// </summary>
    private async Task<QueryResult> RemoteQueryAsync(RemoteQueryArgs args, RequestContext? context)
    {
        if (!Guid.TryParse(args.QueryId, out _) || args.ResultId == 0 || args.Kind != "load")
            throw new RequestException("INVALID_PARAMS", "A remote query needs its query ID, a result and a kind (load).");
        var set = store.Find(args.ResultId) ?? throw Unavailable(args.ResultId);
        if (set.Remote is not { Source: BigQueryWindow window } remote) throw new RequestException("INVALID_PARAMS", "Only a windowed BigQuery result can be loaded into memory.");
        var connection = window.Connection;
        if (bigQuery.Find(connection.Id) != connection) throw new RequestException("NOT_CONNECTED", "The connection was closed.");
        // The script that made it is still running: its end would complete the set under the load, and its budget is shared.
        if (set.Budget.Executing) throw new RequestException("BUSY", "This result's query is still running. Load it into memory once the query has finished.");
        if (BudgetStopped(set.Budget) is { } stopped) throw stopped;
        using var cancellation = new CancellationTokenSource();
        var running = new RunningQuery(connection.Id, args.QueryId, cancellation);
        LoadRegistering?.Invoke();
        if (!Register(args.QueryId, running)) throw new RequestException("DUPLICATE_QUERY", "This query is already running.");
        // A disconnect between finding the handle and registering cancelled nothing of this load's: refuse it, still windowed.
        if (bigQuery.Find(connection.Id) != connection)
        {
            queries.TryRemove(new(args.QueryId, running));
            throw new RequestException("NOT_CONNECTED", "The connection was closed.");
        }
        // Promoted here, not inside the try below: a load that lost the race to another (two clicks, two windows) must not
        // switch the winner's set back to windowed on its way out.
        LoadPromoting?.Invoke();
        // One load per query at a time: its sets share the query's budget.
        if (!set.Budget.TryBeginLoad())
        {
            queries.TryRemove(new(args.QueryId, running));
            // This very set already loading (promoted, so no longer windowed) is refused as before.
            throw !set.IsRemote ? new RequestException("INVALID_PARAMS", "Only a windowed BigQuery result can be loaded into memory.")
                : new RequestException("BUSY", "Another result of this query is loading into memory. Load this one once it has finished.");
        }
        if (!set.Promote(window.TotalRows))
        {
            set.Budget.EndLoad();
            queries.TryRemove(new(args.QueryId, running));
            throw set.IsReleased ? Unavailable(args.ResultId) : new RequestException("INVALID_PARAMS", "Only a windowed BigQuery result can be loaded into memory.");
        }
        using var cancelled = context?.Token.Register(running.Cancel);
        // Released meanwhile (Close Results, the tab closed or ran again): the load stops at once, for no one holds the result.
        using var gone = set.Released.Register(running.Cancel);
        using var events = new QueryEventSink(context is null ? null : context.SendEvent);
        var messages = new QueryMessages(events.Message);
        var token = cancellation.Token;
        var watch = Stopwatch.StartNew();
        var status = "completed";
        var loaded = -1;
        QueryFailure? failure = null;
        try
        {
            set.SwitchesOnRefusal = true;
            loaded = set.Revision;
            events.Residence(set);
            var first = await bigQuery.QueryResultsAsync(connection, window.Project, window.JobId, window.Location, null, BigQueryFirstPageRows, 0, token);
            var loadArgs = window.Args;
            BigQueryReadSession? readSession;
            // A script child's rows load through REST, as its query.execute read them: the text is the whole script's, so
            // whether its order matters (an ORDER BY inside EXECUTE IMMEDIATE or a procedure) cannot be read from it.
            try { readSession = window.Child ? null : await BigQueryStorageSessionAsync(loadArgs, connection, window.Project, window.JobId, window.Location, window.Plan, first, messages, token); }
            catch
            {
                first.Dispose();
                throw;
            }
            if (readSession is null) await ReadBigQueryRowsAsync(loadArgs, connection, window.Project, window.JobId, window.Location, window.Plan.Fork(), first, set, set.Budget, window.TotalRows, new RoomWaited(), events, NoWarning, token, window, messages);
            else
            {
                first.Dispose();
                await ReadBigQueryArrowAsync(loadArgs, readSession, set, set.Budget, window.TotalRows, new RoomWaited(), events, NoWarning, token, window, messages);
            }
            // Only the revision this load opened: one a later load promoted is that load's to finish.
            if (set.IsOpen && set.Revision == loaded) set.Complete();
            if (set.IsReleased) throw Unavailable(args.ResultId);
            messages.Add(!set.IsRemote ? "The result was loaded into memory."
                : set.SwitchedFor == TruncationReason.SystemMemory ? "The computer is low on memory, so the result stays windowed in BigQuery."
                : "The result did not fit in memory, so it stays windowed in BigQuery.");
        }
        catch (Exception error)
        {
            // Read before the switch back: its Demote fires `gone`, which would make a failure read as the user's cancel.
            var userStopped = token.IsCancellationRequested;
            gone.Dispose();
            // Stopped or failed part way: the result goes back to windowed, whole, rather than staying a partial copy.
            if (set.IsOpen && !set.IsReleased && set.Revision == loaded) SwitchBack();
            if (set.IsReleased)
            {
                var closed = Unavailable(args.ResultId);
                status = "failed";
                failure = new(closed.Code, closed.Message, 1, 1);
                messages.Add(closed.Message, MessageKind.Error);
            }
            else if (userStopped)
            {
                status = "cancelled";
                failure = new("CANCELLED", "Loading into memory was cancelled. The result stays windowed in BigQuery.", 1, 1);
                messages.Add(failure.Message, MessageKind.Error);
            }
            else
            {
                // The destination table expired: as a windowed read of it says, not a project to check.
                var mapped = error as RequestException ?? (NotFound(error) ? Expired() : BigQueryErrors.Map(error, window.Project) as RequestException)
                    ?? new RequestException("BACKEND_ERROR", "Loading into memory stopped unexpectedly: " + BigQueryErrors.Sanitize(error.Message));
                status = "failed";
                failure = new(mapped.Code, mapped.Message, 1, 1);
                messages.Add(mapped.Message, MessageKind.Error);
            }
        }
        finally
        {
            watch.Stop();
            set.Budget.EndLoad();
            queries.TryRemove(new(args.QueryId, running));
            events.Closed(set);
        }
        var budget = set.Budget;
        return new([set.Describe()], 0, messages.Snapshot(), -1, watch.ElapsedMilliseconds, status, failure, status == "completed" ? 1 : 0, 1, "", messages.Truncated,
            SummaryBudget(budget.StoppedBytes), DateTimeOffset.Now.ToString("yyyy-MM-ddTHH:mm:ss.fffffffzzz", CultureInfo.InvariantCulture));

        void SwitchBack()
        {
            var back = Window(window, set);
            if (store.Demote(set, back, window.TotalRows)) events.Residence(set);
        }
    }
}
