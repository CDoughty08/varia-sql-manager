using System.Globalization;
using System.Text.RegularExpressions;
using Varia.Backend.Explorer;
using Varia.Backend.Scripting;

namespace Varia.Backend.Actions;

/// <summary>The statements an action runs: DROP TABLE, VIEW, PROCEDURE or FUNCTION, sp_rename, ALTER DATABASE … MODIFY NAME,
/// SET SINGLE_USER, DROP DATABASE and msdb's backup history cleanup; and the shared templates later actions plan (critic
/// A21): SET MULTI_USER and RESTRICTED_USER (which also restore a database's access after a failed or stopped step),
/// sp_detach_db, ALTER LOGIN … DISABLE and ENABLE, DENY and GRANT CONNECT SQL, and DROP USER; New Login's ALTER SERVER ROLE …
/// ADD MEMBER (its CREATE LOGIN is LoginSql's builder, which takes the password) and its User Mapping's CREATE USER … FOR LOGIN,
/// ALTER USER … WITH DEFAULT_SCHEMA, CREATE SCHEMA … AUTHORIZATION and ALTER ROLE … ADD MEMBER, each in the mapped database; then
/// Take Offline's SET OFFLINE (plain, or WITH ROLLBACK IMMEDIATE) and Bring Online's SET ONLINE; and Restore Database's cleanup,
/// which drops only the RESTORING database the restore created (critic A11a).</summary>
internal enum ActionTemplate
{
    DropTable, DropView, DropProcedure, DropFunction, RenameObject, RenameDatabase, SetSingleUser, DropDatabase, DeleteBackupHistory,
    SetMultiUser, SetRestrictedUser, DetachDatabase, DisableLogin, EnableLogin, DenyConnect, GrantConnect, DropUser,
    AddServerRoleMember, SetOffline, SetOfflineRollback, SetOnline, DropRestoring, CreateUserForLogin, AlterUserSchema, CreateSchemaFor, AddRoleMember
}

/// <summary>Where a step runs in the plan (critic A4): main steps in order; a compensation undoes the main step <c>Undoes</c>
/// names (its index among the main steps) once that step completed and a later one failed or was stopped; a cleanup runs after
/// any failure or Stop. Both run under a fresh token bounded by the action's catalogue budget, and only when <c>When</c> (over
/// the main steps' statuses) allows it.</summary>
internal enum StepKind { Main, Compensation, Cleanup }

/// <summary>One statement of an action: its template, the database it runs in, and the names it takes, verbatim (a
/// schema-scoped object's schema and name, then a new name; a database's name, then a new name; sp_detach_db's @skipchecks
/// as true or false, from <see cref="ActionSql.Detach"/>; a partly restored database's name and its database_id as decimal digits,
/// from <see cref="ActionSql.DropRestoring"/>). Kind, Undoes and When place it in runner v2 (StepKind).</summary>
internal sealed record PlannedStatement(ActionTemplate Template, string Database, IReadOnlyList<string> Names, StepKind Kind = StepKind.Main, int? Undoes = null,
    Func<IReadOnlyList<string>, bool>? When = null);

/// <summary>All SQL of the action path, as constant text per template, kind and version band. DDL is built by SQL Server
/// from that text: names reach it only as nvarchar(128) parameters (@db, @p1…) passed through QUOTENAME, or as a
/// procedure's own argument, so no name can change what a statement does. <see cref="ScriptText"/> renders the same
/// statement as SSMS writes it, for the Script button; the live checks prove both agree for every hostile name.</summary>
internal static partial class ActionSql
{
    public static string NL => ScriptFormatter.NewLine;
    /// <summary>The action connection's settings. DDL waits for locks as SSMS does (no LOCK_TIMEOUT); Stop cancels it.</summary>
    public const string Prologue = "SET NOCOUNT ON; SET XACT_ABORT ON; SET DEADLOCK_PRIORITY NORMAL; SET ANSI_NULLS ON; SET QUOTED_IDENTIFIER ON; SET ANSI_PADDING ON; "
        + "SET ANSI_WARNINGS ON; SET CONCAT_NULL_YIELDS_NULL ON; SET ARITHABORT ON; SET TRANSACTION ISOLATION LEVEL READ COMMITTED;";
    /// <summary>Describe and script requests only read, and give up behind another session's DDL after 10 s (BLOCKED).</summary>
    public const string ReadPrologue = Prologue + " SET LOCK_TIMEOUT 10000;";
    /// <summary>Execute requests restore the default after a describe on the same connection could have set it.</summary>
    public const string ExecutePrologue = Prologue + " SET LOCK_TIMEOUT -1;";

    public const string Declarations = "@schema sysname, @name sysname, @new sysname, @take int";
    /// <summary>Runs a catalog statement in the object's database, which reaches T-SQL only through QUOTENAME.</summary>
    public const string ModuleCall = "DECLARE @module nvarchar(300) = QUOTENAME(@db) + N'.sys.sp_executesql';\n"
        + "EXEC @module @stmt, @decl, @schema = @schema, @name = @name, @new = @new, @take = @take;";
    /// <summary>Every DDL batch stops before running a statement a NULL from QUOTENAME (a name over 128 units) emptied.</summary>
    internal const string Guard = "IF @stmt IS NULL THROW 50000, N'A name could not be quoted.', 1;\n";

    public static string Quote(string name) => ScriptFormatter.Quote(name);
    private static string Literal(string value) => "N'" + value.Replace("'", "''", StringComparison.Ordinal) + "'";

    public static int ParameterCount(ActionTemplate template) => template switch
    {
        ActionTemplate.DropTable or ActionTemplate.DropView or ActionTemplate.DropProcedure or ActionTemplate.DropFunction or ActionTemplate.RenameDatabase or ActionTemplate.DetachDatabase
            or ActionTemplate.AddServerRoleMember or ActionTemplate.DropRestoring or ActionTemplate.CreateUserForLogin or ActionTemplate.AlterUserSchema
            or ActionTemplate.CreateSchemaFor or ActionTemplate.AddRoleMember => 2,
        ActionTemplate.RenameObject => 3,
        _ => 1
    };

    private static string DropKeyword(ActionTemplate template) => template switch
    {
        ActionTemplate.DropTable => "TABLE",
        ActionTemplate.DropView => "VIEW",
        ActionTemplate.DropProcedure => "PROCEDURE",
        ActionTemplate.DropFunction => "FUNCTION",
        _ => throw new InvalidOperationException("Not a DROP of a schema object: " + template)
    };

    /// <summary>The template a kind's DROP uses.</summary>
    public static ActionTemplate DropOf(string kind) => kind switch
    {
        "table" => ActionTemplate.DropTable,
        "view" => ActionTemplate.DropView,
        "procedure" => ActionTemplate.DropProcedure,
        "function" => ActionTemplate.DropFunction,
        _ => throw new InvalidOperationException("No DROP for " + kind)
    };

    /// <summary>sp_detach_db's @skipchecks from Update Statistics (critic A21): 'false' runs UPDATE STATISTICS first, as SSMS's
    /// Detach does when the box is checked; 'true' skips it. The only values the template may carry (Checked).</summary>
    public static PlannedStatement Detach(string database, bool updateStatistics, StepKind kind = StepKind.Main, int? undoes = null) =>
        new(ActionTemplate.DetachDatabase, "master", [database, updateStatistics ? "false" : "true"], kind, undoes);

    /// <summary>Restore Database's cleanup (critic A11a): drop the database named <paramref name="database"/> only while it is still the
    /// RESTORING database with <paramref name="id"/>, which the restore created (its id was absent at the preflight). The batch checks
    /// both itself, right before the DROP, so a database that took the name or left RESTORING since is never dropped.</summary>
    public static PlannedStatement DropRestoring(string database, int id, StepKind kind = StepKind.Cleanup) =>
        new(ActionTemplate.DropRestoring, "master", [database, id.ToString(CultureInfo.InvariantCulture)], kind);

    /// <summary>The plan, or a throw when its names do not fit its template: the wrong count, an @skipchecks that is not true or
    /// false, or a database id that is not a positive int in decimal digits. Every statement passes it before it runs or is scripted.</summary>
    public static PlannedStatement Checked(PlannedStatement plan)
    {
        if (plan.Names.Count != ParameterCount(plan.Template)) throw new InvalidOperationException("The plan has the wrong number of names for " + plan.Template + ".");
        if (plan.Template == ActionTemplate.DetachDatabase && plan.Names[1] is not ("true" or "false")) throw new InvalidOperationException("@skipchecks is true or false.");
        if (plan.Template == ActionTemplate.DropRestoring && !(plan.Names[1].Length is > 0 and <= 10 && plan.Names[1].All(char.IsAsciiDigit) && plan.Names[1][0] != '0'
            && long.Parse(plan.Names[1], CultureInfo.InvariantCulture) <= int.MaxValue)) throw new InvalidOperationException("A database id is a positive int.");
        return plan;
    }

    /// <summary>The statement itself as SSMS writes it, names quoted by C#'s QUOTENAME.</summary>
    public static string Statement(PlannedStatement plan)
    {
        var names = plan.Names;
        return plan.Template switch
        {
            ActionTemplate.DropTable or ActionTemplate.DropView or ActionTemplate.DropProcedure or ActionTemplate.DropFunction => "DROP " + DropKeyword(plan.Template) + " " + Quote(names[0]) + "." + Quote(names[1]),
            ActionTemplate.RenameObject => "EXEC sys.sp_rename @objname = " + Literal(Quote(names[0]) + "." + Quote(names[1])) + ", @newname = " + Literal(names[2]) + ", @objtype = N'OBJECT'",
            ActionTemplate.RenameDatabase => "ALTER DATABASE " + Quote(names[0]) + " MODIFY NAME = " + Quote(names[1]),
            ActionTemplate.SetSingleUser => "ALTER DATABASE " + Quote(names[0]) + " SET  SINGLE_USER WITH ROLLBACK IMMEDIATE",
            ActionTemplate.DropDatabase => "DROP DATABASE " + Quote(names[0]),
            ActionTemplate.DeleteBackupHistory => "EXEC msdb.dbo.sp_delete_database_backuphistory @database_name = " + Literal(names[0]),
            // SMO writes two spaces after SET (probed by D1 and D3), and @skipchecks as a plain string.
            ActionTemplate.SetMultiUser => "ALTER DATABASE " + Quote(names[0]) + " SET  MULTI_USER",
            ActionTemplate.SetRestrictedUser => "ALTER DATABASE " + Quote(names[0]) + " SET  RESTRICTED_USER",
            ActionTemplate.DetachDatabase => "EXEC master.dbo.sp_detach_db @dbname = " + Literal(names[0]) + ", @skipchecks = '" + Checked(plan).Names[1] + "'",
            ActionTemplate.DisableLogin => "ALTER LOGIN " + Quote(names[0]) + " DISABLE",
            ActionTemplate.EnableLogin => "ALTER LOGIN " + Quote(names[0]) + " ENABLE",
            ActionTemplate.DenyConnect => "DENY CONNECT SQL TO " + Quote(names[0]),
            ActionTemplate.GrantConnect => "GRANT CONNECT SQL TO " + Quote(names[0]),
            ActionTemplate.DropUser => "DROP USER " + Quote(names[0]),
            // The role, then the member, as SMO writes it (captured by D2).
            ActionTemplate.AddServerRoleMember => "ALTER SERVER ROLE " + Quote(names[0]) + " ADD MEMBER " + Quote(names[1]),
            // SMO's capture of SSMS's Take Offline and Bring Online (probed by D3).
            ActionTemplate.SetOffline => "ALTER DATABASE " + Quote(names[0]) + " SET  OFFLINE",
            ActionTemplate.SetOfflineRollback => "ALTER DATABASE " + Quote(names[0]) + " SET  OFFLINE WITH ROLLBACK IMMEDIATE",
            ActionTemplate.SetOnline => "ALTER DATABASE " + Quote(names[0]) + " SET  ONLINE",
            ActionTemplate.DropRestoring => "DROP DATABASE " + Quote(Checked(plan).Names[0]),
            // User Mapping, each in its database, as SMO writes them (captured by D2): the user, then the login, schema or member.
            ActionTemplate.CreateUserForLogin => "CREATE USER " + Quote(names[0]) + " FOR LOGIN " + Quote(names[1]),
            ActionTemplate.AlterUserSchema => "ALTER USER " + Quote(names[0]) + " WITH DEFAULT_SCHEMA=" + Quote(names[1]),
            ActionTemplate.CreateSchemaFor => "CREATE SCHEMA " + Quote(names[0]) + " AUTHORIZATION " + Quote(names[1]),
            ActionTemplate.AddRoleMember => "ALTER ROLE " + Quote(names[0]) + " ADD MEMBER " + Quote(names[1]),
            _ => throw new InvalidOperationException("Unknown template " + plan.Template)
        };
    }

    /// <summary>SSMS's script of one statement: USE and GO around it (no USE before msdb's procedure, which names its database).</summary>
    public static string ScriptText(PlannedStatement plan) =>
        (plan.Template == ActionTemplate.DeleteBackupHistory ? "" : "USE " + Quote(plan.Database) + NL + "GO" + NL) + Statement(plan) + NL + "GO" + NL;

    /// <summary>The batch that runs a statement: SQL Server builds it from parameters (@db, then @p1… in the plan's name order).
    /// <paramref name="dryRun"/> (the live checks only, never the wire) selects what would run instead of running it.</summary>
    public static string Executable(ActionTemplate template, bool dryRun = false)
    {
        string Run(string build) => build + Guard + (dryRun ? "SELECT @stmt AS stmt;" : "DECLARE @module nvarchar(300) = QUOTENAME(@db) + N'.sys.sp_executesql';\nEXEC @module @stmt;");
        return template switch
        {
            ActionTemplate.DropTable or ActionTemplate.DropView or ActionTemplate.DropProcedure or ActionTemplate.DropFunction =>
                Run("DECLARE @stmt nvarchar(max) = N'DROP " + DropKeyword(template) + " ' + QUOTENAME(@p1) + N'.' + QUOTENAME(@p2);\n"),
            // sp_rename parses @objname itself; the new name is its own argument, never part of any text.
            ActionTemplate.RenameObject => "DECLARE @stmt nvarchar(1035) = QUOTENAME(@p1) + N'.' + QUOTENAME(@p2);\n" + Guard
                + (dryRun ? "SELECT @stmt AS stmt, @p3 AS new_name;" : "DECLARE @rename nvarchar(300) = QUOTENAME(@db) + N'.sys.sp_rename';\nEXEC @rename @objname = @stmt, @newname = @p3, @objtype = N'OBJECT';"),
            ActionTemplate.RenameDatabase => Run("DECLARE @stmt nvarchar(max) = N'ALTER DATABASE ' + QUOTENAME(@p1) + N' MODIFY NAME = ' + QUOTENAME(@p2);\n"),
            ActionTemplate.SetSingleUser => Run("DECLARE @stmt nvarchar(max) = N'ALTER DATABASE ' + QUOTENAME(@p1) + N' SET  SINGLE_USER WITH ROLLBACK IMMEDIATE';\n"),
            ActionTemplate.DropDatabase => Run("DECLARE @stmt nvarchar(max) = N'DROP DATABASE ' + QUOTENAME(@p1);\n"),
            ActionTemplate.DeleteBackupHistory => dryRun ? "SELECT @p1 AS database_name;" : "EXEC msdb.dbo.sp_delete_database_backuphistory @database_name = @p1;",
            ActionTemplate.SetMultiUser => Run("DECLARE @stmt nvarchar(max) = N'ALTER DATABASE ' + QUOTENAME(@p1) + N' SET  MULTI_USER';\n"),
            ActionTemplate.SetRestrictedUser => Run("DECLARE @stmt nvarchar(max) = N'ALTER DATABASE ' + QUOTENAME(@p1) + N' SET  RESTRICTED_USER';\n"),
            // sp_detach_db takes the name as its own argument (never text), and @skipchecks only as true or false (Checked).
            ActionTemplate.DetachDatabase => dryRun ? "SELECT @p1 AS database_name, @p2 AS skipchecks;" : "EXEC master.dbo.sp_detach_db @dbname = @p1, @skipchecks = @p2;",
            ActionTemplate.DisableLogin => Run("DECLARE @stmt nvarchar(max) = N'ALTER LOGIN ' + QUOTENAME(@p1) + N' DISABLE';\n"),
            ActionTemplate.EnableLogin => Run("DECLARE @stmt nvarchar(max) = N'ALTER LOGIN ' + QUOTENAME(@p1) + N' ENABLE';\n"),
            ActionTemplate.DenyConnect => Run("DECLARE @stmt nvarchar(max) = N'DENY CONNECT SQL TO ' + QUOTENAME(@p1);\n"),
            ActionTemplate.GrantConnect => Run("DECLARE @stmt nvarchar(max) = N'GRANT CONNECT SQL TO ' + QUOTENAME(@p1);\n"),
            ActionTemplate.DropUser => Run("DECLARE @stmt nvarchar(max) = N'DROP USER ' + QUOTENAME(@p1);\n"),
            ActionTemplate.AddServerRoleMember => Run("DECLARE @stmt nvarchar(max) = N'ALTER SERVER ROLE ' + QUOTENAME(@p1) + N' ADD MEMBER ' + QUOTENAME(@p2);\n"),
            ActionTemplate.SetOffline => Run("DECLARE @stmt nvarchar(max) = N'ALTER DATABASE ' + QUOTENAME(@p1) + N' SET  OFFLINE';\n"),
            ActionTemplate.SetOfflineRollback => Run("DECLARE @stmt nvarchar(max) = N'ALTER DATABASE ' + QUOTENAME(@p1) + N' SET  OFFLINE WITH ROLLBACK IMMEDIATE';\n"),
            ActionTemplate.SetOnline => Run("DECLARE @stmt nvarchar(max) = N'ALTER DATABASE ' + QUOTENAME(@p1) + N' SET  ONLINE';\n"),
            // The name is compared, never run, and the id converted: neither reaches the statement except through QUOTENAME. The dry
            // run (live checks) selects the statement without the check, which no scratch database is in the state to pass.
            ActionTemplate.DropRestoring => Run("DECLARE @stmt nvarchar(max) = N'DROP DATABASE ' + QUOTENAME(@p1);\n"
                + (dryRun ? "" : "IF NOT EXISTS (SELECT 1 FROM sys.databases AS d WHERE d.name = @p1 AND d.state = 1 AND d.database_id = CONVERT(int, @p2)) THROW 50000, " + NotRestoring + ", 1;\n")),
            ActionTemplate.CreateUserForLogin => Run("DECLARE @stmt nvarchar(max) = N'CREATE USER ' + QUOTENAME(@p1) + N' FOR LOGIN ' + QUOTENAME(@p2);\n"),
            ActionTemplate.AlterUserSchema => Run("DECLARE @stmt nvarchar(max) = N'ALTER USER ' + QUOTENAME(@p1) + N' WITH DEFAULT_SCHEMA=' + QUOTENAME(@p2);\n"),
            // CREATE SCHEMA must be its batch's only statement, which sp_executesql gives it.
            ActionTemplate.CreateSchemaFor => Run("DECLARE @stmt nvarchar(max) = N'CREATE SCHEMA ' + QUOTENAME(@p1) + N' AUTHORIZATION ' + QUOTENAME(@p2);\n"),
            ActionTemplate.AddRoleMember => Run("DECLARE @stmt nvarchar(max) = N'ALTER ROLE ' + QUOTENAME(@p1) + N' ADD MEMBER ' + QUOTENAME(@p2);\n"),
            _ => throw new InvalidOperationException("Unknown template " + template)
        };
    }

    /// <summary>Why the cleanup left a database alone: it is no longer the RESTORING database this restore created.</summary>
    internal const string NotRestoring = "N'The database is not the RESTORING database this restore created, so it was not removed.'";

    // --- Catalog statements ---------------------------------------------------------------------------------------------

    /// <summary>Whether sys.databases' row d cannot be written to: set READ_ONLY, a log-shipping standby, or a database snapshot. An
    /// availability group's readable secondary is not caught: its role is only in a DMV that needs VIEW SERVER STATE.</summary>
    public const string ReadOnlyFact = "CONVERT(bit, CASE WHEN d.is_read_only = 1 OR d.is_in_standby = 1 OR d.source_database_id IS NOT NULL THEN 1 ELSE 0 END)";

    /// <summary>The object's database as master sees it: whether it exists, is online, the login can open it, and it is read-only
    /// (<see cref="ReadOnlyFact"/>).</summary>
    public const string DatabaseState = "SELECT d.database_id AS database_id, d.state AS state, d.state_desc AS state_desc, "
        + "CONVERT(bit, ISNULL(CASE WHEN d.user_access = 1 THEN 1 ELSE HAS_DBACCESS(d.name) END, 0)) AS has_access, " + ReadOnlyFact + " AS read_only FROM sys.databases AS d WHERE d.name = @db;";

    /// <summary>The sys.objects types a kind's object is found by.</summary>
    public static string Types(string kind) => kind switch
    {
        "table" => "'U'",
        "view" => "'V'",
        "procedure" => "'P', 'PC', 'X', 'RF'",
        "function" => "'FN', 'IF', 'TF', 'FS', 'FT', 'AF'",
        _ => throw new InvalidOperationException("No object lookup for " + kind)
    };

    private const string Owner = "LEFT JOIN sys.database_principals AS op ON op.principal_id = COALESCE(o.principal_id, s.principal_id) ";
    /// <summary>Advisory permission checks (SQL Server enforces the real ones), and whether @new is taken in the schema. A
    /// check that cannot answer (NULL) does not refuse.</summary>
    private const string Checks = "CONVERT(bit, ISNULL(HAS_PERMS_BY_NAME(QUOTENAME(s.name) + N'.' + QUOTENAME(o.name), N'OBJECT', N'ALTER'), 1)) AS can_alter, "
        + "CONVERT(bit, CASE WHEN ISNULL(HAS_PERMS_BY_NAME(s.name, N'SCHEMA', N'ALTER'), 1) = 1 OR HAS_PERMS_BY_NAME(QUOTENAME(s.name) + N'.' + QUOTENAME(o.name), N'OBJECT', N'CONTROL') = 1 "
        + "THEN 1 ELSE 0 END) AS can_drop, "
        + "CONVERT(bit, CASE WHEN EXISTS (SELECT 1 FROM sys.objects AS x WHERE x.schema_id = o.schema_id AND x.name = @new AND x.object_id <> o.object_id) THEN 1 ELSE 0 END) AS name_in_use";

    /// <summary>One statement per kind and band, run in the object's database: the object's row (its subtype's columns as
    /// ScriptPreflight.Subtype reads them, its owner, permissions and a name collision), then at most @take tables whose
    /// foreign keys reference it, then at most @take schema-bound modules over it. Execute passes @take 0.</summary>
    public static string Object(string kind, int band)
    {
        var render = new SqlRender(band);
        var subtype = kind switch
        {
            "table" => render.Col(13, "t.temporal_type", "CONVERT(tinyint, 0)") + " AS temporal_code, " + render.Col(16, "t.ledger_type", "CONVERT(tinyint, 0)") + " AS ledger_code, "
                + render.Col(14, "t.is_node", "CONVERT(bit, 0)") + " AS node_flag, " + render.Col(14, "t.is_edge", "CONVERT(bit, 0)") + " AS edge_flag, t.is_filetable AS is_filetable, "
                + render.Col(13, "t.is_external", "CONVERT(bit, 0)") + " AS external_flag, " + render.Col(16, "t.is_dropped_ledger_table", "CONVERT(bit, 0)") + " AS dropped_flag, ",
            "view" => render.Col(16, "v.ledger_view_type", "CONVERT(tinyint, 0)") + " AS ledger_view_code, " + render.Col(16, "v.is_dropped_ledger_view", "CONVERT(bit, 0)") + " AS dropped_flag, ",
            _ => ""
        };
        var join = kind switch
        {
            "table" => "JOIN sys.tables AS t ON t.object_id = o.object_id ",
            "view" => "JOIN sys.all_views AS v ON v.object_id = o.object_id ",
            _ => ""
        };
        return "DECLARE @id int = (SELECT o.object_id FROM sys.all_objects AS o JOIN sys.schemas AS s ON s.schema_id = o.schema_id WHERE s.name = @schema AND o.name = @name AND o.type IN ("
            + Types(kind) + "));\n"
            + "SELECT o.object_id AS object_id, o.type AS object_type, o.is_ms_shipped AS is_ms_shipped, " + subtype + "op.name AS owner_name, " + Checks + " "
            + "FROM sys.all_objects AS o JOIN sys.schemas AS s ON s.schema_id = o.schema_id " + join + Owner + "WHERE o.object_id = @id;\n"
            + "SELECT TOP (@take) ps.name AS schema_name, po.name AS object_name, fk.name AS dependent_name FROM sys.foreign_keys AS fk "
            + "JOIN sys.objects AS po ON po.object_id = fk.parent_object_id JOIN sys.schemas AS ps ON ps.schema_id = po.schema_id "
            + "WHERE fk.referenced_object_id = @id AND fk.parent_object_id <> @id ORDER BY ps.name, po.name, fk.name;\n"
            + "SELECT TOP (@take) rs.name AS schema_name, ro.name AS object_name, ro.type AS object_type FROM (SELECT DISTINCT d.referencing_id FROM sys.sql_expression_dependencies AS d "
            + "JOIN sys.sql_modules AS m ON m.object_id = d.referencing_id WHERE d.referenced_id = @id AND d.referencing_id <> @id AND m.is_schema_bound = 1) AS r "
            + "JOIN sys.objects AS ro ON ro.object_id = r.referencing_id JOIN sys.schemas AS rs ON rs.schema_id = ro.schema_id ORDER BY rs.name, ro.name;";
    }

    /// <summary>A session uses a database when it is in it or has a transaction there: SET SINGLE_USER WITH ROLLBACK IMMEDIATE ends
    /// both, and rolls back the whole transaction ("Nonqualified transactions are being rolled back"), so Delete Object counts both.
    /// These DMVs raise error 300 for a login without VIEW SERVER STATE (VIEW SERVER PERFORMANCE STATE on 2022 and later) whatever
    /// guards them in the statement, unlike sys.dm_exec_sessions, which shows such a login its own sessions: so only the statements
    /// the describe runs once Database's guarded count says it has the permission read them (DatabaseUse, DatabaseUseSessions,
    /// TransactionSessions), never Database, which every database action runs.</summary>
    private const string InTransaction = "EXISTS (SELECT 1 FROM sys.dm_tran_session_transactions AS st JOIN sys.dm_tran_database_transactions AS dt ON dt.transaction_id = st.transaction_id "
        + "WHERE st.session_id = es.session_id AND dt.database_id = d.database_id)";
    private const string UsesDatabase = "(es.database_id = d.database_id OR " + InTransaction + ")";
    /// <summary>A session that uses the database (UsesDatabase) with an open transaction, which closing its connections rolls back.</summary>
    private const string HoldsTransaction = "((es.database_id = d.database_id AND es.open_transaction_count > 0) OR " + InTransaction + ")";

    /// <summary>A database's row in master: its identity (database_id, create_date), state, user access, read-only and standby,
    /// subtype, what blocks a DROP, SET OFFLINE or sp_detach_db (replication, an availability group, mirroring, its own database
    /// snapshots), owner, the sessions in it and those with an open transaction (with VIEW SERVER STATE, else null; DatabaseUse adds
    /// those with a transaction there from elsewhere), permissions and whether @new is another database's name. can_alter_state is
    /// what SET OFFLINE and SET ONLINE need, which HAS_PERMS_BY_NAME on the database does not answer: it says 0 to a login with no user
    /// in the database (ALTER ANY DATABASE, dbcreator), to sysadmin while another session holds a SINGLE_USER database, and to everyone
    /// on a database that is not online (probed on SQL Server 2025). So ALTER ANY DATABASE, dbcreator (sys.login_token) or ownership
    /// grant it in any state, and ALTER on the database while it is online. The owner falls back to SUSER_SNAME(d.owner_sid): a Windows
    /// group's member owns it with no server principal of its own. can_detach is what sp_detach_db's DBCC DETACHDB needs that master
    /// can answer, sysadmin or ownership (ALTER, CONTROL, ALTER ANY DATABASE and dbcreator get 7983; probed on SQL Server 2025); a
    /// member of the database's db_owner role is read inside it (DetachInside). sql_login: this connection's login is SQL Server's
    /// own, whose detached files only the service account can open again on Windows.</summary>
    public const string Database ="SELECT d.database_id AS database_id, d.create_date AS create_date, d.state AS state, d.state_desc AS state_desc, "
        + "d.user_access AS user_access, d.is_read_only AS is_read_only, d.is_in_standby AS is_in_standby, "
        + "CONVERT(bit, CASE WHEN d.source_database_id IS NULL THEN 0 ELSE 1 END) AS is_snapshot, "
        + "CONVERT(bit, CASE WHEN d.database_id <= 4 OR d.is_distributor = 1 THEN 1 ELSE 0 END) AS is_system, "
        + "CONVERT(bit, CASE WHEN d.is_published = 1 OR d.is_subscribed = 1 OR d.is_merge_published = 1 OR d.is_distributor = 1 THEN 1 ELSE 0 END) AS replicated, "
        + "CONVERT(bit, CASE WHEN d.replica_id IS NULL THEN 0 ELSE 1 END) AS in_availability_group, "
        + "CONVERT(bit, CASE WHEN dm.mirroring_guid IS NULL THEN 0 ELSE 1 END) AS mirrored, "
        + "CONVERT(bit, CASE WHEN EXISTS (SELECT 1 FROM sys.databases AS s WHERE s.source_database_id = d.database_id) THEN 1 ELSE 0 END) AS has_snapshots, "
        + "COALESCE(sp.name, SUSER_SNAME(d.owner_sid)) AS owner_name, "
        + "CASE WHEN HAS_PERMS_BY_NAME(NULL, NULL, N'VIEW SERVER STATE') = 1 THEN (SELECT COUNT(*) FROM sys.dm_exec_sessions AS es WHERE es.database_id = d.database_id AND es.session_id <> @@SPID) END AS sessions, "
        + "CASE WHEN HAS_PERMS_BY_NAME(NULL, NULL, N'VIEW SERVER STATE') = 1 THEN (SELECT COUNT(*) FROM sys.dm_exec_sessions AS es WHERE es.database_id = d.database_id "
        + "AND es.open_transaction_count > 0 AND es.session_id <> @@SPID) END AS with_transaction, "
        + "CONVERT(bit, ISNULL(HAS_PERMS_BY_NAME(d.name, N'DATABASE', N'ALTER'), 1)) AS can_alter, "
        + "CONVERT(bit, CASE WHEN HAS_PERMS_BY_NAME(NULL, NULL, N'ALTER ANY DATABASE') = 1 OR d.owner_sid = SUSER_SID() "
        + "OR EXISTS (SELECT 1 FROM sys.login_token AS t WHERE t.type = N'SERVER ROLE' AND t.name = N'dbcreator') THEN 1 "
        + "WHEN d.state = 0 THEN ISNULL(HAS_PERMS_BY_NAME(d.name, N'DATABASE', N'ALTER'), 1) ELSE 0 END) AS can_alter_state, "
        + "CONVERT(bit, CASE WHEN IS_SRVROLEMEMBER(N'sysadmin') = 1 OR d.owner_sid = SUSER_SID() THEN 1 ELSE 0 END) AS can_detach, "
        + "CONVERT(bit, CASE WHEN EXISTS (SELECT 1 FROM sys.login_token AS t WHERE t.type = N'SQL LOGIN') THEN 1 ELSE 0 END) AS sql_login, "
        + "CONVERT(bit, CASE WHEN ISNULL(HAS_PERMS_BY_NAME(d.name, N'DATABASE', N'CONTROL'), 1) = 1 OR HAS_PERMS_BY_NAME(NULL, NULL, N'ALTER ANY DATABASE') = 1 THEN 1 ELSE 0 END) AS can_drop, "
        + "CONVERT(bit, CASE WHEN EXISTS (SELECT 1 FROM sys.databases AS x WHERE x.name = @new AND x.database_id <> d.database_id) THEN 1 ELSE 0 END) AS name_in_use "
        + "FROM sys.databases AS d LEFT JOIN sys.database_mirroring AS dm ON dm.database_id = d.database_id LEFT JOIN sys.server_principals AS sp ON sp.sid = d.owner_sid "
        + "WHERE d.name = @name;";

    /// <summary>The login preflight (D4 §6), in master: the login's row (type, state, SID, policy flags, CONNECT SQL denied,
    /// whether it is this connection's own login or a Windows group it gets in through, sysadmin membership, its sessions with
    /// VIEW SERVER STATE, what it owns, the permissions to change it, and whether @new is another principal's name), then at
    /// most @take names of the databases it owns. Catalog views only: a READ COMMITTED read never takes LOGINPROPERTY's locks.</summary>
    public const string Login = "SELECT p.principal_id AS principal_id, p.type AS principal_type, p.is_disabled AS is_disabled, CONVERT(varchar(172), p.sid, 2) AS sid_hex, "
        + "p.create_date AS create_date, l.is_policy_checked AS policy_checked, l.is_expiration_checked AS expiration_checked, "
        + "CONVERT(bit, CASE WHEN EXISTS (SELECT 1 FROM sys.server_permissions AS sp WHERE sp.grantee_principal_id = p.principal_id AND sp.type = 'COSQ' AND sp.state = 'D') THEN 1 ELSE 0 END) AS connect_denied, "
        + "CONVERT(bit, CASE WHEN EXISTS (SELECT 1 FROM sys.login_token AS t WHERE t.principal_id = p.principal_id AND t.usage = N'GRANT OR DENY') THEN 1 ELSE 0 END) AS is_own, "
        + "CONVERT(bit, CASE WHEN EXISTS (SELECT 1 FROM sys.server_role_members AS m JOIN sys.server_principals AS r ON r.principal_id = m.role_principal_id "
        + "WHERE m.member_principal_id = p.principal_id AND r.name = N'sysadmin') THEN 1 ELSE 0 END) AS is_sysadmin, "
        + "CASE WHEN HAS_PERMS_BY_NAME(NULL, NULL, N'VIEW SERVER STATE') = 1 THEN (SELECT COUNT(*) FROM sys.dm_exec_sessions AS es WHERE es.security_id = p.sid AND es.is_user_process = 1) END AS sessions, "
        + "(SELECT COUNT(*) FROM sys.databases AS d WHERE d.owner_sid = p.sid) AS owned_databases, "
        + "(SELECT COUNT(*) FROM sys.server_principals AS o WHERE o.owning_principal_id = p.principal_id) + (SELECT COUNT(*) FROM sys.endpoints AS e WHERE e.principal_id = p.principal_id) AS owned_server_objects, "
        + "CONVERT(bit, ISNULL(HAS_PERMS_BY_NAME(NULL, NULL, N'ALTER ANY LOGIN'), 0)) AS can_alter, "
        + "CONVERT(bit, ISNULL(HAS_PERMS_BY_NAME(NULL, NULL, N'CONTROL SERVER'), 0)) AS can_control_server, "
        + "CONVERT(bit, CASE WHEN EXISTS (SELECT 1 FROM sys.server_principals AS x WHERE x.name = @new AND x.principal_id <> p.principal_id) THEN 1 ELSE 0 END) AS name_in_use "
        + "FROM sys.server_principals AS p LEFT JOIN sys.sql_logins AS l ON l.principal_id = p.principal_id "
        + "WHERE p.name = @name AND p.type IN ('S', 'U', 'G', 'C', 'K', 'E', 'X');\n"
        + "SELECT TOP (@take) d.name AS database_name FROM sys.databases AS d JOIN sys.server_principals AS p ON p.sid = d.owner_sid "
        + "WHERE p.name = @name AND p.type IN ('S', 'U', 'G', 'C', 'K', 'E', 'X') ORDER BY d.name;";

    /// <summary>The sessions this backend's process (@pid) holds in a database, bounded by its own connections: the action keeps
    /// those its pooled connections were given, which a cleared pool leaves for a moment before the server ends them. Without VIEW
    /// SERVER STATE only this session is visible: none.</summary>
    public const string OwnSessions = "SELECT es.session_id AS session_id FROM sys.dm_exec_sessions AS es JOIN sys.databases AS d ON d.database_id = es.database_id "
        + "WHERE d.name = @name AND es.host_process_id = @pid AND es.session_id <> @@SPID;";

    /// <summary>Delete Object's counts of a database's sessions (D3 §8): those using it (UsesDatabase) and those with an open transaction
    /// there (HoldsTransaction), never this one. Only with VIEW SERVER STATE (InTransaction): without it the describe counts none (unknown).</summary>
    public const string DatabaseUse = "SELECT (SELECT COUNT(*) FROM sys.dm_exec_sessions AS es WHERE es.session_id <> @@SPID AND " + UsesDatabase + ") AS sessions, "
        + "(SELECT COUNT(*) FROM sys.dm_exec_sessions AS es WHERE es.session_id <> @@SPID AND " + HoldsTransaction + ") AS with_transaction "
        + "FROM sys.databases AS d WHERE d.name = @name;";

    /// <summary>The sessions using a database (UsesDatabase) that Delete Object lists (D3 §8), each with whether it holds an open
    /// transaction (HoldsTransaction): at most @take by session id, never this one. Only with VIEW SERVER STATE (InTransaction): without
    /// it the describe lists none (unknown); the action leaves out the backend's pooled sessions.</summary>
    public const string DatabaseUseSessions = "SELECT TOP (@take) es.session_id AS session_id, es.host_process_id AS host_process_id, "
        + "CONVERT(int, CASE WHEN " + HoldsTransaction + " THEN 1 ELSE 0 END) AS open_transaction, es.program_name AS program_name, es.host_name AS host_name "
        + "FROM sys.dm_exec_sessions AS es CROSS JOIN sys.databases AS d WHERE d.name = @name AND es.session_id <> @@SPID AND " + UsesDatabase + " ORDER BY es.session_id;";

    /// <summary>This process's sessions (@pid) with an open transaction in the database or while in it (HoldsTransaction), at most @take
    /// by session id, never this one: the action keeps the query tabs' (A7). Only with VIEW SERVER STATE (InTransaction).</summary>
    public const string TransactionSessions = "SELECT TOP (@take) es.session_id AS session_id FROM sys.dm_exec_sessions AS es CROSS JOIN sys.databases AS d "
        + "WHERE d.name = @name AND es.host_process_id = @pid AND es.session_id <> @@SPID AND " + HoldsTransaction + " ORDER BY es.session_id;";

    /// <summary>The sessions in a database that Take Offline lists (in master, with VIEW SERVER STATE; without it only this session, which
    /// is not in it, is visible), at most @take by session id, this process's query windows among them. Names are clipped in C#.</summary>
    public const string DatabaseSessions = "DECLARE @id int = (SELECT d.database_id FROM sys.databases AS d WHERE d.name = @name);\n"
        + "SELECT TOP (@take) es.session_id AS session_id, es.login_name AS login_name, es.program_name AS program_name, es.host_name AS host_name, "
        + "es.open_transaction_count AS open_transactions FROM sys.dm_exec_sessions AS es WHERE es.database_id = @id AND es.session_id <> @@SPID "
        + "ORDER BY es.session_id;";

    /// <summary>Detach's files that stay on the server (sys.master_files, in master): at most @take by file id, as the database had them
    /// when the dialog or the action read it. Paths are never logged.</summary>
    public const string DatabaseFiles = "SELECT TOP (@take) f.file_id AS file_id, f.name AS file_name, f.type AS file_type, f.physical_name AS physical_name "
        + "FROM sys.master_files AS f JOIN sys.databases AS d ON d.database_id = f.database_id WHERE d.name = @name ORDER BY f.file_id;";

    /// <summary>Detach inside an online database (ModuleCall): whether this login is in its db_owner role, which sp_detach_db needs
    /// besides sysadmin or ownership, then at most @take of its files by file id. sys.master_files shows rows only with CREATE
    /// DATABASE, ALTER ANY DATABASE or VIEW ANY DEFINITION, which a db_owner member who may detach can lack; sys.database_files
    /// shows them to every user of the database.</summary>
    public const string DetachInside = "SELECT CONVERT(bit, ISNULL(IS_ROLEMEMBER(N'db_owner'), 0)) AS db_owner;\n"
        + "SELECT TOP (@take) f.file_id AS file_id, f.name AS file_name, f.type AS file_type, f.physical_name AS physical_name FROM sys.database_files AS f ORDER BY f.file_id;";

    /// <summary>A database's state and user access after an action, in master (Bring Online reports a database still SINGLE_USER).</summary>
    public const string DatabaseAccess = "SELECT d.state AS state, d.user_access AS user_access FROM sys.databases AS d WHERE d.name = @name;";

    // --- Lint -----------------------------------------------------------------------------------------------------------

    private static readonly HashSet<string> Literals =
    [
        "N'.'", "N'.sys.sp_executesql'", "N'.sys.sp_rename'", "N'OBJECT'", "N'SCHEMA'", "N'DATABASE'", "N'ALTER'", "N'CONTROL'", "N'VIEW SERVER STATE'", "N'ALTER ANY DATABASE'",
        "N'A name could not be quoted.'", "N'DROP TABLE '", "N'DROP VIEW '", "N'DROP PROCEDURE '", "N'DROP FUNCTION '", "N'DROP DATABASE '", "N'ALTER DATABASE '",
        "N' MODIFY NAME = '", "N' SET  SINGLE_USER WITH ROLLBACK IMMEDIATE'",
        // Take Offline and Bring Online.
        "N' SET  OFFLINE'", "N' SET  OFFLINE WITH ROLLBACK IMMEDIATE'", "N' SET  ONLINE'",
        // The shared templates (critic A21).
        "N' SET  MULTI_USER'", "N' SET  RESTRICTED_USER'", "N'ALTER LOGIN '", "N' DISABLE'", "N' ENABLE'", "N'DENY CONNECT SQL TO '", "N'GRANT CONNECT SQL TO '", "N'DROP USER '",
        // New Login's server roles (Actions/LoginSql), and its describe's and preflight's server facts.
        "N'ALTER SERVER ROLE '", "N' ADD MEMBER '", "'IsIntegratedSecurityOnly'",
        // Its User Mapping's statements, and its describe's guest CONNECT state (LoginSql.DatabaseRoles).
        "N'CREATE USER '", "N' FOR LOGIN '", "N'ALTER USER '", "N' WITH DEFAULT_SCHEMA='", "N'CREATE SCHEMA '", "N' AUTHORIZATION '", "N'ALTER ROLE '",
        // The login preflight (Login).
        "N'GRANT OR DENY'", "N'ALTER ANY LOGIN'", "N'CONTROL SERVER'", "'COSQ'",
        // Take Offline's and Bring Online's permission (Database's can_alter_state).
        "N'SERVER ROLE'", "N'dbcreator'",
        // Detach's permission and the login kind its files note reads (Database, DetachInside).
        "N'db_owner'", "N'SQL LOGIN'",
        // Restore Database's cleanup (DropRestoring).
        NotRestoring,
        // Database Properties' describe and preflight (DatabaseProperties.cs, ActionService.DatabasePropertiesPreflight).
        "N'contained database authentication'", "N'sysadmin'", "N'##%'", "N'SpaceUsed'", "N'@take int'", "N'MAXDOP'", "N'LEGACY_CARDINALITY_ESTIMATION'", "N'PARAMETER_SNIFFING'",
        "N'QUERY_OPTIMIZER_HOTFIXES'", "'FilestreamEffectiveLevel'", "'EngineEdition'", "'ProductMajorVersion'",
        // The table designer's master facts and its describe's collation probes (Designer/DesignerSql).
        "N'CREATE TABLE'", "N'a'", "N'A'", "N'e'",
        // New Database's facts (CreateDatabaseSql.Facts) and Attach Databases' facts and preflight (AttachSql).
        "'InstanceDefaultDataPath'", "'InstanceDefaultLogPath'", "'Collation'", "N'CREATE ANY DATABASE'", "N'CREATE DATABASE'", "N'dm_os_file_exists'"
    ];
    [GeneratedRegex(@"N?'(?:[^']|'')*'")]
    private static partial Regex LiteralPattern();
    [GeneratedRegex(@"^'[A-Z]{1,2}'$")]
    private static partial Regex TypeLetters();
    [GeneratedRegex(@"@\w+")]
    private static partial Regex Variable();
    [GeneratedRegex(@"DECLARE (@\w+)")]
    private static partial Regex Declared();
    [GeneratedRegex(@"(@\w+) = ")]
    private static partial Regex NamedArgument();
    [GeneratedRegex(@"@p\d+")]
    private static partial Regex Placeholder();
    [GeneratedRegex(@"QUOTENAME\(@p\d+\)|(?<=EXEC [^;]*= )@p\d+(?=[,;])|(?<=SELECT )@p\d+(?= AS )|, @p\d+(?= AS )|(?<=WHERE d\.name = )@p1(?= AND d\.state = 1 AND )|(?<=d\.database_id = )CONVERT\(int, @p2\)(?=\) THROW )")]
    private static partial Regex QuotedPlaceholder();
    /// <summary>Builder batches' keyword text: letters, digits, underscores, spaces and the punctuation SMO's forms use. No quote,
    /// bracket, comment or line break can be written with it, and it comes only from an embedded catalogue.</summary>
    [GeneratedRegex(@"^N'[A-Za-z0-9_ ():=;]*'$")]
    private static partial Regex KeywordLiteral();
    /// <summary>The three parameter forms of a builder batch: a name through QUOTENAME (@db where it runs, @p1 and @p2), a
    /// number through CONVERT after its range guard, and a collation only as sys.fn_helpcollations() names it.</summary>
    [GeneratedRegex(@"QUOTENAME\(@(?:db|p1|p2)\)|CONVERT\(nvarchar\(20\), @n1\)|^IF @n1 IS NULL OR @n1 < \d+ OR @n1 > \d+ THROW|WHERE c\.name = @p2\);$", RegexOptions.Multiline)]
    private static partial Regex BuilderUse();
    /// <summary>The one metadata function the catalog statements use, for the owner of a database a Windows group's member made.</summary>
    private const string OwnerFallback = "SUSER_SNAME(d.owner_sid)";
    /// <summary>The other: master's database version, the newest an attach can open (Attach Databases compares a primary file's
    /// with it, since SQL Server's own refusal, 948, is severity 20 and ends the session). Its literals are constant, and master
    /// takes no lock a waiting attach or restore holds.</summary>
    public const string MasterVersion = "CONVERT(int, DATABASEPROPERTYEX(N'master', 'Version'))";

    /// <summary>LOGINPROPERTY and password hashes, which no batch may name (critic A15), as every catalog lint refuses them.</summary>
    private static IEnumerable<string> SecretUses(string text) => CatalogSql.SecretUses(text);

    /// <summary>Problems with one executable batch (empty when it passes): leftover format holes, a name parameter outside
    /// QUOTENAME or a procedure argument, an undeclared variable, and literals beyond the fixed keyword fragments.</summary>
    public static List<string> LintExecutable(string text, ActionTemplate template)
    {
        var problems = new List<string>();
        if (text.Contains('{', StringComparison.Ordinal) || text.Contains('}', StringComparison.Ordinal)) problems.Add("has a format hole");
        problems.AddRange(SecretUses(text));
        var bare = QuotedPlaceholder().Replace(text, "");
        if (Placeholder().IsMatch(bare)) problems.Add("uses a name parameter outside QUOTENAME or a procedure argument");
        // The database a batch runs in reaches T-SQL only as QUOTENAME(@db) + N'.sys.…'.
        if (Variable().Matches(text.Replace("QUOTENAME(@db)", "", StringComparison.Ordinal)).Any(used => used.Value == "@db")) problems.Add("uses @db outside QUOTENAME");
        var parameters = Enumerable.Range(1, ParameterCount(template)).Select(index => "@p" + index.ToString(CultureInfo.InvariantCulture)).Append("@db").ToHashSet(StringComparer.Ordinal);
        foreach (Match used in Placeholder().Matches(text)) if (!parameters.Contains(used.Value)) problems.Add("uses " + used.Value + ", which the template does not bind");
        problems.AddRange(Undeclared(text, parameters));
        foreach (Match literal in LiteralPattern().Matches(text)) if (!Literals.Contains(literal.Value)) problems.Add("has the literal " + literal.Value);
        return problems;
    }

    /// <summary>Problems with one builder batch, which has SQL Server build its statement from constant keyword literals and
    /// parameters (Database Properties' ALTER DATABASE in Actions/DatabaseAlter): a format hole, a parameter outside its three
    /// forms (QUOTENAME of @db, @p1 or @p2; CONVERT of @n1 after its range guard; the collation lookup), an undeclared
    /// variable, no quoting guard, and a literal that is neither one of <paramref name="messages"/> nor keyword text.</summary>
    public static List<string> LintExecutable(string text, IReadOnlySet<string> messages)
    {
        var problems = new List<string>();
        if (text.Contains('{', StringComparison.Ordinal) || text.Contains('}', StringComparison.Ordinal)) problems.Add("has a format hole");
        problems.AddRange(SecretUses(text));
        var bare = BuilderUse().Replace(text, "");
        foreach (Match used in Variable().Matches(bare))
            if (used.Value is "@db" or "@p1" or "@p2" or "@n1") problems.Add("uses " + used.Value + " outside QUOTENAME, CONVERT or the collation lookup");
            else if (used.Value is not ("@stmt" or "@module" or "@c")) problems.Add("uses the undeclared " + used.Value);
        if (text.Contains("@n1", StringComparison.Ordinal) && !text.StartsWith("IF @n1 IS NULL OR @n1 < ", StringComparison.Ordinal)) problems.Add("uses @n1 without its range guard");
        if (!text.Contains(Guard, StringComparison.Ordinal)) problems.Add("has no quoting guard");
        foreach (Match literal in LiteralPattern().Matches(text))
            if (!messages.Contains(literal.Value) && !KeywordLiteral().IsMatch(literal.Value)) problems.Add("has the literal " + literal.Value);
        return problems;
    }

    [GeneratedRegex(@"^N'[A-Za-z0-9_ ():=;,]*'$")]
    private static partial Regex DesignKeywordLiteral();
    /// <summary>A row of the builders' constant type table: (id, N'keyword', form, lob).</summary>
    [GeneratedRegex(@"\(\d+, (N'[^']*'), \d, [01]\)")]
    private static partial Regex TypeRow();
    [GeneratedRegex(@"DECLARE ([^;]*);")]
    private static partial Regex Declaration();
    [GeneratedRegex(@"(?:^|, )(@\w+) ")]
    private static partial Regex DeclaredName();

    /// <summary>Problems with one of the table designer's builder batches (Designer/DesignerSql.Builder), which has SQL Server
    /// shred one JSON parameter and compose the statement: a format hole, no quoting guard, @db outside QUOTENAME, @design
    /// outside ISJSON or OPENJSON, the OPENJSON rules of <see cref="JsonBuilderLint"/> (a JSON text value used anywhere but inside
    /// QUOTENAME, a JSON array or element used anywhere but OPENJSON or an index's CONVERT to int, a column of another type), an
    /// undeclared variable, and a literal that is neither one of the rules' messages nor keyword text (a type keyword must be one of
    /// the catalogue's).</summary>
    public static List<string> LintExecutable(string text, DesignBuilderRules rules)
    {
        var problems = new List<string>();
        if (text.Contains('{', StringComparison.Ordinal) || text.Contains('}', StringComparison.Ordinal)) problems.Add("has a format hole");
        problems.AddRange(SecretUses(text));
        if (!text.Contains(Guard, StringComparison.Ordinal)) problems.Add("has no quoting guard");
        if (Variable().Matches(text.Replace("QUOTENAME(@db)", "", StringComparison.Ordinal)).Any(used => used.Value == "@db")) problems.Add("uses @db outside QUOTENAME");
        if (Variable().Matches(text.Replace("ISJSON(@design)", "", StringComparison.Ordinal).Replace("OPENJSON(@design)", "", StringComparison.Ordinal)).Any(used => used.Value == "@design"))
            problems.Add("uses @design outside ISJSON or OPENJSON");
        // JSON text (a name) reaches the statement only as QUOTENAME(alias.column), the arrays only through OPENJSON.
        problems.AddRange(JsonBuilderLint.Problems(text, ["@columns", "@key"]));
        var declared = Declaration().Matches(text).SelectMany(match => DeclaredName().Matches(match.Groups[1].Value).Select(name => name.Groups[1].Value)).ToHashSet(StringComparer.Ordinal);
        foreach (Match used in Variable().Matches(text)) if (used.Value is not ("@db" or "@design") && !declared.Contains(used.Value)) problems.Add("uses the undeclared " + used.Value);
        foreach (Match literal in LiteralPattern().Matches(text))
            if (!rules.Messages.Contains(literal.Value) && !DesignKeywordLiteral().IsMatch(literal.Value)) problems.Add("has the literal " + literal.Value);
        var keywords = TypeRow().Matches(text).Select(match => match.Groups[1].Value[2..^1]);
        foreach (var keyword in keywords) if (!rules.TypeNames.Contains(keyword)) problems.Add("has the type keyword " + keyword);
        return problems;
    }

    /// <summary>Problems with one catalog statement: Object Explorer's metadata-function ban (but the owner fallback),
    /// band gates, names outside parameters, and literals beyond the allowlist.</summary>
    public static List<string> LintCatalog(string text, int band, bool database)
    {
        var problems = new List<string>();
        var stripped = text.Replace(OwnerFallback, "", StringComparison.Ordinal).Replace(MasterVersion, "", StringComparison.Ordinal);
        foreach (var builtin in CatalogSql.Builtins) if (stripped.Contains(builtin, StringComparison.OrdinalIgnoreCase)) problems.Add("uses " + builtin);
        problems.AddRange(CatalogSql.SecretUses(text));
        if (stripped.Contains("DB_NAME(", StringComparison.OrdinalIgnoreCase) || stripped.Contains("OBJECT_ID(", StringComparison.OrdinalIgnoreCase)) problems.Add("uses a metadata function");
        if (database && text.Contains("HAS_DBACCESS(", StringComparison.OrdinalIgnoreCase)) problems.Add("uses HAS_DBACCESS inside a database");
        foreach (var (token, since) in CatalogSql.Gates) if (band < since && text.Contains(token, StringComparison.Ordinal)) problems.Add("uses " + token + " below band " + since);
        foreach (Match literal in LiteralPattern().Matches(stripped))
            if (!Literals.Contains(literal.Value) && !TypeLetters().IsMatch(literal.Value)) problems.Add("has the literal " + literal.Value);
        if (database && text.Contains("@db", StringComparison.Ordinal)) problems.Add("names @db inside a statement");
        if (Placeholder().IsMatch(text)) problems.Add("uses a DDL name parameter");
        return problems;
    }

    private static IEnumerable<string> Undeclared(string text, HashSet<string> parameters)
    {
        var declared = Declared().Matches(text).Select(match => match.Groups[1].Value).ToHashSet(StringComparer.Ordinal);
        var arguments = NamedArgument().Matches(text).Where(match => !declared.Contains(match.Groups[1].Value) && match.Index > text.IndexOf("EXEC ", StringComparison.Ordinal)
            && text.IndexOf("EXEC ", StringComparison.Ordinal) >= 0).Select(match => match.Groups[1].Value).ToHashSet(StringComparer.Ordinal);
        foreach (Match used in Variable().Matches(text))
            if (!declared.Contains(used.Value) && !parameters.Contains(used.Value) && !arguments.Contains(used.Value)) yield return "uses the undeclared " + used.Value;
    }

    /// <summary>Every executable and catalog statement, rendered for every band, with its lint problems (ActionChecks).</summary>
    public static IEnumerable<(string Name, List<string> Problems)> Lint()
    {
        foreach (var template in Enum.GetValues<ActionTemplate>())
            foreach (var dry in new[] { false, true })
                yield return (template + (dry ? " (dry run)" : ""), LintExecutable(Executable(template, dry), template));
        for (var band = ExplorerCatalog.MinBand; band <= ExplorerCatalog.MaxBand; band++)
        {
            foreach (var kind in new[] { "table", "view", "procedure", "function" }) yield return (kind + " band " + band, LintCatalog(Object(kind, band), band, database: true));
            yield return ("database band " + band, LintCatalog(Database, band, database: false));
        }
        yield return ("database state", LintCatalog(DatabaseState, ExplorerCatalog.MaxBand, database: false));
        yield return ("login", LintCatalog(Login, ExplorerCatalog.MaxBand, database: false));
        yield return ("own sessions", LintCatalog(OwnSessions, ExplorerCatalog.MaxBand, database: false));
        yield return ("database use", LintCatalog(DatabaseUse, ExplorerCatalog.MaxBand, database: false));
        yield return ("database use sessions", LintCatalog(DatabaseUseSessions, ExplorerCatalog.MaxBand, database: false));
        yield return ("transaction sessions", LintCatalog(TransactionSessions, ExplorerCatalog.MaxBand, database: false));
        yield return ("database sessions", LintCatalog(DatabaseSessions, ExplorerCatalog.MaxBand, database: false));
        yield return ("database access", LintCatalog(DatabaseAccess, ExplorerCatalog.MaxBand, database: false));
        yield return ("database files", LintCatalog(DatabaseFiles, ExplorerCatalog.MaxBand, database: false));
        yield return ("detach inside", LintCatalog(DetachInside, ExplorerCatalog.MaxBand, database: true));
        yield return ("module call", LintCatalog(ModuleCall, ExplorerCatalog.MaxBand, database: false));
        // Database Properties: the describe in master and inside the database for every band, its call, the preflight,
        // and every ALTER the catalogue can plan, run and dry run.
        for (var band = ExplorerCatalog.MinBand; band <= ExplorerCatalog.MaxBand; band++)
        {
            yield return ("properties master band " + band, LintCatalog(DatabaseProperties.Master(band), band, database: false));
            yield return ("properties inside band " + band, LintCatalog(DatabaseProperties.Inside(band), band, database: true));
        }
        yield return ("properties call", LintCatalog(DatabaseProperties.InsideCall, ExplorerCatalog.MaxBand, database: false));
        yield return ("properties preflight", LintCatalog(ActionService.DatabasePropertiesPreflight, ExplorerCatalog.MaxBand, database: false));
        foreach (var item in DatabaseAlter.Lint(ActionsCatalog.Current)) yield return item;
        // New Database: its facts for every band, and its builder (form 5), run and dry run.
        foreach (var item in CreateDatabaseSql.LintAll()) yield return item;
        foreach (var item in AttachSql.LintAll()) yield return item;
        // New Login: its describe and preflight in master, and every CREATE LOGIN its builder can write, run and dry run.
        yield return ("new login describe", LintCatalog(LoginSql.Describe, ExplorerCatalog.MaxBand, database: false));
        yield return ("new login preflight", LintCatalog(LoginSql.Preflight, ExplorerCatalog.MaxBand, database: false));
        // User Mapping: its read of a database and its per-database preflight, each run inside the database through ModuleCall.
        yield return ("login database roles", LintCatalog(LoginSql.DatabaseRoles, ExplorerCatalog.MaxBand, database: true));
        yield return ("login mapping preflight", LintCatalog(LoginSql.MappingPreflight, ExplorerCatalog.MaxBand, database: true));
        foreach (var item in LoginSql.Lint()) yield return item;
    }
}

/// <summary>What a table designer builder batch may hold besides keyword text: its fixed messages and module suffix, and
/// the catalogue's type keywords.</summary>
internal sealed record DesignBuilderRules(IReadOnlySet<string> Messages, IReadOnlySet<string> TypeNames);
