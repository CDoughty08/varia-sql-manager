using Microsoft.Data.SqlClient;
using Varia.Backend.Explorer;

namespace Varia.Backend.Live;

/// <summary>A table a reader built: its index in the probe's catalogue entry, its rows in catalogue column order, the rows it
/// read past its cap (cut, as rowLimit), the predicate the source's own filter keeps rows by (null: every row), and the one
/// its facets count rows by (null: every row; the Activity Monitor's view chip and toggles, but not its filter box or column
/// value filters, so a column's own filter never empties its list).</summary>
internal sealed record LiveReaderTable(int Table, List<LiveRow> Rows, long More = 0, Func<LiveRow, bool>? View = null, Func<LiveRow, bool>? FacetScope = null);

/// <summary>What one probe's statements gave: the metrics row (null without series), its tables, status values, and the
/// errors of statements that failed alone, each naming the tables or series it feeds. Sampled is false when nothing was read:
/// the probe failed, and Errors[0] says why. SeriesReset says the series follow something else from this sample on (the
/// Activity Monitor's focus series another session): the sample is marked reset, so charts start them again.</summary>
internal sealed record LiveReaderSample(LiveRawSample? Raw, List<LiveReaderTable> Tables, List<LiveProbeError> Errors, bool Sampled = true, IReadOnlyList<LiveStatus>? Status = null,
    bool SeriesReset = false);

/// <summary>A SQL source whose probes run several statements each and build their rows in C# (the Activity Monitor), rather
/// than one LiveSql batch. SqlSampler keeps everything else: the pooled connection, the live gates, the statement budget (one
/// token for all of a probe's statements), the delta engine, the table writers, back-off and error mapping. A statement error
/// that breaks the connection or the budget (CONNECTION_LOST, TIMEOUT, a cancel) is thrown, so the probe fails as a LiveSql
/// probe would; an error that concerns one statement is a value in the sample.</summary>
internal interface ILiveSqlReader
{
    /// <summary>The source's own session probe, run once per opened connection in place of LiveSql.Session: the session id and
    /// whether the login reads server state (<paramref name="permission"/> names the permission that shows it).</summary>
    Task<(int Spid, bool ServerState)> SessionAsync(SqlConnection connection, string prologue, string permission, CancellationToken token);
    /// <summary>Why the probe does not run on this server, as the opened frame's reason and note, or null when it does.</summary>
    (string Reason, string Note)? Unavailable(LiveProbeJson spec, ServerProfile profile);
    Task<LiveReaderSample> ReadAsync(SqlConnection connection, string prologue, LiveDue item, Func<string, string, string>? testText, CancellationToken token);
    /// <summary>New args from live.subscribe or live.update, already checked for the source.</summary>
    void Apply(object args);
    /// <summary>The connection was lost and may reach another server: per-row rates start again.</summary>
    void Reset();
    /// <summary>The prologue the reader's statements run with once its session probe has chosen one (an SSISDB reader reads
    /// committed when the catalog's database has READ_COMMITTED_SNAPSHOT on); null keeps the scope's.</summary>
    string? Prologue => null;
}
