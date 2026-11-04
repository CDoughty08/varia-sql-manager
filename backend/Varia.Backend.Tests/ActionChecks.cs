using System.Text.Json;
using Microsoft.Data.SqlClient;
using Varia.Backend.Actions;
using Varia.Backend.Explorer;
using Varia.Backend.Protocol;

namespace Varia.Backend.Tests;

/// <summary>Offline object action checks: the embedded catalogue, the lint over every statement and band, the script text
/// of hostile names, plans, validation parity with zod, lanes, error classification, and the service with a fake host.</summary>
internal static class ActionChecks
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
        UnmappedMemberHandling = System.Text.Json.Serialization.JsonUnmappedMemberHandling.Disallow
    };
    private static readonly ActionsCatalog Catalog = ActionsCatalog.Current;
    private static readonly ServerProfile Box2022 = new(16, "16.0.4135.4", 3, "sa", false, true, false, 16);
    private static readonly string NL = Environment.NewLine;

    /// <summary>A name at the sysname limit made of an injection fragment.</summary>
    public static string Long(string fragment) => (fragment + new string('x', 128))[..128];

    public static async Task RunAsync(Action<bool, string> check)
    {
        CatalogChecks(check);
        Lint(check);
        ScriptText(check);
        Plans(check);
        Errors(check);
        Validation(check);
        await RenameWaitAsync(check);
        Detach(check);
        await ServiceAsync(check);
    }

    private static void CatalogChecks(Action<bool, string> check)
    {
        var rows = Catalog.Rows.ToList();
        check(rows.Count == 52 && rows.All(row => ExplorerCatalog.Current.Kind(row.Kind) is { } kind && (row.Subtype == "" || kind.Subtypes.Contains(row.Subtype))),
            "the embedded actions catalogue loads and every row names an Object Explorer kind and subtype");
        check(Catalog.Allows("table", "", "delete") && Catalog.Allows("table", "graphEdge", "rename") && !Catalog.Allows("table", "system", "rename") && !Catalog.Allows("table", "systemVersioned", "delete")
            && !Catalog.Allows("procedure", "extended", "delete") && !Catalog.Allows("database", "system", "rename") && Catalog.Allows("database", "snapshot", "delete")
            && !Catalog.Allows("database", "snapshot", "rename") && Catalog.Allows("function", "aggregate", "rename") && !Catalog.Allows("function", "aggregate", "delete")
            && Catalog.Offered("login", "delete") && Catalog.Offered("view", "selectTop"), "the catalogue's rows decide what each subtype allows");
        var options = new ActionServiceOptions();
        check(Catalog.Limit("readPerConnection") == options.ReadPerConnection && Catalog.Limit("readTotal") == options.ReadTotal && Catalog.Limit("executePerConnection") == options.ExecutePerConnection
            && Catalog.Limit("executeTotal") == options.ExecuteTotal && Catalog.Limit("registered") == options.MaxRegistered && Catalog.Limit("describeMs") == (long)options.DescribeBudget.TotalMilliseconds
            && Catalog.Limit("scriptMs") == (long)options.ScriptBudget.TotalMilliseconds && Catalog.Limit("gateWaitMs") == (long)options.GateWait.TotalMilliseconds
            && Catalog.Limit("messageChars") == ActionErrors.MaxMessage && Catalog.Limit("newName") == ExplorerRefs.MaxIdentifier
            && Catalog.Limit("stopGraceMs") == (long)options.StopGrace.TotalMilliseconds, "the backend's limits are the catalogue's");
        check(Catalog.Describes.Keys.Order(StringComparer.Ordinal).SequenceEqual(["loginFacts", "renameDatabase"]) &&Catalog.Describes["renameDatabase"].SequenceEqual(["database"]) && Catalog.ActionOf("renameDatabase") == "rename"
            && !Catalog.Dialogs.ContainsKey("renameDatabase") && Catalog.DatabaseRefusal("rename", 0, 1, false, false) is null && Catalog.DatabaseRefusal("rename", 0, 2, false, false) is null
            && Catalog.DatabaseRefusal("rename", 0, 0, true, false) == "A read-only database cannot be renamed." && Catalog.DatabaseRefusal("rename", 0, 0, false, true) == "A read-only database cannot be renamed."
            && new[] { 1, 2, 3, 4, 5, 6, 7, 10, 42 }.All(state => Catalog.DatabaseRefusal("rename", state, 0, true, false) == "The database must be online to be renamed."),
            "the renameDatabase describe serves Rename on databases, which the catalogue refuses for a database that is not online, or is read-only or standby (902) (D3c)");
        check(Catalog.ErrorCodes.Count() == 22 && Catalog.ErrorCodes.Contains("FILE_ACCESS") && Catalog.Retryable("FILE_ACCESS") && !Catalog.Retryable("MEDIA") && !Catalog.Retryable("BACKUP_MISMATCH") && !Catalog.Retryable("TAIL_LOG_NEEDED") && !Catalog.Retryable("RESTORE_SEQUENCE") && Catalog.Retryable("PASSWORD_POLICY") && Catalog.Retryable("IN_USE") && Catalog.Retryable("AUTH_ENTRA") && !Catalog.Retryable("DEPENDENTS") && Catalog.Retryable("CANCELLED") && !Catalog.ErrorCodes.Contains("INVALID_NAME")
            && Catalog.Dialogs.Keys.SequenceEqual(["deleteObject", "databaseProperties", "newDatabase", "attachDatabase", "newLogin", "takeOffline", "bringOnline", "detachDatabase", "unlockLogin", "loginProperties"]) && Catalog.IsServerAction("createDatabase") && !Catalog.IsServerAction("properties")
            && Catalog.ActionOf("takeOffline") == "takeOffline" && Catalog.ActionOf("bringOnline") == "bringOnline" && Catalog.ActionOf("detachDatabase") == "detach",
            "the catalogue lists the action error codes (a file SQL Server cannot open, FILE_ACCESS, retryable once fixed; restore's MEDIA, BACKUP_MISMATCH, TAIL_LOG_NEEDED and RESTORE_SEQUENCE not; New Login's PASSWORD_POLICY retryable) and the Delete Object, Database Properties, New Database, Attach Databases, New Login, Take Offline, Bring Online, Detach Database, Unlock Login and Login Properties dialogs, New Database's createDatabase a server action");
        // The database rules are the menu's (databaseActionState, tests/object-actions-catalog.test.ts): the preflight refuses what the menu greys.
        check(Catalog.DatabaseStateOf(0) == "online" && Catalog.DatabaseStateOf(6) == "offline" && Catalog.DatabaseStateOf(10) == "offlineSecondary" && Catalog.DatabaseStateOf(42) == "other"
            && Catalog.DatabaseRefusal("takeOffline", 0, 0, false, false) is null && Catalog.DatabaseRefusal("takeOffline", 6, 0, false, false) == "The database is offline."
            && Catalog.DatabaseRefusal("takeOffline", 1, 0, false, false) == "A database that is restoring or recovering cannot be taken offline."
            && Catalog.DatabaseRefusal("takeOffline", 10, 0, false, false) is not null && Catalog.DatabaseRefusal("takeOffline", 0, 1, true, true) is null
            && Catalog.DatabaseRefusal("bringOnline", 0, 0, false, false) == "The database is online." && Catalog.DatabaseRefusal("bringOnline", 6, 1, true, false) is null
            && Catalog.DatabaseRefusal("bringOnline", 2, 0, false, false) == "A database that is restoring or recovering cannot be brought online."
            && new[] { 3, 4, 5, 10, 42 }.All(state => Catalog.DatabaseRefusal("bringOnline", state, 0, false, false) is null) && Catalog.DatabaseRefusal("properties", 6, 0, false, false) is null
            && Catalog.Allows("database", "", "takeOffline") && !Catalog.Allows("database", "system", "takeOffline") && !Catalog.Allows("database", "snapshot", "bringOnline"),
            "Take Offline and Bring Online are refused in the states the menu greys them in, with its reasons, and never on a snapshot or SQL Server's own databases");
        // A login's Properties opens Login Properties (D2c): the backend checks that action's target as the login kind and the properties verb.
        check(Catalog.KindOf("loginProperties") == "login" && Catalog.VerbOf("loginProperties") == "properties" && Catalog.KindActionOf("login", "properties") == "loginProperties"
            && Catalog.KindActionOf("database", "properties") is null && Catalog.VerbOf("properties") == "properties" && Catalog.KindOf("properties") is null
            && Catalog.Allows("login", "system", "properties") && Catalog.Allows("login", "windowsGroup", "properties"), "Login Properties is the login kind's properties action, on every login");
        // A kind's status overlay is emitted as a second row for the same kind and subtype, with its status, and an action
        // may carry engines (src/shared/actions/catalog.ts); the catalogue must load both, as a later PR will embed them.
        using (var embedded = typeof(ActionsCatalog).Assembly.GetManifestResourceStream("Varia.Backend.Actions.actions-catalog.json")!)
        {
            var json = System.Text.Json.Nodes.JsonNode.Parse(embedded)!.AsObject();
            json["rows"]!.AsArray().Add(new System.Text.Json.Nodes.JsonObject { ["kind"] = "database", ["subtype"] = "", ["status"] = "unavailable", ["enabled"] = new System.Text.Json.Nodes.JsonArray("selectTop"), ["disabled"] = new System.Text.Json.Nodes.JsonArray("rename") });
            json["actions"]![0]!.AsObject()["engines"] = new System.Text.Json.Nodes.JsonArray("box");
            ActionsCatalog? overlaid = null;
            try { overlaid = ActionsCatalog.Parse(new MemoryStream(System.Text.Encoding.UTF8.GetBytes(json.ToJsonString()))); } catch (ArgumentException) { }
            check(overlaid is not null && overlaid.Row("database", "", "unavailable") is { Status: "unavailable" } overlay && overlay.Enabled.SequenceEqual(["selectTop"])
                && overlaid.Row("database", "") is { Status: "" } plain && plain.Enabled.Contains("rename") && overlaid.Row("database", null, "readOnly") == plain
                && overlaid.Allows("database", "", "rename") && !Catalog.Offered("database", "selectTop") && overlaid.Offered("database", "selectTop"),
                "a status overlay's row loads beside its subtype's row, is the row for that status only, and counts toward what the kind offers");
        }
    }

    private static void Lint(Action<bool, string> check)
    {
        var results = ActionSql.Lint().ToList();
        var problems = results.SelectMany(result => result.Problems.Select(problem => result.Name + ": " + problem)).ToList();
        check(problems.Count == 0 && results.Count == Enum.GetValues<ActionTemplate>().Length * 2 + 6 * 5 + 20 + 6 * 2 + 2 + DatabaseAlter.Corpus(Catalog).Count() * 2 + 2 + 6 + AttachSql.LintAll().Count() + 2 + 2 + (LoginSql.Corpus().Count() + LoginSql.OptionsCorpus().Count() + LoginSql.PasswordCorpus().Count()) * 2 + 4 + 2
                + Catalog.Logins.Securables.Types.Count * PermissionSql.Forms.Count * 2 + 4, "every executable and catalog statement passes the lint at every band, New Database's, Attach's and New Login's and Login Properties' builders and facts, User Mapping's reads and the Securables page's statements included (" + results.Count + "): " + string.Join("; ", problems.Take(5)));
        // The transaction DMVs raise error 300 without VIEW SERVER STATE whatever guards them, so the statements every action runs never
        // read them; only the describe's counts and lists do, after Database's guarded count shows the permission.
        check(new[] { ActionSql.Database, ActionSql.DatabaseState, ActionSql.Login, ActionSql.LoginAlter, ActionSql.OwnSessions, ActionSql.DatabaseSessions, ActionSql.DatabaseAccess }.All(statement => !statement.Contains("dm_tran_", StringComparison.Ordinal))
            && new[] { ActionSql.DatabaseUse, ActionSql.DatabaseUseSessions, ActionSql.TransactionSessions }.All(statement => statement.Contains("sys.dm_tran_session_transactions", StringComparison.Ordinal)),
            "only Delete Object's session counts and lists read the transaction DMVs, never the statements every action runs");
        // The lint must catch what it is for: a name spliced into the text, a name parameter outside QUOTENAME, a metadata function.
        check(ActionSql.LintExecutable("DECLARE @stmt nvarchar(max) = N'DROP TABLE ' + @p1;\nEXEC (@stmt);", ActionTemplate.DropTable).Count > 0
            && ActionSql.LintExecutable("DECLARE @stmt nvarchar(max) = N'DROP TABLE [dbo].[x]';\nEXEC (@stmt);", ActionTemplate.DropTable).Count > 0
            && ActionSql.LintExecutable("EXEC @rename @objname = @undeclared;", ActionTemplate.RenameObject).Count > 0
            && ActionSql.LintExecutable(ActionSql.Executable(ActionTemplate.DropTable).Replace("QUOTENAME(@db) + N'.sys.sp_executesql'", "@db + N'.sys.sp_executesql'", StringComparison.Ordinal), ActionTemplate.DropTable).Count > 0
            && ActionSql.LintExecutable(ActionSql.Executable(ActionTemplate.RenameObject).Replace("QUOTENAME(@db) + N'.sys.sp_rename'", "@db + N'.sys.sp_rename'", StringComparison.Ordinal), ActionTemplate.RenameObject).Count > 0
            && ActionSql.LintCatalog("SELECT OBJECT_ID(@name);", 16, database: true).Count > 0 && ActionSql.LintCatalog("SELECT USER_NAME(o.principal_id) FROM sys.objects AS o WHERE o.name = @name;", 16, database: true).Count > 0
            && ActionSql.LintCatalog("SELECT t.ledger_type FROM sys.tables AS t WHERE t.name = @name;", 15, database: true).Count > 0, "the lint refuses spliced names, bare name parameters, the database outside QUOTENAME, undeclared variables, metadata functions and band gates");
        // Every executable batch is constant text: no name ever reaches it.
        check(Enum.GetValues<ActionTemplate>().All(template => ActionSql.Executable(template) == ActionSql.Executable(template) && !InjectionMatrix.Fragments.Any(fragment => ActionSql.Executable(template).Contains(fragment[1..4], StringComparison.Ordinal))),
            "executable batches are constant text per template");
    }

    private static void ScriptText(Action<bool, string> check)
    {
        var failures = new List<string>();
        foreach (var fragment in InjectionMatrix.Fragments.Append("]").Append("'").Append(" ").Append("‮"))
        {
            var name = Long(fragment);
            var quoted = "[" + name.Replace("]", "]]", StringComparison.Ordinal) + "]";
            var plans = new[]
            {
                new PlannedStatement(ActionTemplate.DropTable, name, [name, name]), new PlannedStatement(ActionTemplate.DropView, name, [name, name]),
                new PlannedStatement(ActionTemplate.DropProcedure, name, [name, name]), new PlannedStatement(ActionTemplate.DropFunction, name, [name, name]),
                new PlannedStatement(ActionTemplate.RenameObject, name, [name, name, name]), new PlannedStatement(ActionTemplate.RenameDatabase, "master", [name, name]),
                new PlannedStatement(ActionTemplate.SetSingleUser, "master", [name]), new PlannedStatement(ActionTemplate.DropDatabase, "master", [name]),
                new PlannedStatement(ActionTemplate.DeleteBackupHistory, "msdb", [name]),
                // The shared templates (critic A21).
                new PlannedStatement(ActionTemplate.SetMultiUser, "master", [name]), new PlannedStatement(ActionTemplate.SetRestrictedUser, "master", [name]),
                ActionSql.Detach(name, updateStatistics: true), new PlannedStatement(ActionTemplate.DisableLogin, "master", [name]),
                new PlannedStatement(ActionTemplate.EnableLogin, "master", [name]), new PlannedStatement(ActionTemplate.DenyConnect, "master", [name]),
                new PlannedStatement(ActionTemplate.GrantConnect, "master", [name]), new PlannedStatement(ActionTemplate.DropUser, name, [name]),
                // Take Offline and Bring Online.
                new PlannedStatement(ActionTemplate.SetOffline, "master", [name]), new PlannedStatement(ActionTemplate.SetOfflineRollback, "master", [name]),
                new PlannedStatement(ActionTemplate.SetOnline, "master", [name]),
                // Restore Database's cleanup (D1f).
                ActionSql.DropRestoring(name, 2_147_483_647),
                // Unlock's (D4d), which its own script wraps in one transaction (UnlockChecks).
                new PlannedStatement(ActionTemplate.CheckPolicyOff, "master", [name]), new PlannedStatement(ActionTemplate.CheckPolicyOn, "master", [name]),
                new PlannedStatement(ActionTemplate.CheckPolicyExpirationOn, "master", [name])
            };
            foreach (var plan in plans)
            {
                var text = ActionSql.ScriptText(plan);
                var batches = SqlScript.Parse(text);
                // The query window splits the script where SSMS's does: one USE batch and one statement batch, whatever the name holds.
                if (batches.Count != (plan.Template == ActionTemplate.DeleteBackupHistory ? 1 : 2) || !batches[^1].Sql.Contains(ActionSql.Statement(plan), StringComparison.Ordinal))
                    failures.Add(plan.Template + " splits into " + batches.Count + " batches for " + fragment[..1]);
                if (!ActionSql.Statement(plan).Contains(plan.Template is ActionTemplate.DeleteBackupHistory or ActionTemplate.RenameObject or ActionTemplate.DetachDatabase
                    ? name.Replace("'", "''", StringComparison.Ordinal) : quoted, StringComparison.Ordinal))
                    failures.Add(plan.Template + " does not quote " + fragment[..1]);
            }
        }
        check(failures.Count == 0, "Script Action text quotes hostile 128-unit names as QUOTENAME and N'' do, and splits into SSMS's batches: " + string.Join("; ", failures.Take(5)));
        check(ActionSql.ScriptText(new(ActionTemplate.DropTable, "AppData", ["dbo", "Orders"])) == "USE [AppData]" + NL + "GO" + NL + "DROP TABLE [dbo].[Orders]" + NL + "GO" + NL,
            "a table's DROP script is SSMS's: USE, GO, DROP TABLE, GO");
    }

    private static ActionArgs Delete(ObjectRefDto target, bool close = false, bool history = false) => new("delete", Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), target, null, close, history);
    private static ActionArgs Rename(ObjectRefDto target, string name) => new("rename", Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), target, name);

    private static void Plans(Action<bool, string> check)
    {
        var database = new ObjectRefDto("database", Name: "AppData");
        var full = string.Concat(ActionService.Plan(Delete(database, close: true, history: true), database).Select(ActionSql.ScriptText));
        // SSMS deletes the history first; Varia only after the DROP succeeded, so a DROP that fails (IN_USE) keeps it.
        check(full == "USE [master]" + NL + "GO" + NL + "ALTER DATABASE [AppData] SET  SINGLE_USER WITH ROLLBACK IMMEDIATE" + NL + "GO" + NL
            + "USE [master]" + NL + "GO" + NL + "DROP DATABASE [AppData]" + NL + "GO" + NL
            + "EXEC msdb.dbo.sp_delete_database_backuphistory @database_name = N'AppData'" + NL + "GO" + NL, "a database's Delete scripts single-user mode, the DROP, then its backup history");
        check(ActionService.Plan(Delete(database, history: true), database).Select(plan => plan.Template).SequenceEqual([ActionTemplate.DropDatabase, ActionTemplate.DeleteBackupHistory]),
            "the backup history step runs only after the DROP");
        check(ActionService.Plan(Delete(database), database).Select(plan => plan.Template).SequenceEqual([ActionTemplate.DropDatabase]),
            "without its options, deleting a database only drops it (Close existing connections is off by default, as in SSMS)");
        // D3 §8: a DROP that fails after SINGLE_USER restores the access the database had; only main steps are scripted.
        var multi = ActionService.Plan(Delete(database, close: true, history: true), database, new(false, 0));
        var restricted = ActionService.Plan(Delete(database, close: true), database, new(false, 2));
        var compensation = multi.Single(plan => plan.Kind == StepKind.Compensation);
        check(compensation is { Template: ActionTemplate.SetMultiUser, Database: "master", Undoes: 0, When: { } due } && compensation.Names.SequenceEqual(["AppData"])
            && due(["done", "failed", "skipped"]) && due(["done", "cancelled", "skipped"]) && !due(["done", "done", "failed"])
            && restricted.Single(plan => plan.Kind == StepKind.Compensation).Template == ActionTemplate.SetRestrictedUser
            && ActionService.Plan(Delete(database, close: true), database, new(false, 1)).All(plan => plan.Kind == StepKind.Main)
            && ActionService.Plan(Delete(database), database, new(false, 0)).All(plan => plan.Kind == StepKind.Main)
            && ActionService.ScriptText(multi) == full,
            "closing connections before a DROP restores multi-user or restricted access when the DROP does not complete, never after it, and is never scripted");
        check(ActionService.Plan(Delete(database, close: true, history: true), database, new(true, 0)).Select(plan => plan.Template)
                .SequenceEqual([ActionTemplate.DropDatabase, ActionTemplate.DeleteBackupHistory]),
            "an offline database has no sessions to close: its Delete runs no SINGLE_USER and nothing to restore");
        check(ActionService.CloseConnectionsNote("box", snapshot: false, offline: true) == ActionService.OfflineCloseNote
            && ActionService.CloseConnectionsNote("managedInstance", snapshot: false, offline: false) == ActionService.ManagedInstanceCloseNote
            && ActionService.CloseConnectionsNote("box", snapshot: false, offline: false) is null && ActionService.CloseConnectionsNote("managedInstance", snapshot: true, offline: true) is null,
            "Delete Object greys Close existing connections with a reason for an offline database and on Managed Instance (a snapshot greys it by itself), and offers it elsewhere");
        var view = new ObjectRefDto("view", "AppData", "dbo", "V");
        check(ActionService.Plan(Rename(view, "W"), view).Single() is { Template: ActionTemplate.RenameObject, Database: "AppData" } renamed && renamed.Names.SequenceEqual(["dbo", "V", "W"])
            && ActionService.Plan(Rename(database, "B"), database).Single() is { Template: ActionTemplate.RenameDatabase, Database: "master" }
            && ActionService.Plan(Delete(view), view).Single().Template == ActionTemplate.DropView, "rename and delete plans name the statement, its database and its names");
        // SMO's capture of SSMS's Take Offline (with and without Drop All Active Connections) and Bring Online, two spaces included.
        string Script(ActionArgs args) => ActionService.ScriptText(ActionService.Plan(args, database));
        string Use(string statement) => "USE [master]" + NL + "GO" + NL + statement + NL + "GO" + NL;
        check(Script(TakeOffline(database, drop: false)) == Use("ALTER DATABASE [AppData] SET  OFFLINE") && Script(TakeOffline(database, drop: true)) == Use("ALTER DATABASE [AppData] SET  OFFLINE WITH ROLLBACK IMMEDIATE")
            && Script(BringOnline(database)) == Use("ALTER DATABASE [AppData] SET  ONLINE") && ActionService.Plan(BringOnline(database), database).Single().Database == "master",
            "Take Offline and Bring Online script SSMS's ALTER DATABASE in master: SET OFFLINE, with ROLLBACK IMMEDIATE only when connections are dropped, and SET ONLINE");
        // D3c: Close Connections and Rename scripts SINGLE_USER, MODIFY NAME and the access back under the new name; its compensations
        // put the access back under the old name (the rename failed or was stopped) or the new one (only the restore did not complete).
        var close = Rename(database, "B") with { CloseConnections = true };
        check(ActionService.ScriptText(ActionService.Plan(close, database)) == Use("ALTER DATABASE [AppData] SET  SINGLE_USER WITH ROLLBACK IMMEDIATE") + Use("ALTER DATABASE [AppData] MODIFY NAME = [B]")
            + Use("ALTER DATABASE [B] SET  MULTI_USER") && ActionService.ScriptText(ActionService.Plan(close, database, new ActionService.DeleteFacts(false, 2))).EndsWith(Use("ALTER DATABASE [B] SET  RESTRICTED_USER"), StringComparison.Ordinal),
            "Close Connections and Rename scripts SINGLE_USER, MODIFY NAME and the original access under the new name, compensation left out");
        check(Script(Rename(database, "B")) == Use("ALTER DATABASE [AppData] MODIFY NAME = [B]") && Script(Rename(database, "B") with { CloseConnections = false }) == Use("ALTER DATABASE [AppData] MODIFY NAME = [B]")
            && ActionService.Plan(close, database, new ActionService.DeleteFacts(false, 1)).Select(plan => plan.Template).SequenceEqual([ActionTemplate.RenameDatabase]),
            "Rename When Free, and a database already in SINGLE_USER, run MODIFY NAME alone");
        var plan = ActionService.Plan(close, database);
        var compensations = plan.Where(statement => statement.Kind == StepKind.Compensation).ToList();
        bool Due(PlannedStatement statement, params string[] statuses) => statuses[statement.Undoes!.Value] == "done" && statement.When!(statuses);
        check(plan.Select(statement => (statement.Template, statement.Kind, string.Join("/", statement.Names))).SequenceEqual([
                (ActionTemplate.SetSingleUser, StepKind.Main, "AppData"), (ActionTemplate.RenameDatabase, StepKind.Main, "AppData/B"), (ActionTemplate.SetMultiUser, StepKind.Main, "B"),
                (ActionTemplate.SetMultiUser, StepKind.Compensation, "AppData"), (ActionTemplate.SetMultiUser, StepKind.Compensation, "B")])
            && compensations.All(statement => statement.Undoes == 0 && statement.Database == "master")
            && Due(compensations[0], "done", "failed", "skipped") && Due(compensations[0], "done", "cancelled", "skipped") && !Due(compensations[1], "done", "failed", "skipped")
            && !Due(compensations[0], "done", "done", "failed") && Due(compensations[1], "done", "done", "failed") && Due(compensations[1], "done", "done", "cancelled")
            && !Due(compensations[0], "failed", "skipped", "skipped") && !Due(compensations[1], "failed", "skipped", "skipped"),
            "the rename's compensations restore the access under the old name when MODIFY NAME did not complete, under the new one when only the restore did not, and never without SINGLE_USER");
        check(ActionService.StepTitle(ActionTemplate.SetOffline) == "Take database offline" && ActionService.StepTitle(ActionTemplate.SetOfflineRollback) == "Close connections and take database offline"
            && ActionService.StepTitle(ActionTemplate.SetOnline) == "Bring database online", "the state steps have their own titles");
    }

    private static ActionArgs DetachArgs(ObjectRefDto target, bool? drop, bool? statistics, bool? offline = null, DatabaseIdentityDto? identity = null) =>
        new("detach", Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), target, Identity: identity, DropConnections: drop, UpdateStatistics: statistics, DetachOffline: offline);
    private static ActionArgs TakeOffline(ObjectRefDto target, bool? drop, DatabaseIdentityDto? identity = null) =>
        new("takeOffline", Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), target, Identity: identity, DropConnections: drop);
    private static ActionArgs BringOnline(ObjectRefDto target, DatabaseIdentityDto? identity = null) => new("bringOnline", Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), target, Identity: identity);

    private static SqlException Sql(int number, byte level = 16, string message = "failed") => ConnectionFailureChecks.Sql(number, 1, level, "server", message);

    private static void Errors(Action<bool, string> check)
    {
        var expected = new Dictionary<int, string>
        {
            [1222] = "BLOCKED", [3702] = "IN_USE", [5030] = "IN_USE", [5061] = "IN_USE", [5070] = "IN_USE", [3726] = "DEPENDENTS", [3729] = "DEPENDENTS",
            [2714] = "NAME_IN_USE", [1801] = "NAME_IN_USE", [15335] = "NAME_IN_USE", [15225] = "NOT_FOUND", [229] = "PERMISSION_DENIED", [262] = "PERMISSION_DENIED",
            [297] = "PERMISSION_DENIED", [3701] = "PERMISSION_DENIED", [15247] = "PERMISSION_DENIED", [15151] = "PERMISSION_DENIED", [208] = "SQL_ERROR",
            // Database Properties (PR-B), and the file and filegroup numbers PR-B2's DDL will meet.
            [924] = "IN_USE", [5042] = "DEPENDENTS", [3709] = "DEPENDENTS", [1828] = "NAME_IN_USE", [5170] = "NAME_IN_USE", [15007] = "NOT_FOUND", [5058] = "NOT_SUPPORTED",
            // Take Offline and Bring Online (D3a).
            [5011] = "PERMISSION_DENIED",
            // New Login's password policy: Windows' (15114 to 15118) and SQL Server's own, which SQL Server on Linux applies (33062 too
            // short, 33063 too long, 33064 not complex enough; probed on SQL Server 2022 CU27 on Linux, where CI's 'zq' answered 33062).
            [15114] = "PASSWORD_POLICY", [15116] = "PASSWORD_POLICY", [15118] = "PASSWORD_POLICY", [33062] = "PASSWORD_POLICY", [33063] = "PASSWORD_POLICY",
            [33064] = "PASSWORD_POLICY",
            // Detach Database (D3b).
            [3703] = "IN_USE", [3707] = "NOT_SUPPORTED", [7983] = "PERMISSION_DENIED"
        };
        var wrong = expected.Where(pair => ActionErrors.CodeOf(Sql(pair.Key), null) != pair.Value).Select(pair => pair.Key).ToList();
        check(wrong.Count == 0 && ActionErrors.CodeOf(Sql(50000, 20), null) == "CONNECTION_LOST" && ActionErrors.Numbers.Keys.All(Catalog.ErrorCodes.Contains),
            "SQL Server's error numbers map onto the action error codes: " + string.Join(", ", wrong));
        var inUse = ActionErrors.FromSql(Catalog, Sql(3702), null, ddl: true, inUseAdvice: ActionErrors.CloseConnectionsAdvice);
        check(inUse is { Code: "IN_USE", Retryable: true } && inUse.Message.EndsWith("Close its connections, or check Close existing connections.", StringComparison.Ordinal)
            && ActionErrors.FromSql(Catalog, Sql(1222), null, ddl: false, inUseAdvice: null).Message == "Another session holds a lock on the object; try again when it finishes."
            && ActionErrors.FromSql(Catalog, Sql(50000, 16, new string('m', 5000)), null, ddl: true, inUseAdvice: null).Message.Length == ActionErrors.MaxMessage,
            "error values carry SQL Server's message (clipped to 2,048 characters) with advice for IN_USE");
    }

    /// <summary>D3c: Rename When Free waits on every version. Where SQL Server refuses MODIFY NAME at once as in use (5030) instead of
    /// queueing it, the rename tries again until it completes or Stop; any other failure, a single-user database's 924 included, ends it.</summary>
    private static async Task RenameWaitAsync(Action<bool, string> check)
    {
        var tries = 0;
        string Outcome(Exception? error) => error switch { null => "completed", SqlException sql => sql.Number.ToString(System.Globalization.CultureInfo.InvariantCulture), OperationCanceledException => "cancelled", _ => error.GetType().Name };
        async Task<string> Run(Func<Task> run, CancellationToken token)
        {
            try { await ActionService.WhileLockedAsync(run, ActionService.LockedByOthers, TimeSpan.FromMilliseconds(5), token); return Outcome(null); }
            catch (Exception error) { return Outcome(error); }
        }
        var freed = await Run(() => ++tries < 3 ? throw Sql(5030) : Task.CompletedTask, CancellationToken.None);
        var completed = tries;
        tries = 0;
        var single = await Run(() => { tries++; throw Sql(924); }, CancellationToken.None);
        var singleTries = tries;
        using var stop = new CancellationTokenSource(TimeSpan.FromMilliseconds(100));
        tries = 0;
        var stopped = await Run(() => { tries++; throw Sql(5030); }, stop.Token);
        // Stop that lands while the statement runs and SQL Server refuses it as in use (seen on a slow runner) is Stop too.
        using var during = new CancellationTokenSource();
        var stoppedDuring = await Run(() => { during.Cancel(); throw Sql(5030); }, during.Token);
        check(freed == "completed" && completed == 3 && single == "924" && singleTries == 1 && stopped == "cancelled" && tries > 1 && stoppedDuring == "cancelled"
            && !ActionService.LockedByOthers(new InvalidOperationException()),
            "Rename When Free tries MODIFY NAME again while SQL Server refuses it as in use (5030), until it completes or Stop; any other failure ends it (" + freed + " after " + completed + ", "
            + single + ", " + stopped + ", " + stoppedDuring + ")");
        check(ActionService.RenameInUseAdvice(0) == ActionService.RenameCloseAdvice && ActionService.RenameInUseAdvice(2) == ActionService.RenameCloseAdvice && ActionService.RenameInUseAdvice(1) == ActionService.SingleUserAdvice
            && ActionErrors.FromSql(Catalog, Sql(5030), null, ddl: true, ActionService.RenameInUseAdvice(0)).Message.EndsWith("Close its connections, or rename it when they disconnect.", StringComparison.Ordinal),
            "a database rename that fails in use advises closing the connections, or, for a single-user database, ending the session that holds it");
    }

    private static void Validation(Action<bool, string> check)
    {
        using var service = new ActionService(new FakeHost());
        var table = new ObjectRefDto("table", "AppData", "dbo", "Orders");
        var appData = new ObjectRefDto("database", Name: "AppData");
        string Refused(ActionArgs args)
        {
            try { service.Validate(args); return "accepted"; }
            catch (RequestException error) { return error.Code; }
        }
        var invalid = new (string Name, ActionArgs Args)[]
        {
            ("unknown action", Rename(table, "x") with { Action = "drop" }), ("connection id", Rename(table, "x") with { ConnectionId = "server-a" }),
            ("request id", Rename(table, "x") with { RequestId = "r1" }), ("ref shape", Rename(new ObjectRefDto("table", "AppData", Name: "Orders"), "x")),
            ("a kind without rename", Rename(new ObjectRefDto("synonym", "AppData", "dbo", "s"), "x")), ("U+0000", Rename(table, "a\0b")), ("129 units", Rename(table, new string('x', 129))),
            ("empty name", Rename(table, "")), ("the same name", Rename(table, "Orders")), ("delete flags on a rename", Rename(table, "x") with { CloseConnections = false }),
            ("a new name on a delete", Delete(table) with { NewName = "x" }), ("delete flags missing", Delete(table) with { DeleteHistory = null }),
            ("delete flags on a table", Delete(table, close: true)), ("a system database", Rename(new ObjectRefDto("database", Name: "master"), "x")),
            ("a system schema", Delete(new ObjectRefDto("view", "AppData", "sys", "objects"))), ("an aggregate's delete is offered by no row", Delete(new ObjectRefDto("synonym", "AppData", "dbo", "s"))),
            // Take Offline and Bring Online (takeOfflineSchema, bringOnlineSchema).
            ("take offline without dropConnections", TakeOffline(appData, null)), ("take offline of a table", TakeOffline(table, false)),
            ("take offline of master", TakeOffline(new ObjectRefDto("database", Name: "master"), false)), ("take offline of tempdb", BringOnline(new ObjectRefDto("database", Name: "tempdb"))),
            ("bring online with dropConnections", BringOnline(appData) with { DropConnections = true }), ("take offline with a new name", TakeOffline(appData, false) with { NewName = "x" }),
            ("take offline with delete flags", TakeOffline(appData, true) with { CloseConnections = true }), ("bring online with changes", BringOnline(appData) with { Changes = new() }),
            ("an identity of id 0", TakeOffline(appData, false, new(0, "2026-01-02T03:04:05.678"))), ("an identity without milliseconds", BringOnline(appData, new(5, "2026-01-02T03:04:05"))),
            ("an identity with a line break", BringOnline(appData, new(5, "2026-01-02T03:04:05.678\n"))), ("dropConnections on a rename", Rename(table, "x") with { DropConnections = false }),
            ("dropConnections on a delete", Delete(table) with { DropConnections = true }),
            ("dropConnections on properties", new ActionArgs("properties", Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), appData, CloseConnections: false,
                Changes: new(Options: new() { ["autoUpdateStatistics"] = "false" }), DropConnections: false))
        };
        var accepted = invalid.Where(item => Refused(item.Args) != "INVALID_PARAMS").Select(item => item.Name).ToList();
        check(accepted.Count == 0, "Validate refuses what zod refuses: " + string.Join(", ", accepted));
        check(Refused(Rename(table, " ")) == "accepted" && Refused(Rename(table, Long("q]'); --"))) == "accepted" && Refused(Rename(table, "orders")) == "accepted"
            && Refused(Delete(new ObjectRefDto("database", Name: "AppData"), close: true, history: true)) == "accepted", "hostile, single-space and case-changed names are accepted verbatim");
        var hostile = new ObjectRefDto("database", Name: Long("q]'); --"));
        check(Refused(TakeOffline(hostile, false)) == "accepted" && Refused(TakeOffline(appData, true, new(5, "2026-01-02T03:04:05.678"))) == "accepted"
            && Refused(BringOnline(hostile)) == "accepted" && Refused(BringOnline(appData, new(int.MaxValue, "2026-01-02T03:04:05.678"))) == "accepted"
            && Refused(new ActionArgs("properties", Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), appData, CloseConnections: false, Changes: new(Options: new() { ["autoUpdateStatistics"] = "false" }))) == "accepted",
            "Take Offline (with dropConnections) and Bring Online accept a user database's name verbatim and the identity a describe wrote");
        string DescribeRefused(ActionDescribeArgs args)
        {
            try { service.Validate(args); return "accepted"; }
            catch (RequestException error) { return error.Code; }
        }
        check(DescribeRefused(new(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), "databaseProperties", table)) == "INVALID_PARAMS"
            && DescribeRefused(new(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), "deleteObject", new ObjectRefDto("login", Name: "##MS_PolicyTsqlExecutionLogin##"))) == "INVALID_PARAMS"
            && DescribeRefused(new(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), "deleteObject", new ObjectRefDto("login", Name: "sa"))) == "accepted"
            && DescribeRefused(new(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), "deleteObject", table)) == "accepted"
            && DescribeRefused(new(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), "takeOffline", appData)) == "accepted"
            && DescribeRefused(new(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), "bringOnline", appData)) == "accepted"
            && DescribeRefused(new(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), "takeOffline", table)) == "INVALID_PARAMS"
            && DescribeRefused(new(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), "bringOnline", new ObjectRefDto("database", Name: "msdb"))) == "INVALID_PARAMS",
            "describe refuses unknown dialogs and kinds the dialog does not serve, SQL Server's own logins (sa's Delete Object opens to say why OK is greyed), SQL Server's own databases for Take Offline and Bring Online");
        var sql = new SqlService();
        check(sql.LaneOf("actions.execute") == RequestLane.Actions && sql.LaneOf("actions.describe") == RequestLane.Metadata && sql.LaneOf("actions.script") == RequestLane.Metadata
            && new[] { "actions.describe", "actions.script", "actions.execute" }.All(SqlService.MethodNames.Contains), "DDL runs on the actions lane, never holding a metadata slot; HELLO lists the three methods");
        sql.Dispose();
        // Azure SQL Database refuses EXEC [db].sys.sp_executesql (Msg 40515): tables.columns opens in the object's database there.
        var azure = Box2022 with { EngineEdition = 5 };
        check(SqlService.ColumnsPerDatabase(azure, force: false) && !SqlService.ColumnsPerDatabase(Box2022, force: false) && SqlService.ColumnsPerDatabase(Box2022, force: true)
            && SqlService.ColumnsText(true) == SqlService.ColumnsSql && !SqlService.ColumnsText(true).Contains("sp_executesql", StringComparison.Ordinal)
            && SqlService.ColumnsText(false).Contains("QUOTENAME(@db) + N'.sys.sp_executesql'", StringComparison.Ordinal),
            "Select Top's column read on Azure SQL Database runs in the object's database with no cross-database call; box servers use QUOTENAME(@db)'s sp_executesql");
    }

    /// <summary>Detach Database (D3b): its catalogue rows and rules, its plan and script, Validate, and its execute-time verdict.</summary>
    private static void Detach(Action<bool, string> check)
    {
        var database = new ObjectRefDto("database", Name: "AppData");
        check(Catalog.Allows("database", "", "detach") && !Catalog.Allows("database", "system", "detach") && !Catalog.Allows("database", "snapshot", "detach")
            && Catalog.Serves("detach", "box") && !Catalog.Serves("detach", "managedInstance") && !Catalog.Serves("detach", "cloud")
            && Catalog.DatabaseRefusal("detach", 0, 0, false, false) is null && Catalog.DatabaseRefusal("detach", 6, 1, true, false) is null
            && Catalog.DatabaseRefusal("detach", 1, 0, false, false) == "Wait until it finishes restoring or recovering."
            && Catalog.DatabaseRefusal("detach", 4, 0, false, false) == "Set the database to EMERGENCY with T-SQL before you detach it."
            && Catalog.DatabaseRefusal("detach", 3, 0, false, false) == Catalog.DatabaseRefusal("detach", 4, 0, false, false) && Catalog.DatabaseRefusal("detach", 5, 0, false, false) is null,
            "Detach is a user database's box-only action, greyed while restoring, recovering, copying, suspect or recovery pending, with the menu's reasons");
        // Drop Connections: SINGLE_USER first; a failure or Stop after it gives the database back the access it had.
        static string Shape(IEnumerable<PlannedStatement> plan) => string.Join(", ", plan.Select(item => item.Template + (item.Kind == StepKind.Main ? "" : " " + item.Kind + " of " + item.Undoes)
            + (item.Template == ActionTemplate.DetachDatabase ? " " + item.Names[1] : "")));
        check(Shape(ActionService.Plan(DetachArgs(database, true, false), database)) == "SetSingleUser, DetachDatabase true, SetMultiUser Compensation of 0"
            && Shape(ActionService.Plan(DetachArgs(database, true, true), database, new ActionService.DeleteFacts(false, 2))) == "SetSingleUser, DetachDatabase false, SetRestrictedUser Compensation of 0"
            && Shape(ActionService.Plan(DetachArgs(database, true, false), database, new ActionService.DeleteFacts(false, 1))) == "SetSingleUser, DetachDatabase true"
            && Shape(ActionService.Plan(DetachArgs(database, false, true), database)) == "DetachDatabase false"
            && ActionService.Plan(DetachArgs(database, true, false), database).All(item => item.Database == "master" && item.Names[0] == "AppData"),
            "Detach plans SINGLE_USER with Drop Connections, then sp_detach_db with @skipchecks from Update Statistics, and restores multi-user or restricted access after a failure");
        string Use(string statement) => "USE [master]" + NL + "GO" + NL + statement + NL + "GO" + NL;
        check(ActionService.ScriptText(ActionService.Plan(DetachArgs(database, true, true), database)) == Use("ALTER DATABASE [AppData] SET  SINGLE_USER WITH ROLLBACK IMMEDIATE")
                + Use("EXEC master.dbo.sp_detach_db @dbname = N'AppData', @skipchecks = 'false'")
            && ActionService.ScriptText(ActionService.Plan(DetachArgs(database, false, false), database)) == Use("EXEC master.dbo.sp_detach_db @dbname = N'AppData', @skipchecks = 'true'")
            && ActionService.DetachSkipChecksComment.StartsWith("-- ", StringComparison.Ordinal) && ActionService.DetachSkipChecksComment.EndsWith(NL, StringComparison.Ordinal)
            && SqlScript.Parse(ActionService.DetachSkipChecksComment + Use("SELECT 1")).Count == 2,
            "Detach scripts SSMS's statements, @skipchecks 'true' when Update Statistics is cleared (with a one-line comment), never the compensation");
        check(ActionService.StepTitle(ActionTemplate.SetSingleUser) == "Close existing connections" && ActionService.StepTitle(ActionTemplate.DetachDatabase) == "Detach the database"
            && ActionService.StepTitle(ActionTemplate.SetMultiUser) == "Restore multi-user access" && ActionService.StepTitle(ActionTemplate.SetRestrictedUser) == "Restore restricted user access",
            "Detach's steps have the shared templates' titles (src/shared/actions/schema.ts detachDatabaseStepTitle names the detach)");

        using var service = new ActionService(new FakeHost());
        var table = new ObjectRefDto("table", "AppData", "dbo", "Orders");
        string Refused(ActionArgs args, bool script = false)
        {
            try { service.Validate(args, script); return "accepted"; }
            catch (RequestException error) { return error.Code; }
        }
        var invalid = new (string Name, ActionArgs Args)[]
        {
            ("detach without dropConnections", DetachArgs(database, null, false)), ("detach without updateStatistics", DetachArgs(database, true, null)),
            ("detach of a table", DetachArgs(table, false, false)), ("detach of master", DetachArgs(new ObjectRefDto("database", Name: "master"), false, false)),
            ("detach of model", DetachArgs(new ObjectRefDto("database", Name: "model"), true, true)), ("detach with a new name", DetachArgs(database, false, false) with { NewName = "x" }),
            ("detach with closeConnections", DetachArgs(database, false, false) with { CloseConnections = true }), ("detach with deleteHistory", DetachArgs(database, false, false) with { DeleteHistory = false }),
            ("detach with changes", DetachArgs(database, false, false) with { Changes = new() }), ("detach with an identity of id 0", DetachArgs(database, false, false, identity: new(0, "2026-01-02T03:04:05.678"))),
            ("updateStatistics on take offline", TakeOffline(database, false) with { UpdateStatistics = false }), ("detachOffline on bring online", BringOnline(database) with { DetachOffline = true }),
            ("updateStatistics on a delete", Delete(database) with { UpdateStatistics = true }), ("detachOffline on a rename", Rename(database, "x") with { DetachOffline = false }),
            ("updateStatistics on properties", new ActionArgs("properties", Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), database, CloseConnections: false,
                Changes: new(Options: new() { ["autoUpdateStatistics"] = "false" }), UpdateStatistics: true))
        };
        var accepted = invalid.Where(item => Refused(item.Args) != "INVALID_PARAMS").Select(item => item.Name).ToList();
        check(accepted.Count == 0, "Validate refuses what detachSchema refuses, and the detach members on every other action: " + string.Join(", ", accepted));
        var hostile = new ObjectRefDto("database", Name: Long("q]'); --"));
        check(Refused(DetachArgs(hostile, true, true)) == "accepted" && Refused(DetachArgs(database, false, false, offline: true, identity: new(5, "2026-01-02T03:04:05.678"))) == "accepted"
            && Refused(DetachArgs(database, true, false), script: true) == "accepted",
            "Detach accepts a user database's name verbatim, Detach while offline and the identity a describe wrote, for execute and script");
        string DescribeRefused(ObjectRefDto target)
        {
            try { service.Validate(new ActionDescribeArgs(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), "detachDatabase", target)); return "accepted"; }
            catch (RequestException error) { return error.Code; }
        }
        check(DescribeRefused(database) == "accepted" && DescribeRefused(new ObjectRefDto("database", Name: "msdb")) == "INVALID_PARAMS" && DescribeRefused(table) == "INVALID_PARAMS",
            "Detach Database's describe serves user databases only");

        // The execute-time verdict over a preflight row (StateRefusal, DetachBlockers, critic A27).
        ActionSubject Subject(Dictionary<string, object?> changes, string subtype = "")
        {
            var values = new Dictionary<string, object?>
            {
                ["database_id"] = 7, ["create_date"] = new DateTime(2026, 1, 2, 3, 4, 5, 678), ["state"] = 0, ["user_access"] = 0, ["is_read_only"] = false, ["is_in_standby"] = false,
                ["is_system"] = false, ["replicated"] = false, ["has_snapshots"] = false, ["in_availability_group"] = false, ["mirrored"] = false, ["can_alter_state"] = true
            };
            foreach (var (key, value) in changes) values[key] = value;
            return new(database, "AppData", "Database", subtype, new Varia.Backend.Scripting.ScriptPreflight.Row(values), [], false);
        }
        string Verdict(Dictionary<string, object?> changes, bool linux = false, bool offline = false, DatabaseIdentityDto? read = null, string subtype = "", bool statistics = false,
            ActionError? permission = null) =>
            service.DetachRefusal(Subject(changes, subtype), read, linux, offline, statistics, permission) is { } error ? error.Code + ": " + error.Message : "runs";
        var offlineMessage = "NOT_SUPPORTED: The database AppData is offline. Bring it online first, or check Detach while offline.";
        var denied = new ActionError("PERMISSION_DENIED", "You do not have permission to detach AppData: that needs its db_owner role, or sysadmin.", false);
        check(Verdict([]) == "runs" && Verdict([], read: new(7, "2026-01-02T03:04:05.678")) == "runs" && Verdict([], read: new(8, "2026-01-02T03:04:05.678")).StartsWith("NOT_FOUND: ", StringComparison.Ordinal)
            && Verdict(new() { ["state"] = 6 }) == offlineMessage && Verdict(new() { ["state"] = 6 }, offline: true) == "runs" && Verdict(new() { ["state"] = 6 }, linux: true) == "runs"
            && Verdict(new() { ["has_snapshots"] = true }) == "NOT_SUPPORTED: A database snapshot of this database exists; drop the snapshot before you detach it."
            && Verdict(new() { ["replicated"] = true }).StartsWith("NOT_SUPPORTED: The database is used for replication", StringComparison.Ordinal)
            && Verdict(new() { ["in_availability_group"] = true }).StartsWith("NOT_SUPPORTED: The database is in an availability group", StringComparison.Ordinal)
            && Verdict(new() { ["mirrored"] = true }).StartsWith("NOT_SUPPORTED: The database is mirrored", StringComparison.Ordinal)
            && Verdict(new() { ["is_system"] = true }) == "NOT_SUPPORTED: AppData belongs to SQL Server and cannot be detached."
            && Verdict([], subtype: "snapshot") == "NOT_SUPPORTED: A database snapshot cannot be detached."
            && Verdict(new() { ["state"] = 1 }) == "NOT_SUPPORTED: Wait until it finishes restoring or recovering."
            && Verdict([], permission: denied) == "PERMISSION_DENIED: " + denied.Message && Verdict(new() { ["has_snapshots"] = true }, permission: denied).StartsWith("PERMISSION_DENIED: ", StringComparison.Ordinal),
            "Detach refuses a replaced database, what SQL Server refuses (replication, a snapshot, an availability group, mirroring), the menu's states, no permission, and an offline database on Windows without Detach while offline");
        // DBCC DETACHDB needs db_owner or sysadmin, which SET OFFLINE's ALTER (can_alter_state) does not imply: Detach's own permission decides.
        check(Verdict(new() { ["can_alter_state"] = false }) == "runs" && Verdict(new() { ["can_alter_state"] = true }, permission: denied) == "PERMISSION_DENIED: " + denied.Message,
            "Detach's permission is db_owner or sysadmin (DetachFactsAsync), not Take Offline's ALTER on the database");
        // EMERGENCY on Windows leaves files as an offline detach does (probed): it waits for its own box; Linux only notes it.
        check(Verdict(new() { ["state"] = 5 }) == "NOT_SUPPORTED: The database AppData is in EMERGENCY mode. Bring it online first, or check Detach anyway."
            && Verdict(new() { ["state"] = 5 }, offline: true) == "runs" && Verdict(new() { ["state"] = 5 }, linux: true) == "runs"
            && service.DetachConfirmLabel(6) == "Detach while offline" && service.DetachConfirmLabel(5) == "Detach anyway",
            "Detach of a database in EMERGENCY on Windows waits for Detach anyway, as an offline one waits for Detach while offline (critic A27)");
        // sp_updatestats cannot run on a read-only, standby, EMERGENCY or offline database: 15635 (and the detach happens anyway) or 942.
        check(Verdict([], statistics: true) == "runs" && Verdict(new() { ["is_read_only"] = true }, statistics: true) == "NOT_SUPPORTED: Update Statistics cannot run on a read-only or standby database; clear it."
            && Verdict(new() { ["is_in_standby"] = true }, statistics: true) == Verdict(new() { ["is_read_only"] = true }, statistics: true) && Verdict(new() { ["is_read_only"] = true }) == "runs"
            && Verdict(new() { ["state"] = 6 }, offline: true, statistics: true) == "NOT_SUPPORTED: Update Statistics cannot run while the database is offline; clear it."
            && Verdict(new() { ["state"] = 5 }, linux: true, statistics: true) == "NOT_SUPPORTED: Update Statistics cannot run while the database is in EMERGENCY mode; clear it.",
            "Detach refuses Update Statistics on a database sp_updatestats cannot run in, and runs with it cleared");
        string Notes(Dictionary<string, object?> changes, bool linux, bool hidden = false) => string.Join(" | ", service.DetachNotes(Subject(changes).Row, linux, hidden).Select(note => (note.Blocking ? "!" : "") + note.Text));
        check(Notes([], linux: false) == "" && Notes([], linux: true) == "" && Notes(new() { ["state"] = 6 }, linux: true) == ActionService.DetachOfflineNote
            && Notes(new() { ["state"] = 5 }, linux: true) == "This database is in EMERGENCY mode. On Windows, SQL Server may restrict access to its files when it is detached in this state; bring it online first if you will attach it again."
            && Notes(new() { ["state"] = 6 }, linux: false) == "" && Notes(new() { ["sql_login"] = true }, linux: false) == ActionService.DetachSqlLoginNote
            && Notes(new() { ["sql_login"] = true }, linux: true) == "" && Notes([], linux: false, hidden: true) == ActionService.DetachFilesHiddenNote,
            "Detach notes a database that is not online on Linux, a SQL Server login on Windows (its files open only to the service account) and files SQL Server did not show, never as blocking");
        check(ActionService.DetachBlockers(Subject([]).Row).Count == 0 && ActionService.DetachBlockers(Subject(new() { ["has_snapshots"] = true, ["mirrored"] = true }).Row) is [{ Blocking: true }, { Blocking: true }],
            "the describe's blocking warnings are the execute's refusals");
    }

    internal sealed class FakeHost(int edition = 3) : IActionHost
    {
        public int Connections;
        public List<string> Cleared { get; } = [];
        public ServerProfile Profile(string connectionId) => Box2022 with { EngineEdition = edition };
        public SqlConnection Connection(string connectionId)
        {
            Interlocked.Increment(ref Connections);
            return new SqlConnection("Data Source=tcp:127.0.0.1,1;Connect Timeout=1;Pooling=false;Encrypt=false");
        }
        public Task OpenAsync(SqlConnection connection, CancellationToken token) => connection.OpenAsync(token);
        public bool ClearPoolsFor(string connectionId, string database) { Cleared.Add(database); return true; }
        public bool FreeDatabase(string connectionId, string database) { Cleared.Add("free " + database); return true; }
        public IReadOnlySet<int> PoolSessions(string connectionId) => new HashSet<int>();
        public IReadOnlyList<string> SameServer(string connectionId) => [connectionId];
        public void DatabaseChanged(string connectionId, string database, string? newName) => Cleared.Add(database + " -> " + newName);
    }

    private static async Task ServiceAsync(Action<bool, string> check)
    {
        var cloudHost = new FakeHost(5);
        using var cloud = new ActionService(cloudHost);
        var table = new ObjectRefDto("table", "AppData", "dbo", "Orders");
        var describe = await cloud.DescribeAsync(new(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), "deleteObject", table), CancellationToken.None);
        var script = await cloud.ScriptAsync(Delete(table), CancellationToken.None);
        var execute = await cloud.ExecuteAsync(Rename(table, "Orders2"), CancellationToken.None);
        check(describe.Error?.Code == "NOT_SUPPORTED" && script.Error?.Code == "NOT_SUPPORTED" && execute.Error?.Code == "NOT_SUPPORTED" && execute.Steps.Count == 0
            && execute.Error.Message == ActionService.CloudMessage && cloudHost.Connections == 0 && cloud.RunningCount == 0, "Azure SQL Database answers NOT_SUPPORTED before any connection opens");
        var managedHost = new FakeHost(8);
        using var managed = new ActionService(managedHost);
        var database = new ObjectRefDto("database", Name: "AppData");
        var single = await managed.ExecuteAsync(Delete(database, close: true), CancellationToken.None);
        var plain = await managed.ExecuteAsync(Delete(database), CancellationToken.None);
        check(single.Error is { Code: "NOT_SUPPORTED" } && single.Error.Message == ActionService.ManagedInstanceCloseNote && single.Steps.Count == 0 && managedHost.Connections == 1
            && plain.Error?.Code != "NOT_SUPPORTED" && managed.RunningCount == 0,
            "on Managed Instance, Delete with Close existing connections answers NOT_SUPPORTED before any connection opens; without it, Delete runs");
        var host = new FakeHost();
        using var service = new ActionService(host);
        var unreachable = await service.ExecuteAsync(Rename(table, "Orders2"), CancellationToken.None);
        check(host.Connections == 1 && host.Cleared.Count == 0 && service.RunningCount == 0 && service.ActiveJobs == 0, "a failed open answers and frees the request, its gate and its job");
        _ = unreachable;
        var id = Guid.NewGuid().ToString();
        using var held = new CancellationTokenSource();
        var first = service.DescribeAsync(new(Guid.NewGuid().ToString(), id, "deleteObject", table), held.Token);
        string second;
        try { await service.DescribeAsync(new(Guid.NewGuid().ToString(), id, "deleteObject", table), CancellationToken.None); second = "accepted"; }
        catch (RequestException error) { second = error.Code; }
        held.Cancel();
        try { await first; } catch (OperationCanceledException) { } catch (RequestException) { }
        check(second == "DUPLICATE_REQUEST", "a request id runs once at a time");
        // Managed Instance cannot run sp_detach_db: refused before any connection opens (critic A1).
        var detachHost = new FakeHost(8);
        using var detachManaged = new ActionService(detachHost);
        var appData = new ObjectRefDto("database", Name: "AppData");
        var detached = await detachManaged.ExecuteAsync(DetachArgs(appData, true, false), CancellationToken.None);
        var detachDescribe = await detachManaged.DescribeAsync(new(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), "detachDatabase", appData), CancellationToken.None);
        check(detached.Error?.Code == "NOT_SUPPORTED" && detached.Error.Message == ActionService.ManagedInstanceMessage && detachDescribe.Error?.Code == "NOT_SUPPORTED" && detachHost.Connections == 0,
            "Managed Instance answers Detach NOT_SUPPORTED before any connection opens");
    }
}
