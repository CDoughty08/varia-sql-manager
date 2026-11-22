using System.Diagnostics;
using System.Text;
using Google.Apis.Bigquery.v2.Data;
using Varia.Backend.Explorer;

namespace Varia.Backend.BigQuery;

/// <summary>
/// Object Explorer for BigQuery handles (docs/bigquery.md, Object Explorer): explorer.children through BigQuery's free REST
/// listers, never a job. The connection node lists the billing project and the extra projects; a project its datasets
/// (datasets.list); a dataset its six static folders; Tables, Views, Materialized Views and External Tables page tables.list
/// filtered by type; Routines routines.list; Models models.list; a table-like object's Columns and a STRUCT column's fields
/// come from tables.get. Every call goes through the principal's limiter (<see cref="MetadataAsync"/>); a failure is an
/// <see cref="ExplorerError"/> value on the row, as SQL Server's are.
/// </summary>
internal sealed partial class BigQueryService
{
    /// <summary>How long one listing may take, as SQL Server's (the renderer's watchdog is 60 s).</summary>
    internal TimeSpan ExplorerBudget { get; set; } = TimeSpan.FromSeconds(30);
    /// <summary>The most a REST page asks for: datasets.list, tables.list, routines.list and models.list cap their pages lower themselves.</summary>
    public const int ExplorerPageMax = 1000;

    static readonly ExplorerProfile Profile = new(ExplorerCatalog.MaxBand, false);
    /// <summary>The catalogue's BigQuery list ids: REST listers here, not SQL (ExplorerChecks holds the catalogue to them).</summary>
    internal static readonly string[] Lists = ["bqDatasets", "bqTables", "bqViews", "bqMaterializedViews", "bqExternalTables", "bqRoutines", "bqModels", "bqColumns", "bqFields"];

    public async Task<ExplorerChildrenResult> ChildrenAsync(ExplorerChildrenArgs args, ExplorerCatalog catalog, CancellationToken token)
    {
        var watch = Stopwatch.StartNew();
        var request = ExplorerRefs.Validate(args, catalog);
        var connection = Find(request.ConnectionId) ?? throw new RequestException("NOT_CONNECTED", "The connection is no longer open.");
        if (!catalog.KindOf(request.Object.Kind).Serves(Providers.BigQuery)) throw new RequestException("INVALID_PARAMS", "Invalid Object Explorer request: a BigQuery connection has no " + request.Object.Kind + ".");
        using var budget = CancellationTokenSource.CreateLinkedTokenSource(token);
        budget.CancelAfter(ExplorerBudget);
        var project = request.Object.Kind == "bqProject" ? request.Object.Name : request.Object.Project;
        try
        {
            var page = await LoadAsync(connection, request, catalog, budget.Token);
            return page with { ElapsedMs = watch.ElapsedMilliseconds };
        }
        catch (OperationCanceledException) when (budget.IsCancellationRequested && !token.IsCancellationRequested)
        {
            return new([], watch.ElapsedMilliseconds, Error: ExplorerErrors.Create("TIMEOUT", "", null));
        }
        catch (Exception error) when (!token.IsCancellationRequested && error is not RequestException { Code: "INVALID_PARAMS" })
        {
            return new([], watch.ElapsedMilliseconds, Error: ErrorOf(BigQueryErrors.Map(error, project, ListPermission(request), token: token)));
        }
    }

    /// <summary>The permission a listing needs, named when Google refuses it.</summary>
    static string ListPermission(ExplorerRequest request) => request.Folder?.Id switch
    {
        "bqRoutines" => "bigquery.routines.list",
        "bqModels" => "bigquery.models.list",
        "bqColumns" => "bigquery.tables.get",
        null when request.Object.Kind == "bqColumn" => "bigquery.tables.get",
        null => "bigquery.datasets.get",
        _ => "bigquery.tables.list"
    };

    /// <summary>A mapped failure as the row's error: the codes the tree knows (contracts.ts explorerErrorCodes), anything else as SQL_ERROR's text.</summary>
    internal static ExplorerError ErrorOf(Exception mapped)
    {
        var (code, message) = mapped is RequestException request ? (request.Code, request.Message) : ("SQL_ERROR", "BigQuery refused the request.");
        code = code switch
        {
            "PERMISSION_DENIED" or "NOT_FOUND" or "TIMEOUT" or "CONNECTION_LOST" or "AUTH_EXPIRED" or "AUTH_KEY_FILE" or "API_DISABLED" or "BILLING_DISABLED" or "QUOTA" => code,
            _ => "SQL_ERROR"
        };
        var clipped = ExplorerLabels.Clip(message, ExplorerErrors.MaxMessage);
        return new(code, clipped, code is not ("NOT_FOUND" or "PERMISSION_DENIED"), code == "NOT_FOUND" ? "refreshParent" : null);
    }

    async Task<ExplorerChildrenResult> LoadAsync(BigQueryConnection connection, ExplorerRequest request, ExplorerCatalog catalog, CancellationToken token)
    {
        var target = request.Object;
        if (request.Folder is null)
            return target.Kind switch
            {
                "server" => Projects(connection, catalog),
                "bqProject" => await DatasetsAsync(connection, catalog, target.Name!, request, token),
                "bqDataset" => Folders(catalog, target),
                "bqTable" or "bqView" or "bqMaterializedView" or "bqExternalTable" => Folders(catalog, target),
                "bqColumn" => await FieldsAsync(connection, catalog, target.Project!, target.Dataset!, target.Table!, target.Name, request, token),
                _ => new([], 0)
            };
        return request.Folder.Id switch
        {
            "bqTables" or "bqViews" or "bqMaterializedViews" or "bqExternalTables" => await TablesAsync(connection, catalog, target, request, token),
            "bqRoutines" => await RoutinesAsync(connection, catalog, target, request, token),
            "bqModels" => await ModelsAsync(connection, catalog, target, request, token),
            "bqColumns" => await FieldsAsync(connection, catalog, target.Project!, target.Dataset!, target.Name!, null, request, token),
            _ => throw new RequestException("INVALID_PARAMS", "Invalid Object Explorer request: a BigQuery connection has no " + request.Folder.Id + " folder.")
        };
    }

    static ExplorerNode Node(ExplorerCatalog catalog, ObjectRefDto value, string label, bool hasChildren, string? subtype = null, string? sublabel = null) =>
        new(new NodeRefDto("object", value), ExplorerLabels.Clip(label, ExplorerLabels.MaxLabel), catalog.IconFor(value.Kind, subtype), hasChildren,
            sublabel is null ? null : ExplorerLabels.Clip(sublabel, ExplorerLabels.MaxSublabel), Subtype: subtype);

    /// <summary>The billing project, then the extra projects in the order the connection lists them.</summary>
    static ExplorerChildrenResult Projects(BigQueryConnection connection, ExplorerCatalog catalog)
    {
        var nodes = new List<ExplorerNode> { Node(catalog, new("bqProject", Name: connection.Options.Project), connection.Options.Project, true, sublabel: "billing project") };
        foreach (var extra in connection.Options.ExtraProjects ?? [])
            if (extra != connection.Options.Project) nodes.Add(Node(catalog, new("bqProject", Name: extra), extra, true));
        return new(nodes, 0, Total: nodes.Count);
    }

    static ExplorerChildrenResult Folders(ExplorerCatalog catalog, ObjectRefDto owner) =>
        new([.. catalog.StaticFolders(owner.Kind, null, Profile).Select(id => new ExplorerNode(new NodeRefDto("folder", Owner: owner, Folder: id), catalog.Folder(id)!.Label, "folder", true))], 0);

    /// <summary>A REST page token in a cursor: base64url, so the cursor keeps to [A-Za-z0-9_-]. A token past BigQuery's own limit ends the listing.</summary>
    static string? Cursor(string list, string? pageToken) =>
        pageToken is { Length: > 0 and <= BigQueryLimits.PageToken } ? "v1." + list + "." + Convert.ToBase64String(Encoding.UTF8.GetBytes(pageToken)).TrimEnd('=').Replace('+', '-').Replace('/', '_') : null;

    static string? PageToken(string? cursor)
    {
        if (cursor is null) return null;
        var text = cursor[(cursor.IndexOf('.', 3) + 1)..].Replace('-', '+').Replace('_', '/');
        try { return Encoding.UTF8.GetString(Convert.FromBase64String(text.PadRight(text.Length + (4 - text.Length % 4) % 4, '='))); }
        catch (FormatException) { throw new RequestException("INVALID_PARAMS", "Invalid Object Explorer request: cursor."); }
    }

    static int PageSize(ExplorerRequest request) => Math.Min(request.PageSize, ExplorerPageMax);

    async Task<ExplorerChildrenResult> DatasetsAsync(BigQueryConnection connection, ExplorerCatalog catalog, string project, ExplorerRequest request, CancellationToken token)
    {
        var list = await MetadataAsync(connection, t =>
        {
            var call = connection.Client.Service.Datasets.List(project);
            call.MaxResults = PageSize(request);
            call.PageToken = PageToken(request.Cursor);
            return call.ExecuteAsync(t);
        }, token);
        var nodes = new List<ExplorerNode>();
        foreach (var dataset in list.Datasets ?? [])
            if (dataset.DatasetReference?.DatasetId is { } name && BqNames.IsDataset(name))
                nodes.Add(Node(catalog, new("bqDataset", Name: name, Project: project), name, true,
                    sublabel: dataset.Location is { Length: > 0 and <= BigQueryLimits.Location } location && BigQueryLimits.LocationId().IsMatch(location) ? location : null));
        return new(nodes, 0, Cursor("bqDatasets", list.NextPageToken));
    }

    /// <summary>tables.list's types each folder shows (a snapshot is a table with the snapshot subtype; a clone is a TABLE).</summary>
    static (string Kind, string? Subtype)? TableKind(string folder, string? type) => (folder, type) switch
    {
        ("bqTables", "TABLE") => ("bqTable", null),
        ("bqTables", "SNAPSHOT") => ("bqTable", "snapshot"),
        ("bqViews", "VIEW") => ("bqView", null),
        ("bqMaterializedViews", "MATERIALIZED_VIEW") => ("bqMaterializedView", null),
        ("bqExternalTables", "EXTERNAL") => ("bqExternalTable", null),
        _ => null
    };

    /// <summary>One page of tables.list kept to the folder's types; a page may be short, or empty with a cursor, when the dataset mixes types.</summary>
    async Task<ExplorerChildrenResult> TablesAsync(BigQueryConnection connection, ExplorerCatalog catalog, ObjectRefDto dataset, ExplorerRequest request, CancellationToken token)
    {
        var folder = request.Folder!;
        var list = await MetadataAsync(connection, t =>
        {
            var call = connection.Client.Service.Tables.List(dataset.Project, dataset.Name);
            call.MaxResults = PageSize(request);
            call.PageToken = PageToken(request.Cursor);
            return call.ExecuteAsync(t);
        }, token);
        var nodes = new List<ExplorerNode>();
        foreach (var table in list.Tables ?? [])
            if (table.TableReference?.TableId is { } name && BqNames.IsTable(name) && TableKind(folder.Id, table.Type) is var (kind, subtype))
                nodes.Add(Node(catalog, new(kind, Name: name, Project: dataset.Project, Dataset: dataset.Name), name, true, subtype));
        return new(nodes, 0, Cursor(folder.List!, list.NextPageToken));
    }

    static string? RoutineSubtype(string? type) => type switch
    {
        "PROCEDURE" => "procedure",
        "SCALAR_FUNCTION" => "scalar",
        "TABLE_VALUED_FUNCTION" => "tableValued",
        "AGGREGATE_FUNCTION" => "aggregate",
        _ => null
    };

    async Task<ExplorerChildrenResult> RoutinesAsync(BigQueryConnection connection, ExplorerCatalog catalog, ObjectRefDto dataset, ExplorerRequest request, CancellationToken token)
    {
        var list = await MetadataAsync(connection, t =>
        {
            var call = connection.Client.Service.Routines.List(dataset.Project, dataset.Name);
            call.MaxResults = PageSize(request);
            call.PageToken = PageToken(request.Cursor);
            return call.ExecuteAsync(t);
        }, token);
        var nodes = new List<ExplorerNode>();
        foreach (var routine in list.Routines ?? [])
            if (routine.RoutineReference?.RoutineId is { } name && BqNames.IsRoutine(name))
            {
                var subtype = RoutineSubtype(routine.RoutineType);
                nodes.Add(Node(catalog, new("bqRoutine", Name: name, Project: dataset.Project, Dataset: dataset.Name), name, false, subtype,
                    routine.Language is { Length: > 0 and <= 32 } language && language != "SQL" ? language : null));
            }
        return new(nodes, 0, Cursor("bqRoutines", list.NextPageToken));
    }

    async Task<ExplorerChildrenResult> ModelsAsync(BigQueryConnection connection, ExplorerCatalog catalog, ObjectRefDto dataset, ExplorerRequest request, CancellationToken token)
    {
        var list = await MetadataAsync(connection, t =>
        {
            var call = connection.Client.Service.Models.List(dataset.Project, dataset.Name);
            call.MaxResults = PageSize(request);
            call.PageToken = PageToken(request.Cursor);
            return call.ExecuteAsync(t);
        }, token);
        var nodes = new List<ExplorerNode>();
        foreach (var model in list.Models ?? [])
            if (model.ModelReference?.ModelId is { } name && BqNames.IsModel(name))
                nodes.Add(Node(catalog, new("bqModel", Name: name, Project: dataset.Project, Dataset: dataset.Name), name, false,
                    sublabel: model.ModelType is { Length: > 0 and <= 64 } type ? Words(type) : null));
        return new(nodes, 0, Cursor("bqModels", list.NextPageToken));
    }

    /// <summary>LOGISTIC_REGRESSION as "logistic regression".</summary>
    static string Words(string constant) => constant.Replace('_', ' ').ToLowerInvariant();

    /// <summary>A table's columns (or a STRUCT column's fields) from tables.get's schema, in schema order, paged by offset.</summary>
    async Task<ExplorerChildrenResult> FieldsAsync(BigQueryConnection connection, ExplorerCatalog catalog, string project, string dataset, string table, string? path,
        ExplorerRequest request, CancellationToken token)
    {
        var list = path is null ? "bqColumns" : "bqFields";
        var offset = 0;
        if (request.Cursor is { } cursor && !int.TryParse(cursor.AsSpan(cursor.IndexOf('.', 3) + 1), System.Globalization.NumberStyles.None, null, out offset))
            throw new RequestException("INVALID_PARAMS", "Invalid Object Explorer request: cursor.");
        var schema = await MetadataAsync(connection, t =>
        {
            var call = connection.Client.Service.Tables.Get(project, dataset, table);
            call.Fields = "schema";
            return call.ExecuteAsync(t);
        }, token);
        IList<TableFieldSchema>? fields = schema.Schema?.Fields;
        if (path is not null)
            foreach (var part in path.Split('.'))
            {
                var field = fields?.FirstOrDefault(item => item.Name == part);
                if (field is null || field.Type is not ("RECORD" or "STRUCT")) return new([], 0, Error: ExplorerErrors.Create("NOT_FOUND", "Column " + path, null));
                fields = field.Fields;
            }
        var all = fields ?? [];
        var nodes = new List<ExplorerNode>();
        foreach (var field in all.Skip(offset).Take(request.PageSize))
        {
            if (!BqNames.IsColumn(field.Name)) continue;
            var full = path is null ? field.Name : path + "." + field.Name;
            if (!BqNames.IsFieldPath(full)) continue;
            var record = field.Type is "RECORD" or "STRUCT";
            nodes.Add(Node(catalog, new("bqColumn", Name: full, Project: project, Dataset: dataset, Table: table), field.Name, record && field.Fields is { Count: > 0 },
                record ? "struct" : null, TypeText(field)));
        }
        var next = offset + request.PageSize;
        return new(nodes, 0, next < all.Count ? "v1." + list + "." + next.ToString(System.Globalization.CultureInfo.InvariantCulture) : null, offset == 0 ? all.Count : null);
    }

    /// <summary>A column's type as its row says it: INT64, ARRAY&lt;STRING&gt;, STRUCT, and ", required" for a REQUIRED column.</summary>
    internal static string TypeText(TableFieldSchema field)
    {
        var type = field.Type switch { "RECORD" => "STRUCT", "INTEGER" => "INT64", "FLOAT" => "FLOAT64", "BOOLEAN" => "BOOL", null => "?", var other => other };
        return field.Mode switch { "REPEATED" => "ARRAY<" + type + ">", "REQUIRED" => type + ", required", _ => type };
    }
}
