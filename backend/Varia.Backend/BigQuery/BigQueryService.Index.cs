using Google.Apis.Bigquery.v2.Data;
using Varia.Backend.Search;

namespace Varia.Backend.BigQuery;

/// <summary>
/// The Search Objects index's REST reads for BigQuery handles (docs/object-search.md, BigQuery): datasets.list per project, then
/// tables.list, routines.list and models.list per dataset (pass 1, names), then tables.get and routines.get per object (pass 2,
/// details). Every call is free and goes through the principal's limiter (<see cref="MetadataAsync"/>), shared with Object
/// Explorer, Preview Rows and the pickers. Nothing here runs a job.
/// </summary>
internal sealed partial class BigQueryService : IBigQueryIndexSource
{
    /// <summary>One index read's own deadline, inside the build (a slower call is a TIMEOUT skip for its dataset).</summary>
    internal TimeSpan IndexCallBudget { get; set; } = TimeSpan.FromSeconds(30);
    /// <summary>The fields tables.get returns for the index: what search, details and the editor need, never the rows or the full resource.</summary>
    internal const string IndexTableFields = "type,creationTime,lastModifiedTime,numRows,numBytes,description,schema,timePartitioning,rangePartitioning,clustering,view,materializedView,cloneDefinition,snapshotDefinition";

    (string Billing, IReadOnlyList<string> Extra) IBigQueryIndexSource.Projects(string connectionId)
    {
        var connection = Find(connectionId) ?? throw new RequestException("NOT_CONNECTED", "The connection is no longer open.");
        var billing = connection.Options.Project;
        return (billing, [.. (connection.Options.ExtraProjects ?? []).Where(extra => extra != billing).Distinct(StringComparer.Ordinal)]);
    }

    BigQueryConnection Connection(string connectionId) => Find(connectionId) ?? throw new RequestException("NOT_CONNECTED", "The connection is no longer open.");

    /// <summary>Runs <paramref name="call"/> through the limiter under its own deadline, throwing TimeoutException when only the deadline ran out.</summary>
    async Task<T> IndexCallAsync<T>(BigQueryConnection connection, Func<CancellationToken, Task<T>> call, CancellationToken token)
    {
        using var budget = CancellationTokenSource.CreateLinkedTokenSource(token);
        budget.CancelAfter(IndexCallBudget);
        try { return await MetadataAsync(connection, call, budget.Token); }
        catch (OperationCanceledException) when (budget.IsCancellationRequested && !token.IsCancellationRequested) { throw new TimeoutException(); }
    }

    async Task<BigQueryDatasetList> IBigQueryIndexSource.DatasetsAsync(string connectionId, string project, CancellationToken token)
    {
        var connection = Connection(connectionId);
        var names = new List<string>();
        var locations = new Dictionary<string, string>(StringComparer.Ordinal);
        string? pageToken = null;
        for (var page = 0; page < BigQueryIndexLimits.ListPages; page++)
        {
            var list = await IndexCallAsync(connection, t =>
            {
                var call = connection.Client.Service.Datasets.List(project);
                call.MaxResults = ExplorerPageMax;
                call.PageToken = pageToken;
                return call.ExecuteAsync(t);
            }, token);
            foreach (var dataset in list.Datasets ?? [])
                if (dataset.DatasetReference?.DatasetId is { } name && BqNames.IsDataset(name))
                {
                    names.Add(name);
                    if (BqNames.IsLocation(dataset.Location)) locations[name] = dataset.Location;
                }
            pageToken = list.NextPageToken is { Length: > 0 and <= BigQueryLimits.PageToken } next ? next : null;
            if (pageToken is null) return new(names, false, locations);
        }
        return new(names, true, locations);
    }

    async Task<BigQueryListing> IBigQueryIndexSource.ObjectsAsync(string connectionId, string project, string dataset, CancellationToken token)
    {
        var connection = Connection(connectionId);
        var tables = new List<TableList.TablesData>();
        var routines = new List<Routine>();
        var models = new List<Model>();
        var cut = false;
        string? pageToken = null;
        for (var page = 0; ; page++)
        {
            if (page == BigQueryIndexLimits.ListPages) { cut = true; break; }
            var list = await IndexCallAsync(connection, t =>
            {
                var call = connection.Client.Service.Tables.List(project, dataset);
                call.MaxResults = ExplorerPageMax;
                call.PageToken = pageToken;
                return call.ExecuteAsync(t);
            }, token);
            tables.AddRange(list.Tables ?? []);
            pageToken = list.NextPageToken is { Length: > 0 and <= BigQueryLimits.PageToken } next ? next : null;
            if (pageToken is null) break;
        }
        pageToken = null;
        for (var page = 0; ; page++)
        {
            if (page == BigQueryIndexLimits.ListPages) { cut = true; break; }
            ListRoutinesResponse list;
            try
            {
                list = await IndexCallAsync(connection, t =>
                {
                    var call = connection.Client.Service.Routines.List(project, dataset);
                    call.MaxResults = ExplorerPageMax;
                    call.PageToken = pageToken;
                    return call.ExecuteAsync(t);
                }, token);
            }
            // The emulator (unpackaged test builds only) has no routines.list: it answers 500 "unsupported", and its datasets have no
            // routines, so its index lists none rather than skipping every dataset.
            catch (Google.GoogleApiException error) when (environment.Emulator && page == 0 && error.Message.Contains("unsupported bigquery.routines.list", StringComparison.Ordinal)) { break; }
            routines.AddRange(list.Routines ?? []);
            pageToken = list.NextPageToken is { Length: > 0 and <= BigQueryLimits.PageToken } next ? next : null;
            if (pageToken is null) break;
        }
        pageToken = null;
        for (var page = 0; ; page++)
        {
            if (page == BigQueryIndexLimits.ListPages) { cut = true; break; }
            var list = await IndexCallAsync(connection, t =>
            {
                var call = connection.Client.Service.Models.List(project, dataset);
                call.MaxResults = ExplorerPageMax;
                call.PageToken = pageToken;
                return call.ExecuteAsync(t);
            }, token);
            models.AddRange(list.Models ?? []);
            pageToken = list.NextPageToken is { Length: > 0 and <= BigQueryLimits.PageToken } next ? next : null;
            if (pageToken is null) break;
        }
        return new(tables, routines, models, cut);
    }

    Task<Table> IBigQueryIndexSource.TableAsync(string connectionId, string project, string dataset, string table, CancellationToken token)
    {
        var connection = Connection(connectionId);
        return IndexCallAsync(connection, t =>
        {
            var call = connection.Client.Service.Tables.Get(project, dataset, table);
            call.SelectedFields = IndexTableFields;
            return call.ExecuteAsync(t);
        }, token);
    }

    Task<Routine> IBigQueryIndexSource.RoutineAsync(string connectionId, string project, string dataset, string routine, CancellationToken token)
    {
        var connection = Connection(connectionId);
        return IndexCallAsync(connection, t => connection.Client.Service.Routines.Get(project, dataset, routine).ExecuteAsync(t), token);
    }

    Exception IBigQueryIndexSource.Map(Exception error, string project, string permission, CancellationToken token) =>
        error is TimeoutException ? new RequestException("TIMEOUT", "BigQuery did not answer in time.") : BigQueryErrors.Map(error, project, permission, token: token);
}
