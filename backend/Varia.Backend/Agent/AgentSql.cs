using System.Data;
using System.Text.RegularExpressions;
using Varia.Backend.Explorer;
using Varia.Backend.Live;

namespace Varia.Backend.Agent;

/// <summary>A parameter of an Agent read statement, with its SQL type and size.</summary>
internal sealed record AgentParameter(string Name, SqlDbType Type, int Size = 0);

/// <summary>One Agent read statement: constant text with values as parameters, the columns the reader takes from its first
/// result set (an msdb procedure returns more, and its column set varies by version, so these are read by name), and the
/// catalogue limit that caps its rows.</summary>
internal sealed record AgentStatement(string Id, string Text, IReadOnlyList<string> Columns, IReadOnlyList<AgentParameter> Parameters, string Cap);

/// <summary>SQL Server Agent's read statements and their lint (docs/agent-plan.md › SQL rules). Every Agent read that EXECs, in
/// any caller (live, listing, Search Objects, describe), is checked by <see cref="LintRead"/>: <see cref="LiveSql.Lint"/>'s
/// rules, plus two exemptions. A statement may be exactly <c>EXEC msdb.dbo.&lt;procedure&gt; @arg = @param, …;</c> for a
/// procedure the catalogue lists, with named arguments each a parameter or one of its listed constants, or one of the
/// catalogue's master shapes; and the prologue it must start with is its caller's (null for describes, whose prologue runs as
/// its own command). Names never enter the text, so nothing needs QUOTENAME. The job verbs' writes and their lint are in AgentSql.Writes.cs (AG-2).</summary>
internal static partial class AgentSql
{
    private static readonly string[] JobColumns = ["job_id", "name", "enabled", "category", "owner", "date_created", "date_modified", "version_number", "last_run_date", "last_run_time",
        "last_run_outcome", "next_run_date", "next_run_time", "current_execution_status", "current_execution_step"];

    /// <summary>Whether Agent XPs is on (value_in_use, which RECONFIGURE installs) and how many Agent sessions this login sees.
    /// Below VIEW SERVER PERFORMANCE STATE the session count reads 0 without an error (AG-0), so only a sysadmin's or a
    /// permitted login's count means anything.</summary>
    public static readonly AgentStatement State = new("state",
        "SELECT CONVERT(int, c.value_in_use) AS agent_xps, (SELECT COUNT(*) FROM sys.dm_exec_sessions AS s WHERE s.program_name LIKE N'SQLAgent - %') AS agent_sessions\n"
        + "FROM sys.configurations AS c WHERE c.configuration_id = 16384;", ["agent_xps", "agent_sessions"], [], "listRows");

    /// <summary>Every job the login may see, one result set (role-filtered by msdb).</summary>
    public static readonly AgentStatement Jobs = new("jobs", "EXEC msdb.dbo.sp_help_job;", JobColumns, [], "listRows");

    /// <summary>One job's row only (`@job_aspect = N'JOB'` gives one result set instead of four).</summary>
    public static readonly AgentStatement Job = new("job", "EXEC msdb.dbo.sp_help_job @job_id = @job_id, @job_aspect = N'JOB';", JobColumns, [new("@job_id", SqlDbType.UniqueIdentifier)], "listRows");

    /// <summary>The job's activity rows, which carry a running job's start time for every Agent role.</summary>
    public static readonly AgentStatement Activity = new("activity", "EXEC msdb.dbo.sp_help_jobactivity @job_id = @job_id;",
        ["session_id", "job_id", "start_execution_date", "stop_execution_date"], [new("@job_id", SqlDbType.UniqueIdentifier)], "listRows");

    /// <summary>A job's history through msdb (the role path): FULL mode carries instance_id, step_id and the message.</summary>
    public static readonly AgentStatement History = new("history", "EXEC msdb.dbo.sp_help_jobhistory @job_id = @job_id, @mode = N'FULL';",
        ["instance_id", "job_id", "step_id", "step_name", "sql_message_id", "sql_severity", "message", "run_status", "run_date", "run_time", "run_duration", "retries_attempted"],
        [new("@job_id", SqlDbType.UniqueIdentifier)], "historyRows");

    /// <summary>The newest history rows of a job, for Job Activity Monitor's last run (AG-3): the same read as <see cref="History"/>,
    /// cancelled after lastRunRows rows (newest first), so a long history is not read every sample.</summary>
    public static readonly AgentStatement LastRunHistory = History with { Id = "lastRunHistory", Cap = "lastRunRows" };

    /// <summary>The step types this server's Agent has.</summary>
    public static readonly AgentStatement Subsystems = new("subsystems", "EXEC msdb.dbo.sp_enum_sqlagent_subsystems;", ["subsystem", "subsystem_id"], [], "listRows");

    /// <summary>Agent's history caps and idle-CPU condition; 15281 while Agent XPs is off.</summary>
    public static readonly AgentStatement Properties = new("properties", "EXEC msdb.dbo.sp_get_sqlagent_properties;",
        ["jobhistory_max_rows", "jobhistory_max_rows_per_job", "idle_cpu_percent", "idle_cpu_duration"], [], "listRows");

    /// <summary>The Agent error logs: 0 is the current one.</summary>
    public static readonly AgentStatement ErrorLogs = new("errorLogs", "EXEC master.dbo.xp_enumerrorlogs 2;", ["Archive #", "Date", "Log File Size (Byte)"], [], "listRows");

    /// <summary>One Agent error log, newest first, filtered by up to two search texts (NULL for none).</summary>
    public static readonly AgentStatement ErrorLog = new("errorLog", "EXEC master.dbo.xp_readerrorlog @log, 2, @search1, @search2, NULL, NULL, N'desc';", ["LogDate", "ErrorLevel", "Text"],
        [new("@log", SqlDbType.Int), new("@search1", SqlDbType.NVarChar, SearchChars), new("@search2", SqlDbType.NVarChar, SearchChars)], "logRows");

    /// <summary>The Agent service's state as the engine sees it (sysadmin): "Running.", "Stopped." and the pending states.</summary>
    public static readonly AgentStatement ServiceState = new("serviceState", "DECLARE @rc int;\nEXEC @rc = master.dbo.xp_servicecontrol N'QueryState', N'SQLServerAgent';",
        ["Current Service State"], [], "listRows");

    /// <summary>The search texts' bound, from the catalogue (agentLimits.searchChars), so zod and the reader agree.</summary>
    private static int SearchChars => (int)AgentCatalog.Current.Limit("searchChars");

    /// <summary>A job's steps, for Start Job at Step (AG-2; every Agent role may read them).</summary>
    public static readonly AgentStatement JobSteps = new("jobSteps", "EXEC msdb.dbo.sp_help_jobstep @job_id = @job_id;", ["step_id", "step_name"], [new("@job_id", SqlDbType.UniqueIdentifier)], "stepsPerJob");

    private static readonly string[] ActivityColumns = [.. JobColumns, "has_step", "has_schedule", "current_retry_attempt"];

    /// <summary>Job Activity Monitor's list (AG-3): every job the login may see with the columns its grid and tiles need.</summary>
    public static readonly AgentStatement JobActivity = new("jobActivity", "EXEC msdb.dbo.sp_help_job;", ActivityColumns, [], "listRows");

    /// <summary>One watched job's row for the status bar (AG-3), with its step count.</summary>
    public static readonly AgentStatement WatchedJob = new("watchedJob", "EXEC msdb.dbo.sp_help_job @job_id = @job_id, @job_aspect = N'JOB';", ActivityColumns,
        [new("@job_id", SqlDbType.UniqueIdentifier)], "listRows");

    /// <summary>Every job's activity row in the Agent's current session (sp_help_jobactivity defaults to the newest syssessions row),
    /// which carries a running job's start for every Agent role.</summary>
    public static readonly AgentStatement Activities = new("activities", "EXEC msdb.dbo.sp_help_jobactivity;", ["job_id", "start_execution_date", "stop_execution_date"], [], "listRows");

    /// <summary>The server's clock in its local time, which msdb's dates use, for a running job's elapsed time.</summary>
    public static readonly AgentStatement ServerClock = new("clock", "SELECT CONVERT(datetime, SYSDATETIME()) AS server_now;", ["server_now"], [], "listRows");

    /// <summary>Every setting the SQL Server Agent Properties dialog shows (AG-8a), from sp_get_sqlagent_properties (every Agent role may run it; 15281 while Agent XPs is off).</summary>
    public static readonly AgentStatement AgentProperties = new("agentProperties", "EXEC msdb.dbo.sp_get_sqlagent_properties;",
        ["auto_start", "startup_account", "sqlserver_restart", "monitor_autostart", "jobhistory_max_rows", "jobhistory_max_rows_per_job", "errorlog_file", "errorlogging_level"], [], "listRows");

    // --- The job document's describe (AG-6a; its save is in AgentSql.JobDocument.cs) ----------------------------------------

    private static readonly string[] JobDocumentColumns = ["job_id", "name", "enabled", "description", "start_step_id", "category", "owner", "notify_level_eventlog", "notify_level_email",
        "notify_level_netsend", "notify_level_page", "notify_email_operator", "notify_netsend_operator", "notify_page_operator", "delete_level", "date_created", "date_modified", "version_number",
        "last_run_date", "last_run_time", "last_run_outcome"];

    /// <summary>The job the document edits (one result set with the JOB aspect).</summary>
    public static readonly AgentStatement JobDocument = new("jobDocument", "EXEC msdb.dbo.sp_help_job @job_id = @job_id, @job_aspect = N'JOB';", JobDocumentColumns,
        [new("@job_id", SqlDbType.UniqueIdentifier)], "listRows");
    /// <summary>The job's steps, for the Start menu and the Start step (every Agent role may read them).</summary>
    public static readonly AgentStatement JobDocumentSteps = new("jobDocumentSteps", "EXEC msdb.dbo.sp_help_jobstep @job_id = @job_id;", ["step_id", "step_name", "subsystem"],
        [new("@job_id", SqlDbType.UniqueIdentifier)], "stepsPerJob");
    /// <summary>The job categories the Category picker offers.</summary>
    public static readonly AgentStatement JobCategories = new("jobCategories", "EXEC msdb.dbo.sp_help_category @class = N'JOB';", ["name"], [], "listRows");
    /// <summary>The operators Notifications offers, with their addresses and pager duty (msdb grants SQLAgentUserRole EXECUTE).</summary>
    public static readonly AgentStatement Operators = new("operators", "EXEC msdb.dbo.sp_help_operator;",
        ["name", "enabled", "email_address", "pager_address", "netsend_address", "weekday_pager_start_time", "weekday_pager_end_time", "saturday_pager_start_time", "saturday_pager_end_time",
            "sunday_pager_start_time", "sunday_pager_end_time", "pager_days"], [], "listRows");
    /// <summary>Every alert (SQLAgentOperatorRole and sysadmin); the describe keeps those that run the job.</summary>
    public static readonly AgentStatement Alerts = new("alerts", "EXEC msdb.dbo.sp_help_alert;", ["id", "name", "enabled", "message_id", "severity", "job_id"], [], "listRows");
    /// <summary>SQL Server Agent's own mail settings (sysadmin: the Notifications section's Database Mail readiness).</summary>
    public static readonly AgentStatement AgentMail = new("agentMail", "EXEC msdb.dbo.sp_get_sqlagent_properties;", ["use_databasemail", "databasemail_profile"], [], "listRows");
    /// <summary>The Database Mail profiles (sysadmin and DatabaseMailUserRole; others are refused, and then nothing is said about mail).</summary>
    public static readonly AgentStatement MailProfiles = new("mailProfiles", "EXEC msdb.dbo.sysmail_help_profile_sp;", ["profile_id", "name"], [], "listRows");
    /// <summary>The login the document runs as, whether it is sysadmin, and Database Mail XPs (16386) as installed.</summary>
    public static readonly AgentStatement JobDocumentFacts = new("jobDocumentFacts",
        "SELECT SYSTEM_USER AS login_name, CONVERT(int, ISNULL(IS_SRVROLEMEMBER(N'sysadmin'), 0)) AS is_sysadmin,\n"
        + "(SELECT CONVERT(int, c.value_in_use) FROM sys.configurations AS c WHERE c.configuration_id = 16386) AS mail_xps;", ["login_name", "is_sysadmin", "mail_xps"], [], "listRows");
    /// <summary>The logins the owner picker lists (sysadmin): SQL, Windows and Entra logins and groups, not certificate-mapped ones.</summary>
    public static readonly AgentStatement OwnerLogins = new("ownerLogins",
        "SELECT p.name FROM sys.server_principals AS p WHERE p.type IN (N'S', N'U', N'G', N'E', N'X') AND p.name NOT LIKE N'##%' ORDER BY p.name;", ["name"], [], "ownerLogins");

    public static IReadOnlyList<AgentStatement> All { get; } = [State, Jobs, Job, Activity, History, Subsystems, Properties, ErrorLogs, ErrorLog, ServiceState, JobSteps, AgentProperties, JobActivity, WatchedJob, Activities, ServerClock, LastRunHistory,
        JobDocument, JobDocumentSteps, JobCategories, Operators, Alerts, AgentMail, MailProfiles, JobDocumentFacts, OwnerLogins];

    /// <summary>Whether a statement is one of <see cref="All"/>: the reader runs nothing else, so everything it runs was linted.</summary>
    public static bool Known(AgentStatement statement) => All.Any(known => ReferenceEquals(known, statement));

    /// <summary>The prologues Agent reads run under, by caller: the live pools', Object Explorer's listings and Search Objects',
    /// and none for describes (ActionSql.ReadPrologue runs as its own command).</summary>
    public static IReadOnlyList<(string Caller, string? Prologue)> Callers { get; } =
        [("live", LiveSql.UncommittedPrologue), ("live committed", LiveSql.CommittedPrologue), ("listing", CatalogSql.Prologue), ("describe", null)];

    // Every EXEC up to its statement's semicolon. An EXEC whose text is not exactly an admitted shape stays in the text, so
    // LiveSql.Lint refuses it too ("uses EXEC").
    [GeneratedRegex(@"(?<![\w@])EXEC(?:UTE)?\b[^;]*;", RegexOptions.IgnoreCase)]
    private static partial Regex ExecStatement();
    [GeneratedRegex(@"^EXEC msdb\.dbo\.(?<proc>\w+)(?: (?<arg>@\w+ = (?:@\w+|N'[A-Z]+'|\d+))(?:, (?<arg>@\w+ = (?:@\w+|N'[A-Z]+'|\d+)))*)?;$")]
    private static partial Regex MsdbCall();
    [GeneratedRegex(@"(?<!@)@(?!@)\w+")]
    private static partial Regex Variable();
    [GeneratedRegex(@"\bDECLARE\s+(@\w+)", RegexOptions.IgnoreCase)]
    private static partial Regex Local();
    [GeneratedRegex(@"N?'(?:[^']|'')*'")]
    private static partial Regex Literal();

    private static readonly Lazy<Regex[]> MasterShapes = new(() => [.. AgentCatalog.Current.MasterReadShapes.Values.Select(Shape)]);

    /// <summary>A master shape as a pattern: the statement exactly, with each `@p` any parameter.</summary>
    internal static Regex Shape(string shape) => new("^" + Regex.Replace(Regex.Escape(shape), "@p(?=[,;])", @"@\w+") + "$", RegexOptions.CultureInvariant);

    /// <summary>Problems with one command's full text, for the caller whose prologue it must start with (null: none); empty
    /// when it passes.</summary>
    public static List<string> LintRead(string text, string? prologue, AgentCatalog? catalog = null)
    {
        catalog ??= AgentCatalog.Current;
        var shapes = catalog == AgentCatalog.Current ? MasterShapes.Value : [.. catalog.MasterReadShapes.Values.Select(Shape)];
        var problems = new List<string>();
        var body = text;
        if (prologue is not null)
        {
            if (text.StartsWith(prologue, StringComparison.Ordinal)) body = text[prologue.Length..];
            else problems.Add("does not start with its caller's prologue");
        }
        else if (text.TrimStart().StartsWith("SET ", StringComparison.OrdinalIgnoreCase)) problems.Add("carries a prologue its caller runs as its own command");
        if (!body.TrimEnd().EndsWith(';')) problems.Add("does not end with a semicolon");
        // A batch's first statement may name a procedure without EXEC, and that runs it; so the body opens with a keyword.
        if (!FirstKeyword().IsMatch(body)) problems.Add("does not open with SELECT, WITH, DECLARE or EXEC");
        var rest = ExecStatement().Replace(body, match =>
        {
            if (shapes.Any(shape => shape.IsMatch(match.Value))) return " ";
            var problem = CallProblem(match.Value, catalog);
            if (problem is null) return " ";
            problems.Add(problem);
            return match.Value;
        });
        // LiveSql.Lint's word list is a deny list with word boundaries that T-SQL does not share (it reads `1DELETE` as `1`
        // and DELETE). So the rest also may not glue a word to a number, and may use no statement keyword but SELECT, WITH and
        // DECLARE: every T-SQL statement opens with one, which makes this an allow list of statement kinds.
        var code = Quoted().Replace(rest, " ");
        if (GluedNumber().IsMatch(code)) problems.Add("glues a word to a number");
        foreach (Match match in StatementKeyword().Matches(code)) problems.Add("uses " + match.Value.ToUpperInvariant());
        problems.AddRange(LiveSql.Lint(LiveSql.UncommittedPrologue + rest));
        return problems;
    }

    [GeneratedRegex(@"--[^\r\n]*|/\*[\s\S]*?\*/|N?'(?:[^']|'')*'|\[(?:[^\]]|\]\])*\]|""(?:[^""]|"""")*""", RegexOptions.CultureInvariant)]
    private static partial Regex Quoted();
    [GeneratedRegex(@"(?<![A-Za-z0-9_@#])[0-9][\w$.]*[A-Za-z_$]", RegexOptions.CultureInvariant)]
    private static partial Regex GluedNumber();
    [GeneratedRegex(@"(?<![A-Za-z0-9_@#])(?:ADD|ALTER|BACKUP|BEGIN|BREAK|BULK|CHECKPOINT|CLOSE|COMMIT|CONTINUE|CONVERSATION|CREATE|CURSOR|DBCC|DEALLOCATE|DELETE|DENY|DISABLE|DROP|ENABLE|EXEC|EXECUTE|FETCH|GET|GOTO|GRANT|IF|INSERT|INTO|KILL|LOG|MERGE|MOVE|NEXT|OPEN\w*|PRINT|RAISERROR|READTEXT|RECEIVE|RECONFIGURE|RESTORE|RETURN|REVERT|REVOKE|ROLLBACK|SAVE|SEND|SET|SETUSER|SHUTDOWN|SIGNATURE|THROW|TRUNCATE|UPDATE|UPDATETEXT|USE|WAITFOR|WHILE|WRITETEXT)(?![\w$])",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex StatementKeyword();
    [GeneratedRegex(@"^\s*(?:SELECT|WITH|DECLARE|EXEC)\s", RegexOptions.CultureInvariant)]
    private static partial Regex FirstKeyword();

    /// <summary>Why an EXEC is not an admitted msdb read, or null when it is one.</summary>
    private static string? CallProblem(string statement, AgentCatalog catalog)
    {
        var match = MsdbCall().Match(statement);
        if (!match.Success) return "EXECs in a shape the Agent read lint does not admit";
        var name = match.Groups["proc"].Value;
        if (!catalog.ReadProcedures.TryGetValue(name, out var procedure)) return "EXECs " + name + ", which is not an Agent read procedure";
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (Capture capture in match.Groups["arg"].Captures)
        {
            var parts = capture.Value.Split(" = ", 2);
            var (argument, value) = (parts[0], parts[1]);
            if (!procedure.Arguments.TryGetValue(argument, out var constants)) return "passes " + argument + " to " + name;
            if (!seen.Add(argument)) return "passes " + argument + " twice";
            if (!value.StartsWith('@') && !constants.Contains(value)) return "passes " + value + " as " + argument + " of " + name;
        }
        return null;
    }

    /// <summary>Problems with a statement under one caller: <see cref="LintRead"/> on its full text, plus its own declaration
    /// (every parameter used, every variable declared, columns named once, a cap the catalogue has).</summary>
    public static List<string> Lint(AgentStatement statement, string? prologue)
    {
        var problems = LintRead((prologue ?? "") + statement.Text, prologue);
        var code = Literal().Replace(statement.Text, "''");
        var declared = statement.Parameters.Select(parameter => parameter.Name).ToHashSet(StringComparer.Ordinal);
        var locals = Local().Matches(code).Select(match => match.Groups[1].Value).ToHashSet(StringComparer.Ordinal);
        // An msdb call names the procedure's argument on the left of each '='; those are not variables of the batch.
        var values = Regex.Replace(code, @"@\w+ = ", "= ");
        var used = Variable().Matches(values).Select(match => match.Value).Where(name => !locals.Contains(name)).ToHashSet(StringComparer.Ordinal);
        foreach (var name in used.Except(declared)) problems.Add("uses the undeclared " + name);
        foreach (var name in declared.Except(used)) problems.Add("declares the unused " + name);
        if (statement.Columns.Count == 0 || statement.Columns.Distinct(StringComparer.Ordinal).Count() != statement.Columns.Count) problems.Add("has no or duplicate column names");
        try { AgentCatalog.Current.Limit(statement.Cap); }
        catch (InvalidOperationException) { problems.Add("is capped by an unknown limit"); }
        return problems;
    }

    /// <summary>Every statement under every caller, with its problems.</summary>
    public static IEnumerable<(string Name, List<string> Problems)> Lint()
    {
        foreach (var statement in All)
            foreach (var (caller, prologue) in Callers)
                yield return (statement.Id + " (" + caller + ")", Lint(statement, prologue));
    }
}
