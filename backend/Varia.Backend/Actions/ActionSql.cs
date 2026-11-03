using System.Globalization;
using System.Text.RegularExpressions;
using Varia.Backend.Explorer;
using Varia.Backend.Scripting;

namespace Varia.Backend.Actions;

/// <summary>The statements an action runs: DROP TABLE, VIEW, PROCEDURE or FUNCTION, sp_rename, ALTER DATABASE … MODIFY NAME,
/// SET SINGLE_USER, DROP DATABASE and msdb's backup history cleanup; and the shared templates later actions plan (critic
/// A21): SET MULTI_USER and RESTRICTED_USER (which also restore a database's access after a failed or stopped step),
/// sp_detach_db, ALTER LOGIN … DISABLE and ENABLE, DENY and GRANT CONNECT SQL, and DROP USER; New Login's ALTER SERVER ROLE …
/// ADD MEMBER and its User Mapping's CREATE USER … FOR LOGIN, ALTER USER … WITH DEFAULT_SCHEMA, CREATE SCHEMA … AUTHORIZATION and
/// ALTER ROLE … ADD MEMBER, each in the mapped database (its CREATE LOGIN is LoginSql's builder, which takes the password); a login's
/// rename (D4b); the password policy turned off and back on, with or without expiration, which Unlock runs in one transaction
/// (D4d); a login's Delete (D4c): DROP USER of a mapped user and DROP LOGIN, each bound to the principal it was planned for
/// (<see cref="PrincipalBinding"/>); and what Login Properties (D2c) adds: ALTER SERVER ROLE … DROP MEMBER, ALTER USER … WITH NAME
/// and ALTER ROLE … DROP MEMBER.</summary>
internal enum ActionTemplate
{
    DropTable, DropView, DropProcedure, DropFunction, RenameObject, RenameDatabase, SetSingleUser, DropDatabase, DeleteBackupHistory,
    SetMultiUser, SetRestrictedUser, DetachDatabase, DisableLogin, EnableLogin, DenyConnect, GrantConnect, DropUser,
    AddServerRoleMember, CreateUserForLogin, AlterUserSchema, CreateSchemaFor, AddRoleMember, RenameLogin, DropLogin, DropMappedUser,
    CheckPolicyOff, CheckPolicyOn, CheckPolicyExpirationOn, DropServerRoleMember, RenameUser, DropRoleMember
}

/// <summary>The principal a guarded DROP was planned for (D4c): its SID, and for a login its principal_id and create_date. SQL Server
/// checks them in the statement's own batch, waiting behind any change to the row, and rolls the DROP back when the name it quoted
/// belonged to another principal by then: a user renamed or remapped in an open transaction while the scan read past it, or a login
/// dropped and created again while an earlier step waited for a lock.</summary>
internal sealed record PrincipalBinding(byte[] Sid, int? PrincipalId = null, DateTime? Created = null);

/// <summary>Where a step runs in the plan (critic A4): main steps in order; a compensation undoes the main step <c>Undoes</c>
/// names (its index among the main steps) once that step completed and a later one failed or was stopped; a cleanup runs after
/// any failure or Stop. Both run under a fresh token bounded by the action's catalogue budget, and only when <c>When</c> (over
/// the main steps' statuses) allows it.</summary>
internal enum StepKind { Main, Compensation, Cleanup }

/// <summary>One statement of an action: its template, the database it runs in, and the names it takes, verbatim (a
/// schema-scoped object's schema and name, then a new name; a database's name, then a new name; sp_detach_db's @skipchecks
/// as true or false, from <see cref="ActionSql.Detach"/>). Kind, Undoes and When place it in runner v2 (StepKind).</summary>
internal sealed record PlannedStatement(ActionTemplate Template, string Database, IReadOnlyList<string> Names, StepKind Kind = StepKind.Main, int? Undoes = null,
    Func<IReadOnlyList<string>, bool>? When = null, PrincipalBinding? Principal = null);

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
    /// <summary>The read prologue with another lock timeout: the live checks shorten it (ActionServiceOptions.ReadLockTimeoutMs).</summary>
    public static string ReadPrologueOf(int lockTimeoutMs) =>
        lockTimeoutMs == 10_000 ? ReadPrologue : Prologue + " SET LOCK_TIMEOUT " + Math.Max(0, lockTimeoutMs).ToString(CultureInfo.InvariantCulture) + ";";
    /// <summary>Execute requests restore the default after a describe on the same connection could have set it.</summary>
    public const string ExecutePrologue = Prologue + " SET LOCK_TIMEOUT -1;";
    /// <summary>A describe whose facts only advise (loginFacts) reads past other sessions' uncommitted changes rather than waiting.</summary>
    public const string FactsIsolation = "SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;";

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
            or ActionTemplate.AddServerRoleMember or ActionTemplate.CreateUserForLogin or ActionTemplate.AlterUserSchema or ActionTemplate.CreateSchemaFor or ActionTemplate.AddRoleMember
            or ActionTemplate.RenameLogin or ActionTemplate.DropServerRoleMember or ActionTemplate.RenameUser or ActionTemplate.DropRoleMember => 2,
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

    /// <summary>The plan, or a throw when its names do not fit its template: the wrong count, or an @skipchecks that is not
    /// true or false. Every statement passes it before it runs or is scripted.</summary>
    public static PlannedStatement Checked(PlannedStatement plan)
    {
        if (plan.Names.Count != ParameterCount(plan.Template)) throw new InvalidOperationException("The plan has the wrong number of names for " + plan.Template + ".");
        if (plan.Template == ActionTemplate.DetachDatabase && plan.Names[1] is not ("true" or "false")) throw new InvalidOperationException("@skipchecks is true or false.");
        if (plan.Principal is { } bound && (!Guarded(plan.Template) || bound.Sid.Length is < 1 or > 85 || (plan.Template == ActionTemplate.DropLogin) != (bound.PrincipalId is not null && bound.Created is not null)))
            throw new InvalidOperationException("The principal binding does not fit " + plan.Template + ".");
        return plan;
    }

    /// <summary>The templates whose batch checks the principal it drops (<see cref="PrincipalBinding"/>): they never run without one.</summary>
    public static bool Guarded(ActionTemplate template) => template is ActionTemplate.DropMappedUser or ActionTemplate.DropLogin;

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
            ActionTemplate.DropUser or ActionTemplate.DropMappedUser => "DROP USER " + Quote(names[0]),
            // The role, then the member, as SMO writes it (captured by D2).
            ActionTemplate.AddServerRoleMember => "ALTER SERVER ROLE " + Quote(names[0]) + " ADD MEMBER " + Quote(names[1]),
            // User Mapping, each in its database, as SMO writes them (captured by D2): the user, then the login, schema or member.
            ActionTemplate.CreateUserForLogin => "CREATE USER " + Quote(names[0]) + " FOR LOGIN " + Quote(names[1]),
            ActionTemplate.AlterUserSchema => "ALTER USER " + Quote(names[0]) + " WITH DEFAULT_SCHEMA=" + Quote(names[1]),
            ActionTemplate.CreateSchemaFor => "CREATE SCHEMA " + Quote(names[0]) + " AUTHORIZATION " + Quote(names[1]),
            ActionTemplate.AddRoleMember => "ALTER ROLE " + Quote(names[0]) + " ADD MEMBER " + Quote(names[1]),
            // SMO's text for a login's rename (probed for D4 §5.3), with no spaces around the equals sign.
            ActionTemplate.RenameLogin => "ALTER LOGIN " + Quote(names[0]) + " WITH NAME=" + Quote(names[1]),
            ActionTemplate.DropLogin => "DROP LOGIN " + Quote(names[0]),
            // Learn's way to unlock without a password (D4 P12-P15): CHECK_POLICY = OFF unlocks and also turns expiration off, so
            // the second statement turns back on what the login had.
            ActionTemplate.CheckPolicyOff => "ALTER LOGIN " + Quote(names[0]) + " WITH CHECK_POLICY = OFF",
            ActionTemplate.CheckPolicyOn => "ALTER LOGIN " + Quote(names[0]) + " WITH CHECK_POLICY = ON",
            ActionTemplate.CheckPolicyExpirationOn => "ALTER LOGIN " + Quote(names[0]) + " WITH CHECK_POLICY = ON, CHECK_EXPIRATION = ON",
            // Login Properties (D2c), as SMO writes them (D2 §4): the role, then the member; the user, then its new name.
            ActionTemplate.DropServerRoleMember => "ALTER SERVER ROLE " + Quote(names[0]) + " DROP MEMBER " + Quote(names[1]),
            ActionTemplate.RenameUser => "ALTER USER " + Quote(names[0]) + " WITH NAME=" + Quote(names[1]),
            ActionTemplate.DropRoleMember => "ALTER ROLE " + Quote(names[0]) + " DROP MEMBER " + Quote(names[1]),
            _ => throw new InvalidOperationException("Unknown template " + plan.Template)
        };
    }

    /// <summary>SSMS's script of one statement: USE and GO around it (no USE before msdb's procedure, which names its database).</summary>
    public static string ScriptText(PlannedStatement plan) =>
        (plan.Template == ActionTemplate.DeleteBackupHistory ? "" : "USE " + Quote(plan.Database) + NL + "GO" + NL) + Statement(plan) + NL + "GO" + NL;

    /// <summary>The script of statements Varia runs in one transaction (Unlock): one batch under XACT_ABORT, as New Login's
    /// (critic A14), so a statement that fails when the script is run rolls back the ones before it, as Varia's run does.</summary>
    public static string TransactionScriptText(IReadOnlyList<PlannedStatement> plans)
    {
        if (plans.Count == 0 || plans.Any(plan => plan.Database != plans[0].Database || plan.Template == ActionTemplate.DeleteBackupHistory))
            throw new InvalidOperationException("A transaction's statements run in one database.");
        return "USE " + Quote(plans[0].Database) + NL + "GO" + NL + "SET XACT_ABORT ON;" + NL + "BEGIN TRANSACTION;" + NL
            + string.Concat(plans.Select(Checked).Select(plan => Statement(plan) + ";" + NL)) + "COMMIT TRANSACTION;" + NL + "GO" + NL;
    }

    /// <summary>The batch that runs a statement: SQL Server builds it from parameters (@db, then @p1… in the plan's name order).
    /// <paramref name="dryRun"/> (the live checks only, never the wire) selects what would run instead of running it.</summary>
    public static string Executable(ActionTemplate template, bool dryRun = false)
    {
        string Run(string build) => build + Guard + (dryRun ? "SELECT @stmt AS stmt;" : "DECLARE @module nvarchar(300) = QUOTENAME(@db) + N'.sys.sp_executesql';\nEXEC @module @stmt;");
        // A guarded DROP (PrincipalBinding): the dry run selects only the DROP, which Script Action shows.
        string Bound(string build, string arguments) => build + Guard + (dryRun ? "SELECT @drop AS stmt;" : "DECLARE @module nvarchar(300) = QUOTENAME(@db) + N'.sys.sp_executesql';\nEXEC @module @stmt, " + arguments);
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
            ActionTemplate.CreateUserForLogin => Run("DECLARE @stmt nvarchar(max) = N'CREATE USER ' + QUOTENAME(@p1) + N' FOR LOGIN ' + QUOTENAME(@p2);\n"),
            ActionTemplate.AlterUserSchema => Run("DECLARE @stmt nvarchar(max) = N'ALTER USER ' + QUOTENAME(@p1) + N' WITH DEFAULT_SCHEMA=' + QUOTENAME(@p2);\n"),
            // CREATE SCHEMA must be its batch's only statement, which sp_executesql gives it.
            ActionTemplate.CreateSchemaFor => Run("DECLARE @stmt nvarchar(max) = N'CREATE SCHEMA ' + QUOTENAME(@p1) + N' AUTHORIZATION ' + QUOTENAME(@p2);\n"),
            ActionTemplate.AddRoleMember => Run("DECLARE @stmt nvarchar(max) = N'ALTER ROLE ' + QUOTENAME(@p1) + N' ADD MEMBER ' + QUOTENAME(@p2);\n"),
            ActionTemplate.RenameLogin => Run("DECLARE @stmt nvarchar(max) = N'ALTER LOGIN ' + QUOTENAME(@p1) + N' WITH NAME=' + QUOTENAME(@p2);\n"),
            ActionTemplate.DropMappedUser => Bound("DECLARE @drop nvarchar(max) = N'DROP USER ' + QUOTENAME(@p1);\nDECLARE @stmt nvarchar(max) = " + UserCheck + " + @drop + " + UserRecheck + ";\n",
                UserParameters + ", @name = @p1, @sid = @sid;"),
            ActionTemplate.DropLogin => Bound("DECLARE @drop nvarchar(max) = N'DROP LOGIN ' + QUOTENAME(@p1);\nDECLARE @stmt nvarchar(max) = " + LoginCheck + " + @drop + " + LoginRecheck + ";\n",
                LoginParameters + ", @name = @p1, @sid = @sid, @principal = @principal, @created = @created;"),
            ActionTemplate.CheckPolicyOff => Run("DECLARE @stmt nvarchar(max) = N'ALTER LOGIN ' + QUOTENAME(@p1) + N' WITH CHECK_POLICY = OFF';\n"),
            ActionTemplate.CheckPolicyOn => Run("DECLARE @stmt nvarchar(max) = N'ALTER LOGIN ' + QUOTENAME(@p1) + N' WITH CHECK_POLICY = ON';\n"),
            ActionTemplate.CheckPolicyExpirationOn => Run("DECLARE @stmt nvarchar(max) = N'ALTER LOGIN ' + QUOTENAME(@p1) + N' WITH CHECK_POLICY = ON, CHECK_EXPIRATION = ON';\n"),
            ActionTemplate.DropServerRoleMember => Run("DECLARE @stmt nvarchar(max) = N'ALTER SERVER ROLE ' + QUOTENAME(@p1) + N' DROP MEMBER ' + QUOTENAME(@p2);\n"),
            ActionTemplate.RenameUser => Run("DECLARE @stmt nvarchar(max) = N'ALTER USER ' + QUOTENAME(@p1) + N' WITH NAME=' + QUOTENAME(@p2);\n"),
            ActionTemplate.DropRoleMember => Run("DECLARE @stmt nvarchar(max) = N'ALTER ROLE ' + QUOTENAME(@p1) + N' DROP MEMBER ' + QUOTENAME(@p2);\n"),
            _ => throw new InvalidOperationException("Unknown template " + template)
        };
    }

    /// <summary>A guarded DROP's check, in its database (inside sp_executesql, under the batch's READ COMMITTED and lock timeout, so it
    /// waits for any open change to the row): the principal with the planned name and binding, else 50010 before anything runs. The
    /// DROP and the recheck then run in one transaction: if the principal that was checked still exists, the DROP took another one
    /// that had the name by then, and 50010 rolls it back (XACT_ABORT). The texts are constant: no name reaches a message.</summary>
    internal const string UserCheck = "N'DECLARE @principal int = (SELECT u.principal_id FROM sys.database_principals AS u WHERE u.name = @name AND u.sid = @sid); "
        + "IF @principal IS NULL THROW 50010, N''The database user is no longer the one mapped to the login: it was renamed, remapped or dropped since it was read. Nothing was dropped in its database.'', 1; BEGIN TRANSACTION; '";
    internal const string UserRecheck = "N'; IF EXISTS (SELECT 1 FROM sys.database_principals AS u WHERE u.principal_id = @principal) THROW 50010, N''The database user changed while it was dropped. Nothing was dropped in its database.'', 1; COMMIT TRANSACTION;'";
    internal const string UserParameters = "N'@name sysname, @sid varbinary(85)'";
    internal const string LoginCheck = "N'IF NOT EXISTS (SELECT 1 FROM sys.server_principals AS p WHERE p.name = @name AND p.sid = @sid AND p.principal_id = @principal AND p.create_date = @created) "
        + "THROW 50010, N''The login is no longer the one that was read: it was renamed, dropped or replaced since. It was not dropped.'', 1; BEGIN TRANSACTION; '";
    internal const string LoginRecheck = "N'; IF EXISTS (SELECT 1 FROM sys.server_principals AS p WHERE p.principal_id = @principal) THROW 50010, N''The login changed while it was dropped. It was not dropped.'', 1; COMMIT TRANSACTION;'";
    internal const string LoginParameters = "N'@name sysname, @sid varbinary(85), @principal int, @created datetime'";
    private static readonly string[] GuardedTexts = [UserCheck, UserRecheck, UserParameters, LoginCheck, LoginRecheck, LoginParameters];
    /// <summary>The variables a guarded batch binds besides its names (RunStatementAsync, from the plan's PrincipalBinding).</summary>
    public static IReadOnlyList<string> Bindings(ActionTemplate template) => template switch
    {
        ActionTemplate.DropMappedUser => ["@sid"],
        ActionTemplate.DropLogin => ["@sid", "@principal", "@created"],
        _ => []
    };

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
    /// the describe runs once Database's guarded count says it has the permission read them (DatabaseUse, DatabaseSessions,
    /// TransactionSessions), never Database, which every database action runs.</summary>
    private const string InTransaction = "EXISTS (SELECT 1 FROM sys.dm_tran_session_transactions AS st JOIN sys.dm_tran_database_transactions AS dt ON dt.transaction_id = st.transaction_id "
        + "WHERE st.session_id = es.session_id AND dt.database_id = d.database_id)";
    private const string UsesDatabase = "(es.database_id = d.database_id OR " + InTransaction + ")";
    /// <summary>A session that uses the database (UsesDatabase) with an open transaction, which closing its connections rolls back.</summary>
    private const string HoldsTransaction = "((es.database_id = d.database_id AND es.open_transaction_count > 0) OR " + InTransaction + ")";

    /// <summary>A database's row in master: state, user access, subtype, what blocks a DROP (replication, an availability group,
    /// mirroring, its own database snapshots), owner, the sessions in it and those with an open transaction (with VIEW SERVER STATE,
    /// else null; DatabaseUse adds those with a transaction there from elsewhere), permissions and whether @new is another database's name. The owner falls back to SUSER_SNAME(d.owner_sid): a Windows
    /// group's member owns it with no server principal of its own.</summary>
    public const string Database = "SELECT d.database_id AS database_id, d.state AS state, d.state_desc AS state_desc, d.user_access AS user_access, "
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
        + "CONVERT(bit, CASE WHEN ISNULL(HAS_PERMS_BY_NAME(d.name, N'DATABASE', N'CONTROL'), 1) = 1 OR HAS_PERMS_BY_NAME(NULL, NULL, N'ALTER ANY DATABASE') = 1 THEN 1 ELSE 0 END) AS can_drop, "
        + "CONVERT(bit, CASE WHEN EXISTS (SELECT 1 FROM sys.databases AS x WHERE x.name = @new AND x.database_id <> d.database_id) THEN 1 ELSE 0 END) AS name_in_use "
        + "FROM sys.databases AS d LEFT JOIN sys.database_mirroring AS dm ON dm.database_id = d.database_id LEFT JOIN sys.server_principals AS sp ON sp.sid = d.owner_sid "
        + "WHERE d.name = @name;";

    /// <summary>The login preflight (D4 §6), in master: the login's row (type, state, SID, policy flags, CONNECT SQL denied,
    /// whether it is this connection's own login or a Windows group it gets in through, sysadmin membership, its sessions with
    /// VIEW SERVER STATE, what it owns, the permissions to change it, and whether @new is another principal's name), then at
    /// most @take names of the databases it owns. Catalog views only, never LOGINPROPERTY's locks; under READ COMMITTED (an
    /// execute's preflight) the row still waits behind another session's uncommitted ALTER LOGIN, until Stop. Every other read
    /// seeks the login's own rows (CONNECT SQL by its class, major and minor id too), except the owned counts and names, which
    /// scan every principal, database and endpoint: <see cref="LoginAlter"/> leaves them out.</summary>
    public const string Login = LoginHead + LoginOwned + LoginTail + ";\n"
        + "SELECT TOP (@take) d.name AS database_name FROM sys.databases AS d JOIN sys.server_principals AS p ON p.sid = d.owner_sid "
        + "WHERE p.name = @name AND p.type IN ('S', 'U', 'G', 'C', 'K', 'E', 'X') ORDER BY d.name;";

    /// <summary>The preflight of the verbs that ALTER LOGIN (Disable, Enable, Rename): <see cref="Login"/> without what the login
    /// owns. Under READ COMMITTED those scans would wait behind any other session's open change to any principal (a New Login in
    /// its transaction, another login's ALTER), which the ALTER LOGIN itself does not.</summary>
    public const string LoginAlter = LoginHead + LoginTail + ";";

    private const string LoginHead = "SELECT p.principal_id AS principal_id, p.name AS name, p.type AS principal_type, p.is_disabled AS is_disabled, CONVERT(varchar(172), p.sid, 2) AS sid_hex, "
        + "p.create_date AS create_date, l.is_policy_checked AS policy_checked, l.is_expiration_checked AS expiration_checked, "
        + "CONVERT(bit, CASE WHEN EXISTS (SELECT 1 FROM sys.server_permissions AS sp WHERE sp.class = 100 AND sp.major_id = 0 AND sp.minor_id = 0 AND sp.grantee_principal_id = p.principal_id "
        + "AND sp.type = 'COSQ' AND sp.state = 'D') THEN 1 ELSE 0 END) AS connect_denied, "
        + "CONVERT(bit, CASE WHEN EXISTS (SELECT 1 FROM sys.login_token AS t WHERE t.principal_id = p.principal_id AND t.usage = N'GRANT OR DENY') THEN 1 ELSE 0 END) AS is_own, "
        + "CONVERT(bit, CASE WHEN EXISTS (SELECT 1 FROM sys.server_role_members AS m JOIN sys.server_principals AS r ON r.principal_id = m.role_principal_id "
        + "WHERE m.member_principal_id = p.principal_id AND r.name = N'sysadmin') THEN 1 ELSE 0 END) AS is_sysadmin, "
        + "CASE WHEN HAS_PERMS_BY_NAME(NULL, NULL, N'VIEW SERVER STATE') = 1 THEN (SELECT COUNT(*) FROM sys.dm_exec_sessions AS es WHERE es.security_id = p.sid AND es.is_user_process = 1) END AS sessions, ";
    /// <summary>What the login owns (server roles, endpoints and availability groups: 15141), and the server permissions it granted
    /// to other principals (DROP LOGIN fails on them, 15173).</summary>
    private const string LoginOwned = "(SELECT COUNT(*) FROM sys.databases AS d WHERE d.owner_sid = p.sid) AS owned_databases, "
        + "(SELECT COUNT(*) FROM sys.server_principals AS o WHERE o.owning_principal_id = p.principal_id) + (SELECT COUNT(*) FROM sys.endpoints AS e WHERE e.principal_id = p.principal_id) "
        + "+ (SELECT COUNT(DISTINCT ar.group_id) FROM sys.availability_replicas AS ar WHERE ar.owner_sid = p.sid) AS owned_server_objects, "
        + "(SELECT COUNT(*) FROM sys.server_permissions AS g WHERE g.grantor_principal_id = p.principal_id AND g.grantee_principal_id <> p.principal_id) AS granted_permissions, ";
    private const string LoginTail = "CONVERT(bit, ISNULL(HAS_PERMS_BY_NAME(NULL, NULL, N'ALTER ANY LOGIN'), 0)) AS can_alter, "
        + "CONVERT(bit, ISNULL(HAS_PERMS_BY_NAME(NULL, NULL, N'CONTROL SERVER'), 0)) AS can_control_server, "
        + "CONVERT(bit, CASE WHEN EXISTS (SELECT 1 FROM sys.server_principals AS x WHERE x.name = @new AND x.principal_id <> p.principal_id) THEN 1 ELSE 0 END) AS name_in_use "
        + "FROM sys.server_principals AS p LEFT JOIN sys.sql_logins AS l ON l.principal_id = p.principal_id "
        + "WHERE p.name = @name AND p.type IN ('S', 'U', 'G', 'C', 'K', 'E', 'X')";

    /// <summary>A login's lock-out state (D4d): the only Varia statement that may call LOGINPROPERTY (critic A15), and only for
    /// <see cref="LoginLockProperties"/>, of @name, the login the preflight found. Catalog views do not hold this state. LOGINPROPERTY
    /// waits for another session's open change to that login whatever the isolation level (D4 P8; other logins' changes do not hold
    /// it), so it runs only in an action's own connection: Unlock's describe gives up after the read lock timeout (BLOCKED), and its
    /// execute waits until Stop, as the ALTER LOGIN after it would.</summary>
    public const string LoginLock = "SELECT CONVERT(int, LOGINPROPERTY(@name, N'IsLocked')) AS is_locked, CONVERT(int, LOGINPROPERTY(@name, N'BadPasswordCount')) AS bad_passwords, "
        + "CONVERT(datetime, LOGINPROPERTY(@name, N'LockoutTime')) AS lockout_time, CONVERT(int, LOGINPROPERTY(@name, N'IsMustChange')) AS must_change, "
        + "CONVERT(int, LOGINPROPERTY(@name, N'IsExpired')) AS is_expired, CONVERT(int, LOGINPROPERTY(@name, N'DaysUntilExpiration')) AS days_until_expiration;";
    /// <summary>The properties <see cref="LoginLock"/> may read. Never PasswordHash or PasswordHashAlgorithm, which every lint refuses.</summary>
    public static readonly IReadOnlyList<string> LoginLockProperties = ["IsLocked", "BadPasswordCount", "LockoutTime", "IsMustChange", "IsExpired", "DaysUntilExpiration"];

    /// <summary>The sessions this backend's process (@pid) holds in a database, bounded by its own connections: the action keeps
    /// those its pooled connections were given, which a cleared pool leaves for a moment before the server ends them. Without VIEW
    /// SERVER STATE only this session is visible: none.</summary>
    public const string OwnSessions = "SELECT es.session_id AS session_id FROM sys.dm_exec_sessions AS es JOIN sys.databases AS d ON d.database_id = es.database_id "
        + "WHERE d.name = @name AND es.host_process_id = @pid AND es.session_id <> @@SPID;";

    /// <summary>The services that run as a Windows login (D4 §5.4), at most loginLimits.serviceNames: the account compared without
    /// case (a server may write NT Service\MSSQLSERVER), and LocalSystem as NT AUTHORITY\SYSTEM. It needs VIEW SERVER STATE, and
    /// whether Linux and Managed Instance have the view is unverified, so a failure is no answer, never the describe's.</summary>
    public const string LoginService = "SELECT TOP (@take) s.servicename AS service_name FROM sys.dm_server_services AS s "
        + @"WHERE UPPER(s.service_account) = UPPER(@name) OR (UPPER(s.service_account) = N'LOCALSYSTEM' AND UPPER(@name) = N'NT AUTHORITY\SYSTEM') "
        + "ORDER BY s.servicename;";
    /// <summary>The databases the mapped-user scan reads (D4 §5.4), in master: first how many databases the server has in all (its own
    /// statement, so a connection that may read none still learns how many it did not check), then at most @take online databases this
    /// login can open (HAS_DBACCESS) and whose users it can see (VIEW DEFINITION: without it sys.database_principals hides other users),
    /// by name, with whether each is read-only and whether this login may drop users there (ALTER ANY USER): no DROP USER runs where
    /// either fails. The ones left out (offline, restoring, not accessible or readable, past @take) count as not checked. Snapshots
    /// are read-only copies of a database the scan reads, so they are neither read nor counted.</summary>
    public const string LoginDatabases = "SELECT COUNT(*) AS total FROM sys.databases AS a WHERE a.source_database_id IS NULL;\n"
        + "SELECT TOP (@take) d.name AS database_name, d.is_read_only AS is_read_only, CONVERT(bit, ISNULL(HAS_PERMS_BY_NAME(d.name, N'DATABASE', N'ALTER ANY USER'), 0)) AS can_drop "
        + "FROM sys.databases AS d WHERE d.state = 0 AND d.source_database_id IS NULL AND HAS_DBACCESS(d.name) = 1 "
        + "AND ISNULL(HAS_PERMS_BY_NAME(d.name, N'DATABASE', N'VIEW DEFINITION'), 0) = 1 ORDER BY d.name;";

    /// <summary>Inside one database (through <see cref="MappedUserCall"/>): at most @take users mapped to the login's SID, by name,
    /// with what DROP USER fails on: the schemas (15138) and roles (15421) each owns, the other securables it owns (15138, 15183: an
    /// object it owns apart from its schema, a type, an XML schema collection, an assembly, a certificate or key, a full-text catalog,
    /// stoplist or search property list, a Service Broker service, contract, message type, route or binding, a database scoped
    /// credential), and the permissions it granted to others (15284). dbo, guest, INFORMATION_SCHEMA and sys (principal_id 1 to 4)
    /// are never dropped: a login that owns the database is dbo there, and that ownership blocks its DROP anyway.</summary>
    public const string MappedUser = "SELECT TOP (@take) u.name AS user_name, (SELECT COUNT(*) FROM sys.schemas AS s WHERE s.principal_id = u.principal_id) AS owned_schemas, "
        + "(SELECT COUNT(*) FROM sys.database_principals AS r WHERE r.owning_principal_id = u.principal_id) AS owned_roles, "
        + "(SELECT COUNT(*) FROM sys.objects AS o WHERE o.principal_id = u.principal_id) + (SELECT COUNT(*) FROM sys.types AS t WHERE t.principal_id = u.principal_id) "
        + "+ (SELECT COUNT(*) FROM sys.xml_schema_collections AS x WHERE x.principal_id = u.principal_id) + (SELECT COUNT(*) FROM sys.assemblies AS a WHERE a.principal_id = u.principal_id) "
        + "+ (SELECT COUNT(*) FROM sys.certificates AS c WHERE c.principal_id = u.principal_id) + (SELECT COUNT(*) FROM sys.asymmetric_keys AS ak WHERE ak.principal_id = u.principal_id) "
        + "+ (SELECT COUNT(*) FROM sys.symmetric_keys AS sk WHERE sk.principal_id = u.principal_id) + (SELECT COUNT(*) FROM sys.fulltext_catalogs AS fc WHERE fc.principal_id = u.principal_id) "
        + "+ (SELECT COUNT(*) FROM sys.fulltext_stoplists AS fs WHERE fs.principal_id = u.principal_id) + (SELECT COUNT(*) FROM sys.registered_search_property_lists AS pl WHERE pl.principal_id = u.principal_id) "
        + "+ (SELECT COUNT(*) FROM sys.services AS sv WHERE sv.principal_id = u.principal_id) + (SELECT COUNT(*) FROM sys.service_contracts AS sc WHERE sc.principal_id = u.principal_id) "
        + "+ (SELECT COUNT(*) FROM sys.service_message_types AS mt WHERE mt.principal_id = u.principal_id) + (SELECT COUNT(*) FROM sys.routes AS ro WHERE ro.principal_id = u.principal_id) "
        + "+ (SELECT COUNT(*) FROM sys.remote_service_bindings AS rb WHERE rb.principal_id = u.principal_id) "
        + "+ (SELECT COUNT(*) FROM sys.database_scoped_credentials AS dc WHERE dc.principal_id = u.principal_id) AS owned_securables, "
        + "(SELECT COUNT(*) FROM sys.database_permissions AS g WHERE g.grantor_principal_id = u.principal_id AND g.grantee_principal_id <> u.principal_id) AS granted_permissions "
        + "FROM sys.database_principals AS u WHERE u.sid = @sid AND u.type IN ('S', 'U', 'G', 'C', 'K', 'E', 'X') AND u.principal_id > 4 ORDER BY u.name;";
    /// <summary>Runs <see cref="MappedUser"/> (@stmt) in a database, which reaches T-SQL only through QUOTENAME.</summary>
    public const string MappedUserCall = "DECLARE @module nvarchar(300) = QUOTENAME(@db) + N'.sys.sp_executesql';\n"
        + "EXEC @module @stmt, N'@sid varbinary(85), @take int', @sid = @sid, @take = @take;";

    /// <summary>The SQL Server Agent jobs a login owns (DROP LOGIN fails on them, 15170). A login that cannot read msdb's job table
    /// gets no answer, never a failed describe.</summary>
    public const string LoginJobs = "SELECT COUNT(*) AS jobs FROM msdb.dbo.sysjobs AS j WHERE j.owner_sid = @sid;";

    /// <summary>Delete Object's counts of a database's sessions (D3 §8): those using it (UsesDatabase) and those with an open transaction
    /// there (HoldsTransaction), never this one. Only with VIEW SERVER STATE (InTransaction): without it the describe counts none (unknown).</summary>
    public const string DatabaseUse = "SELECT (SELECT COUNT(*) FROM sys.dm_exec_sessions AS es WHERE es.session_id <> @@SPID AND " + UsesDatabase + ") AS sessions, "
        + "(SELECT COUNT(*) FROM sys.dm_exec_sessions AS es WHERE es.session_id <> @@SPID AND " + HoldsTransaction + ") AS with_transaction "
        + "FROM sys.databases AS d WHERE d.name = @name;";

    /// <summary>The sessions using a database (UsesDatabase) that Delete Object lists (D3 §8), each with whether it holds an open
    /// transaction (HoldsTransaction): at most @take by session id, never this one. Only with VIEW SERVER STATE (InTransaction): without
    /// it the describe lists none (unknown); the action leaves out the backend's pooled sessions.</summary>
    public const string DatabaseSessions = "SELECT TOP (@take) es.session_id AS session_id, es.host_process_id AS host_process_id, "
        + "CONVERT(int, CASE WHEN " + HoldsTransaction + " THEN 1 ELSE 0 END) AS open_transaction, es.program_name AS program_name, es.host_name AS host_name "
        + "FROM sys.dm_exec_sessions AS es CROSS JOIN sys.databases AS d WHERE d.name = @name AND es.session_id <> @@SPID AND " + UsesDatabase + " ORDER BY es.session_id;";

    /// <summary>This process's sessions (@pid) with an open transaction in the database or while in it (HoldsTransaction), at most @take
    /// by session id, never this one: the action keeps the query tabs' (A7). Only with VIEW SERVER STATE (InTransaction).</summary>
    public const string TransactionSessions = "SELECT TOP (@take) es.session_id AS session_id FROM sys.dm_exec_sessions AS es CROSS JOIN sys.databases AS d "
        + "WHERE d.name = @name AND es.host_process_id = @pid AND es.session_id <> @@SPID AND " + HoldsTransaction + " ORDER BY es.session_id;";

    // --- Lint -----------------------------------------------------------------------------------------------------------

    private static readonly HashSet<string> Literals =
    [
        "N'.'", "N'.sys.sp_executesql'", "N'.sys.sp_rename'", "N'OBJECT'", "N'SCHEMA'", "N'DATABASE'", "N'ALTER'", "N'CONTROL'", "N'VIEW SERVER STATE'", "N'ALTER ANY DATABASE'",
        "N'A name could not be quoted.'", "N'DROP TABLE '", "N'DROP VIEW '", "N'DROP PROCEDURE '", "N'DROP FUNCTION '", "N'DROP DATABASE '", "N'ALTER DATABASE '",
        "N' MODIFY NAME = '", "N' SET  SINGLE_USER WITH ROLLBACK IMMEDIATE'",
        // The shared templates (critic A21).
        "N' SET  MULTI_USER'", "N' SET  RESTRICTED_USER'", "N'ALTER LOGIN '", "N' DISABLE'", "N' ENABLE'", "N'DENY CONNECT SQL TO '", "N'GRANT CONNECT SQL TO '", "N'DROP USER '",
        // New Login's server roles (Actions/LoginSql), and its describe's and preflight's server facts.
        "N'ALTER SERVER ROLE '", "N' ADD MEMBER '", "'IsIntegratedSecurityOnly'",
        // Its User Mapping's statements, and its describe's guest CONNECT state (LoginSql.DatabaseRoles).
        "N'CREATE USER '", "N' FOR LOGIN '", "N'ALTER USER '", "N' WITH DEFAULT_SCHEMA='", "N'CREATE SCHEMA '", "N' AUTHORIZATION '", "N'ALTER ROLE '",
        // The login preflight (Login), a login's rename, and the service lookup (LoginService).
        "N'GRANT OR DENY'", "N'ALTER ANY LOGIN'", "N'CONTROL SERVER'", "'COSQ'", "N' WITH NAME='", "N'LOCALSYSTEM'", @"N'NT AUTHORITY\SYSTEM'",
        // A login's Delete (D4c): DROP LOGIN and the mapped-user scan's call (MappedUserCall).
        "N'DROP LOGIN '", "N'@sid varbinary(85), @take int'", "N'VIEW DEFINITION'", "N'ALTER ANY USER'",
        // Its guarded DROPs (PrincipalBinding).
        UserCheck, UserRecheck, UserParameters, LoginCheck, LoginRecheck, LoginParameters,
        // Unlock's password policy statements (D4d).
        "N' WITH CHECK_POLICY = OFF'", "N' WITH CHECK_POLICY = ON'", "N' WITH CHECK_POLICY = ON, CHECK_EXPIRATION = ON'",
        // Login Properties' server role and database role removals (D2c); its user rename is a login rename's N' WITH NAME='.
        "N' DROP MEMBER '",
        // Database Properties' describe and preflight (DatabaseProperties.cs, ActionService.DatabasePropertiesPreflight).
        "N'contained database authentication'", "N'sysadmin'", "N'##%'", "N'SpaceUsed'", "N'@take int'", "N'MAXDOP'", "N'LEGACY_CARDINALITY_ESTIMATION'", "N'PARAMETER_SNIFFING'",
        "N'QUERY_OPTIMIZER_HOTFIXES'", "'FilestreamEffectiveLevel'", "'EngineEdition'", "'ProductMajorVersion'",
        // The table designer's master facts and its describe's collation probes (Designer/DesignerSql).
        "N'CREATE TABLE'", "N'a'", "N'A'", "N'e'"
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
    [GeneratedRegex(@"QUOTENAME\(@p\d+\)|(?<=EXEC [^;]*= )@p\d+(?=[,;])|(?<=SELECT )@p\d+(?= AS )|, @p\d+(?= AS )")]
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
        var parameters = Enumerable.Range(1, ParameterCount(template)).Select(index => "@p" + index.ToString(CultureInfo.InvariantCulture)).Append("@db").Concat(Bindings(template)).ToHashSet(StringComparer.Ordinal);
        foreach (Match used in Placeholder().Matches(text)) if (!parameters.Contains(used.Value)) problems.Add("uses " + used.Value + ", which the template does not bind");
        // A guarded DROP's constant check and recheck are sp_executesql's own batch, whose variables its constant parameter list declares.
        problems.AddRange(Undeclared(GuardedTexts.Aggregate(text, (rest, inner) => rest.Replace(inner, "N''", StringComparison.Ordinal)), parameters));
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
    /// <summary>A JSON text column of an OPENJSON WITH clause (not AS JSON): a value from the request.</summary>
    [GeneratedRegex(@"(\[?\w+\]?) nvarchar\(max\)(?! AS JSON)")]
    private static partial Regex JsonText();
    /// <summary>An OPENJSON WITH clause's columns (its alias is one lowercase letter).</summary>
    [GeneratedRegex(@"OPENJSON\([^)]*\) WITH \((.*?)\) AS [a-z](?=[ ;\n])")]
    private static partial Regex WithClause();
    [GeneratedRegex(@"\b\w+\.(\[?\w+\]?)")]
    private static partial Regex Qualified();
    /// <summary>A row of the builders' constant type table: (id, N'keyword', form, lob).</summary>
    [GeneratedRegex(@"\(\d+, (N'[^']*'), \d, [01]\)")]
    private static partial Regex TypeRow();
    [GeneratedRegex(@"DECLARE ([^;]*);")]
    private static partial Regex Declaration();
    [GeneratedRegex(@"(?:^|, )(@\w+) ")]
    private static partial Regex DeclaredName();

    /// <summary>Problems with one of the table designer's builder batches (Designer/DesignerSql.Builder), which has SQL Server
    /// shred one JSON parameter and compose the statement: a format hole, no quoting guard, @db outside QUOTENAME, @design
    /// outside ISJSON or OPENJSON, a JSON text value used anywhere but inside QUOTENAME, a JSON array or element used
    /// anywhere but OPENJSON (or an index's CONVERT to int), an undeclared variable, and a literal that is neither one of the
    /// rules' messages nor keyword text (a type keyword must be one of the catalogue's).</summary>
    public static List<string> LintExecutable(string text, DesignBuilderRules rules)
    {
        var problems = new List<string>();
        if (text.Contains('{', StringComparison.Ordinal) || text.Contains('}', StringComparison.Ordinal)) problems.Add("has a format hole");
        problems.AddRange(SecretUses(text));
        if (!text.Contains(Guard, StringComparison.Ordinal)) problems.Add("has no quoting guard");
        if (Variable().Matches(text.Replace("QUOTENAME(@db)", "", StringComparison.Ordinal)).Any(used => used.Value == "@db")) problems.Add("uses @db outside QUOTENAME");
        if (Variable().Matches(text.Replace("ISJSON(@design)", "", StringComparison.Ordinal).Replace("OPENJSON(@design)", "", StringComparison.Ordinal)).Any(used => used.Value == "@design"))
            problems.Add("uses @design outside ISJSON or OPENJSON");
        // JSON text (a name) reaches the statement only as QUOTENAME(alias.column).
        var texts = WithClause().Matches(text).SelectMany(clause => JsonText().Matches(clause.Groups[1].Value)).Select(match => match.Groups[1].Value.Trim('[', ']')).ToHashSet(StringComparer.Ordinal);
        foreach (Match used in Qualified().Matches(text))
        {
            var column = used.Groups[1].Value.Trim('[', ']');
            if (texts.Contains(column) && !(text[..used.Index].EndsWith("QUOTENAME(", StringComparison.Ordinal) && text[(used.Index + used.Length)..].StartsWith(')')))
                problems.Add("uses the JSON text " + used.Value + " outside QUOTENAME");
            if (column == "value" && !(text[..used.Index].EndsWith("OPENJSON(", StringComparison.Ordinal) || text[..used.Index].EndsWith("CONVERT(int, ", StringComparison.Ordinal)))
                problems.Add("uses " + used.Value + " outside OPENJSON or an index's CONVERT");
        }
        foreach (var json in new[] { "@columns", "@key" })
        {
            var rest = text.Replace("OPENJSON(" + json + ")", "", StringComparison.Ordinal).Replace(json + " = d.", "", StringComparison.Ordinal).Replace(json + " IS NULL", "", StringComparison.Ordinal)
                .Replace(json + " nvarchar(max)", "", StringComparison.Ordinal);
            if (Variable().Matches(rest).Any(used => used.Value == json)) problems.Add("uses " + json + " outside OPENJSON");
        }
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
        var stripped = text.Replace(OwnerFallback, "", StringComparison.Ordinal);
        foreach (var builtin in CatalogSql.Builtins) if (stripped.Contains(builtin, StringComparison.OrdinalIgnoreCase)) problems.Add("uses " + builtin);
        problems.AddRange(CatalogSql.SecretUses(text));
        if (stripped.Contains("DB_NAME(", StringComparison.OrdinalIgnoreCase) || stripped.Contains("OBJECT_ID(", StringComparison.OrdinalIgnoreCase)) problems.Add("uses a metadata function");
        if (database && text.Contains("HAS_DBACCESS(", StringComparison.OrdinalIgnoreCase)) problems.Add("uses HAS_DBACCESS inside a database");
        foreach (var (token, since) in CatalogSql.Gates) if (band < since && text.Contains(token, StringComparison.Ordinal)) problems.Add("uses " + token + " below band " + since);
        foreach (Match literal in LiteralPattern().Matches(text))
            if (!Literals.Contains(literal.Value) && !TypeLetters().IsMatch(literal.Value)) problems.Add("has the literal " + literal.Value);
        if (database && text.Contains("@db", StringComparison.Ordinal)) problems.Add("names @db inside a statement");
        if (Placeholder().IsMatch(text)) problems.Add("uses a DDL name parameter");
        return problems;
    }

    /// <summary>A LOGINPROPERTY call LoginLock's lint accepts: of @name, with one property literal.</summary>
    [GeneratedRegex(@"\bLOGINPROPERTY\(@name, N'(\w+)'\)")]
    private static partial Regex LockPropertyCall();

    /// <summary>Problems with the one statement that may call LOGINPROPERTY (<see cref="LoginLock"/>, critic A15): a call of any other
    /// form or property (PasswordHash above all), and then whatever LintCatalog finds in the rest, LOGINPROPERTY included.</summary>
    public static List<string> LintLoginLock(string text)
    {
        var problems = new List<string>();
        foreach (Match call in LockPropertyCall().Matches(text))
            if (!LoginLockProperties.Contains(call.Groups[1].Value)) problems.Add("reads the login property " + call.Groups[1].Value);
        if (!LockPropertyCall().IsMatch(text)) problems.Add("reads no login property");
        problems.AddRange(LintCatalog(LockPropertyCall().Replace(text, "NULL"), ExplorerCatalog.MaxBand, database: false));
        return problems;
    }

    private static IEnumerable<string> Undeclared(string text, HashSet<string> parameters)
    {
        var declared = Declared().Matches(text).Select(match => match.Groups[1].Value).ToHashSet(StringComparer.Ordinal);
        // A procedure's own parameter names ("@name = " after EXEC) are the callee's; every value passed, as every other use, is declared or bound.
        var exec = text.IndexOf("EXEC ", StringComparison.Ordinal);
        var callee = exec < 0 ? [] : NamedArgument().Matches(text).Where(match => match.Index > exec).Select(match => match.Index).ToHashSet();
        foreach (Match used in Variable().Matches(text))
            if (!callee.Contains(used.Index) && !declared.Contains(used.Value) && !parameters.Contains(used.Value)) yield return "uses the undeclared " + used.Value;
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
        yield return ("login alter", LintCatalog(LoginAlter, ExplorerCatalog.MaxBand, database: false));
        yield return ("login lock", LintLoginLock(LoginLock));
        yield return ("login service", LintCatalog(LoginService, ExplorerCatalog.MaxBand, database: false));
        yield return ("login databases", LintCatalog(LoginDatabases, ExplorerCatalog.MaxBand, database: false));
        yield return ("mapped user", LintCatalog(MappedUser, ExplorerCatalog.MaxBand, database: true));
        yield return ("mapped user call", LintCatalog(MappedUserCall, ExplorerCatalog.MaxBand, database: false));
        yield return ("login jobs", LintCatalog(LoginJobs, ExplorerCatalog.MaxBand, database: false));
        yield return ("own sessions", LintCatalog(OwnSessions, ExplorerCatalog.MaxBand, database: false));
        yield return ("database use", LintCatalog(DatabaseUse, ExplorerCatalog.MaxBand, database: false));
        yield return ("database sessions", LintCatalog(DatabaseSessions, ExplorerCatalog.MaxBand, database: false));
        yield return ("transaction sessions", LintCatalog(TransactionSessions, ExplorerCatalog.MaxBand, database: false));
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
        // New Login: its describe and preflight in master, and every CREATE LOGIN its builder can write, run and dry run.
        yield return ("new login describe", LintCatalog(LoginSql.Describe, ExplorerCatalog.MaxBand, database: false));
        yield return ("new login preflight", LintCatalog(LoginSql.Preflight, ExplorerCatalog.MaxBand, database: false));
        // User Mapping: its read of a database and its per-database preflight, each run inside the database through ModuleCall.
        yield return ("login database roles", LintCatalog(LoginSql.DatabaseRoles, ExplorerCatalog.MaxBand, database: true));
        yield return ("login mapping preflight", LintCatalog(LoginSql.MappingPreflight, ExplorerCatalog.MaxBand, database: true));
        foreach (var item in LoginSql.Lint()) yield return item;
        // Login Properties (D2c): its read of the login in master, a login's SID by name, and the users mapped to it inside a database.
        yield return ("login properties read", LintCatalog(LoginSql.PropertiesRead, ExplorerCatalog.MaxBand, database: false));
        yield return ("login sid", LintCatalog(LoginSql.LoginSid, ExplorerCatalog.MaxBand, database: false));
        yield return ("login properties mapped user", LintCatalog(LoginSql.PropertiesMappedUser, ExplorerCatalog.MaxBand, database: true));
        yield return ("login database user", LintCatalog(LoginSql.DatabaseUser, ExplorerCatalog.MaxBand, database: true));
    }
}

/// <summary>What a table designer builder batch may hold besides keyword text: its fixed messages and module suffix, and
/// the catalogue's type keywords.</summary>
internal sealed record DesignBuilderRules(IReadOnlySet<string> Messages, IReadOnlySet<string> TypeNames);
