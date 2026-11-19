using Google.Cloud.BigQuery.V2;
using Varia.Backend.Protocol;

namespace Varia.Backend.BigQuery;

/// <summary>
/// The dataset picker (docs/bigquery.md, Datasets): the Connect dialog's Default dataset before a connection exists
/// (connections.databases with BigQuery's options and main's credential), and a query tab's Dataset box for a connected
/// handle (databases.list). Both list the billing project's datasets with their locations through datasets.list, a free
/// REST call; no job runs.
/// </summary>
internal sealed partial class BigQueryService
{
    public const string DatasetsPermission = "bigquery.datasets.get";
    /// <summary>datasets.list's page size, and how many datasets the picker lists at most (the rest are typed).</summary>
    public const int DatasetsPerPage = 1000;
    public const int MaxDatasets = 10_000;

    /// <summary>connections.databases for BigQuery: signs in with main's credential, then lists the project's datasets.</summary>
    public async Task<List<DatabaseInfo>> DiscoverDatasetsAsync(BigQueryConnectOptions options, CancellationToken token)
    {
        BigQueryLimits.Check(options, environment.Emulator);
        using var budget = CancellationTokenSource.CreateLinkedTokenSource(token);
        budget.CancelAfter(options.NonInteractive ? BackgroundConnectLimit : ConnectLimit);
        try
        {
            var (credential, _) = await SignInAsync(options.Authentication, options.ImpersonateServiceAccount, options.Credential!, budget.Token);
            using var client = Client(options.Project, credential, options.Location);
            return await ListDatasetsAsync(client, options.Project, budget.Token);
        }
        catch (Exception error) { throw BigQueryErrors.Map(error, options.Project, DatasetsPermission, KindOf(options.Authentication), token: token); }
    }

    /// <summary>databases.list for a BigQuery handle: the billing project's datasets.</summary>
    public async Task<List<DatabaseInfo>> DatasetsAsync(string connectionId, CancellationToken token)
    {
        var connection = Find(connectionId) ?? throw new RequestException("NOT_CONNECTED", "The connection is no longer open.");
        using var budget = CancellationTokenSource.CreateLinkedTokenSource(token);
        budget.CancelAfter(PreConnectLimit);
        try { return await ListDatasetsAsync(connection.Client, connection.Options.Project, budget.Token); }
        catch (Exception error) { throw BigQueryErrors.Map(error, connection.Options.Project, DatasetsPermission, token: token); }
    }

    /// <summary>Every page of datasets.list up to <see cref="MaxDatasets"/>, sorted by name. Names BigQuery's rule refuses and
    /// locations that are not location ids are left out (the location only), so main's check of the answer holds.</summary>
    static async Task<List<DatabaseInfo>> ListDatasetsAsync(BigQueryClient client, string project, CancellationToken token)
    {
        var result = new List<DatabaseInfo>();
        string? pageToken = null;
        do
        {
            var request = client.Service.Datasets.List(project);
            request.MaxResults = DatasetsPerPage;
            request.PageToken = pageToken;
            var page = await request.ExecuteAsync(token);
            foreach (var dataset in page.Datasets ?? [])
            {
                var name = dataset.DatasetReference?.DatasetId;
                if (name is not { Length: > 0 and <= BigQueryLimits.Dataset } || !BigQueryLimits.DatasetId().IsMatch(name)) continue;
                var location = dataset.Location is { Length: > 0 and <= BigQueryLimits.Location } value && BigQueryLimits.LocationId().IsMatch(value) ? value : null;
                result.Add(new(name, false, false, location));
                if (result.Count >= MaxDatasets) break;
            }
            pageToken = page.NextPageToken is { Length: > 0 and <= BigQueryLimits.PageToken } next && !next.Any(char.IsControl) ? next : null;
        } while (pageToken is not null && result.Count < MaxDatasets);
        result.Sort((left, right) => string.CompareOrdinal(left.Name, right.Name));
        return result;
    }
}
