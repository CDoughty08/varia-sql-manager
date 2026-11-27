using System.Diagnostics;
using System.Globalization;
using Microsoft.Data.SqlClient;
using Varia.Backend.Explorer;

namespace Varia.Backend.Search;

/// <summary>How a SQL Server check (a stale-only build, ObjectSearchService.Freshness) left each database it looked at: held as it
/// was (its fingerprint matched), read again in part, read whole, or not checked (the fingerprint failed, timed out or was denied, so
/// the held read stays and so does its mark).</summary>
internal readonly record struct SqlCheckCounts(long Kept, long Reread, long Whole, long Failed);

internal sealed partial class ObjectSearchService
{
    /// <summary>How long a SQL Server database's read is trusted before a search that uses it checks it again (its fingerprint,
    /// about a tenth of a second a database).</summary>
    internal static readonly TimeSpan SqlCheckAfter = TimeSpan.FromMinutes(15);
    /// <summary>How long a BigQuery dataset's read is trusted before a search that uses it lists it again (three free list calls,
    /// and a get for each object created or changed since).</summary>
    internal static readonly TimeSpan BigQueryCheckAfter = TimeSpan.FromHours(1);

    /// <summary>The checks' clock (UTC), which they move forward.</summary>
    internal Func<DateTime> UtcNow { get; set; } = () => DateTime.UtcNow;

    private sealed partial class State
    {
        /// <summary>SQL Server databases DDL from one of Varia's query tabs, object actions or Table Designer may have changed, by name
        /// (<see cref="ServerScope"/> for the server's own objects), each with its mark (under Gate): the next check reads them.</summary>
        public readonly Dictionary<string, long> SqlStale = new(StringComparer.Ordinal);
        /// <summary>Units a search used after they were last checked longer ago than the provider's threshold, by key, each with its
        /// mark (under Gate): the next check verifies them (a fingerprint, or a re-list that reuses what is unchanged).</summary>
        public readonly Dictionary<string, long> Due = new(StringComparer.Ordinal);
        /// <summary>When each held unit was last confirmed against its source, by key (UTC ticks, under Gate).</summary>
        public readonly Dictionary<string, long> Checked = new(StringComparer.Ordinal);
        /// <summary>When each unit was last checked or tried (UTC ticks, under Gate): a check that failed is not asked again before the
        /// threshold has passed once more.</summary>
        public readonly Dictionary<string, long> Tried = new(StringComparer.Ordinal);
        /// <summary>A check (a stale-only build) is running, rather than a full build (under Gate).</summary>
        public bool Checking;
        /// <summary>The databases the last full build listed (under Gate): a check reads a database that is new since in whole.</summary>
        public HashSet<string> Listed = new(StringComparer.Ordinal);
    }

    private long checkKept, checkReread, checkWhole, checkFailed;

    /// <summary>What SQL Server checks did (the checks read them).</summary>
    internal SqlCheckCounts SqlChecks => new(Interlocked.Read(ref checkKept), Interlocked.Read(ref checkReread), Interlocked.Read(ref checkWhole), Interlocked.Read(ref checkFailed));

    /// <summary>A check's hook: called with a database and what its check did (kept, reread, whole or failed).</summary>
    internal Action<string, string>? CheckOutcome { get; set; }

    /// <summary>
    /// DDL from one of Varia's query tabs, an object action or Table Designer ran in <paramref name="database"/> (null: on the server's
    /// own objects): the database is checked at the next use of the index (a search, or Refresh) rather than its held read served as
    /// it is. A connection with no SQL Server index keeps no mark. Free: nothing is read here.
    /// </summary>
    public void MarkSqlStale(string connectionId, string? database)
    {
        if (!states.TryGetValue(connectionId, out var state)) return;
        lock (state.Gate)
        {
            if (state.BigQuery) return;
            var key = database ?? ServerScope;
            // A mark on a database the index neither holds nor listed would be read by no check, and would never be spent.
            if (key.Length > 0 && state.Index.Get(key) is null && !state.Listed.Contains(key)) return;
            state.SqlStale[key] = ++state.StaleMarks;
        }
    }

    /// <summary>The SQL Server databases marked stale on a connection (the checks read them).</summary>
    internal List<string> SqlStaleOf(string connectionId)
    {
        if (!states.TryGetValue(connectionId, out var state)) return [];
        lock (state.Gate) return [.. state.SqlStale.Keys];
    }

    /// <summary>The units due for a check on a connection (the checks read them).</summary>
    internal List<string> DueOf(string connectionId)
    {
        if (!states.TryGetValue(connectionId, out var state)) return [];
        lock (state.Gate) return [.. state.Due.Keys];
    }

    /// <summary>Under Gate: a unit was confirmed against its source now (and tried).</summary>
    private void CheckedLocked(State state, string key)
    {
        var now = UtcNow().Ticks;
        state.Checked[key] = now;
        state.Tried[key] = now;
        // Due only for its age, which a check has just reset; a DDL mark stays until the read it asks for.
        state.Due.Remove(key);
    }

    /// <summary>
    /// Under Gate, as a search uses the index: marks each held unit it reads (one database, one project or dataset, or every one) whose
    /// last check (or try) is older than the provider's threshold as due, with a new mark, so the status the search answers names the
    /// mark and the renderer asks one check for it. Nothing is marked while a full build runs, which reads them all anyway. A unit
    /// held before anything checked it (a check's own Held read) starts its clock now.
    /// </summary>
    private void DueOnUseLocked(State state, string? database, string? project, string? dataset)
    {
        if (state.Building && !state.Checking) return;
        var now = UtcNow().Ticks;
        var after = (state.BigQuery ? BigQueryCheckAfter : SqlCheckAfter).Ticks;
        foreach (var read in state.Index.Databases)
        {
            if (state.BigQuery ? read.Dataset is null || project is not null && read.Database != project || dataset is not null && read.Dataset != dataset
                : read.Dataset is not null || database is not null && read.Database != database) continue;
            var key = read.Key;
            // A loaded read no listing has checked yet is the running (or a failed) full build's: the status already says so.
            if (state.BigQuery && state.Saved.ContainsKey(key)) continue;
            if (!state.Tried.TryGetValue(key, out var tried)) { state.Tried[key] = now; continue; }
            if (now - tried < after || state.Due.ContainsKey(key) || (state.BigQuery ? state.Stale.ContainsKey((read.Database, read.Dataset!)) || state.StaleProjects.ContainsKey(read.Database)
                : state.SqlStale.ContainsKey(key))) continue;
            state.Due[key] = ++state.StaleMarks;
        }
    }

    /// <summary>Under Gate: what the status says of how fresh the index is (docs/object-search.md, Freshness): when the oldest held
    /// unit was read and whether it came from the saved index, when the one checked longest ago was last checked, how many units are
    /// marked and not yet checked, and how many could not be verified (a SQL Server read with no fingerprint, a BigQuery dataset
    /// loaded and not yet listed).</summary>
    private (string? ReadAt, bool? Saved, string? CheckedAt, int? Stale, int? Unverified) FreshnessLocked(State state, IReadOnlyCollection<DatabaseIndex> databases)
    {
        DatabaseIndex? oldest = null;
        long? checkedAt = null;
        var unverified = 0;
        // Only a saving store takes fingerprints: without one, a check reads a database whole, which needs none.
        var fingerprints = state.Index.Sink?.Scope is not null && Store.Saves;
        foreach (var read in databases)
        {
            if (state.BigQuery != read.Dataset is not null) continue;
            if (oldest is null || read.ReadAt < oldest.ReadAt) oldest = read;
            if (state.BigQuery ? state.Saved.ContainsKey(read.Key) : fingerprints && read.Sync.IsEmpty) unverified++;
            else if (state.Checked.TryGetValue(read.Key, out var ticks) && (checkedAt is null || ticks < checkedAt)) checkedAt = ticks;
        }
        var stale = state.BigQuery ? state.Stale.Count + state.StaleProjects.Count + state.Due.Count : state.SqlStale.Count + state.Due.Count;
        return (SavedAtText(oldest is null ? null : Utc(oldest.ReadAt)), oldest is { Loaded: true } ? true : null, checkedAt is { } at ? SavedAtText(new DateTime(at, DateTimeKind.Utc)) : null,
            stale > 0 ? stale : null, unverified > 0 ? unverified : null);
    }

    /// <summary>
    /// A SQL Server check (explorer.index with stale, docs/object-search.md, Freshness): lists the databases again, drops those gone,
    /// and verifies each database DDL marked stale, a search found due, or <paramref name="database"/> names (Object Explorer's
    /// Refresh, whatever its age), and each database new since the last full build: a held read with a fingerprint is held as it is
    /// when the fingerprint still matches, and otherwise only what changed is read again (PR 5's tiers, from the held read rather than a
    /// file); one with none is read whole. A check never replaces a running full build, which reads everything anyway; a full build
    /// replaces a running check.
    /// </summary>
    private async Task<ObjectIndexResult> CheckSqlAsync(ObjectIndexArgs args, State state, ServerProfile profile, CancellationToken token, Action<object>? progress)
    {
        var watch = Stopwatch.StartNew();
        var explorer = profile.Explorer(ExplorerCatalog.Current);
        var perDatabase = explorer.Cloud;
        var render = IndexRender(profile);
        using var source = CancellationTokenSource.CreateLinkedTokenSource(token);
        HashSet<string> targets;
        long seen;
        bool definitions;
        lock (state.Gate)
        {
            if (state.Building && !state.Checking || !state.Built && state.Index.Databases.Count == 0) return new(Status(state), watch.ElapsedMilliseconds);
            targets = [.. state.SqlStale.Keys, .. state.Due.Keys];
            if (args.Database is { } asked) targets.Add(asked);
            else if (args.CheckAll == true)
            {
                targets.Add(ServerScope);
                foreach (var read in state.Index.Databases) targets.Add(read.Database);
            }
            if (targets.Count == 0) return new(Status(state), watch.ElapsedMilliseconds);
            seen = state.StaleMarks;
            definitions = state.Definitions;
            try { state.Build?.Cancel(); } catch (ObjectDisposedException) { }
            state.Build = source;
            state.Building = true;
            state.Checking = true;
        }
        var entry = running.Register(args.RequestId, args.ConnectionId, source);
        bool Current() => ReferenceEquals(state.Build, source);
        // The check's answer: its status once it has ended, so the status it answers is not still building or checking.
        ObjectIndexResult Answer()
        {
            lock (state.Gate)
                if (Current()) { state.Build = null; state.Building = false; state.Checking = false; }
            return new(Status(state), watch.ElapsedMilliseconds);
        }
        // Spends a target's marks made before the check began: DDL that lands while it reads stays marked.
        void Spend(string key, bool checkedNow)
        {
            lock (state.Gate)
            {
                if (!Current()) return;
                if (state.SqlStale.TryGetValue(key, out var mark) && mark <= seen) state.SqlStale.Remove(key);
                if (state.Due.TryGetValue(key, out var due) && due <= seen) state.Due.Remove(key);
                if (checkedNow) CheckedLocked(state, key);
                else state.Tried[key] = UtcNow().Ticks;
            }
        }
        try
        {
            var names = await ListAsync(args.ConnectionId, source.Token);
            var listed = names.ToHashSet(StringComparer.Ordinal);
            List<string> databases;
            lock (state.Gate)
            {
                if (!Current()) throw new OperationCanceledException(source.Token);
                // New since the last full build: read whole, as a full build would. Gone: dropped, with their marks.
                databases = [.. names.Where(name => targets.Contains(name) || !state.Listed.Contains(name) && state.Index.Get(name) is null)];
                foreach (var gone in targets.Where(name => name.Length > 0 && !listed.Contains(name)))
                {
                    state.SqlStale.Remove(gone);
                    state.Due.Remove(gone);
                }
                state.Listed = listed;
            }
            state.Index.Keep(listed);
            if (targets.Contains(ServerScope))
            {
                var serverSkip = await ReadServerAsync(args.ConnectionId, state, !explorer.Cloud, definitions, source.Token);
                if (serverSkip is not null) lock (state.Gate) state.Skipped.Add(SkipList.Server, serverSkip);
                // Agent's objects are the server's too (a job an object action changed).
                if (explorer.Agent is { } platform && await ReadAgentAsync(args.ConnectionId, state, Varia.Backend.Agent.AgentCatalog.Current.Offers("alerts", platform), source.Token) is { } agentSkip)
                    lock (state.Gate) state.Skipped.Add(SkipList.Agent, agentSkip);
                Spend(ServerScope, checkedNow: serverSkip is null);
            }
            await ReadDatabasesAsync(databases, Limits.Total, (name, loop) => CheckDatabaseAsync(args.ConnectionId, state, name, render, definitions, perDatabase, loop), (at, outcome) =>
            {
                lock (state.Gate)
                {
                    if (!Current()) return;
                    var name = databases[at];
                    // The check's outcome replaces the database's earlier skip (a read that failed before and passes now).
                    state.Skipped.Remove(name);
                    if (outcome is { Skip: { } skip }) state.Skipped.Add(Math.Max(0, names.IndexOf(name)), skip);
                    state.Ledger.Done(name, outcome?.Skip);
                }
                // A check whose fingerprint failed leaves the database marked: its next use shows it is still not checked.
                if (outcome is { Unchecked: true }) { lock (state.Gate) if (Current()) state.Tried[databases[at]] = UtcNow().Ticks; }
                else Spend(databases[at], checkedNow: outcome?.Skip is null or { Code: ChildrenLeftOut });
            }, progress is null ? null : done => progress(new { Type = "explorer.index.progress", Done = done, Total = databases.Count, Objects = state.Index.Objects }), source.Token);
            return Answer();
        }
        catch (Exception error) when (error is OperationCanceledException || (error is SqlException && source.IsCancellationRequested))
        {
            throw new RequestException("CANCELLED", "The object index check was stopped.");
        }
        catch (SqlException error)
        {
            // The database list itself failed: the index keeps what it had and its marks, and the check answers as a value.
            lock (state.Gate) state.Skipped.Add(SkipList.Server, new("", "CATALOG_ERROR", ExplorerErrors.From(error, ErrorPhase.Statement, "Databases", null).Message));
            return Answer();
        }
        finally
        {
            lock (state.Gate)
                if (Current()) { state.Build = null; state.Building = false; state.Checking = false; }
            Ended();
            running.Unregister(args.RequestId, entry);
        }
    }

    /// <summary>What a check did with one database: the skip to report, and whether it left the database unchecked.</summary>
    private sealed record CheckedDatabase(ObjectIndexSkip? Skip, bool Unchecked = false);

    /// <summary>Checks one database: a held read with a fingerprint of the same mode is verified against the server (<see cref="RecheckAsync"/>);
    /// any other (none held, no fingerprint, or one the check could not use) is read as a full build reads it.</summary>
    private async Task<CheckedDatabase?> CheckDatabaseAsync(string connectionId, State state, string database, SqlRender render, bool definitions, bool perDatabase, CancellationToken token)
    {
        var held = state.Index.Get(database);
        if (held is not null && SqlSync.From(held.Sync.Span) is { } saved && saved.Definitions == definitions && saved.Children == !held.ChildrenLeftOut)
        {
            using var budgetSource = CancellationTokenSource.CreateLinkedTokenSource(token);
            await total.WaitAsync(token);
            budgetSource.CancelAfter(Limits.DatabaseBudget);
            string outcome;
            try
            {
                await using var connection = host.Connection(connectionId, perDatabase ? database : null);
                await host.OpenAsync(connection, budgetSource.Token);
                outcome = await RecheckAsync(connection, state, database, held, render, definitions, perDatabase, saved.Children, budgetSource.Token, token);
            }
            catch (Exception error) when (error is OperationCanceledException or SqlException or InvalidOperationException && !token.IsCancellationRequested) { outcome = "failed"; }
            finally { total.Release(); }
            if (outcome == "kept") Interlocked.Increment(ref checkKept);
            else if (outcome == "reread") Interlocked.Increment(ref checkReread);
            else if (outcome == "failed") Interlocked.Increment(ref checkFailed);
            else Interlocked.Increment(ref checkWhole);
            CheckOutcome?.Invoke(database, outcome);
            if (outcome == "failed") return new(null, Unchecked: true);
            if (outcome != "whole") return new(null);
        }
        else
        {
            Interlocked.Increment(ref checkWhole);
            CheckOutcome?.Invoke(database, "whole");
        }
        return new(await ReadAsync(connectionId, state, database, render, definitions, perDatabase, token));
    }

    /// <summary>
    /// Verifies a held read against the server: "kept" when its fingerprint still matches; "reread" when only what changed since was
    /// read again beside the rest of it and held (verified as a whole read is); "whole" when it is to be read whole (another database
    /// under the name, too much changed, no listing beside it, definitions left out that now fit, or a selective read that failed or
    /// ran past its deadline); "failed" when the fingerprint failed, timed out or was denied, so the held read stays as it is. The held
    /// read is never given up here: a merged read replaces it only when held.
    /// </summary>
    private async Task<string> RecheckAsync(SqlConnection connection, State state, string database, DatabaseIndex held, SqlRender render, bool definitions, bool perDatabase, bool children,
        CancellationToken token, CancellationToken stop)
    {
        var saved = SqlSync.From(held.Sync.Span)!.Value;
        SqlFingerprint? fingerprint;
        try { fingerprint = await FingerprintAsync(connection, database, render, perDatabase, token); }
        catch (Exception error) when (error is SqlException or OperationCanceledException or InvalidOperationException && !stop.IsCancellationRequested) { return "failed"; }
        if (fingerprint is not { } now) return "whole";
        var current = now.Sync(definitions, children);
        if (!current.SameDatabase(saved)) return "whole";
        if (current.Unchanged(saved))
            // Definitions left out for memory come back once there is room for them, as a reload does.
            return held.LeftOut > 0 && budget.Free >= Limits.NamesReserveBytes + held.Bytes ? "whole" : "kept";
        if (!now.Selective || held.LeftOut > 0 || held.Extra.IsEmpty || SqlListing.From(held.Extra.Span, held.Table.Count) is not { } listing) return "whole";
        DatabaseReader? reader = null;
        DatabaseIndex? kept = null;
        using var selective = CancellationTokenSource.CreateLinkedTokenSource(token);
        selective.CancelAfter(SelectiveBudget ?? Limits.DatabaseBudget / 3);
        try
        {
            var rows = await ListingAsync(connection, database, perDatabase, selective.Token);
            var plan = SqlReloadPlan.Of(listing, rows);
            if (!plan.Worth(rows.Count)) return "whole";
            reader = new DatabaseReader(database, Limits, pool, held);
            if (!reader.Seed(held, listing, plan.Keeps)) return "whole";
            await using var command = connection.CreateCommand();
            command.CommandTimeout = 0;
            InDatabase(command, database, perDatabase, ObjectSearchSql.Batch(render, definitions, children, only: true),
                "[" + string.Join(",", plan.Reread.Order().Select(id => id.ToString(CultureInfo.InvariantCulture))) + "]");
            var merged = await ReadBatchAsync(command, rows => reader.ReadAsync(rows, definitions, selective.Token, children), read => kept = read, selective.Token);
            if (merged is null) return "whole";
            kept = null;
            await HoldVerifiedAsync(connection, database, render, perDatabase, now, merged, reader.Listing, definitions, children, Holding(state.Index, children), stop);
            return "reread";
        }
        catch (Exception error) when (error is SqlException or InvalidOperationException or OperationCanceledException && !stop.IsCancellationRequested)
        {
            // A merged read whose batch then failed to close is held, with nothing to compare (the whole read that follows replaces it).
            if (kept is { } read) Holding(state.Index, children)(read);
            else reader?.Abandon();
            return "whole";
        }
        catch
        {
            if (kept is { } read) Holding(state.Index, children)(read);
            else reader?.Abandon();
            throw;
        }
    }
}
