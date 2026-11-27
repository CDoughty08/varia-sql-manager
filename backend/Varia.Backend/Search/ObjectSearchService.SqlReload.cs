using System.Data;
using Microsoft.Data.SqlClient;
using Varia.Backend.Explorer;

namespace Varia.Backend.Search;

/// <summary>How a SQL Server build used the saved index (the checks read them): databases whose fingerprint matched and that were
/// held as saved, databases read again only in part and the ids those reads named, and why a saved database was read whole
/// instead: a file with no fingerprint this version reads, saved in another mode (definitions or children), another database's
/// (identity), a fingerprint, listing or selective read that failed, timed out or was denied, a file that did not load (or was
/// rewritten meanwhile), or too much changed (or the database cannot take OPENJSON) for a selective read to pay.</summary>
internal readonly record struct SqlReloadCounts(long Unchanged, long Reread, long RereadIds, long Unverifiable, long Mode, long Identity, long Failed, long Refused, long Whole);

internal sealed partial class ObjectSearchService
{
    private long reloadUnchanged, reloadReread, reloadRereadIds, reloadUnverifiable, reloadMode, reloadIdentity, reloadFailed, reloadRefused, reloadWhole;

    internal SqlReloadCounts SqlReloads => new(Interlocked.Read(ref reloadUnchanged), Interlocked.Read(ref reloadReread), Interlocked.Read(ref reloadRereadIds),
        Interlocked.Read(ref reloadUnverifiable), Interlocked.Read(ref reloadMode), Interlocked.Read(ref reloadIdentity), Interlocked.Read(ref reloadFailed),
        Interlocked.Read(ref reloadRefused), Interlocked.Read(ref reloadWhole));

    /// <summary>The fingerprint a reload compares (the live checks swap it for one that fails or waits); a whole read's batch always
    /// starts with <see cref="ObjectSearchSql.Fingerprint"/> itself.</summary>
    internal Func<SqlRender, string> ReloadFingerprint { get; set; } = ObjectSearchSql.Fingerprint;

    /// <summary>The longest a reload's fingerprint may take before the database is read whole instead.</summary>
    internal TimeSpan FingerprintBudget { get; set; } = TimeSpan.FromSeconds(15);

    /// <summary>A reload's answer when it held the database (or found it too large): the skip to report, or null.</summary>
    private sealed record Reloaded(ObjectIndexSkip? Skip);

    /// <summary>
    /// Holds the saved read of <paramref name="database"/> when its fingerprint (<see cref="ObjectSearchSql.Fingerprint"/>) still
    /// matches the file's (<see cref="SqlSync"/>), or reads again only what changed (<see cref="SqlReloadPlan"/>) beside the rest
    /// of it; null, having held nothing, when the database is to be read whole: no file, one this version cannot verify, another
    /// mode's, another database's, a failure on the way (counted, never thrown, but a stop or the database's own budget), or too
    /// much changed. A saved read is never searchable before one of these passes.
    /// </summary>
    private async Task<Reloaded?> ReloadAsync(SqlConnection connection, State state, string database, SqlRender render, bool definitions, bool perDatabase, bool children,
        CancellationToken token)
    {
        if (state.Index.Sink?.Scope is not { } scope || Store.Find(scope, IndexUnitKind.Database, database) is not { } unit) return null;
        if (SqlSync.From(unit.Sync) is not { } saved) return Count(ref reloadUnverifiable, database, "unverifiable");
        if (saved.Definitions != definitions || saved.Children != children) return Count(ref reloadMode, database, "mode");
        SqlFingerprint? fingerprint;
        try { fingerprint = await FingerprintAsync(connection, database, render, perDatabase, token); }
        catch (Exception error) when (error is SqlException or OperationCanceledException or InvalidOperationException && !token.IsCancellationRequested) { return Count(ref reloadFailed, database, "failed"); }
        if (fingerprint is not { } now) return Count(ref reloadFailed, database, "failed");
        var current = now.Sync(definitions, children);
        if (!current.SameDatabase(saved)) return Count(ref reloadIdentity, database, "identity");
        var unchanged = current.Unchanged(saved);
        if (!unchanged && !now.Selective) return Count(ref reloadWhole, database, "whole");
        var load = Store.Load(unit, state.Index, Limits, pool, children: children, token: token);
        if (load.Value is not { } loaded) return Count(ref reloadRefused, database, "refused:" + load.Problem);
        // Rewritten since it was found (another connection's build saved it meanwhile): its sync state is not the one compared.
        if (load.Header is not { } header || !IndexStoreNames.TryReadSync(header.Sync, out _, out _, out var own) || !own.AsSpan().SequenceEqual(unit.Sync))
        {
            state.Index.Abandon(loaded);
            return Count(ref reloadRefused, database, "refused:rewritten");
        }
        if (unchanged)
        {
            loaded.Sync = unit.Sync;
            Holding(state.Index, children)(loaded);
            Interlocked.Increment(ref reloadUnchanged);
            ReloadOutcome?.Invoke(database, "unchanged");
            return new(null);
        }
        // A read that left definitions out for memory cannot tell which: it is read whole, which may now fit them.
        if (loaded.LeftOut > 0 || load.Extra is not { } extra || SqlListing.From(extra, loaded.Table.Count) is not { } listing)
        {
            state.Index.Abandon(loaded);
            return Count(ref reloadWhole, database, "whole");
        }
        DatabaseReader? reader = null;
        try
        {
            var rows = await ListingAsync(connection, database, perDatabase, token);
            var plan = SqlReloadPlan.Of(listing, rows);
            if (!plan.Worth(rows.Count))
            {
                state.Index.Abandon(loaded);
                return Count(ref reloadWhole, database, "whole");
            }
            reader = new DatabaseReader(database, Limits, pool, loaded);
            if (!reader.Seed(loaded, listing, plan.Keeps))
            {
                state.Index.Abandon(loaded);
                return new(new(database, "TOO_LARGE", "The database does not fit in the index's memory (" + Size + " across every connection)."));
            }
            await using var command = connection.CreateCommand();
            command.CommandTimeout = 0;
            InDatabase(command, database, perDatabase, ObjectSearchSql.Batch(render, definitions, children, only: true),
                "[" + string.Join(",", plan.Reread.Order().Select(id => id.ToString(System.Globalization.CultureInfo.InvariantCulture))) + "]");
            var merged = await ReadBatchAsync(command, rows => reader.ReadAsync(rows, definitions, token, children), read =>
            {
                // The fingerprint taken before the listing: whatever changed after it makes the next one differ from this.
                read.Sync = current.ToBytes();
                read.Extra = reader.Listing ?? default(ReadOnlyMemory<byte>);
                Holding(state.Index, children)(read);
            }, token);
            state.Index.Abandon(loaded);
            if (merged is null) return new(new(database, "TOO_LARGE", "The database does not fit in the index's memory (" + Size + " across every connection)."));
            Interlocked.Increment(ref reloadReread);
            Interlocked.Add(ref reloadRereadIds, plan.Reread.Count);
            ReloadOutcome?.Invoke(database, "reread:" + plan.Reread.Count.ToString(System.Globalization.CultureInfo.InvariantCulture) + ":" + reader.Listed.ToString(System.Globalization.CultureInfo.InvariantCulture));
            return new(null);
        }
        catch (Exception error) when (error is SqlException or InvalidOperationException && !token.IsCancellationRequested)
        {
            reader?.Abandon();
            state.Index.Abandon(loaded);
            return Count(ref reloadFailed, database, "failed");
        }
        catch
        {
            reader?.Abandon();
            state.Index.Abandon(loaded);
            throw;
        }
    }

    private Reloaded? Count(ref long counter, string database, string outcome)
    {
        Interlocked.Increment(ref counter);
        ReloadOutcome?.Invoke(database, outcome);
        return null;
    }

    /// <summary>A check's hook: called with a database and what its reload did (unchanged, reread, or why it read it whole).</summary>
    internal Action<string, string>? ReloadOutcome { get; set; }

    /// <summary>The database's fingerprint now, or null where sys.databases shows the login no row for it; within
    /// <see cref="FingerprintBudget"/>, past which it throws OperationCanceledException (the caller reads the database whole).</summary>
    private async Task<SqlFingerprint?> FingerprintAsync(SqlConnection connection, string database, SqlRender render, bool perDatabase, CancellationToken token)
    {
        using var limit = CancellationTokenSource.CreateLinkedTokenSource(token);
        limit.CancelAfter(FingerprintBudget);
        await using var command = connection.CreateCommand();
        command.CommandTimeout = 0;
        InDatabase(command, database, perDatabase, ReloadFingerprint(render));
        await using var rows = await command.ExecuteReaderAsync(CommandBehavior.SequentialAccess, limit.Token);
        return await SqlFingerprint.ReadAsync(rows, limit.Token);
    }

    /// <summary>The database's indexed sys.objects rows now (<see cref="ObjectSearchSql.Listing"/>), at most as many as a listing holds.</summary>
    private static async Task<List<SqlListingRow>> ListingAsync(SqlConnection connection, string database, bool perDatabase, CancellationToken token)
    {
        await using var command = connection.CreateCommand();
        command.CommandTimeout = 0;
        InDatabase(command, database, perDatabase, ObjectSearchSql.Listing);
        await using var rows = await command.ExecuteReaderAsync(CommandBehavior.SequentialAccess, token);
        var listed = new List<SqlListingRow>();
        while (await rows.ReadAsync(token))
        {
            if (listed.Count >= SqlListing.MostRows) throw new InvalidOperationException("The listing is longer than a saved listing holds.");
            listed.Add(new(rows.GetInt32(0), rows.GetInt32(1), rows.GetDateTime(2).Ticks, rows.IsDBNull(3) ? 0 : rows.GetInt32(3), -1));
        }
        return listed;
    }
}
