using System.Globalization;
using Google.Apis.Bigquery.v2.Data;
using Varia.Backend.BigQuery;
using Varia.Backend.Protocol;
using Varia.Backend.Results;

namespace Varia.Backend;

/// <summary>
/// Load sample and Re-run of a windowed BigQuery result (docs/bigquery.md, Load a sample, Expiry): results.remoteQuery's
/// sample and rerun kinds, which <see cref="RemoteDerivedAsync"/> runs as it runs a view. A sample of the first rows reads them
/// through tabledata.list (free, no job); a random one runs <c>TABLESAMPLE SYSTEM</c> over the result table, which bills only
/// the blocks it reads. A rerun runs the result's own statement again (a script child's alone), outside the tab's session, and
/// its result stands in for the source. Both are auxiliary: the source's release cancels them.
/// </summary>
internal sealed partial class SqlService
{
    /// <summary>Checks a sample or rerun request against its source result and writes its query.</summary>
    private RemotePlan PlanAuxiliary(uint resultId, string kind, RemoteSortArgs[]? sort, RemoteFilterArgs[]? filters, int? column, RemoteFilterArgs[]? kept, bool fallback, int? rows, string? method)
    {
        var sample = kind == "sample";
        if (resultId == 0 || sort is not null || filters is not null || column is not null || kept is not null || fallback)
            throw new RequestException("INVALID_PARAMS", sample ? "A sample takes its rows and a method (first or random), and nothing else." : "A rerun takes only its result.");
        var set = store.Find(resultId) ?? throw Unavailable(resultId);
        if (set.Remote is not { Source: BigQueryWindow window })
            throw new RequestException("INVALID_PARAMS", sample ? "Only a windowed BigQuery result loads a sample." : "Only a windowed BigQuery result runs again in place.");
        if (sample)
        {
            if (rows is not { } count || count < 1 || count > BigQueryViewSql.MaxSampleRows || method is not ("first" or "random"))
                throw new RequestException("INVALID_PARAMS", "A sample takes 1 to 10,000,000 rows and a method, first or random.");
            if (method == "first") return new RemotePlan(set, window, "", [], false, null, false) { Kind = kind, SampleRows = count, FirstRows = true };
            var parameters = new List<QueryParameter>();
            return new RemotePlan(set, window, BigQueryViewSql.Sample(window.Table, count, window.TotalRows, parameters), parameters, false, null, false) { Kind = kind, SampleRows = count };
        }
        if (rows is not null || method is not null) throw new RequestException("INVALID_PARAMS", "A rerun takes only its result.");
        // A view's, value list's or sample's own statement reads a result table that may be gone: only the query's result (or
        // the rerun that replaced it) runs again.
        if (set.Derived && !set.Reran)
            throw new RequestException("INVALID_PARAMS", "Only a query's own result runs again in place. Run the query again for a sorted or filtered view, a value list or a sample.");
        // The text kept here may be a whole script's (a script child's, or a script whose children were not listed) or none (a
        // re-attached job's): the statement is always read from the job, which also says whether it was one SELECT.
        return new RemotePlan(set, window, "", [], false, null, false)
        {
            Kind = kind, FromJob = true, Dataset = window.Args.NoDefaultDataset ? null : window.Args.Dataset ?? window.Connection.Options.Dataset
        };
    }

    /// <summary>A rerun's statement from its job (jobs.get, free): the statement that made the result (a script child's alone),
    /// and the default dataset it ran with when that was the billing project's. Only one SELECT runs again: a script's job, or
    /// any other statement, is refused before anything is billed.</summary>
    private async Task<(string Sql, string? Dataset, bool Session)> StatementAsync(RemotePlan plan, CancellationToken token)
    {
        var window = plan.Window;
        var job = await bigQuery.GetJobAsync(window.Connection, window.Project, window.JobId, window.Location, token);
        var query = job.Configuration?.Query;
        if (string.IsNullOrWhiteSpace(query?.Query))
            throw new RequestException("BACKEND_ERROR", "BigQuery did not say which statement made this result, so it cannot run again in place. Run the query again.");
        // The emulator names no statement type; BigQuery names every job's, so a job it does not name as one SELECT is refused.
        var type = BigQueryService.StatementOf(job.Statistics);
        if (type == "SCRIPT" || job.Statistics?.NumChildJobs > 0)
            throw new RequestException("INVALID_PARAMS", "Only a single SELECT's result runs again in place, and this result came from a script. Run the query again.");
        // There the text itself must be one query: a script's parent job holds the whole script.
        if (type != "SELECT" && !(type is null && bigQuery.Environment.Emulator && GoogleSqlScanner.IsSingleQuery(query.Query)))
            throw new RequestException("INVALID_PARAMS", "Only a single SELECT's result runs again in place, and BigQuery does not name this result's statement a SELECT. Run the query again.");
        // A job made outside Varia may be legacy SQL, which Varia never runs (nor guesses at as GoogleSQL).
        if (query.UseLegacySql == true || BigQueryErrors.IsLegacySql(query.Query)) throw new RequestException("LEGACY_SQL", BigQueryErrors.LegacySql);
        if (query.DefaultDataset is { DatasetId: { Length: > 0 } externalDataset, ProjectId: { } externalProject } && externalProject != window.Project)
            throw new RequestException("INVALID_PARAMS", $"This result came from default dataset {externalProject}.{externalDataset} in another project, so it cannot run again in place. Open the job's SQL in a new tab and choose a dataset.");
        var own = query.DefaultDataset is { DatasetId: { } dataset, ProjectId: var project } && (project is null || project == window.Project) && BqNames.IsDataset(dataset) ? dataset : null;
        return (query.Query, own ?? plan.Dataset, job.Statistics?.SessionInfo?.SessionId is { Length: > 0 });
    }

    /// <summary>
    /// The table a random sample reads, through tables.get (free), held to TABLESAMPLE's limitations
    /// (https://cloud.google.com/bigquery/docs/table-sampling#limitations): the statement names it once and samples no subquery,
    /// table-valued function, UNNEST or IN subquery (BigQueryViewSql.Sample's fixed shape), and it must be a table, not a view
    /// or materialized view (a query's destination always is; checked rather than assumed). A table with row-level security
    /// is refused by BigQuery itself at the estimate, before any job. Gone answers REMOTE_EXPIRED: TABLESAMPLE has no fallback.
    /// </summary>
    private async Task<Table> SampleTableAsync(BigQueryConnection connection, TableReference reference, CancellationToken token)
    {
        Table table;
        try { table = await bigQuery.TableAsync(connection, reference, token); }
        catch (Exception error) when (!token.IsCancellationRequested && NotFound(error)) { throw Expired(); }
        // The emulator names no type.
        if (table.Type is not (null or "TABLE"))
            throw new RequestException("INVALID_PARAMS", "BigQuery samples only tables, and this result is read from a " + (table.Type == "VIEW" ? "view" : table.Type == "MATERIALIZED_VIEW" ? "materialized view" : "non-table") + ". Load its first rows instead.");
        return table;
    }

    /// <summary>BigQuery keeps a table under about 1 GB as one block, which TABLESAMPLE reads whole.</summary>
    internal const long SampleBlockBytes = 1L << 30;

    /// <summary>What a random sample of a table of one block is, in Messages: its rows are the table's, cut at LIMIT.</summary>
    internal static string OneBlock(Table table) =>
        table.NumBytes is { } bytes && bytes < SampleBlockBytes
            ? " The result's table is under about 1 GB, which BigQuery usually keeps as one block: TABLESAMPLE read all of it, so these are the rows BigQuery returned first, not a random pick."
            : "";

    /// <summary>What a rerun of a job that ran in a session cannot carry over, in Messages.</summary>
    internal const string RerunOutsideSession = "The statement ran again outside the tab's session: session settings such as @@dataset_id, temp tables and the changes of a transaction that was open do not carry over, so its rows may differ.";

    /// <summary>Why a sample was not made: the store had no room for its set.</summary>
    internal const string SampleRoom = "There is not enough result memory for this sample. Close other results, or ask for fewer rows.";

    /// <summary>What a sample holds, in Messages: "The sample holds 1,000 of 52,341,118 rows."</summary>
    private static string SampleSentence(ResultSetBuffer sample, long total) =>
        "The sample holds " + sample.Describe().RowsStored.ToString("N0", CultureInfo.InvariantCulture) + " of " + total.ToString("N0", CultureInfo.InvariantCulture) + " rows.";

    /// <summary>Why a random sample holds fewer rows than asked, when BigQuery's pick did: it takes whole blocks of varying
    /// size, so a sample holds about its share of rows (a table of one block is read whole).</summary>
    internal static string ShortSample(long picked, int asked, long total) =>
        picked >= Math.Min(asked, total) ? "" : picked == 0
            ? " BigQuery's pick held no rows. Load the first rows instead, or ask for more."
            : " BigQuery's pick held fewer rows than asked: TABLESAMPLE takes whole blocks, so a sample holds about its share of the table, not an exact count.";

    /// <summary>What a remote query does, as the start of a sentence ("Sort or filter it once the query has finished").</summary>
    private static string RemoteVerb(string kind) => kind switch
    {
        "sample" => "Load a sample of it",
        "rerun" => "Run it again",
        _ => "Sort or filter it"
    };

    /// <summary>A remote query as the subject of a sentence ("The sample was cancelled.").</summary>
    private static string RemoteNoun(string kind) => kind switch
    {
        "sample" => "The sample",
        "rerun" => "The re-run",
        _ => "The sort or filter"
    };

    /// <summary>
    /// Load sample's first rows: tabledata.list pages of the windowed result's table into <paramref name="set"/>, up to
    /// <paramref name="rows"/> (the emulator ignores maxResults, so the count is kept here too). Each page is reserved from the
    /// budget while it is written; a page the budget refuses is asked again at half the rows from where the sample stopped, so
    /// it keeps what fits, and a refusal of a single row stops only this set, a derived one, never its source's query.
    /// </summary>
    private async Task SampleFirstRowsAsync(BigQueryConnection connection, BigQueryWindow window, int rows, ResultSetBuffer set, QueryBudget budget, QueryEventSink events,
        Action<string> warn, CancellationToken token)
    {
        var plan = window.Plan.Fork();
        var cap = BigQueryPageRows(plan.Columns.Count);
        string? pageToken = null;
        long stored = 0;
        var stopping = false;
        var roomWaited = new RoomWaited();
        while (stored < rows && !stopping)
        {
            var asked = (int)Math.Max(1, Math.Min(cap, rows - stored));
            using var page = await bigQuery.TableRowsAsync(connection, window.Table, pageToken is null ? stored : null, asked, pageToken, token);
            // Only the rows asked are decoded, so a page holding more (the emulator's) is charged its share for them.
            var taking = (int)Math.Min(asked, page.RowCount);
            var charge = page.Cost(plan.Columns.Count);
            if (page.RowCount > 0 && taking < page.RowCount) charge = (long)Math.Ceiling((double)charge * taking / page.RowCount);
            if (!store.TryReserve(budget, charge, true, out var refusal))
            {
                if (asked > 1 && refusal != TruncationReason.SystemMemory)
                {
                    cap = asked / 2;
                    pageToken = null;
                    continue;
                }
                set.Skip(refusal);
                break;
            }
            var took = 0;
            try
            {
                foreach (var row in page.Rows.ValueKind == System.Text.Json.JsonValueKind.Array ? page.Rows.EnumerateArray() : default)
                {
                    token.ThrowIfCancellationRequested();
                    if (took >= taking) break;
                    set.CountRow();
                    var builder = set.BeginRow();
                    if (builder is null) { stopping = true; break; }
                    int truncatedCells;
                    try { truncatedCells = plan.ReadRow(row, builder, warn); }
                    catch { set.AbortRow(); throw; }
                    var sealedBefore = set.SealedPages;
                    var committed = set.TryCommitRow(truncatedCells, mayWait: true);
                    if (!committed && set.RoomWanted > 0) committed = await WaitAndCommitAsync(store, set, truncatedCells, roomWaited, token);
                    if (!committed) { stopping = true; break; }
                    stored++;
                    took++;
                    if (set.SealedPages != sealedBefore) events.Sealed(set);
                }
            }
            finally { store.Return(budget, charge); }
            events.RowsChanged();
            if (set.HasPendingRows)
            {
                set.Seal();
                events.Sealed(set);
            }
            if (took == 0 || page.RowCount == 0) break;
            // A page cut short here goes on from the row it stopped at; a whole one follows BigQuery's page token.
            pageToken = took < page.RowCount ? null : page.PageToken;
            if (pageToken is null && took == page.RowCount && page.PageToken is null) break;
        }
        events.RowsChanged();
    }
}
