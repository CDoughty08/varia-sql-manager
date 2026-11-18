using Microsoft.Data.SqlClient;
using Varia.Backend.Live;

namespace Varia.Backend.Agent;

/// <summary>What one Agent read statement returned: its declared columns' values, row by row, and whether more rows were
/// there than its cap (the rest were cancelled, not read).</summary>
internal sealed record AgentResult(IReadOnlyList<string> Columns, List<object?[]> Rows, bool Truncated)
{
    public int Index(string column)
    {
        for (var at = 0; at < Columns.Count; at++) if (Columns[at] == column) return at;
        return -1;
    }

    public object? Value(object?[] row, string column) => Index(column) is var at and >= 0 ? row[at] : throw new InvalidOperationException("The Agent statement does not declare that column.");
}

/// <summary>A statement's failure as a value: the live error code (PERMISSION_DENIED, NOT_SUPPORTED, AGENT_DISABLED, …), the
/// first error's number and a sentence that names no Agent object.</summary>
internal sealed record AgentReadError(string Statement, string Code, int Number, string Message);

/// <summary>Runs Agent read statements (<see cref="AgentSql"/>) one at a time on the caller's connection, as ActivityReader runs
/// the Activity Monitor's: each fails alone, as a value, so a refused read (a role below Operator reading alerts, error logs
/// below sysadmin) or one this server lacks leaves the others' results; error 15281 (Agent XPs off) is AGENT_DISABLED. A
/// lost connection or a timeout is thrown, since nothing more can run on it. Each statement reads at most its cap plus one
/// row and cancels the rest, so a full result says it was truncated. It runs only <see cref="AgentSql.All"/>, every one of
/// which the offline lint checks. Nothing is logged. Not wired to a method yet (AG-0b).</summary>
internal sealed class AgentReader(AgentCatalog? catalog = null)
{
    public const string DisabledMessage = "SQL Server Agent's extended procedures are off (Agent XPs): SQL Server Agent is stopped or disabled on this server.";
    public const string RefusedMessage = "This login may not read this part of SQL Server Agent.";
    public const string MissingMessage = "This server's SQL Server Agent does not offer this read.";

    private readonly AgentCatalog catalog = catalog ?? AgentCatalog.Current;

    /// <summary>Runs a statement in place of the server, with its parameter values and its row cap (offline checks only).</summary>
    internal Func<AgentStatement, IReadOnlyDictionary<string, object?>, int, Task<AgentResult>>? TestRun { get; init; }

    /// <summary>Runs the statements in order, each after <paramref name="prologue"/> (null for a describe, whose prologue ran as
    /// its own command), and returns what each read or why it failed.</summary>
    public async Task<(Dictionary<string, AgentResult> Results, List<AgentReadError> Errors)> ReadAsync(SqlConnection? connection, string? prologue, IReadOnlyList<AgentStatement> statements,
        Func<AgentStatement, AgentParameter, object?> values, CancellationToken token)
    {
        var results = new Dictionary<string, AgentResult>(StringComparer.Ordinal);
        var errors = new List<AgentReadError>();
        foreach (var statement in statements)
        {
            if (!AgentSql.Known(statement)) throw new RequestException("BACKEND_ERROR", "An Agent read ran a statement the lint never checked.");
            var cap = (int)catalog.Limit(statement.Cap);
            var arguments = statement.Parameters.ToDictionary(parameter => parameter.Name, parameter => values(statement, parameter), StringComparer.Ordinal);
            try
            {
                results[statement.Id] = TestRun is { } run ? await run(statement, arguments, cap).ConfigureAwait(false)
                    : await RunAsync(connection ?? throw new InvalidOperationException("An Agent read needs a connection."), prologue, statement, arguments, cap, token).ConfigureAwait(false);
            }
            catch (AgentShapeException error)
            {
                errors.Add(new(statement.Id, "BACKEND_ERROR", 0, error.Message));
            }
            catch (SqlException error) when (!token.IsCancellationRequested)
            {
                var value = Classify(statement, error);
                if (LiveErrors.Breaks(value.Code) || value.Code == "LOGIN_FAILED") throw;
                errors.Add(value);
            }
        }
        return (results, errors);
    }

    /// <summary>A statement's SqlException as a value. 15281 is Agent XPs off; 2812 a procedure this server lacks; 229 (EXECUTE
    /// denied) and the live layer's refusals are PERMISSION_DENIED; anything else keeps the live classification.</summary>
    public static AgentReadError Classify(AgentStatement statement, SqlException error)
    {
        var first = error.Errors.Cast<SqlError>().FirstOrDefault(item => item.Class > 10) ?? (error.Errors.Count > 0 ? error.Errors[0] : null);
        var number = first?.Number ?? error.Number;
        var code = number switch
        {
            15281 => "AGENT_DISABLED",
            2812 => "NOT_SUPPORTED",
            229 => "PERMISSION_DENIED",
            _ => LiveErrors.Classify(number, first?.Class ?? error.Class)
        };
        var message = code switch
        {
            "AGENT_DISABLED" => DisabledMessage,
            "PERMISSION_DENIED" => RefusedMessage,
            "NOT_SUPPORTED" => MissingMessage,
            _ => LiveErrors.From(statement.Id, error).Message
        };
        return new(statement.Id, code, number, message);
    }

    /// <summary>Runs one statement and reads its first result set's declared columns, at most <paramref name="cap"/> + 1 rows;
    /// a missing column fails that statement alone (BACKEND_ERROR), so one server's other shape does not stop the rest.</summary>
    private static async Task<AgentResult> RunAsync(SqlConnection connection, string? prologue, AgentStatement statement, IReadOnlyDictionary<string, object?> arguments, int cap, CancellationToken token)
    {
        await using var command = connection.CreateCommand();
        command.CommandTimeout = 0;
        command.CommandText = (prologue ?? "") + statement.Text;
        foreach (var parameter in statement.Parameters)
            command.Parameters.Add(new SqlParameter(parameter.Name, parameter.Type) { Value = arguments[parameter.Name] ?? DBNull.Value, Size = parameter.Size });
        await using var reader = await command.ExecuteReaderAsync(token).ConfigureAwait(false);
        var ordinals = new int[statement.Columns.Count];
        for (var at = 0; at < ordinals.Length; at++)
        {
            ordinals[at] = -1;
            for (var field = 0; field < reader.FieldCount; field++) if (reader.GetName(field) == statement.Columns[at]) ordinals[at] = field;
            // Only the server's own column names are named: an msdb or master procedure's result shape, never data.
            if (ordinals[at] < 0)
                throw new AgentShapeException("The Agent read " + statement.Id + " returned the columns " + string.Join(", ", Enumerable.Range(0, reader.FieldCount).Select(reader.GetName))
                    + " without " + statement.Columns[at] + ".");
        }
        var rows = new List<object?[]>();
        var truncated = false;
        while (await reader.ReadAsync(token).ConfigureAwait(false))
        {
            if (rows.Count == cap)
            {
                truncated = true;
                // The rest is not read: the server stops sending, and disposing the reader drains nothing.
                command.Cancel();
                break;
            }
            var row = new object?[ordinals.Length];
            for (var at = 0; at < ordinals.Length; at++) row[at] = reader.IsDBNull(ordinals[at]) ? null : reader.GetValue(ordinals[at]);
            rows.Add(row);
        }
        return new(statement.Columns, rows, truncated);
    }
}

/// <summary>A statement's result set lacks a declared column: a server whose procedure answers in another shape.</summary>
internal sealed class AgentShapeException(string message) : Exception(message);
