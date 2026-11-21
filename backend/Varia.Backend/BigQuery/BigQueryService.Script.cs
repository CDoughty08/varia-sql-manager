using System.Diagnostics;
using System.Text;
using Google.Apis.Bigquery.v2.Data;

namespace Varia.Backend.BigQuery;

/// <summary>
/// Script As for BigQuery (docs/bigquery.md, Script As). SELECT, INSERT, UPDATE, DELETE and DROP are local templates built from
/// tables.get (routines.get for a routine's DROP), free; names reach them only through BqNames. CREATE reads the object's own
/// DDL from INFORMATION_SCHEMA.TABLES or ROUTINES (the ddl column), a query BigQuery bills: the renderer first asks for its
/// estimate (EstimateOnly, a free dry run) and the cost prompts' answer, then sends it with the maximum bytes billed. The name
/// is a query parameter; the dataset's qualifier is quoted by BqNames. No DDL ever runs.
/// </summary>
internal sealed partial class BigQueryService
{
    /// <summary>Script As' budget inside its 60 s deadline.</summary>
    internal TimeSpan ScriptLimit { get; set; } = TimeSpan.FromSeconds(55);
    /// <summary>Rows the SELECT template's LIMIT keeps.</summary>
    public const int SelectLimit = 1000;
    const string SearchConditions = "<Search Conditions,,>";

    /// <summary>The CREATE query's text: constant but for the dataset qualifier, which BqNames quotes; the name is @name.</summary>
    internal static string CreateSql(string project, string dataset, bool routine) => routine
        ? "SELECT ddl FROM " + BqNames.DatasetPath(project, dataset) + ".INFORMATION_SCHEMA.ROUTINES WHERE routine_name = @name"
        : "SELECT ddl FROM " + BqNames.DatasetPath(project, dataset) + ".INFORMATION_SCHEMA.TABLES WHERE table_name = @name";

    public async Task<ScriptResult> ScriptAsync(ScriptArgs args, ObjectRefDto target, string verb, CancellationToken token)
    {
        var watch = Stopwatch.StartNew();
        var connection = Find(args.ConnectionId) ?? throw new RequestException("NOT_CONNECTED", "The connection is no longer open.");
        if (args.EstimateOnly == true && verb != "create") throw new RequestException("INVALID_PARAMS", "Only CREATE has an estimate.");
        if (args.MaximumBytesBilled is < 1 or > BigQueryLimits.MaxSafeInteger) throw new RequestException("INVALID_PARAMS", "Maximum bytes billed is outside its supported range.");
        var project = target.Project!;
        var dataset = target.Dataset!;
        var name = target.Name!;
        // A new query window runs in the dataset when it is in the billing project; elsewhere the script's full names stand alone.
        var home = project == connection.Options.Project ? dataset : "";
        using var budget = CancellationTokenSource.CreateLinkedTokenSource(token);
        budget.CancelAfter(ScriptLimit);
        try
        {
            if (verb == "create")
            {
                var routine = target.Kind == "bqRoutine";
                var sql = CreateSql(project, dataset, routine);
                if (args.EstimateOnly == true)
                {
                    var estimate = await CreateEstimateAsync(connection, sql, name, budget.Token);
                    return new(null, home, [], 0, watch.ElapsedMilliseconds, Estimate: new(estimate.BytesProcessed, estimate.Incomplete, estimate.StatementType, estimate.Faked));
                }
                var cap = connection.Options.MaximumBytesBilled ?? args.MaximumBytesBilled;
                var ddl = await DdlAsync(connection, sql, name, dataset, project, cap, budget.Token);
                if (ddl is null) return Failure("NOT_FOUND", (routine ? "Routine " : "Table ") + project + "." + dataset + "." + name + " no longer exists.");
                if (ddl.Length == 0) return Failure("NOT_SUPPORTED", "BigQuery has no CREATE statement for " + project + "." + dataset + "." + name + ".");
                return Bounded(Terminate(ddl), 1);
            }
            var text = target.Kind == "bqRoutine"
                ? await RoutineDropAsync(connection, project, dataset, name, budget.Token)
                : await TableTemplateAsync(connection, target.Kind, verb, project, dataset, name, budget.Token);
            return text is null ? Failure("NOT_SUPPORTED", "This object has no " + verb.ToUpperInvariant() + " script.") : Bounded(text, 0);
        }
        catch (OperationCanceledException) when (budget.IsCancellationRequested && !token.IsCancellationRequested)
        {
            return Failure("TIMEOUT", "Scripting took longer than " + (int)ScriptLimit.TotalSeconds + " seconds. Retry.");
        }
        catch (Exception error) when (!token.IsCancellationRequested && error is not RequestException { Code: "INVALID_PARAMS" or "NOT_CONNECTED" })
        {
            var mapped = BigQueryErrors.Map(error, project, verb == "create" ? "bigquery.jobs.create" : "bigquery.tables.get", cap: connection.Options.MaximumBytesBilled ?? args.MaximumBytesBilled, token: token);
            var (code, message) = mapped is RequestException request ? (request.Code, request.Message) : ("SQL_ERROR", "BigQuery refused the request.");
            return Failure(code switch
            {
                "NOT_FOUND" or "PERMISSION_DENIED" or "TIMEOUT" or "CONNECTION_LOST" or "COST_CAP" or "QUOTA" or "AUTH_EXPIRED" => code,
                _ => "SQL_ERROR"
            }, message);
        }

        // A script past the catalogue's 4,000,000 characters (a 10,000-column table's INSERT, a long DDL) is TOO_LARGE, as SQL Server's is.
        ScriptResult Bounded(string text, int commands) => text.Length > Varia.Backend.Scripting.ScriptingCatalog.Current.Limit("maxScriptChars")
            ? Failure("TOO_LARGE", "The script for " + project + "." + dataset + "." + name + " is longer than 4,000,000 characters, which Varia cannot open.")
            : new(text, home, [], commands, watch.ElapsedMilliseconds);

        ScriptResult Failure(string code, string message) =>
            new(null, home, [], 0, watch.ElapsedMilliseconds, new(code, message.Length > 2048 ? message[..2047] + "…" : message, code is "TIMEOUT" or "CONNECTION_LOST" or "QUOTA" or "SQL_ERROR"));
    }

    static string Terminate(string ddl) => ddl.TrimEnd() is var text && text.EndsWith(';') ? text : text + ";";

    Job CreateJob(BigQueryConnection connection, string sql, string name, string? location, long? cap, bool dryRun) => new()
    {
        JobReference = new JobReference { ProjectId = connection.Options.Project, JobId = dryRun ? null : NewJobId(), Location = location },
        Configuration = new JobConfiguration
        {
            DryRun = dryRun, Labels = new Dictionary<string, string>(Labels),
            Query = new JobConfigurationQuery
            {
                Query = sql, UseLegacySql = false, ParameterMode = "NAMED", MaximumBytesBilled = cap,
                QueryParameters = [new QueryParameter { Name = "name", ParameterType = new QueryParameterType { Type = "STRING" }, ParameterValue = new QueryParameterValue { Value = name } }]
            }
        }
    };

    /// <summary>The CREATE query's free dry run. Emulator mode fakes it, as the query tab's estimate does.</summary>
    async Task<BigQueryEstimate> CreateEstimateAsync(BigQueryConnection connection, string sql, string name, CancellationToken token)
    {
        if (environment.Emulator) return new(0, Faked: true);
        var job = CreateJob(connection, sql, name, null, null, dryRun: true);
        return Estimate(await MetadataAsync(connection, t => connection.Client.Service.Jobs.Insert(job, connection.Options.Project).ExecuteAsync(t), token));
    }

    /// <summary>Waits between polls of a CREATE query whose results are not ready (the emulator answers at once).</summary>
    internal TimeSpan DdlPoll { get; set; } = TimeSpan.FromMilliseconds(200);

    /// <summary>Runs the CREATE query in the dataset's location under the cap, then reads its one cell: null when no row matched,
    /// empty when the row's ddl is NULL. Any exit before its cell is read (Stop, the budget, a failure) cancels the job (best effort),
    /// including one that ends while jobs.insert is in flight, since the job id is Varia's own.</summary>
    async Task<string?> DdlAsync(BigQueryConnection connection, string sql, string name, string dataset, string project, long? cap, CancellationToken token)
    {
        var location = connection.DatasetLocations.TryGetValue(project + ":" + dataset, out var known) ? known
            : await MetadataAsync(connection, t => DatasetLocationAsync(connection.Client, project, dataset, t), token);
        connection.DatasetLocations[project + ":" + dataset] = location;
        var request = CreateJob(connection, sql, name, location, cap, dryRun: false);
        var reference = request.JobReference;
        var read = false;
        try
        {
            var job = await InsertJobAsync(connection, request, null, token);
            if (BigQueryJobException.Of(job) is { } refused) { read = true; throw refused; }
            reference = job.JobReference ?? reference;
            while (true)
            {
                using var page = await QueryResultsAsync(connection, reference.ProjectId, reference.JobId, reference.Location ?? location, null, 1, 10_000, token);
                if (!page.JobComplete) { await Task.Delay(DdlPoll, token); continue; }
                read = true;
                if (page.RowCount == 0) return null;
                var row = page.Rows[0];
                return row.TryGetProperty("f", out var cells) && cells.ValueKind == System.Text.Json.JsonValueKind.Array && cells.GetArrayLength() > 0
                    && cells[0].TryGetProperty("v", out var value) && value.ValueKind == System.Text.Json.JsonValueKind.String ? value.GetString() : "";
            }
        }
        finally
        {
            if (!read) _ = CancelDdlAsync(connection, reference);
        }
    }

    /// <summary>Cancels a CREATE query its budget or Stop abandoned, so it bills nothing more; failures are ignored.</summary>
    async Task CancelDdlAsync(BigQueryConnection connection, JobReference reference)
    {
        try
        {
            using var limit = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            var call = connection.Client.Service.Jobs.Cancel(reference.ProjectId, reference.JobId);
            call.Location = reference.Location;
            await call.ExecuteAsync(limit.Token);
        }
        catch (Exception) { }
    }

    async Task<string?> RoutineDropAsync(BigQueryConnection connection, string project, string dataset, string name, CancellationToken token)
    {
        var routine = await MetadataAsync(connection, t =>
        {
            var call = connection.Client.Service.Routines.Get(project, dataset, name);
            call.ReadMask = "routineType";
            return call.ExecuteAsync(t);
        }, token);
        var statement = routine.RoutineType switch
        {
            "PROCEDURE" => "DROP PROCEDURE IF EXISTS ",
            "TABLE_VALUED_FUNCTION" => "DROP TABLE FUNCTION IF EXISTS ",
            "AGGREGATE_FUNCTION" => "DROP AGGREGATE FUNCTION IF EXISTS ",
            _ => "DROP FUNCTION IF EXISTS "
        };
        return statement + BqNames.RoutinePath(project, dataset, name) + ";";
    }

    /// <summary>A table-like object's DROP, SELECT, INSERT, UPDATE or DELETE from its type and top-level columns.</summary>
    async Task<string?> TableTemplateAsync(BigQueryConnection connection, string kind, string verb, string project, string dataset, string name, CancellationToken token)
    {
        var table = await MetadataAsync(connection, t =>
        {
            var call = connection.Client.Service.Tables.Get(project, dataset, name);
            call.SelectedFields = "schema,type";
            return call.ExecuteAsync(t);
        }, token);
        return Template(verb, table.Type, table.Schema?.Fields ?? [], BqNames.TablePath(project, dataset, name));
    }

    /// <summary>The templates themselves (BigQueryExplorerChecks renders them with hostile names).</summary>
    internal static string? Template(string verb, string? type, IList<TableFieldSchema> fields, string path)
    {
        var columns = fields.Where(field => BqNames.IsColumn(field.Name)).ToList();
        const string nl = "\n";
        switch (verb)
        {
            case "drop":
                return type switch
                {
                    "VIEW" => "DROP VIEW IF EXISTS ",
                    "MATERIALIZED_VIEW" => "DROP MATERIALIZED VIEW IF EXISTS ",
                    "EXTERNAL" => "DROP EXTERNAL TABLE IF EXISTS ",
                    "SNAPSHOT" => "DROP SNAPSHOT TABLE IF EXISTS ",
                    _ => "DROP TABLE IF EXISTS "
                } + path + ";";
            case "select":
            {
                var text = new StringBuilder("-- LIMIT does not lower the bytes billed: BigQuery bills every column the query reads.").Append(nl).Append("SELECT");
                if (columns.Count == 0) text.Append(" *");
                for (var i = 0; i < columns.Count; i++) text.Append(nl).Append("  ").Append(BqNames.QuoteColumn(columns[i].Name)).Append(i < columns.Count - 1 ? "," : "");
                return text.Append(nl).Append("FROM ").Append(path).Append(nl).Append("LIMIT ").Append(SelectLimit).Append(';').ToString();
            }
            case "insert" when type is "TABLE":
                return "INSERT INTO " + path + " (" + string.Join(", ", columns.Select(field => BqNames.QuoteColumn(field.Name))) + ")" + nl
                    + "VALUES (" + string.Join(", ", columns.Select(Placeholder)) + ");";
            case "update" when type is "TABLE":
                return "UPDATE " + path + nl + "SET" + string.Concat(columns.Select((field, i) => nl + "  " + BqNames.QuoteColumn(field.Name) + " = " + Placeholder(field) + (i < columns.Count - 1 ? "," : "")))
                    + nl + "WHERE " + SearchConditions + ";";
            case "delete" when type is "TABLE":
                return "DELETE FROM " + path + nl + "WHERE " + SearchConditions + ";";
            default:
                return null;
        }
    }

    /// <summary>&lt;name, type,&gt; as SSMS's templates write it; no column name holds a comma or line break that could split it.
    /// The flexible set's &lt; and &gt; would end it, and its # and -- would start a GoogleSQL comment, so they become _.</summary>
    static string Placeholder(TableFieldSchema field) => "<" + field.Name.Replace('<', '_').Replace('>', '_').Replace('#', '_').Replace("--", "__") + ", " + TypeText(field).Replace(", required", "").Replace('<', '(').Replace('>', ')') + ",>";
}
