using System.Data;
using Microsoft.Data.SqlClient;
using Varia.Backend.Scripting;

namespace Varia.Backend.Actions;

/// <summary>Table Properties' jobs: the describe (master's facts of the database, then the table inside it), and Apply's and Script's
/// plan from a preflight in this connection. Apply runs every statement in one transaction (runner v2's transaction mode), whose first
/// step finds the table again and plans again: a table renamed, dropped or replaced since, or changed so the plan would differ, is
/// refused before anything changes, and a failure or Stop rolls back every statement, so there is nothing to compensate.</summary>
internal sealed partial class ActionService
{
    /// <summary>The table's database as master sees it, or why it cannot be read: gone, not online, or not open to this login.</summary>
    private async Task<(ScriptPreflight.Row? Row, ActionError? Error)> TableDatabaseAsync(SqlConnection connection, string database, CancellationToken token)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = TableProperties.Master;
        command.CommandTimeout = 0;
        Add(command, "@name", SqlDbType.NVarChar, 128, database);
        await using var reader = await command.ExecuteReaderAsync(token);
        var display = Scripting.ScriptingErrors.Display(database);
        if (!await reader.ReadAsync(token)) return (null, Error("NOT_FOUND", "The database " + display + " no longer exists. Refresh Object Explorer."));
        var row = TableProperties.Read(reader);
        if (row.Int("state") != 0) return (null, Error("DATABASE_UNAVAILABLE", "The database " + display + " is " + (row.Text("state_desc") ?? "unavailable").Replace('_', ' ').ToLowerInvariant() + "."));
        if (!row.Bool("has_access")) return (null, Error("DATABASE_UNAVAILABLE", "The database " + display + " is not accessible to this login."));
        return (row, null);
    }

    private async Task<ActionDescribeResult> DescribeTablePropertiesJobAsync(SqlConnection connection, ObjectRefDto target, int band, CancellationToken token)
    {
        var (database, error) = await TableDatabaseAsync(connection, target.Database!, token);
        if (database is null) return new(null, 0, error);
        await using var command = ModuleCommand(connection, target.Database!, TableProperties.Inside(band, catalog.Tables), target.Name, target.Schema, 0);
        await using var reader = await command.ExecuteReaderAsync(token);
        var model = await TableProperties.ReadAsync(reader, band, catalog.Tables, database, token);
        return model is null ? new(null, 0, Error("NOT_FOUND", "The table " + Display(target) + " no longer exists. Refresh Object Explorer.")) : new(null, 0, TableProperties: model);
    }

    /// <summary>The preflight's facts of the table, in this connection (and the transaction, for the recheck), or null when it is gone.</summary>
    private static async Task<TableProperties.Facts?> TableFactsAsync(SqlConnection connection, ObjectRefDto target, int band, CancellationToken token, SqlTransaction? transaction = null)
    {
        await using var command = ModuleCommand(connection, target.Database!, TableProperties.Preflight(band), target.Name, target.Schema, 0);
        command.Transaction = transaction;
        await using var reader = await command.ExecuteReaderAsync(token);
        if (!await reader.ReadAsync(token) || !reader.GetBoolean(0)) return null;
        if (!await reader.NextResultAsync(token) || !await reader.ReadAsync(token)) return null;
        return TableProperties.FactsOf(TableProperties.Read(reader));
    }

    /// <summary>The plan from the preflight, or the refusal. Script and Apply share it; Apply also refuses a read-only database.</summary>
    private async Task<(List<TableStatement>? Plan, TableProperties.Facts? Facts, ActionError? Error)> PlanTableAsync(SqlConnection connection, ActionArgs args, ObjectRefDto target, int band, bool execute,
        CancellationToken token)
    {
        var (database, error) = await TableDatabaseAsync(connection, target.Database!, token);
        if (database is null) return (null, null, error);
        if (execute && database.Bool("read_only")) return (null, null, Error("NOT_SUPPORTED", catalog.Tables.Message("readOnlyDatabase")));
        var facts = await TableFactsAsync(connection, target, band, token);
        if (facts is null) return (null, null, Error("NOT_FOUND", "The table " + Display(target) + " no longer exists. Refresh Object Explorer."));
        // The properties were read from one table; a rename, drop or new table since can have given its name to another.
        if (args.Identity is { } read && (facts.Id != read.Id || facts.Created != read.Created)) return (null, null, Error("NOT_FOUND", catalog.Tables.Message("notTheTable")));
        var (plan, refusal) = TableAlter.Plan(catalog, target.Database!, target.Schema!, target.Name!, args.TableChanges!, facts);
        if (refusal is not null) return (null, null, Error("NOT_SUPPORTED", refusal));
        if (TableAlter.NeedsDatabaseTracking(plan!) && !database.Bool("tracking")) return (null, null, Error("NOT_SUPPORTED", catalog.Tables.Message("databaseTracking")));
        return (plan, facts, null);
    }

    private async Task<ActionScriptResult> ScriptTableJobAsync(SqlConnection connection, ActionArgs args, ObjectRefDto target, int band, CancellationToken token)
    {
        var (plan, _, error) = await PlanTableAsync(connection, args, target, band, execute: false, token);
        if (plan is null) return new(null, target.Database!, [], error);
        var text = TableAlter.ScriptText(catalog, plan);
        if (text.Length > ScriptLimit(args.Action)) return new(null, target.Database!, [], Error("SQL_ERROR", "The script is too large."));
        return new(text, target.Database!, []);
    }

    private async Task<ActionExecuteResult> ExecuteTableJobAsync(SqlConnection connection, ActionArgs args, ObjectRefDto target, int band, CancellationToken token)
    {
        var messages = CollectMessages(connection);
        var (plan, facts, error) = await PlanTableAsync(connection, args, target, band, execute: true, token);
        if (plan is null) return new([], [], 0, error);
        async Task Recheck(StepContext context)
        {
            var now = await TableFactsAsync(connection, target, band, context.Token, context.Transaction);
            if (now is null) throw new StepRefusedException(Error("NOT_FOUND", "The table " + Display(target) + " no longer exists. Refresh Object Explorer."));
            if (now.Id != facts!.Id || now.Created != facts.Created) throw new StepRefusedException(Error("NOT_FOUND", catalog.Tables.Message("notTheTable")));
            var (again, _) = TableAlter.Plan(catalog, target.Database!, target.Schema!, target.Name!, args.TableChanges!, now);
            // TableStatement is a record: equal plans are the same statements, values and titles.
            if (again is null || !again.SequenceEqual(plan))
                throw new StepRefusedException(Error("NOT_SUPPORTED", catalog.Tables.Message("changed")));
        }
        var run = plan.Select((statement, index) => new RunStep(statement.Title, async context =>
        {
            if (index == 0) await Recheck(context);
            await RunTableAsync(connection, statement, dryRun: false, context.Token, context.Transaction);
        }, Detail: statement.Name)).ToList();
        var (steps, failure, _) = await RunStepsAsync(connection, run, null, token, CleanupBudget(args.Action), transaction: true, rolledBack: catalog.Tables.Message("rolledBack"));
        return new(steps, messages.Collected(), 0, failure);
    }

    /// <summary>Runs one of Table Properties' batches (TableAlter.Executable): the database, schema and table, and a property's name and value.</summary>
    internal async Task<List<string?>> RunTableAsync(SqlConnection connection, TableStatement statement, bool dryRun, CancellationToken token, SqlTransaction? transaction = null)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = TableAlter.Executable(catalog, statement, dryRun);
        command.CommandTimeout = 0;
        Add(command, "@db", SqlDbType.NVarChar, 128, statement.Database);
        Add(command, "@p1", SqlDbType.NVarChar, 128, statement.Schema);
        Add(command, "@p2", SqlDbType.NVarChar, 128, statement.Table);
        if (statement.Procedure)
        {
            Add(command, "@p3", SqlDbType.NVarChar, 128, statement.Name);
            // nvarchar(4000), never (max): sp_*extendedproperty's @value is sql_variant, which takes no max type.
            if (statement.Template != TableTemplate.DropProperty) Add(command, "@v1", SqlDbType.NVarChar, 4000, statement.Value);
        }
        return await ReadAllAsync(command, token);
    }
}
