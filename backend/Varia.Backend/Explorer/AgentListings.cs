using System.Globalization;
using Microsoft.Data.SqlClient;
using Varia.Backend.Agent;

namespace Varia.Backend.Explorer;

/// <summary>The SQL Server Agent node's listings (docs/agent-plan.md › Object Explorer): its pre-folder step, and the msdb
/// catalog listings of jobs, alerts, operators, proxy subsystems and proxies, all constant <see cref="CatalogSql"/> text run in
/// msdb through the scope wrapper and checked by its lint; the error logs list through <see cref="AgentReader"/>
/// (<c>xp_enumerrorlogs</c>), since CatalogSql stays free of EXEC.</summary>
internal static class AgentListings
{
    /// <summary>The node's step: <c>Agent XPs</c> (value_in_use, by configuration_id), sysadmin and the three msdb Agent roles.
    /// In msdb, so IS_ROLEMEMBER resolves msdb's roles rather than returning NULL in master.</summary>
    public const string Access = "SELECT CONVERT(int, ISNULL((SELECT CONVERT(int, c.value_in_use) FROM sys.configurations AS c WHERE c.configuration_id = 16384), 0)), "
        + "CONVERT(bit, ISNULL(IS_SRVROLEMEMBER(N'sysadmin'), 0)), CONVERT(bit, ISNULL(IS_ROLEMEMBER(N'SQLAgentOperatorRole'), 0)), "
        + "CONVERT(bit, ISNULL(IS_ROLEMEMBER(N'SQLAgentReaderRole'), 0)), CONVERT(bit, ISNULL(IS_ROLEMEMBER(N'SQLAgentUserRole'), 0));";
    public static readonly IReadOnlySet<string> AccessLiterals = new HashSet<string>(StringComparer.Ordinal) { "N'sysadmin'", "N'SQLAgentOperatorRole'", "N'SQLAgentReaderRole'", "N'SQLAgentUserRole'" };

    /// <summary>The database every Agent listing reads.</summary>
    public const string Msdb = "msdb";

    /// <summary>What a login sees below the node: the folders (and the Job Activity Monitor singleton) its role reads.</summary>
    public enum Role { None, User, Reader, Operator, Sysadmin }

    /// <summary>The node's children a role may read. Jobs and Job Activity Monitor need any Agent role (a User sees its own jobs),
    /// Alerts and Operators SQLAgentOperatorRole (msdb grants it SELECT on sysalerts and sysoperators), Proxies and Error Logs
    /// sysadmin: msdb grants no role SELECT on the proxy tables, and their role path (sp_help_proxy) comes with the proxy lane.</summary>
    public static bool Reads(Role role, CatalogChild child) => role switch
    {
        Role.Sysadmin => true,
        Role.Operator => child.Singleton is not null || child.Folder is "agentJobs" or "agentAlerts" or "agentOperators",
        Role.Reader or Role.User => child.Singleton is not null || child.Folder is "agentJobs",
        _ => false
    };

    /// <summary>The no-role refusal, an Agent sentence rather than Create's fixed one.</summary>
    public static ExplorerError NoRole => new("PERMISSION_DENIED",
        "This login has no SQL Server Agent role. A sysadmin can add it to SQLAgentUserRole, SQLAgentReaderRole or SQLAgentOperatorRole in msdb.", true);

    /// <summary>Agent XPs at 0: the node lists nothing and says why.</summary>
    public static ExplorerError Disabled => new("AGENT_DISABLED", ExplorerErrors.AgentDisabled, true);

    private static string? Disabledness(bool enabled) => enabled ? null : "disabled";

    private static ExplorerQuery List(string id, string from, string key, string select, Func<Row, ExplorerNode> map, string? where = null, FilterColumns? filter = null,
        string? ownerJoin = null) => new()
    {
        Id = id, Scope = QueryScope.Database, Database = Msdb, From = _ => from, Where = where is null ? null : _ => where, Keys = [key], Select = _ => select,
        Filter = filter ?? new(Name: key), OwnerJoin = ownerJoin, RowsNeedOwner = ownerJoin is not null, Map = map
    };

    private static ExplorerNode Named(Row row, string kind, string? status = null, string? detail = null, DateTime? created = null, string? label = null, bool? hasChildren = null) =>
        ExplorerQueries.Node(row.Context, new ObjectRefDto(kind, Name: row.Key(0)), label ?? row.Key(0), status: status, detail: detail, created: created, hasChildren: hasChildren);

    /// <summary>Proxies assigned to the subsystem row's subsystem (@object_name).</summary>
    private const string InSubsystem = "EXISTS (SELECT 1 FROM dbo.sysproxysubsystem AS ps JOIN dbo.syssubsystems AS ss ON ss.subsystem_id = ps.subsystem_id "
        + "WHERE ps.proxy_id = p.proxy_id AND ss.subsystem = @object_name)";

    /// <summary>The catalog listings, by the ids the catalogue's Agent folders and kinds name.</summary>
    public static IEnumerable<ExplorerQuery> Queries =>
    [
        // sysjobs_view filters by role itself (owner, SQLAgentReaderRole or sysadmin) and every Agent role may read it; an owner
        // is named only where the login may see that server principal.
        List("agentJobs", "dbo.sysjobs_view AS j", "j.name", "j.enabled, j.date_created, own.name, j.description",
            row => Named(row, "agentJob", Disabledness(row.B(0)), ExplorerLabels.Join([row.S(2) is { } owner ? "Owner " + owner : null, row.S(3) is { Length: > 0 } text ? text : null]), row.D(1)),
            filter: new(Name: "j.name", Owner: "own.name", Created: "j.date_created"), ownerJoin: "LEFT JOIN sys.server_principals AS own ON own.sid = j.owner_sid"),
        List("agentAlerts", "dbo.sysalerts AS a", "a.name", "a.enabled", row => Named(row, "agentAlert", Disabledness(row.B(0)))),
        List("agentOperators", "dbo.sysoperators AS o", "o.name", "o.enabled", row => Named(row, "agentOperator", Disabledness(row.B(0)))),
        // Every subsystem but TSQL (subsystem_id 1), to which no proxy can be assigned; labelled with SSMS's step-type names.
        List("agentProxySubsystems", "dbo.syssubsystems AS ss", "ss.subsystem", "(SELECT COUNT_BIG(*) FROM dbo.sysproxysubsystem AS ps WHERE ps.subsystem_id = ss.subsystem_id)",
            row => Named(row, "agentProxySubsystem", label: AgentCatalog.Current.SubsystemLabels.GetValueOrDefault(row.Key(0), row.Key(0)), hasChildren: true,
                detail: row.I(0) == 1 ? "1 proxy" : row.I(0).ToString(CultureInfo.InvariantCulture) + " proxies"), "ss.subsystem_id <> 1"),
        List("agentProxies", "dbo.sysproxies AS p", "p.name", "p.enabled", row => Named(row, "agentProxy", Disabledness(row.B(0))), InSubsystem),
        List("agentUnassignedProxies", "dbo.sysproxies AS p", "p.name", "p.enabled", row => Named(row, "agentProxy", Disabledness(row.B(0))),
            "NOT EXISTS (SELECT 1 FROM dbo.sysproxysubsystem AS ps WHERE ps.proxy_id = p.proxy_id)")
    ];

    /// <summary>The listings that read through <see cref="AgentReader"/> rather than catalog SQL.</summary>
    public static readonly IReadOnlyList<string> ReaderLists = ["agentErrorLogs"];

    /// <summary>An error log row: keyed by archive number (0 is Current), labelled as SSMS does.</summary>
    public static ExplorerNode ErrorLog(RowContext context, int archive, object? date)
    {
        var when = date switch
        {
            DateTime value => value.ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture),
            null => null,
            _ => Convert.ToString(date, CultureInfo.InvariantCulture)
        };
        var label = (archive == 0 ? "Current" : "Archive #" + archive.ToString(CultureInfo.InvariantCulture)) + (when is null ? "" : " - " + when);
        return ExplorerQueries.Node(context, new ObjectRefDto("agentErrorLog", Name: archive.ToString(CultureInfo.InvariantCulture)), label, hasChildren: false);
    }

    /// <summary>An Agent read's failure as the node's error value.</summary>
    public static ExplorerError From(AgentReadError error) => new(error.Code, ExplorerLabels.Clip(error.Message, ExplorerErrors.MaxMessage), error.Code is not ("NOT_SUPPORTED" or "NOT_FOUND"));
}

internal sealed partial class ExplorerService
{
    /// <summary>The Agent node's pre-folder step: one batch in msdb. Agent XPs at 0 is AGENT_DISABLED, no Agent role and no
    /// sysadmin PERMISSION_DENIED (both with Agent sentences), msdb closed to the login the usual NO_DB_ACCESS naming msdb;
    /// otherwise the login's role, which gates the folders.</summary>
    private async Task<(AgentListings.Role Role, ExplorerError? Error)> AgentAccessAsync(ExplorerRequest request, ExplorerProfile profile, CancellationToken token)
    {
        var role = AgentListings.Role.None;
        var result = await RunAsync(request.ConnectionId, AgentListings.Msdb, "SQL Server Agent", profile, QueryScope.Database, AgentListings.Access,
            new Values(null, null, null, false, 1, null, null, null, null, null, null, null), async (_, reader) =>
            {
                if (!await reader.ReadAsync(token)) return new ExplorerChildrenResult([], 0, Error: new("SQL_ERROR", "The SQL Server Agent access read returned no row. Refresh to retry.", true));
                if (Convert.ToInt32(reader.GetValue(0), CultureInfo.InvariantCulture) != 1) return new([], 0, Error: AgentListings.Disabled);
                role = reader.GetBoolean(1) ? AgentListings.Role.Sysadmin : reader.GetBoolean(2) ? AgentListings.Role.Operator : reader.GetBoolean(3) ? AgentListings.Role.Reader
                    : reader.GetBoolean(4) ? AgentListings.Role.User : AgentListings.Role.None;
                return new([], 0, Error: role == AgentListings.Role.None ? AgentListings.NoRole : null);
            },
            error => new ExplorerChildrenResult([], 0, Error: error.Code == "NO_DB_ACCESS" ? ExplorerErrors.Create("NO_DB_ACCESS", "SQL Server Agent", AgentListings.Msdb) : error), token);
        return (role, result.Error);
    }

    /// <summary>The Error Logs folder: <c>xp_enumerrorlogs 2</c> through <see cref="AgentReader"/> on the Object Explorer pool under
    /// the tree's gates, every archive in number order (at most the catalogue's listRows, a handful in practice), in one page.</summary>
    private async Task<ExplorerChildrenResult> AgentErrorLogsAsync(ExplorerRequest request, ExplorerProfile profile, List<ExplorerNode> nodes, CancellationToken token)
    {
        var context = new RowContext(catalog, profile, null, request.Object);
        var gate = gates.GetOrAdd(request.ConnectionId, _ => new SemaphoreSlim(Options.PerConnection));
        await gate.WaitAsync(token);
        // The listing's own budget once it holds its slots, as every other listing has (AgentReader sets no command timeout).
        using var budget = CancellationTokenSource.CreateLinkedTokenSource(token);
        try
        {
            await total.WaitAsync(token);
            try
            {
                budget.CancelAfter(Options.Budget);
                await using var connection = host.Connection(request.ConnectionId, null);
                await host.OpenAsync(connection, budget.Token);
                var (results, errors) = await (Options.AgentReader ?? new AgentReader()).ReadAsync(connection, CatalogSql.Prologue, [AgentSql.ErrorLogs], (_, _) => null, budget.Token);
                // Where xp_enumerrorlogs returns no list (SQL Server on Linux), the current log still exists: Current alone.
                if (errors is [{ Code: "NOT_SUPPORTED" }])
                {
                    nodes.Add(AgentListings.ErrorLog(context, 0, null));
                    return new(nodes, 0, Total: nodes.Count);
                }
                if (errors.Count > 0) return new(nodes, 0, Error: AgentListings.From(errors[0]));
                var logs = results[AgentSql.ErrorLogs.Id];
                foreach (var row in logs.Rows.Select(row => (Archive: Convert.ToInt32(logs.Value(row, "Archive #"), CultureInfo.InvariantCulture), Date: logs.Value(row, "Date"))).OrderBy(row => row.Archive))
                    nodes.Add(AgentListings.ErrorLog(context, row.Archive, row.Date));
                // Agent keeps at most 99 archives, far under the read's cap.
                return new(nodes, 0, Total: nodes.Count);
            }
            finally { total.Release(); }
        }
        catch (Exception error) when (error is OperationCanceledException or SqlException && budget.IsCancellationRequested && !token.IsCancellationRequested)
        {
            return new(nodes, 0, Error: new("TIMEOUT", "Listing SQL Server Agent's error logs took longer than "
                + Math.Ceiling(Options.Budget.TotalSeconds).ToString(CultureInfo.InvariantCulture) + " seconds. Refresh to retry.", true));
        }
        catch (SqlException error) when (!token.IsCancellationRequested) { return new(nodes, 0, Error: ExplorerErrors.From(error, ErrorPhase.Statement, Subject(request), null)); }
        catch (RequestException error) when (error.Code is "AUTH_KERBEROS" or "AUTH_UNSUPPORTED" or "AUTH_ENTRA" or "AUTH_IDENTITY") { return new(nodes, 0, Error: ExplorerErrors.SignIn(error)); }
        finally { gate.Release(); }
    }

    /// <summary>A singleton child: named by its kind alone.</summary>
    private ExplorerNode SingletonNode(string kind, ExplorerProfile profile)
    {
        var spec = catalog.KindOf(kind);
        return new(new NodeRefDto("object", new ObjectRefDto(kind)), spec.Title, spec.Icon, catalog.HasChildren(kind, null, profile));
    }
}
