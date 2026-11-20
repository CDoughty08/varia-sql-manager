using System.Diagnostics;
using System.Globalization;
using Microsoft.Data.SqlClient;

namespace Varia.Backend.Agent
{
    /// <summary>agent.profile's one constant batch (docs/agent-plan.md › Permissions and how the UI degrades): the login's Agent
    /// roles and the permissions and server options the Agent surfaces branch on. It runs in msdb through Object Explorer's
    /// scope wrapper (<c>msdb.sys.sp_executesql</c>, so <c>IS_ROLEMEMBER</c> resolves msdb's roles), passes
    /// <see cref="Explorer.CatalogSql.Lint"/> with its own exact literals, and reads <c>Agent XPs</c> as <c>value_in_use</c> by
    /// <c>configuration_id</c>, never by name. Where msdb refuses the login, its server-scope variant (<see cref="Render"/> without
    /// msdb) reads the server facts alone, under the same lint.</summary>
    internal static class AgentProfileSql
    {
        /// <summary>The literals the batch holds: role and permission names, the two msdb procedures and the server property.</summary>
        public static readonly IReadOnlySet<string> Literals = new HashSet<string>(StringComparer.Ordinal)
        {
            "N'sysadmin'", "N'SQLAgentUserRole'", "N'SQLAgentReaderRole'", "N'SQLAgentOperatorRole'", "N'msdb.dbo.sp_purge_jobhistory'", "N'msdb.dbo.sysmail_help_profile_sp'",
            "N'OBJECT'", "N'EXECUTE'", "N'VIEW SERVER STATE'", "N'VIEW SERVER SECURITY STATE'", "N'VIEW SERVER PERFORMANCE STATE'", "N'ALTER ANY CREDENTIAL'", "N'IsClustered'"
        };

        /// <summary>The batch for a version band: the two server-state permissions SQL Server 2022 split from VIEW SERVER STATE
        /// exist from band 16 (Managed Instance reports it too), and read as 0 below it. Without <paramref name="msdb"/> (msdb
        /// refused the login) it reads only the server's facts, at server scope, with every msdb fact 0.</summary>
        public static string Render(Explorer.SqlRender render, bool msdb = true)
        {
            string Msdb(string expression) => msdb ? Bit(expression) : "CONVERT(bit, 0)";
            static string Bit(string expression) => "CONVERT(bit, ISNULL(" + expression + ", 0))";
            static string Option(int id) => "(SELECT CONVERT(int, c.value_in_use) FROM sys.configurations AS c WHERE c.configuration_id = " + id.ToString(CultureInfo.InvariantCulture) + ")";
            return "SELECT " + string.Join(", ",
                Bit("IS_SRVROLEMEMBER(N'sysadmin')"),
                Msdb("IS_ROLEMEMBER(N'SQLAgentUserRole')"),
                Msdb("IS_ROLEMEMBER(N'SQLAgentReaderRole')"),
                Msdb("IS_ROLEMEMBER(N'SQLAgentOperatorRole')"),
                Msdb("HAS_PERMS_BY_NAME(N'msdb.dbo.sp_purge_jobhistory', N'OBJECT', N'EXECUTE')"),
                Bit("HAS_PERMS_BY_NAME(NULL, NULL, N'VIEW SERVER STATE')"),
                render.Col(16, Bit("HAS_PERMS_BY_NAME(NULL, NULL, N'VIEW SERVER SECURITY STATE')"), "CONVERT(bit, 0)"),
                render.Col(16, Bit("HAS_PERMS_BY_NAME(NULL, NULL, N'VIEW SERVER PERFORMANCE STATE')"), "CONVERT(bit, 0)"),
                Bit("HAS_PERMS_BY_NAME(NULL, NULL, N'ALTER ANY CREDENTIAL')"),
                Bit("CONVERT(int, SERVERPROPERTY(N'IsClustered'))"),
                Option(16384),
                Option(16386),
                Msdb("HAS_PERMS_BY_NAME(N'msdb.dbo.sysmail_help_profile_sp', N'OBJECT', N'EXECUTE')")) + ";\n";
        }

        /// <summary>The lint's problems for every band's render; empty when all pass.</summary>
        public static IEnumerable<(int Band, List<string> Problems)> Lint()
        {
            for (var band = Explorer.ExplorerCatalog.MinBand; band <= Explorer.ExplorerCatalog.MaxBand; band++)
            {
                var render = new Explorer.SqlRender(band);
                yield return (band, Explorer.CatalogSql.Lint(Render(render), render, list: false, mayCheckAccess: false, Literals)
                    .Concat(Explorer.CatalogSql.Lint(Render(render, msdb: false), render, list: false, mayCheckAccess: false, Literals)).ToList());
            }
        }

        /// <summary>Reads the batch's one row.</summary>
        public static async Task<AgentProfileDto?> ReadAsync(SqlDataReader reader, string platform, int engineEdition, CancellationToken token, bool msdb = true)
        {
            if (!await reader.ReadAsync(token)) return null;
            bool Bit(int ordinal) => !reader.IsDBNull(ordinal) && reader.GetBoolean(ordinal);
            bool? Option(int ordinal) => reader.IsDBNull(ordinal) ? null : Convert.ToInt32(reader.GetValue(ordinal), CultureInfo.InvariantCulture) == 1;
            bool state = Bit(5), security = Bit(6), performance = Bit(7);
            return new(platform, engineEdition, msdb, Bit(0), Bit(1), Bit(2), Bit(3), Bit(4), state || security || performance, state || performance, Bit(8), Bit(9), Option(10), Option(11), Bit(12));
        }

        /// <summary>The server-scope batch's one row (<see cref="Render"/> without msdb): msdb access, every Agent role and the msdb
        /// permissions off.</summary>
        public static Task<AgentProfileDto?> ReadServerAsync(SqlDataReader reader, string platform, int engineEdition, CancellationToken token) =>
            ReadAsync(reader, platform, engineEdition, token, msdb: false);

        /// <summary>msdb refused the login (916, where its guest CONNECT was revoked) and the server-scope read failed too: no Agent
        /// role, nothing read.</summary>
        public static AgentProfileDto NoMsdb(string platform, int engineEdition) => new(platform, engineEdition, false, false, false, false, false, false, false, false, false, false, null, null, false);

        /// <summary>A failed read as agent.profile answers it: msdb refusing the login (NO_DB_ACCESS once the pool connection is open,
        /// so from the msdb scope wrapper) is a profile with no role, whose server facts a second read at server scope then fills in;
        /// anything else, a refused open included, is the error itself.</summary>
        public static AgentProfileResult Failed(ExplorerError error, bool opened, string platform, int engineEdition) => opened && error.Code == "NO_DB_ACCESS"
            ? new(NoMsdb(platform, engineEdition), 0)
            : new(null, 0, error);

        /// <summary>The batch returned no row, which a working server never does.</summary>
        /// The renderer adds "Refresh to retry." to every failed role read (agentRoleReason), so the message does not.
        public static readonly ExplorerError NoRow = new("SQL_ERROR", "The SQL Server Agent capability read returned no row.", true);

        /// <summary>Why a server serves no Agent node, by its engine edition.</summary>
        public static string Unsupported(int engineEdition) => engineEdition == 4
            ? "SQL Server Agent isn't available on SQL Server Express."
            : "SQL Server Agent isn't available on Azure SQL Database or the other cloud editions.";
    }
}

namespace Varia.Backend.Explorer
{
    using Varia.Backend.Agent;

    internal sealed partial class ExplorerService
    {
        /// <summary>agent.profile: the batch above in msdb on the Object Explorer pool under its own slot per connection (never the tree's gates, as Peek), within the Agent
        /// catalogue's <c>profileMs</c> from the moment it has its slots (a TIMEOUT value past it, unless msdb already refused the login: then the profile with no role). A server with no Agent answers
        /// NOT_SUPPORTED without connecting; msdb refusing the login (NO_DB_ACCESS) is a profile with no role, not a failure.</summary>
        public async Task<AgentProfileResult> AgentProfileAsync(AgentProfileArgs args, CancellationToken token)
        {
            var watch = Stopwatch.StartNew();
            if (!Guid.TryParse(args.ConnectionId, out _)) throw new RequestException("INVALID_PARAMS", "Invalid agent.profile request: connectionId.");
            if (!Guid.TryParse(args.RequestId, out _)) throw new RequestException("INVALID_PARAMS", "Invalid agent.profile request: requestId.");
            var server = host.Profile(args.ConnectionId);
            var real = server.Explorer(catalog);
            var profile = Options.ForceBand is { } band ? real with { Band = band } : real;
            if (AgentCatalog.Current.PlatformOf(server.EngineEdition, server.Linux) is not { } platform)
                return new(null, watch.ElapsedMilliseconds, ExplorerErrors.Create("NOT_SUPPORTED", AgentProfileSql.Unsupported(server.EngineEdition), null));
            var budget = Options.AgentProfileBudget ?? TimeSpan.FromMilliseconds(AgentCatalog.Current.Limit("profileMs"));
            using var source = CancellationTokenSource.CreateLinkedTokenSource(token);
            var entry = running.Register(args.RequestId, args.ConnectionId, source);
            try
            {
                token.ThrowIfCancellationRequested();
                var values = new Values(null, null, null, false, 1, null, null, null, null, null, null, null);
                var opened = false;
                var result = await RunAsync(args.ConnectionId, "msdb", "SQL Server Agent", profile, QueryScope.Database, AgentProfileSql.Render(new SqlRender(profile.Band)), values,
                    async (_, reader) => await AgentProfileSql.ReadAsync(reader, platform, server.EngineEdition, source.Token) is { } read
                        ? new AgentProfileResult(read, 0)
                        : new AgentProfileResult(null, 0, AgentProfileSql.NoRow),
                    error => AgentProfileSql.Failed(error, opened, platform, server.EngineEdition),
                    source.Token, agentProfileGates.GetOrAdd(args.ConnectionId, _ => new SemaphoreSlim(1)), () => source.CancelAfter(budget), () => opened = true);
                // msdb refused the login: the server's own facts (server state, ALTER ANY CREDENTIAL, clustering, the options) are
                // still this login's to read, so read them at server scope rather than report them false, within what is left of the
                // one budget. A statement failing or the budget running out keeps the no-role profile the 916 already settled; a
                // refused open or sign-in is the error itself, and a disconnect or the caller's cancel still cancels.
                if (result is { Profile.MsdbAccess: false })
                {
                    var unread = result;
                    var serverOpened = false;
                    try
                    {
                        result = await RunAsync(args.ConnectionId, null, "SQL Server Agent", profile, QueryScope.Server, AgentProfileSql.Render(new SqlRender(profile.Band), msdb: false), values,
                            async (_, reader) => new AgentProfileResult(await AgentProfileSql.ReadServerAsync(reader, platform, server.EngineEdition, source.Token) ?? unread.Profile, 0),
                            error => serverOpened ? unread : new AgentProfileResult(null, 0, error),
                            source.Token, agentProfileGates.GetOrAdd(args.ConnectionId, _ => new SemaphoreSlim(1)), opened: () => serverOpened = true);
                    }
                    catch (Exception error) when (error is OperationCanceledException or SqlException && source.IsCancellationRequested && !token.IsCancellationRequested && !entry.Forgotten)
                    {
                        result = unread;
                    }
                }
                return result with { ElapsedMs = watch.ElapsedMilliseconds };
            }
            catch (Exception error) when (error is OperationCanceledException or SqlException && source.IsCancellationRequested && !token.IsCancellationRequested)
            {
                if (entry.Forgotten) throw new RequestException("CANCELLED", "The operation was cancelled.");
                return new(null, watch.ElapsedMilliseconds, new("TIMEOUT", "Reading this login's SQL Server Agent role took longer than "
                    + Math.Ceiling(budget.TotalSeconds).ToString(CultureInfo.InvariantCulture) + " seconds.", true));
            }
            finally { running.Unregister(args.RequestId, entry); }
        }
    }
}
