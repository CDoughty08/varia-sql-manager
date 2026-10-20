using System.Data;
using Microsoft.Data.SqlClient;
using Varia.Backend.Designer;
using Varia.Backend.Explorer;
using Varia.Backend.Scripting;

namespace Varia.Backend.Actions;

/// <summary>The table designer's jobs on the object-action path (spec PR-G §6): describe the database, script a new table
/// as SSMS's Save Change Script does, and create it in one transaction on the action's own connection. They reuse RunAsync's
/// gates, budgets, cloud refusal and Stop.</summary>
internal sealed partial class ActionService
{
    /// <summary>What a failed save adds: nothing was left behind.</summary>
    public const string RolledBack = "SQL Server rolled back the transaction; the table was not created.";

    /// <summary>The database a new table goes in: a database ref, SQL Server's own allowed (SSMS creates tables there too).</summary>
    private ObjectRefDto DatabaseTarget(ObjectRefDto? target)
    {
        if (target is null) throw Invalid("target.");
        try { ExplorerRefs.Object(target, explorer); }
        catch (RequestException) { throw Invalid("target."); }
        if (target.Kind != "database") throw Invalid("a new table goes in a database.");
        return target;
    }

    private static string StepTitle(DesignerPart part) => part switch
    {
        DesignerPart.CreateTable => "Create the table",
        DesignerPart.PrimaryKey => "Add the primary key",
        _ => "Set lock escalation"
    };

    /// <summary>The database as master sees it, or why nothing can be created in it.</summary>
    private async Task<(ScriptPreflight.Row? Row, ActionError? Error)> DesignerFactsAsync(SqlConnection connection, string database, CancellationToken token)
    {
        ScriptPreflight.Row? row = null;
        await using (var command = connection.CreateCommand())
        {
            command.CommandText = DesignerSql.MasterFacts;
            command.CommandTimeout = 0;
            Add(command, "@db", SqlDbType.NVarChar, 128, database);
            await using var reader = await command.ExecuteReaderAsync(token);
            if (await reader.ReadAsync(token)) row = ReadRow(reader);
        }
        var display = ScriptingErrors.Display(database);
        if (row is null) return (null, Error("NOT_FOUND", "The database " + display + " no longer exists. Refresh Object Explorer."));
        if (row.Int("state") != 0) return (null, Error("DATABASE_UNAVAILABLE", "The database " + display + " is " + (row.Text("state_desc") ?? "unavailable").Replace('_', ' ').ToLowerInvariant() + "."));
        if (!row.Bool("has_access")) return (null, Error("DATABASE_UNAVAILABLE", "The database " + display + " is not accessible to this login."));
        return (row, null);
    }

    /// <summary>Runs a catalog statement in the database through ModuleCall; a missing wrapper means the database went away.</summary>
    private async Task<(List<List<ScriptPreflight.Row>>? Sets, ActionError? Error)> InsideAsync(SqlConnection connection, string database, string statement, string? schema, string? name, string? other,
        int take, CancellationToken token)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = ActionSql.ModuleCall;
        command.CommandTimeout = 0;
        Add(command, "@db", SqlDbType.NVarChar, 128, database);
        Add(command, "@stmt", SqlDbType.NVarChar, -1, statement);
        Add(command, "@decl", SqlDbType.NVarChar, -1, ActionSql.Declarations);
        Add(command, "@schema", SqlDbType.NVarChar, 128, schema);
        Add(command, "@name", SqlDbType.NVarChar, 128, name);
        Add(command, "@new", SqlDbType.NVarChar, 128, other);
        Add(command, "@take", SqlDbType.Int, 0, take);
        var sets = new List<List<ScriptPreflight.Row>>();
        try
        {
            await using var reader = await command.ExecuteReaderAsync(token);
            do
            {
                var rows = new List<ScriptPreflight.Row>();
                while (await reader.ReadAsync(token)) rows.Add(ReadRow(reader));
                sets.Add(rows);
            } while (await reader.NextResultAsync(token));
        }
        catch (SqlException error) when (error.Number is 2812 or 911 && !token.IsCancellationRequested)
        {
            return (null, Error("NOT_FOUND", "The database " + ScriptingErrors.Display(database) + " no longer exists. Refresh Object Explorer."));
        }
        return (sets, null);
    }

    private async Task<ActionDescribeResult> DescribeDesignerJobAsync(SqlConnection connection, ObjectRefDto target, int band, CancellationToken token)
    {
        var database = target.Name!;
        var (facts, refused) = await DesignerFactsAsync(connection, database, token);
        if (facts is null) return new(null, 0, refused);
        var limit = (int)designer.Limit("schemas");
        var (sets, missing) = await InsideAsync(connection, database, DesignerSql.Describe, null, null, null, limit + 1, token);
        if (sets is null) return new(null, 0, missing);
        var schemas = sets[0].Select(row => row.Name("schema_name")).ToList();
        var filegroup = sets.Count > 1 && sets[1].Count > 0 && sets[1][0].Name("filegroup_name") is { Length: > 0 } name ? name : "PRIMARY";
        var listed = schemas.Take(limit).ToList();
        var model = new TableDesignerModelDto(database, band, listed, schemas.Count > limit, listed.Contains("dbo") ? "dbo" : listed.FirstOrDefault() ?? "dbo", filegroup,
            facts.NullableBool("can_create"));
        return new(null, 0, TableDesigner: model);
    }

    /// <summary>The preflight Script and Save share, in the action's connection: the database, the types' band, the schema,
    /// names already taken and advisory permissions. Script turns what would only fail into warnings; Save refuses it before
    /// any DDL. Returns the default filegroup the table goes on.</summary>
    private async Task<(string? Filegroup, ActionError? Error, List<string> Warnings)> PlanDesignerAsync(SqlConnection connection, TablePlan plan, string database, int band, bool execute,
        CancellationToken token)
    {
        var warnings = new List<string>();
        var (facts, refused) = await DesignerFactsAsync(connection, database, token);
        if (facts is null) return (null, refused, warnings);
        if (plan.Since(designer) > band) return (null, Error("NOT_SUPPORTED", "The json and vector data types need SQL Server 2025 or later."), warnings);
        var display = ScriptingErrors.Display(database);
        if (execute)
        {
            if (facts.Bool("is_read_only")) return (null, Error("NOT_SUPPORTED", "The database " + display + " is read-only."), warnings);
            if (facts.NullableBool("can_create") == false) return (null, Error("PERMISSION_DENIED", "You do not have permission to create a table in " + display + " (CREATE TABLE)."), warnings);
            // The builders shred the design with OPENJSON, which needs master at compatibility level 130 (SQL Server 2016) or later.
            if (facts.Int("master_level") < 130) return (null, Error("NOT_SUPPORTED", "Saving a table needs master at compatibility level 130 or later."), warnings);
        }
        var (sets, missing) = await InsideAsync(connection, database, DesignerSql.Preflight, plan.Schema, plan.Name, plan.PrimaryKeyName, 0, token);
        if (sets is null) return (null, missing, warnings);
        var row = sets[0][0];
        var schema = ScriptingErrors.Display(plan.Schema);
        var problems = new List<(string Code, string Message)>();
        if (!row.Bool("schema_exists")) problems.Add(("NOT_FOUND", "The schema " + schema + " does not exist."));
        else
        {
            if (row.Bool("name_in_use")) problems.Add(("NAME_IN_USE", "An object named " + ScriptingErrors.Display(plan.Name) + " already exists in schema " + schema + "."));
            if (plan.PrimaryKey.Count > 0 && row.Bool("key_in_use")) problems.Add(("NAME_IN_USE", "An object named " + ScriptingErrors.Display(plan.PrimaryKeyName) + " already exists in schema " + schema + "."));
            if (!row.Bool("can_alter")) problems.Add(("PERMISSION_DENIED", "You do not have permission to create a table in schema " + schema + " (ALTER on it)."));
        }
        if (execute && problems.Count > 0) return (null, Error(problems[0].Code, problems[0].Message), warnings);
        warnings.AddRange(problems.Take(8).Select(problem => problem.Message));
        return (row.Name("filegroup_name") is { Length: > 0 } filegroup ? filegroup : "PRIMARY", null, warnings);
    }

    private async Task<ActionScriptResult> ScriptDesignerJobAsync(SqlConnection connection, ActionArgs args, ObjectRefDto target, int band, CancellationToken token)
    {
        var plan = TableDesignValidator.Validate(designer, args.Design);
        var (filegroup, error, warnings) = await PlanDesignerAsync(connection, plan, target.Name!, band, execute: false, token);
        if (filegroup is null) return new(null, target.Name!, [], error);
        var text = DesignerSql.Script(designer, plan, filegroup);
        if (text.Length > ScriptLimit(args.Action)) return new(null, target.Name!, [], Error("SQL_ERROR", "The script is too large."));
        return new(text, target.Name!, warnings);
    }

    /// <summary>Save: the preflight, then each step's builder in one transaction, then the commit. Any failure, Stop or lost
    /// connection rolls back (a rollback that cannot finish within StopGrace closes the unpooled connection, which ends the
    /// session and rolls it back); only a commit the connection broke during leaves the outcome unknown.</summary>
    private async Task<ActionExecuteResult> ExecuteDesignerJobAsync(SqlConnection connection, ActionArgs args, ObjectRefDto target, int band, CancellationToken token)
    {
        var plan = TableDesignValidator.Validate(designer, args.Design);
        var messages = CollectMessages(connection);
        var (filegroup, refused, _) = await PlanDesignerAsync(connection, plan, target.Name!, band, execute: true, token);
        if (filegroup is null) return new([], [], 0, refused);
        var design = DesignerSql.DesignJson(designer, plan, filegroup);
        var transaction = (SqlTransaction)await connection.BeginTransactionAsync(token);
        var committed = false;
        var work = DesignerSql.Statements(plan, filegroup).Select(statement => (StepTitle(statement.Part),
            (Func<Task>)(() => RunBuilderAsync(connection, transaction, statement.Part, target.Name!, design, dryRun: false, token)))).ToList();
        // Stop has no say once the commit is sent: its outcome is the server's.
        work.Add(("Commit", async () => { await transaction.CommitAsync(CancellationToken.None); committed = true; }));
        var (steps, failure, _) = await RunStepsAsync(connection, work, null, token);
        if (!committed)
        {
            try { await transaction.RollbackAsync(CancellationToken.None).WaitAsync(Options.StopGrace, CancellationToken.None); }
            // XACT_ABORT or the attention may have rolled it back already; otherwise closing the session does.
            catch (Exception) { try { await connection.CloseAsync(); } catch (Exception) { } }
            if (failure is not null && failure.Code != "CONNECTION_LOST") failure = failure with { Message = ScriptingErrors.Clip(failure.Message + " " + RolledBack, ActionErrors.MaxMessage) };
        }
        await transaction.DisposeAsync();
        return new(steps, messages.Collected(), 0, failure);
    }

    private async Task<List<string?>> RunBuilderAsync(SqlConnection connection, SqlTransaction? transaction, DesignerPart part, string database, string design, bool dryRun, CancellationToken token)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = DesignerSql.Builder(designer, part, dryRun);
        command.CommandTimeout = 0;
        Add(command, "@db", SqlDbType.NVarChar, 128, database);
        Add(command, "@design", SqlDbType.NVarChar, -1, design);
        var values = new List<string?>();
        await using var reader = await command.ExecuteReaderAsync(token);
        do
        {
            while (await reader.ReadAsync(token))
                for (var i = 0; i < reader.FieldCount; i++) values.Add(reader.IsDBNull(i) ? null : reader.GetString(i));
        } while (await reader.NextResultAsync(token));
        return values;
    }

    /// <summary>The live checks' only way to see what the builders compose for a plan, in order (see the other DryRunAsync).</summary>
    internal async Task<List<string?>> DryRunDesignAsync(string connectionId, string database, TablePlan plan, string filegroup, CancellationToken token)
    {
        await using var connection = host.Connection(connectionId);
        await host.OpenAsync(connection, token);
        var design = DesignerSql.DesignJson(designer, plan, filegroup);
        var built = new List<string?>();
        foreach (var (part, _) in DesignerSql.Statements(plan, filegroup)) built.AddRange(await RunBuilderAsync(connection, null, part, database, design, dryRun: true, token));
        return built;
    }
}
