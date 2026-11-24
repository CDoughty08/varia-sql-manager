using System.Diagnostics;
using System.Globalization;
using Varia.Backend.BigQuery;
using Varia.Backend.Protocol;
using Varia.Backend.Results;

namespace Varia.Backend;

/// <summary>
/// Preview Rows (docs/bigquery.md, Preview Rows): a table's first rows through tabledata.list, which is free and runs no job, read
/// through the same converter as query results (BigQueryColumnPlan) into the tab's result store, so the tab's earlier results are
/// released first and Close Results, re-execute and tab close release these. Only tables, snapshots and clones have stored rows to
/// list; a view, materialized view or external table is refused (the renderer offers Script As › SELECT instead), and a table with
/// row access policies answers ROW_ACCESS, since tabledata.list cannot apply them.
/// </summary>
internal sealed partial class SqlService
{
    /// <summary>The rows Preview Rows reads at most.</summary>
    internal const int BigQueryPreviewRows = 1000;
    /// <summary>Preview's budget inside its 120 s deadline.</summary>
    internal TimeSpan BigQueryPreviewLimit { get; set; } = TimeSpan.FromSeconds(110);

    private async Task<QueryResult> PreviewBigQueryAsync(QueryArgs query, BigQueryPreviewTarget target, BigQueryConnection connection, RequestContext? context)
    {
        if (!Guid.TryParse(query.QueryId, out _) || !Guid.TryParse(query.SessionId, out _) || !BqNames.IsProject(target.Project) || !BqNames.IsDataset(target.Dataset) || !BqNames.IsTable(target.Table))
            throw new RequestException("INVALID_PARAMS", "The table, query or session is invalid.");
        // As Execute: SQL Server's options have no BigQuery meaning, and the tab's dataset is echoed back only when it is one.
        if (query.StopOnError || query.IncludeActualPlan || query.IncludeLivePlan || query.IncludeClientStatistics)
            throw new RequestException("UNSUPPORTED_PROVIDER", "Stop on error, actual and live plans and client statistics are not available for BigQuery connections.");
        if (query.Dataset is { } tabDataset && !BqNames.IsDataset(tabDataset))
            throw new RequestException("INVALID_PARAMS", "A dataset name has only letters, numbers and underscores.");
        // Bounded as Execute bounds them, though a preview's rows are always read into memory (its 1,000 rows).
        ResidenceOf(query.Residence);
        CacheBytesOf(query.WindowCacheMiB);
        var args = new PreviewRequest(query.ConnectionId, query.SessionId, query.QueryId, target.Project, target.Dataset, target.Table);
        using var cancellation = new CancellationTokenSource(BigQueryPreviewLimit);
        var running = new RunningQuery(args.ConnectionId, args.SessionId, cancellation);
        if (!Register(args.QueryId, running)) throw new RequestException("DUPLICATE_QUERY", "This query is already running.");
        if (!bigQueryTabs.TryAdd(args.SessionId, 0))
        {
            queries.TryRemove(new(args.QueryId, running));
            throw new RequestException("SESSION_BUSY", "A query is already running in this tab.");
        }
        // A disconnect that came between finding the handle and registering cancelled nothing of this preview's: refuse it.
        if (bigQuery.Find(args.ConnectionId) != connection)
        {
            bigQueryTabs.TryRemove(args.SessionId, out _);
            queries.TryRemove(new(args.QueryId, running));
            throw new RequestException("NOT_CONNECTED", "The connection was closed.");
        }
        using var cancelled = context?.Token.Register(() => { if (context.Reason == CancelReason.Deadline) TryCancel(cancellation); else running.Cancel(); });
        using var events = new QueryEventSink(context is null ? null : context.SendEvent);
        var messages = new QueryMessages(events.Message);
        Action<string> warn = text => messages.Add(text);
        var token = cancellation.Token;
        var watch = Stopwatch.StartNew();
        var sets = new List<ResultSetBuffer>();
        QueryBudget? budget = null;
        var status = "completed";
        QueryFailure? failure = null;
        var name = args.Project + "." + args.Dataset + "." + args.Table;
        try
        {
            using var table = await bigQuery.MetadataAsync(connection, t =>
            {
                var call = connection.Client.Service.Tables.Get(args.Project, args.Dataset, args.Table);
                call.Fields = "schema,type";
                return bigQuery.SendRawAsync(connection.Client.Service, call, t);
            }, token);
            var type = table.Text("type");
            if (type is not ("TABLE" or "SNAPSHOT"))
                throw new RequestException("INVALID_PARAMS", "Preview Rows reads stored tables only; " + name + " is " + (type is null ? "not a table" : "a " + type.Replace('_', ' ').ToLowerInvariant())
                    + ". Use Script As › SELECT to query it (billed).");
            var plan = BigQueryColumnPlan.From(table.Schema) ?? throw new RequestException("INVALID_PARAMS", "Table " + name + " has no columns to preview.");
            budget = store.BeginQuery(args.SessionId);
            if (plan.TruncatedColumns)
                messages.Add("The table has " + plan.SchemaColumns.ToString("N0", CultureInfo.InvariantCulture) + " columns; the first " + PageBuilder.MaxColumns.ToString("N0", CultureInfo.InvariantCulture) + " are shown.");
            var set = store.Open(budget, 0, 1, 1, "rows", plan.Columns, plan.Wires, lengths: plan.Lengths);
            if (set is not null)
            {
                sets.Add(set);
                events.Opened(set);
                await PreviewRowsAsync(connection, args, plan, set, budget, events, warn, token);
                set.Complete();
                events.Closed(set);
            }
            messages.Add("Preview Rows read the first rows of " + name + " with tabledata.list, which is free and runs no job.");
        }
        catch (Exception error)
        {
            foreach (var set in sets) set.Incomplete = true;
            if (token.IsCancellationRequested)
            {
                status = running.UserCancelled ? "cancelled" : "timedOut";
                var sentence = running.UserCancelled ? CancelledSentence : TimedOutSentence;
                messages.Add(sentence, MessageKind.Error);
                failure = new(running.UserCancelled ? "CANCELLED" : "TIMEOUT", sentence, 1, 1);
            }
            else
            {
                var mapped = PreviewFailure(error, args.Project);
                status = "failed";
                messages.Add(mapped.Message, MessageKind.Error);
                failure = new(mapped.Code, mapped.Message, 1, 1);
            }
        }
        finally
        {
            watch.Stop();
            queries.TryRemove(new(args.QueryId, running));
            foreach (var set in sets.Where(set => set.IsOpen))
            {
                set.Complete();
                events.Closed(set);
            }
            bigQueryTabs.TryRemove(args.SessionId, out _);
        }
        var output = messages.Snapshot();
        var descriptors = sets.Select(set => set.Describe()).ToList();
        if (PreviewStopNote(descriptors.Select(set => set.Truncated)) is { } note) output.Add(new(note, QueryMessages.Info));
        if (context is not null) context.Unsent = () => store.Release(descriptors.Select(set => set.ResultId));
        var completedAt = DateTimeOffset.Now.ToString("yyyy-MM-ddTHH:mm:ss.fffffffzzz", CultureInfo.InvariantCulture);
        // The tab's dataset as Execute reports it (its own, else the connection's): the previewed table may be in another project.
        return new(descriptors, 0, output, -1, watch.ElapsedMilliseconds, status, failure, status is "completed" ? 1 : 0, 1, query.Dataset ?? connection.Options.Dataset ?? "", messages.Truncated,
            SummaryBudget(budget?.StoppedBytes), completedAt);
    }

    /// <summary>tabledata.list's pages up to <see cref="BigQueryPreviewRows"/> (the emulator ignores maxResults, so the count is kept
    /// here too); the rows past it are counted from the table's total.</summary>
    private sealed record PreviewRequest(string ConnectionId, string SessionId, string QueryId, string Project, string Dataset, string Table);

    private async Task PreviewRowsAsync(BigQueryConnection connection, PreviewRequest args, BigQueryColumnPlan plan, ResultSetBuffer set, QueryBudget budget,
        QueryEventSink events, Action<string> warn, CancellationToken token)
    {
        string? pageToken = null;
        long stored = 0, counted = 0, total = 0;
        // Set when the set stops taking rows (a row limit or the result budget): no further page is read.
        var stopping = false;
        var roomWaited = new RoomWaited();
        do
        {
            using var page = await bigQuery.MetadataAsync(connection, t =>
            {
                var call = connection.Client.Service.Tabledata.List(args.Project, args.Dataset, args.Table);
                call.MaxResults = BigQueryPreviewRows - (int)stored;
                call.PageToken = pageToken;
                call.FormatOptionsUseInt64Timestamp = true;
                return bigQuery.SendRawAsync(connection.Client.Service, call, t);
            }, token);
            total = page.TotalRows ?? total;
            var charge = page.Cost(plan.Columns.Count);
            if (!store.TryReserve(budget, charge, true, out var refusal))
            {
                set.Skip(refusal);
                budget.Stop(refusal);
                stopping = true;
                break;
            }
            try
            {
                foreach (var row in page.Rows.ValueKind == System.Text.Json.JsonValueKind.Array ? page.Rows.EnumerateArray() : default)
                {
                    token.ThrowIfCancellationRequested();
                    if (stored >= BigQueryPreviewRows) break;
                    set.CountRow();
                    counted++;
                    var builder = set.BeginRow();
                    if (builder is null) { stopping = true; break; }
                    int truncatedCells;
                    try { truncatedCells = plan.ReadRow(row, builder, warn); }
                    catch { set.AbortRow(); throw; }
                    var committed = set.TryCommitRow(truncatedCells, mayWait: true);
                    if (!committed && set.RoomWanted > 0) committed = await WaitAndCommitAsync(store, set, truncatedCells, roomWaited, token);
                    if (!committed) { stopping = true; break; }
                    stored++;
                }
            }
            finally { store.Return(budget, charge); }
            events.RowsChanged();
            if (set.HasPendingRows)
            {
                set.Seal();
                events.Sealed(set);
            }
            pageToken = !stopping && stored < BigQueryPreviewRows ? page.PageToken : null;
        } while (pageToken is not null);
        if (stored >= BigQueryPreviewRows && total > counted) set.Skip(TruncationReason.RowLimit);
        if (total > counted) set.CountRows(total - counted);
        events.RowsChanged();
    }

    /// <summary>Why Preview Rows stopped reading early, from its result's truncation: the result budget, or the computer's
    /// low memory, which closing results alone may not cure. Null when it read every page it meant to.</summary>
    internal static string? PreviewStopNote(IEnumerable<string?> truncated)
    {
        var reasons = truncated.ToList();
        if (reasons.Any(reason => reason is "queryBudget" or "globalBudget"))
            return "Preview Rows stopped early because the result memory budget is full; close other query results to free memory.";
        return reasons.Contains("systemMemory")
            ? "Preview Rows stopped early because the computer is low on memory; close other query results or other programs to free memory."
            : null;
    }

    /// <summary>A preview's failure: ROW_ACCESS when row access policies refused tabledata.list, else the usual mapping.</summary>
    internal static RequestException PreviewFailure(Exception error, string project)
    {
        if (error is RequestException own) return own;
        var mapped = BigQueryErrors.Map(error, project, "bigquery.tables.getData") as RequestException ?? new RequestException("BACKEND_ERROR", "Preview Rows failed.");
        for (var current = error; current is not null; current = current.InnerException)
            if (current is Google.GoogleApiException api && (api.Error?.Message ?? api.Message).Contains("row access polic", StringComparison.OrdinalIgnoreCase))
                return new RequestException("ROW_ACCESS", "This table has row access policies, which Preview Rows cannot apply. Use Script As › SELECT to query it (billed).");
        return mapped;
    }
}
