using System.Data.Common;
using System.Globalization;

namespace Varia.Backend.Results;

/// <summary>What a run does with each result set it reads, and what it did not keep: sets discarded on request (Discard
/// results after execution) with the rows read past in them, and sets dropped past maxResultSets, past the summary's
/// descriptor limit or after the result budget refused one. SqlService's read loop asks it at each set; the summary's
/// notes and DiscardedResultSets come from it. Apart from the loop so that its decisions are checked without a server
/// (DiscardChecks).</summary>
internal sealed class ResultSetTally
{
    internal enum Fate { Unkept, Overflow, Oversize, Open }

    /// <summary>Sets discarded on request, and the rows read past in them, counted as they pass: a run that is stopped or
    /// fails part-way through a set still says how many it read.</summary>
    public int UnkeptSets { get; private set; }
    public long UnkeptRows { get; private set; }
    public int OverflowSets { get; private set; }
    public int OversizeSets { get; private set; }
    public int BudgetSets { get; private set; }

    /// <summary>QueryResult.DiscardedResultSets: every set read and not returned, for whatever reason.</summary>
    public int Discarded => OverflowSets + OversizeSets + BudgetSets + UnkeptSets;

    /// <summary>Decides what becomes of the set the reader is on, which has columns. A set that may be a plan has its first row
    /// read, and <paramref name="told"/> builds its plan from the start of that row's text (null for a set that may not be
    /// a plan, or has no rows), saying whether it is a plan and whether its descriptors are past the summary's limit. A
    /// discarded set is read to its end here, its rows counted. Open: the caller opens the plan in the store, calling
    /// <see cref="Refused"/> if the budget refuses it. Prefetched: the reader is on the set's first row, still to be read
    /// (never for a discarded set).</summary>
    public async Task<(Fate Fate, bool Prefetched, TPlan? Plan)> SortAsync<TPlan>(DbDataReader reader, bool discard, int keptSets, int maxResultSets,
        Func<string?, (TPlan Plan, bool IsPlan, bool DescriptorsTooLarge)> told, CancellationToken token) where TPlan : class
    {
        var mayBePlan = ColumnPlan.MayBeExecutionPlan(reader);
        var fate = Arrive(discard, mayBePlan, keptSets, maxResultSets);
        var prefetched = false;
        TPlan? plan = null;
        if (fate == Fate.Open)
        {
            prefetched = mayBePlan && await reader.ReadAsync(CancellationToken.None);
            var (built, isPlan, tooLarge) = told(prefetched ? ColumnPlan.ReadShowplanPrefix(reader) : null);
            fate = Told(discard, isPlan, prefetched, tooLarge);
            if (fate == Fate.Open) plan = built;
            // Its prefetched row was counted with it.
            else if (fate == Fate.Unkept) prefetched = false;
        }
        // Rows are counted as they pass, so a run that is stopped or fails says how many it read.
        if (fate == Fate.Unkept) await PassAsync(reader, ColumnPlan.HasLongColumns(reader), token);
        return (fate, prefetched, plan);
    }

    /// <summary>A set with columns, before any of its rows is read. With results discarded only a set that may be a plan
    /// (its first row says) is looked at, and then within the limits on sets as ever. Open means: read its first row if it
    /// may be a plan, build its plan and call <see cref="Told"/>.</summary>
    public Fate Arrive(bool discard, bool mayBePlan, int keptSets, int maxResultSets)
    {
        if (discard && !mayBePlan)
        {
            UnkeptSets++;
            return Fate.Unkept;
        }
        if (keptSets >= maxResultSets) { OverflowSets++; return Fate.Overflow; }
        // Once one set's columns did not fit, no later one is shown, so the results do not skip a set silently.
        if (OversizeSets > 0) { OversizeSets++; return Fate.Oversize; }
        return Fate.Open;
    }

    /// <summary>A set <see cref="Arrive"/> opened, once its first row said whether it is a plan. A set that looked like a plan
    /// and is rows is discarded, and the row read to tell is one of its rows. Open means: open it in the store, calling
    /// <see cref="Refused"/> if the budget refuses it.</summary>
    public Fate Told(bool discard, bool isPlan, bool prefetched, bool descriptorsTooLarge)
    {
        if (discard && !isPlan)
        {
            UnkeptSets++;
            if (prefetched) UnkeptRows++;
            return Fate.Unkept;
        }
        if (descriptorsTooLarge) { OversizeSets++; return Fate.Oversize; }
        return Fate.Open;
    }

    /// <summary>The store refused a set Told opened: the result budget is full.</summary>
    public void Refused() => BudgetSets++;

    /// <summary>Reads past the rest of a discarded set, counting its rows as they pass. Long values are read past on a thread
    /// of its own (SqlService.SkipRowsAsync), as in a set that stopped storing; a thread for every set of a script that
    /// returns thousands would be the cost of the script, so other sets are read inline.</summary>
    public async Task PassAsync(DbDataReader reader, bool hasLong, CancellationToken token)
    {
        if (hasLong)
        {
            var passed = new long[1];
            try { await SqlService.SkipRowsAsync(reader, null, null, token, passed); }
            finally { UnkeptRows += passed[0]; }
        }
        else while (await reader.ReadAsync(CancellationToken.None)) UnkeptRows++;
    }

    /// <summary>Whether a row of an open set is stored. The row limit is on the rows a query returns, so a plan asked for
    /// with them is kept whatever came before; a plan is told by its first row and is that row, so a set of more rows under
    /// a plan's column name is rows. With results discarded only a plan's set is open, and only its plan is kept of it.</summary>
    public static bool Stores(bool discard, int maxRows, long storedRows, bool planRow) =>
        planRow || !discard && (maxRows <= 0 || storedRows < maxRows);

    /// <summary>The summary's notes on the sets not kept, in order.</summary>
    public IEnumerable<string> Notes(int maxResultSets)
    {
        if (UnkeptSets > 0)
            yield return "Discard results after execution is on: " + Count(UnkeptSets) + (UnkeptSets == 1 ? " result set (" : " result sets (")
                + Count(UnkeptRows) + (UnkeptRows == 1 ? " row) " : " rows) ") + (UnkeptSets == 1 ? "was" : "were") + " read and not kept.";
        if (OverflowSets > 0)
            yield return "Only the first " + (maxResultSets == 10 ? "ten" : Count(maxResultSets)) + " result sets are displayed. Display limits do not stop script execution.";
        if (OversizeSets > 0)
            yield return OversizeSets + " later result sets are not displayed because their column lists are too large to return. Display limits do not stop script execution.";
    }

    private static string Count(long value) => value.ToString("N0", CultureInfo.InvariantCulture);
}
