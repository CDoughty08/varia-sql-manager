using System.Data;
using Microsoft.Data.SqlClient;
using Varia.Backend.Explorer;

namespace Varia.Backend.Language;

/// <summary>language.definition's SQL: constant text, names only as parameters, compared by the database's own collation, run on
/// Object Explorer's pool (READ UNCOMMITTED, a 5 s lock timeout) through its prologue. Catalog views, never metadata functions,
/// so the lookup honours that isolation (CatalogSql.Lint).</summary>
internal static class DefinitionSql
{
    /// <summary>One object or user-defined type named @name: in schema @schema, or with no schema in the user's default schema
    /// and then dbo, as SQL Server resolves a one-part name; with @column, only a table or view that has that column.
    /// Objects before types (a function and a type may share a name).</summary>
    public const string Lookup = """
        DECLARE @default sysname = (SELECT p.default_schema_name FROM sys.database_principals AS p WHERE p.principal_id = DATABASE_PRINCIPAL_ID());
        SELECT TOP (1) DB_NAME() AS database_name, x.schema_name, x.object_name, x.object_type
        FROM (
            SELECT s.name AS schema_name, o.name AS object_name, CAST(o.type AS varchar(2)) AS object_type, 0 AS rank_kind
            FROM sys.all_objects AS o INNER JOIN sys.schemas AS s ON s.schema_id = o.schema_id
            WHERE o.name = @name AND o.parent_object_id = 0 AND o.type IN ('U', 'S', 'V', 'P', 'PC', 'X', 'RF', 'FN', 'IF', 'TF', 'FS', 'FT', 'AF', 'SN', 'SO')
              AND (@column IS NULL OR EXISTS (SELECT 1 FROM sys.all_columns AS c WHERE c.object_id = o.object_id AND c.name = @column))
            UNION ALL
            SELECT s.name, t.name, CASE WHEN t.is_table_type = 1 THEN 'TT' WHEN t.is_assembly_type = 1 THEN 'UA' ELSE 'UD' END, 1
            FROM sys.types AS t INNER JOIN sys.schemas AS s ON s.schema_id = t.schema_id
            WHERE t.is_user_defined = 1 AND t.name = @name AND @column IS NULL
        ) AS x
        WHERE x.schema_name = @schema OR @schema IS NULL AND (x.schema_name = @default OR x.schema_name = N'dbo')
        ORDER BY x.rank_kind, CASE WHEN x.schema_name = @default THEN 0 ELSE 1 END;
        """;
    /// <summary>The literals <see cref="Lookup"/> may hold besides type letters.</summary>
    internal static readonly IReadOnlySet<string> Literals = new HashSet<string>(StringComparer.Ordinal) { "N'dbo'" };
    /// <summary>The declarations <see cref="Lookup"/> takes inside the wrapper.</summary>
    public const string Declarations = "@schema sysname, @name sysname, @column sysname";
    /// <summary>Runs <see cref="Lookup"/> in database @db without a connection per database (CatalogSql.ModuleCall's way): the name
    /// reaches T-SQL only through QUOTENAME.</summary>
    public const string Wrapper = "DECLARE @module nvarchar(300) = QUOTENAME(@db) + N'.sys.sp_executesql';\n"
        + "EXEC @module @stmt, @decl, @schema = @schema, @name = @name, @column = @column;";

    /// <summary>A sys.objects (or Lookup's type) code as Object Explorer's kind and subtype; null for any other code.</summary>
    public static (string Kind, string? Subtype)? KindOf(string code) => code.Trim() switch
    {
        "U" => ("table", null),
        "S" => ("table", "system"),
        "V" => ("view", null),
        "P" => ("procedure", "sql"),
        "PC" => ("procedure", "clr"),
        "X" => ("procedure", "extended"),
        "RF" => ("procedure", "replicationFilter"),
        "FN" => ("function", "scalar"),
        "IF" => ("function", "inline"),
        "TF" => ("function", "tableValued"),
        "FS" => ("function", "clrScalar"),
        "FT" => ("function", "clrTableValued"),
        "AF" => ("function", "aggregate"),
        "SN" => ("synonym", null),
        "SO" => ("sequence", null),
        "TT" => ("tableType", null),
        "UA" => ("type", "clr"),
        "UD" => ("type", "alias"),
        _ => null
    };
}

/// <summary>language.definition: the object a name under the caret stands for (DefinitionNames), looked up on the document's
/// connection in the name's database, or else the document's. An unknown name, a database the login cannot open and a missing
/// object are all a null answer, which the editor shows as a quiet status message.</summary>
internal sealed class DefinitionService(IExplorerHost host)
{
    internal static readonly TimeSpan Budget = TimeSpan.FromSeconds(10);
    /// <summary>Replaces <see cref="Budget"/> (timeout checks).</summary>
    internal TimeSpan? TestBudget { get; set; }

    public async Task<LanguageDefinition?> ResolveAsync(LanguageRequest request, CancellationToken token)
    {
        SqlToolsLanguageService.Validate(request);
        if (request.Context.ConnectionId is not { } connectionId) return null;
        var lookup = DefinitionNames.Find(request.Text, request.Position);
        if (lookup is null) return null;
        var cloud = host.Profile(connectionId).Explorer(ExplorerCatalog.Current).Cloud;
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
        deadline.CancelAfter(TestBudget ?? Budget);
        try
        {
            // One connection per database on cloud editions, which cannot EXEC across databases; otherwise one in all.
            foreach (var group in lookup.Candidates.GroupBy(candidate => candidate.Database ?? request.Context.Database, StringComparer.Ordinal))
            {
                var database = group.Key;
                await using var connection = host.Connection(connectionId, cloud ? database : null);
                try { await host.OpenAsync(connection, deadline.Token); }
                // A cloud database that is gone or closed to the login: nothing to go to there. Any other failure to connect
                // (the server, the login, the pool) is the caller's error, never "no definition".
                catch (SqlException error) when (Unavailable(error) && !deadline.IsCancellationRequested) { continue; }
                foreach (var candidate in group)
                {
                    var found = await LookupAsync(connection, cloud ? null : database, candidate, lookup.Range, deadline.Token);
                    if (found is not null) return found;
                }
            }
            return null;
        }
        catch (Exception error) when (error is OperationCanceledException or SqlException && deadline.IsCancellationRequested && !token.IsCancellationRequested)
        {
            throw new RequestException("TIMEOUT", "Finding the definition took longer than " + (TestBudget ?? Budget).TotalSeconds + " seconds.");
        }
    }

    private static async Task<LanguageDefinition?> LookupAsync(SqlConnection connection, string? database, DefinitionName name, LanguageRange range, CancellationToken token)
    {
        await using var command = connection.CreateCommand();
        command.CommandTimeout = 15;
        if (database is null) command.CommandText = CatalogSql.Prologue + DefinitionSql.Lookup;
        else
        {
            command.CommandText = CatalogSql.Prologue + DefinitionSql.Wrapper;
            Add(command, "@db", 128, database);
            Add(command, "@stmt", -1, DefinitionSql.Lookup);
            Add(command, "@decl", -1, DefinitionSql.Declarations);
        }
        Add(command, "@schema", 128, name.Schema);
        Add(command, "@name", 128, name.Name);
        Add(command, "@column", 128, name.Column);
        try
        {
            await using var reader = await command.ExecuteReaderAsync(token);
            if (!await reader.ReadAsync(token)) return null;
            if (reader.IsDBNull(0) || reader.IsDBNull(1) || reader.IsDBNull(2) || reader.IsDBNull(3)) return null;
            var kind = DefinitionSql.KindOf(reader.GetString(3));
            return kind is { } known ? new LanguageDefinition(reader.GetString(0), reader.GetString(1), reader.GetString(2), known.Kind, known.Subtype, range) : null;
        }
        catch (SqlException error) when (Unavailable(error) && !token.IsCancellationRequested)
        {
            return null;
        }
    }

    /// <summary>The name's database does not exist or cannot be opened: 2812, the wrapper's database has no sys.sp_executesql
    /// because there is none; 911, 4060, 916, the database is unknown or closed to the login; 942, 945, 952, it is offline,
    /// unavailable or in transition.</summary>
    internal static bool Unavailable(SqlException error) => error.Number is 2812 or 911 or 916 or 4060 or 942 or 945 or 952;

    private static void Add(SqlCommand command, string name, int size, string? value) =>
        command.Parameters.Add(new SqlParameter(name, SqlDbType.NVarChar, size) { Value = (object?)value ?? DBNull.Value });
}
