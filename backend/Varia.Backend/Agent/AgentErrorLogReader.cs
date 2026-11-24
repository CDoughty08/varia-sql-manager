using System.Data;
using System.Globalization;
using Microsoft.Data.SqlClient;
using Varia.Backend.Explorer;
using Varia.Backend.Live;

namespace Varia.Backend.Agent;

/// <summary>agent.errorLog's args (src/shared/agent/error-log.ts agentErrorLogArgsSchema): the checked logs by archive number (0 is Current), the
/// date window in days and a message text.</summary>
internal sealed record AgentErrorLogLiveArgs(int[]? Logs = null, int? Days = null, string? Text = null);

/// <summary>Checks agent.errorLog's args as main's schema does.</summary>
internal static class AgentErrorLogArgs
{
    /// <summary>SQL Server Agent keeps at most 99 archives besides the current log.</summary>
    public const int MaxArchive = 99;

    public static AgentErrorLogLiveArgs Check(AgentErrorLogLiveArgs args, AgentCatalog catalog)
    {
        static RequestException Invalid(string message) => new("INVALID_PARAMS", message);
        if (args.Logs is not { Length: > 0 } logs || logs.Length > MaxArchive + 1 || logs.Any(log => log is < 0 or > MaxArchive) || logs.Distinct().Count() != logs.Length)
            throw Invalid("Logs names 1 to " + (MaxArchive + 1) + " error logs (0 to " + MaxArchive + ") once each.");
        if (args.Days is { } days && (days < 1 || days > AgentHistoryArgs.MaxDays)) throw Invalid("The window is 1 to " + AgentHistoryArgs.MaxDays + " days.");
        if (args.Text is { } text && (text.Length == 0 || text.Length > catalog.Limit("searchChars"))) throw Invalid("The message text is 1 to " + catalog.Limit("searchChars") + " characters.");
        return args;
    }
}

/// <summary>
/// The agent.errorLog live source (docs/sql-server-agent.md, Log File Viewer): its one probe reads the checked SQL Server Agent error logs through
/// master.dbo.xp_readerrorlog (sp_readmierrorlog on Managed Instance) by <see cref="AgentReader"/>, sysadmin only, with the message text as the
/// procedure's own search argument. xp_readerrorlog cannot page, so each log is read newest first and at most logRows rows are kept across the
/// checked logs (the rest are cancelled and the table says it was cut); Managed Instance's reader has no sort argument and keeps the oldest
/// (status errorLogOldestFirst). The date window is from the server's clock, in backend memory. One table: the rows newest first, keyed by
/// archive and the row's place in its log. A refused read (below sysadmin, PERMISSION_DENIED) or a log that no longer exists fails the probe as a
/// value. Nothing is logged.
/// </summary>
internal sealed class AgentErrorLogReader(AgentErrorLogLiveArgs? args = null, AgentCatalog? catalog = null) : ILiveSqlReader
{
    public const string Source = "agent.errorLog";
    public const string ReadProbe = "agent.errorLog.read";
    /// <summary>The longest message a row keeps: an error log line is rarely longer; a longer one ends in an ellipsis.</summary>
    public const int MessageChars = 4000;
    public static readonly IReadOnlyDictionary<int, (string Label, string? Tone)> Levels = new Dictionary<int, (string, string?)>
    {
        [1] = ("Error", "error"), [2] = ("Warning", "warning"), [3] = ("Information", null)
    };

    private readonly AgentCatalog catalog = catalog ?? AgentCatalog.Current;
    private readonly Lock gate = new();
    private AgentErrorLogLiveArgs current = args ?? new();
    private bool managedInstance;

    /// <summary>The reader the probe runs its statements through (offline checks give one with a TestRun).</summary>
    internal AgentReader Reader { get; init; } = new();

    /// <summary>The args in force (the checks read them).</summary>
    internal AgentErrorLogLiveArgs Current { get { lock (gate) return current; } }

    public async Task<(int Spid, bool ServerState)> SessionAsync(SqlConnection connection, string prologue, string permission, CancellationToken token)
    {
        await using var command = connection.CreateCommand();
        command.CommandTimeout = 0;
        command.CommandText = prologue + LiveSql.Session;
        command.Parameters.Add(new SqlParameter("@permission", SqlDbType.NVarChar, 128) { Value = permission });
        command.Parameters.Add(new SqlParameter("@catalog", SqlDbType.NVarChar, 128) { Value = DBNull.Value });
        await using var row = await command.ExecuteReaderAsync(CommandBehavior.SingleRow, token).ConfigureAwait(false);
        if (!await row.ReadAsync(token).ConfigureAwait(false)) throw new InvalidOperationException("The session probe returned no row.");
        return (Convert.ToInt32(row.GetValue(0), CultureInfo.InvariantCulture), Convert.ToInt32(row.GetValue(1), CultureInfo.InvariantCulture) == 1);
    }

    public (string Reason, string Note)? Unavailable(LiveProbeJson spec, ServerProfile profile)
    {
        managedInstance = profile.EngineEdition == 8;
        return null;
    }

    public void Apply(object value)
    {
        lock (gate) current = (AgentErrorLogLiveArgs)value;
    }

    public void Reset() { }

    /// <summary>Whether this server reads its Agent log through sp_readmierrorlog (offline checks set it).</summary>
    internal bool ManagedInstance { get => managedInstance; init => managedInstance = value; }

    public async Task<LiveReaderSample> ReadAsync(SqlConnection connection, string prologue, LiveDue item, Func<string, string, string>? testText, CancellationToken token)
    {
        if (item.Probe.Spec.Id != ReadProbe) throw new RequestException("BACKEND_ERROR", "agent.errorLog has no such probe.");
        AgentErrorLogLiveArgs now;
        lock (gate) now = current;
        return await ReadLogsAsync(connection, prologue, now, token).ConfigureAwait(false);
    }

    /// <summary>One sample: the server's clock when a window is set, then each checked log in archive order until the rows reach logRows.</summary>
    internal async Task<LiveReaderSample> ReadLogsAsync(SqlConnection? connection, string prologue, AgentErrorLogLiveArgs now, CancellationToken token)
    {
        var cap = (int)catalog.Limit("logRows");
        var statement = managedInstance ? AgentSql.ErrorLogMi : AgentSql.ErrorLog;
        DateTime? since = null;
        if (now.Days is { } days)
        {
            var (clock, refused) = await Reader.ReadAsync(connection, prologue, [AgentSql.ServerClock], (_, _) => null, token).ConfigureAwait(false);
            if (!clock.TryGetValue(AgentSql.ServerClock.Id, out var time)) return Failed(refused[0]);
            if (time.Rows.Count == 0 || time.Value(time.Rows[0], "server_now") is not DateTime stamp)
                return Failed(new AgentReadError(AgentSql.ServerClock.Id, "SQL_ERROR", 0, "The server's clock could not be read for the window."));
            since = stamp.AddDays(-days);
        }
        var rows = new List<Entry>();
        var truncated = false;
        foreach (var log in (now.Logs ?? []).Order())
        {
            if (rows.Count >= cap) { truncated = true; break; }
            var (results, refused) = await Reader.ReadAsync(connection, prologue, [statement],
                (_, parameter) => parameter.Name switch { "@log" => log, "@search1" => now.Text, _ => null }, token).ConfigureAwait(false);
            if (!results.TryGetValue(statement.Id, out var result)) return Failed(refused[0]);
            truncated |= result.Truncated;
            // A row's key stays with it as Agent writes more lines: its place is counted from the log's oldest row read (xp_readerrorlog
            // reads newest first, sp_readmierrorlog oldest first). A newest-first read that was cut has no oldest row, so its rows are
            // keyed by their time and their place among the rows of that same time, counted from the oldest.
            var count = result.Rows.Count;
            var seen = new Dictionary<DateTime, int>();
            var keys = new string[count];
            for (var at = 0; at < count; at++)
            {
                var index = managedInstance ? at : count - 1 - at;
                if (managedInstance || !result.Truncated) { keys[index] = (at + 1).ToString(CultureInfo.InvariantCulture); continue; }
                var stamp = result.Value(result.Rows[index], "LogDate") as DateTime? ?? DateTime.MinValue;
                seen[stamp] = seen.GetValueOrDefault(stamp) + 1;
                keys[index] = "t" + stamp.ToString("yyyyMMddHHmmssfff", CultureInfo.InvariantCulture) + "." + seen[stamp].ToString(CultureInfo.InvariantCulture);
            }
            for (var index = 0; index < count; index++)
            {
                var row = result.Rows[index];
                var when = result.Value(row, "LogDate") as DateTime?;
                if (since is { } start && when is { } at && at < start) continue;
                rows.Add(new(log, index + 1, keys[index], when, Int(result.Value(row, "ErrorLevel")), Message(result.Value(row, "Text") as string)));
            }
        }
        // Newest first across logs; within a second, a log's own order (newest first, or oldest first on Managed Instance).
        var ordered = rows.OrderByDescending(row => row.When ?? DateTime.MinValue).ThenBy(row => row.Archive).ThenBy(row => managedInstance ? -row.Place : row.Place).ToList();
        if (ordered.Count > cap) { truncated = true; ordered = managedInstance ? ordered.TakeLast(cap).ToList() : ordered.Take(cap).ToList(); }
        var status = managedInstance ? new List<LiveStatus> { new("errorLogOldestFirst", 1L) } : [];
        return new(null, [new(0, [.. ordered.Select(Row)], truncated ? 1 : 0)], [], Status: status);
    }

    private sealed record Entry(int Archive, int Place, string Key, DateTime? When, int? Level, string? Message);

    private static LiveRow Row(Entry entry)
    {
        var (label, tone) = entry.Level is { } level && Levels.TryGetValue(level, out var known) ? known : (entry.Level?.ToString(CultureInfo.InvariantCulture), null);
        var archive = entry.Archive.ToString(CultureInfo.InvariantCulture);
        return new LiveRow([
            entry.When is { } when ? LiveCell.DateTime2(when, 0) : LiveCell.Null, LiveCell.Of(entry.Archive == 0 ? "Current" : "Archive #" + archive), LiveCell.Of(label),
            LiveCell.Of(entry.Message), LiveCell.Of(archive + ":" + entry.Key), LiveCell.Of((long)entry.Archive),
            tone is null ? LiveCell.Null : LiveCell.Of(tone)
        ]);
    }

    /// <summary>A log line's text without its line break, at most <see cref="MessageChars"/> characters.</summary>
    internal static string? Message(string? text)
    {
        if (text is null) return null;
        var trimmed = text.TrimEnd('\r', '\n', ' ');
        return trimmed.Length > MessageChars ? trimmed[..(MessageChars - 1)] + "…" : trimmed;
    }

    private static LiveReaderSample Failed(AgentReadError error) =>
        new(null, [], [LiveErrors.Create(ReadProbe, error.Code, error.Message, error.Number == 0 ? null : error.Number)], Sampled: false);

    private static int? Int(object? value) => value is null or DBNull ? null : Convert.ToInt32(value, CultureInfo.InvariantCulture);
}
