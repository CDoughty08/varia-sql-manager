using System.Diagnostics;
using System.Globalization;
using Google.Apis.Bigquery.v2.Data;
using Varia.Backend.BigQuery;
using Varia.Backend.Protocol;
using Varia.Backend.Results;

namespace Varia.Backend;

/// <summary>
/// Sort, filter and value lists of a windowed BigQuery result (docs/bigquery.md, Sort and filter in BigQuery): results.remoteQuery's
/// view and distinct kinds run a query job over the result's destination table, outside the tab's session, and read its
/// answer into a new result of the same query (a derived set, so a refusal ends only it), by the residence rule for a view
/// and whole into memory for a value list. bigquery.dryRun estimates the same query first. When the result table expired,
/// the original query runs again with the clauses around it, only when that gives the same rows (<see cref="CanFallBack"/>).
/// </summary>
internal sealed partial class SqlService
{
    /// <summary>results.remoteQuery (docs/ipc.md): Load into memory, a sort or filter (view), a value list (distinct), Load sample
    /// (sample) or Re-run (rerun).</summary>
    private Task<QueryResult> RemoteQueryAsync(RemoteQueryArgs args, RequestContext? context) => args.Kind switch
    {
        "load" => RemoteLoadAsync(args, context),
        "view" or "distinct" or "sample" or "rerun" => RemoteDerivedAsync(args, context),
        _ => throw new RequestException("INVALID_PARAMS", "A remote query's kind is load, view, distinct, sample or rerun.")
    };

    /// <summary>A derived remote query, checked and written: its source result and window, its SQL and parameters, whether it
    /// runs the original query again, and the value list's column. A sample reads <see cref="SampleRows"/> rows, its first ones
    /// through tabledata.list when <see cref="FirstRows"/> (no job, no SQL); a rerun runs the result's own statement in
    /// <see cref="Dataset"/>, its text read from the job when <see cref="FromJob"/>.</summary>
    private sealed record RemotePlan(ResultSetBuffer Set, BigQueryWindow Window, string Sql, List<QueryParameter> Parameters, bool Fallback, int? Column, bool Lists)
    {
        public string Kind { get; init; } = "view";
        public int SampleRows { get; init; }
        public bool FirstRows { get; init; }
        public bool FromJob { get; init; }
        public string? Dataset { get; init; }
    }

    /// <summary>Whether a windowed result's original query may run again in place of its expired result table: one query the
    /// scanner finds deterministic, not a script's child, run outside a session. Every tab job runs in the tab's session
    /// except in emulator mode, which has none, so only there.</summary>
    private bool CanFallBack(BigQueryWindow window) =>
        bigQuery.Environment.Emulator && !window.Child && GoogleSqlScanner.IsDeterministicQuery(window.Args.Sql);

    private static RequestException NotWindowed() => new("INVALID_PARAMS", "Only a windowed BigQuery result is sorted or filtered in BigQuery.");

    /// <summary>Checks a view, distinct, sample or rerun request against its source result and writes its query. A dry run
    /// (<paramref name="estimate"/>) reads a checklist's ticks without freezing them, so a declined prompt leaves the checklist
    /// as it was; the query itself freezes them.</summary>
    private RemotePlan PlanRemote(uint resultId, string kind, RemoteSortArgs[]? sort, RemoteFilterArgs[]? filters, int? column, RemoteFilterArgs[]? kept, bool fallback,
        int? rows = null, string? method = null, bool estimate = false)
    {
        if (kind is "sample" or "rerun") return PlanAuxiliary(resultId, kind, sort, filters, column, kept, fallback, rows, method);
        if (rows is not null || method is not null) throw new RequestException("INVALID_PARAMS", "Only a sample takes rows and a method.");
        if (resultId == 0 || kind is not ("view" or "distinct"))
            throw new RequestException("INVALID_PARAMS", "A remote view or value list needs a result and a kind (view or distinct).");
        var set = store.Find(resultId) ?? throw Unavailable(resultId);
        if (set.Remote is not { Source: BigQueryWindow window }) throw NotWindowed();
        var fields = window.Plan.Fields;
        sort ??= [];
        filters ??= [];
        if (sort.Length > BigQueryViewSql.MaxKeys || filters.Length > BigQueryViewSql.MaxFilters || kept is { Length: > BigQueryViewSql.MaxFilters })
            throw new RequestException("INVALID_PARAMS", "A remote view takes up to 16 sort keys and 16 filters.");
        if (kind == "view")
        {
            if (column is not null || kept is not null || sort.Length + filters.Length == 0)
                throw new RequestException("INVALID_PARAMS", "A remote view takes 1 to 16 sort keys or filters, and no column.");
            for (var i = 0; i < sort.Length; i++)
            {
                var key = sort[i] ?? throw new RequestException("INVALID_PARAMS", "A sort key needs a column.");
                Orderable(fields, key.Column, "sorted");
                for (var j = 0; j < i; j++)
                    if (sort[j].Column == key.Column) throw new RequestException("INVALID_PARAMS", "Each sort key must be a distinct column.");
            }
        }
        else
        {
            if (sort.Length > 0 || column is not { } listed) throw new RequestException("INVALID_PARAMS", "A value list takes a column and no sort keys.");
            Orderable(fields, listed, "listed");
        }
        var resolved = filters.Select(filter => ResolveRemote(filter, set, fields, estimate)).ToList();
        var keptRows = kept?.Select(filter => ResolveRemote(filter, set, fields, estimate)).ToList();
        string source;
        if (!fallback) source = BigQueryViewSql.Source(window.Table);
        else if (CanFallBack(window)) source = BigQueryViewSql.Source(window.Args.Sql);
        else throw Expired();
        var parameters = new List<QueryParameter>();
        var sql = kind == "view" ? BigQueryViewSql.View(source, fields, sort, resolved, parameters)
            : BigQueryViewSql.Values(source, fields, column!.Value, resolved, keptRows, parameters);
        // Whether it reads a value list's table (a filter with no values, or a groups filter frozen to none, reads none): a
        // missing table it did not read is not a list's.
        var lists = resolved.Concat(keptRows ?? []).Any(filter => filter.List is not null);
        return new RemotePlan(set, window, sql, parameters, fallback, column, lists);
    }

    /// <summary>Refuses a column the result does not show, or one BigQuery cannot order and group, with why.</summary>
    private static void Orderable(IReadOnlyList<BigQueryField> fields, int column, string verb)
    {
        if (column < 0 || column >= fields.Count) throw new RequestException("INVALID_PARAMS", "The column is not one of the result's.");
        if (!BigQueryViewSql.Orderable(fields[column]))
            throw new RequestException("INVALID_PARAMS", "BigQuery cannot sort or group a " + fields[column].TypeText() + " column, so it cannot be " + verb + " here.");
    }

    /// <summary>One filter against its value list: the list must be this result's, for this column, and its rows its own; a
    /// <c>groups</c> filter freezes its snapshot of the list, as results.view does, except for an estimate, which only reads it.</summary>
    private RemoteFilter ResolveRemote(RemoteFilterArgs? filter, ResultSetBuffer source, IReadOnlyList<BigQueryField> fields, bool estimate)
    {
        if (filter is null || filter.Column < 0 || filter.Column >= fields.Count) throw new RequestException("INVALID_PARAMS", "A filter needs a column of the result.");
        RemoteValueList List()
        {
            if (filter.List is not { } id || id == 0) throw new RequestException("INVALID_PARAMS", "A filter's values need the column's value list.");
            var held = store.Find(id) ?? throw ValueListClosed();
            return held.ValueList is { } list && list.Source == source.ResultId && list.Column == filter.Column ? list
                : throw new RequestException("INVALID_PARAMS", "The value list is not this column's.");
        }
        int[] Rows(RemoteValueList list, int[] rows) => rows.All(row => row >= 0 && row < list.Rows) ? rows
            : throw new RequestException("INVALID_PARAMS", "A filter's value is not one of its list's.");
        switch (filter.Op)
        {
            case "in" or "notIn" when filter.SnapshotId is null && filter.Rows is { Length: <= 2 } rows:
            {
                var list = rows.Length > 0 ? List() : null;
                return new RemoteFilter(filter.Op == "in" ? RemoteFilterKind.In : RemoteFilterKind.NotIn, filter.Column, list, list is null ? [] : Rows(list, rows), filter.Nulls == true);
            }
            case "between" when filter.SnapshotId is null && filter.Nulls is null && filter.Rows is { Length: 2 } rows:
            {
                var list = List();
                // BETWEEN a NULL bound keeps nothing: the list's NULL row (its value, column 0, is NULL) is no bound. A row not
                // in a sealed page reads as NULL too, so it is refused rather than guessed.
                var held = store.Find(filter.List!.Value);
                if (Rows(list, rows).Any(row => held?.CellSize(row, 0) is null))
                    throw new RequestException("INVALID_PARAMS", "A between filter's bounds are values, not NULL.");
                return new RemoteFilter(RemoteFilterKind.Between, filter.Column, list, rows, false);
            }
            case "groups" when filter.Rows is null && filter.Nulls is null && filter.SnapshotId is { } snapshotId and > 0:
            {
                var list = List();
                var snapshot = store.FindSnapshot(filter.List!.Value, snapshotId) ?? throw SnapshotClosed();
                var (op, rows, nulls) = estimate ? snapshot.Peek() : snapshot.Freeze();
                return new RemoteFilter(op == FilterOp.In ? RemoteFilterKind.In : RemoteFilterKind.NotIn, filter.Column, rows.Length > 0 ? list : null, rows, nulls);
            }
            default:
                throw new RequestException("INVALID_PARAMS", "A remote filter is in or notIn (up to 2 values and NULL), between (2 values) or groups (a value list's ticks).");
        }
    }

    private static RequestException ValueListClosed() => new("VIEW_NOT_FOUND", "This column's value list was closed. Open the column's filter again.");

    /// <summary>A value list's table expired (it lives as long as BigQuery keeps a query's result, about a day).</summary>
    private static RequestException ValueListExpired() =>
        new("REMOTE_EXPIRED", "BigQuery no longer has this column's value list. Open the column's filter again.");

    /// <summary>Whether BigQuery no longer has a result table (tabledata.list, free); false on any other failure, which the
    /// query itself then reports.</summary>
    private async Task<bool> TableGoneAsync(BigQueryConnection connection, TableReference table, CancellationToken token)
    {
        try
        {
            using var page = await bigQuery.TableRowsAsync(connection, table, 0, 1, null, token);
            return false;
        }
        catch (Exception error) when (!token.IsCancellationRequested && NotFound(error)) { return true; }
        catch (Exception error) when (!token.IsCancellationRequested && error is not OperationCanceledException) { return false; }
    }

    /// <summary>bigquery.dryRun: editor text, or a results.remoteQuery request.</summary>
    private Task<BigQueryDryRunResult> BigQueryDryRunAsync(BigQueryDryRunArgs args, CancellationToken token) =>
        args.Remote is null ? bigQuery.DryRunQueryAsync(args, token) : RemoteDryRunAsync(args, token);

    /// <summary>bigquery.dryRun of a results.remoteQuery request: the bytes its query would process. When the result table
    /// expired it estimates the original query run again, and says so (Fallback), or answers REMOTE_EXPIRED when that may not
    /// run (<see cref="CanFallBack"/>).</summary>
    private async Task<BigQueryDryRunResult> RemoteDryRunAsync(BigQueryDryRunArgs args, CancellationToken token)
    {
        var remote = args.Remote!;
        if (args.Sql is not null || args.Dataset is not null || args.SessionId is not null) throw new RequestException("INVALID_PARAMS", "A dry run takes query text or a remote query, not both.");
        var connection = bigQuery.Find(args.ConnectionId) ?? throw new RequestException("NOT_CONNECTED", "The connection is no longer open.");
        var set = store.Find(remote.ResultId) ?? throw Unavailable(remote.ResultId);
        if (set.Remote is not { Source: BigQueryWindow window }) throw NotWindowed();
        if (window.Connection != connection) throw new RequestException("INVALID_PARAMS", "The result is not this connection's.");
        // The request is checked whole before anything is asked of BigQuery.
        var plan = PlanRemote(remote.ResultId, remote.Kind, remote.Sort, remote.Filters, remote.Column, remote.Kept, false, remote.Rows, remote.Method, estimate: true);
        // The first rows are free (tabledata.list, no job): nothing to estimate.
        if (plan.FirstRows) return new(0, StatementType: "SELECT");
        var sql = plan.Sql;
        var dataset = plan.Dataset;
        if (plan.Kind == "rerun")
        {
            // A rerun reads what its statement reads, not the result table, so whether that expired does not matter.
            if (plan.FromJob) (sql, dataset, _) = await StatementAsync(plan, token);
        }
        // TABLESAMPLE reads a table, never a subquery: a sample of an expired result has nothing to fall back to.
        else if (plan.Kind == "sample") await SampleTableAsync(connection, window.Table, token);
        else if (await TableGoneAsync(connection, window.Table, token))
        {
            plan = PlanRemote(remote.ResultId, remote.Kind, remote.Sort, remote.Filters, remote.Column, remote.Kept, true, estimate: true);
            sql = plan.Sql;
            dataset = window.Args.Dataset ?? connection.Options.Dataset;
        }
        BigQueryEstimate estimate;
        try { estimate = await bigQuery.EstimateAsync(connection, sql, token, dataset, plan.Parameters, window.Location); }
        // A table that is not there is a value list's, unless the result's own expired since the check above. A rerun's
        // missing table is its statement's, which BigQuery's own words name.
        catch (RequestException error) when (plan.Kind != "rerun" && error.Code is "SQL_ERROR" or "NOT_FOUND" && error.Message.StartsWith("Not found: Table", StringComparison.Ordinal))
        {
            if (!plan.Fallback && await TableGoneAsync(connection, window.Table, token)) throw Expired();
            if (plan.Lists) throw ValueListExpired();
            throw;
        }
        return new(estimate.BytesProcessed, estimate.Incomplete, estimate.StatementType, estimate.Faked, plan.Fallback ? true : null);
    }

    /// <summary>Checks only: runs after a derived remote query registers, before its job is inserted.</summary>
    internal Action? RemoteDerivedRegistered { get; set; }

    /// <summary>
    /// results.remoteQuery, kind view, distinct, sample or rerun: one query job over the windowed result (or its original query,
    /// Fallback; or, for a rerun, the result's own statement), outside the tab's session, under the original query's billing cap
    /// and timeout. Its answer becomes a new result of the same query, announced with resultSet.opened: a view or rerun by the
    /// residence rule (so a small one is in memory, and a large one is windowed itself), a value list whole in memory and marked
    /// as one (<see cref="ResultSetBuffer.ValueList"/>), a sample in memory. A sample of the first rows runs no job: it reads
    /// them through tabledata.list. Stop, the source's release or a failure releases the new result and cancels the job; the
    /// answer is a query summary.
    /// </summary>
    private async Task<QueryResult> RemoteDerivedAsync(RemoteQueryArgs args, RequestContext? context)
    {
        if (!Guid.TryParse(args.QueryId, out _)) throw new RequestException("INVALID_PARAMS", "A remote query needs its query ID.");
        var distinct = args.Kind == "distinct";
        var plan = PlanRemote(args.ResultId, args.Kind, args.Sort, args.Filters, args.Column, args.Kept, args.Fallback == true, args.Rows, args.Method);
        var (set, window) = (plan.Set, plan.Window);
        var kind = plan.Kind;
        var sample = kind == "sample";
        var connection = window.Connection;
        if (bigQuery.Find(connection.Id) != connection) throw new RequestException("NOT_CONNECTED", "The connection was closed.");
        if (set.Budget.Executing) throw new RequestException("BUSY", "This result's query is still running. " + RemoteVerb(kind) + " once the query has finished.");
        // A sample or rerun is read into the same budget a load is filling.
        if (kind is "sample" or "rerun" && set.Budget.Loading)
            throw new RequestException("BUSY", "Another result of this query is loading into memory. " + RemoteVerb(kind) + " once it has finished.");
        if (BudgetStopped(set.Budget) is { } stopped) throw stopped;
        var queryArgs = window.Args with
        {
            Sql = plan.Sql, QueryId = args.QueryId,
            // A value list is read whole, never capped by Maximum rows, so its rows are its values' ranks; a sample is capped by
            // its own LIMIT and is always read into memory.
            MaxRows = distinct || sample ? 0 : window.QueryMaxRows ?? window.Args.MaxRows, Residence = distinct || sample ? "memory" : window.Args.Residence
        };
        // The query's timeout bounds a job; a first-rows sample runs none, and Stop ends its free reads.
        var timeout = plan.FirstRows ? 0 : window.Args.TimeoutSeconds;
        using var cancellation = timeout == 0 ? new CancellationTokenSource() : new CancellationTokenSource(TimeSpan.FromSeconds(timeout));
        var running = new RunningQuery(connection.Id, args.QueryId, cancellation);
        if (!Register(args.QueryId, running)) throw new RequestException("DUPLICATE_QUERY", "This query is already running.");
        RemoteDerivedRegistered?.Invoke();
        if (bigQuery.Find(connection.Id) != connection)
        {
            queries.TryRemove(new(args.QueryId, running));
            throw new RequestException("NOT_CONNECTED", "The connection was closed.");
        }
        using var cancelled = context?.Token.Register(() => { if (context.Reason == CancelReason.Deadline) TryCancel(cancellation); else running.Cancel(); });
        // The source released (Close Results, the tab closed or ran again): no one holds what this would add to.
        using var gone = set.Closed.Register(running.Cancel);
        using var events = new QueryEventSink(context is null ? null : context.SendEvent);
        var messages = new QueryMessages(events.Message);
        Action<string> warn = text => messages.Add(text);
        var token = cancellation.Token;
        var watch = Stopwatch.StartNew();
        var project = window.Project;
        var jobId = BigQueryService.NewJobId();
        var location = window.Location;
        var dataset = plan.Fallback ? window.Args.Dataset ?? connection.Options.Dataset : plan.Dataset;
        var cap = connection.Options.MaximumBytesBilled ?? window.Args.MaximumBytesBilled;
        var prices = window.Args.Prices != false;
        var sent = false;
        var complete = false;
        var created = false;
        ResultSetBuffer? derived = null;
        BigQueryJobSummary? summary = null;
        var status = "completed";
        QueryFailure? failure = null;
        var stopAsked = 0;
        // Whether jobs.insert has answered or failed: a cancel sent while it is in flight can reach BigQuery before the job
        // exists, so Stop then waits for the insert to settle and cancels from there (asking again while BigQuery answers 404).
        var insertSettled = false;
        void StopJob()
        {
            if (!sent || complete || !Volatile.Read(ref insertSettled)) return;
            if (Interlocked.Exchange(ref stopAsked, 1) == 0) bigQuery.CancelJob(connection, project, jobId, location, maybeUnborn: !created);
        }
        using var stopJob = token.Register(StopJob);
        try
        {
            if (plan.FirstRows)
            {
                // Free: tabledata.list reads the result table's first rows, and no job runs.
                derived = store.Open(set.Budget, set.Index, set.BatchNumber, set.Iteration, "rows", window.Plan.Columns, window.Plan.Wires, lengths: window.Plan.Lengths, derived: true)
                    ?? throw TooLarge(SampleRoom);
                derived.InMemory(Math.Min(plan.SampleRows, window.TotalRows));
                events.Opened(derived);
                await SampleFirstRowsAsync(connection, window, plan.SampleRows, derived, set.Budget, events, warn, token);
                derived.Complete();
                // The source released while the last rows came: nothing owns the new result (the catch releases it).
                if (set.IsReleased) throw Unavailable(args.ResultId);
                events.Closed(derived);
                messages.Add(SampleSentence(derived, window.TotalRows) + " Its first rows were read with tabledata.list, which is free and runs no job.");
            }
            else
            {
                if (plan.Fallback) messages.Add("BigQuery no longer has the result's temporary table, so the original query runs again with the sort or filter around it.");
                // A random sample's table is checked against TABLESAMPLE's limitations (free) before anything is billed.
                var sampled = sample ? await SampleTableAsync(connection, window.Table, token) : null;
                // A rerun's statement is read from its job (free) before anything is billed.
                if (plan.FromJob)
                {
                    var (statement, from, session) = await StatementAsync(plan, token);
                    // The window it opens keeps them, so its own rerun starts from what ran.
                    queryArgs = queryArgs with { Sql = statement, Dataset = from };
                    dataset = from;
                    if (session) messages.Add(RerunOutsideSession);
                }
                var job = new Job
                {
                    JobReference = new JobReference { ProjectId = project, JobId = jobId, Location = location },
                    Configuration = new JobConfiguration
                    {
                        Labels = new Dictionary<string, string>(BigQueryService.Labels),
                        JobTimeoutMs = timeout > 0 ? timeout * 1000L : null,
                        Query = new JobConfigurationQuery
                        {
                            Query = queryArgs.Sql, UseLegacySql = false, QueryParameters = plan.Parameters, ParameterMode = "NAMED",
                            DefaultDataset = dataset is null ? null : new DatasetReference { ProjectId = project, DatasetId = dataset },
                            MaximumBytesBilled = cap
                        }
                    }
                };
                sent = true;
                Job inserted;
                try
                {
                    inserted = await bigQuery.InsertJobAsync(connection, job, dataset, token);
                    created = true;
                }
                catch (Exception error) when (BigQueryService.NeverCreated(error) && !token.IsCancellationRequested)
                {
                    // Refused outright or never sent: no job to cancel.
                    sent = false;
                    throw;
                }
                finally
                {
                    Volatile.Write(ref insertSettled, true);
                    // Stop (or the source's release) came while the insert was out: cancel what it may have created.
                    if (token.IsCancellationRequested) StopJob();
                }
                location = KnownLocation(inserted.JobReference?.Location) ?? location;
                messages.Add("BigQuery job " + JobName(project, location, jobId) + ".");
                events.Job(JobEvent(project, jobId, location, "running", BigQueryTransaction.None));
                if (BigQueryJobException.Of(inserted) is { } refused) throw refused;
                BigQueryPage? page = null;
                try
                {
                    while (true)
                    {
                        token.ThrowIfCancellationRequested();
                        page = await bigQuery.QueryResultsAsync(connection, project, jobId, location, null, BigQueryFirstPageRows, bigQuery.ChildPollMs, token);
                        if (page.JobComplete) break;
                        page.Dispose();
                        page = null;
                    }
                    complete = true;
                    var finished = await bigQuery.GetJobAsync(connection, project, jobId, location, token);
                    summary = JobSummary(project, location, jobId, finished);
                    events.Job(JobEvent(project, jobId, location, "done", BigQueryTransaction.None));
                    var columns = BigQueryColumnPlan.From(page.Schema) ?? throw new RequestException("BACKEND_ERROR", "BigQuery answered the query without columns.");
                    var total = page.TotalRows ?? 0;
                    derived = store.Open(set.Budget, set.Index, set.BatchNumber, set.Iteration, "rows", columns.Columns, columns.Wires, lengths: columns.Lengths, derived: true)
                        ?? throw TooLarge(distinct ? "There is not enough result memory for this column's values. Close other results and try again."
                            : sample ? SampleRoom : "There is not enough result memory for this view. Close other results and try again.");
                    BigQueryWindow? derivedWindow = null;
                    RemoteResult? windowed;
                    // Announced even when deciding fails, so the end closes a set the grid heard open.
                    try { windowed = await DecideResidenceAsync(queryArgs, connection, project, jobId, location, finished, false, columns, page, derived, set.Budget, messages, value => derivedWindow = value, token); }
                    catch
                    {
                        events.Opened(derived);
                        throw;
                    }
                    events.Opened(derived);
                    if (windowed is null)
                    {
                        var readSession = distinct ? null : await BigQueryStorageSessionAsync(queryArgs, connection, project, jobId, location, columns, page, messages, token);
                        var reading = page;
                        page = null;
                        if (readSession is null) await ReadBigQueryRowsAsync(queryArgs, connection, project, jobId, location, columns, reading, derived, set.Budget, total, new RoomWaited(), events, warn, token, derivedWindow, messages);
                        else
                        {
                            reading.Dispose();
                            await ReadBigQueryArrowAsync(queryArgs, readSession, derived, set.Budget, total, new RoomWaited(), events, warn, token, derivedWindow, messages);
                        }
                    }
                    derived.Complete();
                    if (distinct)
                    {
                        // A value list is used whole: its rows are named by rank, so a part would name the wrong values.
                        if (derived.IsRemote || derived.Describe().RowsStored < total)
                            throw TooLarge("There is not enough result memory for this column's values. Close other results and try again.");
                        var table = await DestinationAsync(connection, project, jobId, location, finished, token)
                            ?? throw new RequestException("BACKEND_ERROR", "BigQuery did not name the value list's result table.");
                        derived.ValueList = new RemoteValueList(table, set.ResultId, plan.Column!.Value, (int)total, total >= BigQueryViewSql.ValueListCap);
                    }
                    // A rerun stands for its source from now on, so it may be run again itself.
                    if (kind == "rerun") derived.Reran = true;
                    // The source released while the last rows came: nothing owns the new result (the catch releases it).
                    if (set.IsReleased) throw Unavailable(args.ResultId);
                    events.Closed(derived);
                    messages.Add(distinct ? "The column's values were listed in BigQuery." : sample ? SampleSentence(derived, window.TotalRows) + ShortSample(total, plan.SampleRows, window.TotalRows) + OneBlock(sampled!)
                        : total == 1 ? "(1 row affected)" : "(" + total.ToString(CultureInfo.InvariantCulture) + " rows affected)");
                }
                finally { page?.Dispose(); }
            }
        }
        catch (Exception error)
        {
            if (derived is not null)
            {
                // A part of a view or value list is never kept: the grid falls back to the source.
                derived.Incomplete = true;
                if (derived.IsOpen) derived.Complete();
                events.Closed(derived);
                if (store.Release([derived.ResultId]) > 0) ReportMemory();
                derived = null;
            }
            if (!token.IsCancellationRequested && bigQuery.Find(connection.Id) != connection) running.Cancel();
            if (set.IsReleased)
            {
                StopJob();
                var closed = Unavailable(args.ResultId);
                status = "failed";
                failure = new(closed.Code, closed.Message, 1, 1);
                messages.Add(closed.Message, MessageKind.Error);
            }
            else if (token.IsCancellationRequested)
            {
                StopJob();
                status = running.UserCancelled ? "cancelled" : "timedOut";
                var sentence = running.UserCancelled ? RemoteNoun(kind) + " was cancelled." : RemoteNoun(kind) + " exceeded the query's execution timeout.";
                messages.Add(sentence, MessageKind.Error);
                if (running.UserCancelled && sent && !complete)
                    messages.Add("Varia asked BigQuery to cancel job " + JobName(project, location, jobId) + ". Cancelling is best-effort: BigQuery may still bill work done before the job stopped.");
                failure = new(running.UserCancelled ? "CANCELLED" : "TIMEOUT", sentence, 1, 1);
            }
            else
            {
                var mapped = error as RequestException ?? await RemoteFailureAsync(error, connection, window, created, cap, prices, plan.Lists, kind);
                status = "failed";
                messages.Add(mapped.Message, MessageKind.Error);
                failure = new(mapped.Code, mapped.Message.Length > 16384 ? mapped.Message[..16384] + "…" : mapped.Message, 1, 1);
            }
        }
        finally
        {
            watch.Stop();
            queries.TryRemove(new(args.QueryId, running));
        }
        if (summary is not null && BigQueryCost.Summary(summary, prices) is { } cost) messages.Add(cost);
        var descriptors = derived is null ? new List<ResultDescriptor>() : [derived.Describe()];
        if (context is not null && derived is { } made) context.Unsent = () => store.Release([made.ResultId]);
        return new(descriptors, 0, messages.Snapshot(), -1, watch.ElapsedMilliseconds, status, failure, status == "completed" ? 1 : 0, 1, dataset ?? "", messages.Truncated,
            SummaryBudget(set.Budget.StoppedBytes), DateTimeOffset.Now.ToString("yyyy-MM-ddTHH:mm:ss.fffffffzzz", CultureInfo.InvariantCulture),
            Job: summary ?? (created ? new BigQueryJobSummary(project, jobId, location) : null));
    }

    /// <summary>A derived query's failure: an expired result table (or value list) as REMOTE_EXPIRED, an ORDER BY BigQuery had
    /// no resources for with a pointer to filtering first, anything else as Execute reports it.</summary>
    private async Task<RequestException> RemoteFailureAsync(Exception error, BigQueryConnection connection, BigQueryWindow window, bool created, long? cap, bool prices, bool lists,
        string kind = "view")
    {
        var mapped = await BigQueryFailureAsync(error, connection, created, cap, prices, CancellationToken.None);
        // A rerun reads its statement's tables, not the expired result table: BigQuery's own words name what is missing.
        if (kind == "rerun") return mapped;
        if (kind is "view" or "distinct" && error is BigQueryJobException job && job.Errors.Concat([job.Result]).Any(entry => entry.Reason == "resourcesExceeded"))
            return new RequestException(mapped.Code, mapped.Message + " Filter the result first, so BigQuery sorts fewer rows.");
        if (NotFound(error) || (error is BigQueryJobException missing && missing.Errors.Concat([missing.Result]).Any(entry => entry.Reason == "notFound")))
            return await TableGoneAsync(connection, window.Table, CancellationToken.None) ? Expired() : lists ? ValueListExpired() : mapped;
        return mapped;
    }

    /// <summary>results.distinct of a value list (<see cref="ResultSetBuffer.ValueList"/>): its rows are already the column's
    /// values in value order with their counts (n) and whether the kept rows hold them (k), so the snapshot is read from
    /// them rather than grouped. It is complete unless the cap cut the list, so a filter of a cut list drops the cleared
    /// values (NotIn) and keeps those never listed.</summary>
    private ResultsDistinctResult ValueListSnapshot(ResultSetBuffer set, RemoteValueList list, ResultsDistinctArgs args)
    {
        if (args.Column != 0 || args.ViewId is not null || args.KeptViewId is not null)
            throw new RequestException("INVALID_PARAMS", "A value list is read whole, from its first column.");
        if (!set.IsComplete) throw new RequestException("RESULT_OPEN", "The column's values are still loading.");
        using var pin = set.Pin();
        var pages = set.SealedSnapshot();
        var charged = ViewSorter.DistinctSnapshotBytes(list.Rows);
        if (!store.TryReserveWork(set.Budget, charged)) throw TooLarge(ViewSorter.DistinctTooLarge);
        DistinctSnapshot built;
        try
        {
            var reps = new List<int>(list.Rows);
            var counts = new List<int>(list.Rows);
            var ticks = new List<bool>(list.Rows);
            long rows = 0, nulls = 0;
            bool nullTicked = false, approximate = false;
            foreach (var page in pages)
            {
                var body = set.Raw(page) ?? page.Body();
                var view = PageView.Parse(body, set.Wires.Count);
                for (var local = 0; local < view.Rows; local++)
                {
                    var count = long.TryParse(view.Span(1, local), NumberStyles.None, CultureInfo.InvariantCulture, out var n) ? n : 0;
                    var kept = view.Span(3, local).SequenceEqual("true"u8);
                    rows += count;
                    if (view.IsNull(0, local) && !view.IsError(0, local))
                    {
                        nulls += count;
                        nullTicked = kept;
                        continue;
                    }
                    approximate |= view.IsTruncated(0, local);
                    reps.Add((int)(page.FirstRow + local));
                    counts.Add((int)Math.Min(count, int.MaxValue));
                    ticks.Add(kept);
                }
            }
            var countArray = counts.ToArray();
            var snapshot = new DistinctSnapshot(set, 0, new KeptPages(set, pages, set.Wires.Count), [.. reps], countArray, ViewSorter.ByCount(countArray), [.. ticks], rows, nulls, nullTicked,
                complete: !list.Capped, approximate) { Charged = charged };
            built = snapshot;
        }
        catch
        {
            store.Return(set.Budget, charged);
            throw;
        }
        // Outside the catch: a refusal here returns the charge itself.
        store.AddSnapshot(built);
        var (ticked, nullsTicked) = built.Ticks;
        return new ResultsDistinctResult(built.SnapshotId, built.Rows, built.Complete, built.Nulls, built.Distinct, built.Approximate, ticked, nullsTicked);
    }
}
