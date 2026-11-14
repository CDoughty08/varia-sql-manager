using System.Collections;
using System.Collections.ObjectModel;
using System.Data.Common;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>Offline checks of Discard results after execution: the read loop's decisions for each result set
/// (ResultSetTally) against a fake reader, so they hold on a machine with no SQL Server. Which sets are not kept, how their
/// rows are counted inline and on a thread of their own (also when the read is stopped or fails part-way), a set named
/// like a plan whose first row is not one, a plan kept with only its plan row, plans past maxResultSets or the descriptor
/// limit, the note's wording and the discarded total. The live Query suite checks the same against a server.</summary>
internal static class DiscardChecks
{
    private const string PlanXml = "<ShowPlanXML xmlns=\"http://schemas.microsoft.com/sqlserver/2004/07/showplan\" Version=\"1.564\"><BatchSequence/></ShowPlanXML>";

    public static async Task RunAsync(Action<bool, string> check)
    {
        Arrivals(check);
        await CountsAsync(check);
        await PlansAsync(check);
        Rows(check);
        Notes(check);
    }

    // Which sets are looked at before any row is read, and in which order the reasons apply.
    private static void Arrivals(Action<bool, string> check)
    {
        var tally = new ResultSetTally();
        check(tally.Arrive(discard: true, mayBePlan: false, keptSets: 0, maxResultSets: 10) == ResultSetTally.Fate.Unkept
            && tally.Arrive(discard: true, mayBePlan: false, keptSets: 10, maxResultSets: 10) == ResultSetTally.Fate.Unkept
            && tally is { UnkeptSets: 2, OverflowSets: 0, UnkeptRows: 0 },
            "with results discarded a set that cannot be a plan is discarded on request, also past maxResultSets");
        tally = new ResultSetTally();
        check(tally.Arrive(discard: true, mayBePlan: true, keptSets: 9, maxResultSets: 10) == ResultSetTally.Fate.Open
            && tally.Arrive(discard: true, mayBePlan: true, keptSets: 10, maxResultSets: 10) == ResultSetTally.Fate.Overflow
            && tally.Arrive(discard: false, mayBePlan: false, keptSets: 10, maxResultSets: 10) == ResultSetTally.Fate.Overflow
            && tally.Arrive(discard: false, mayBePlan: false, keptSets: 0, maxResultSets: 10) == ResultSetTally.Fate.Open
            && tally is { UnkeptSets: 0, OverflowSets: 2 },
            "a set that may be a plan is looked at with results discarded, within maxResultSets as ever");
        tally = new ResultSetTally();
        check(tally.Told(discard: false, isPlan: false, prefetched: false, descriptorsTooLarge: true) == ResultSetTally.Fate.Oversize
            && tally.Arrive(discard: false, mayBePlan: false, keptSets: 0, maxResultSets: 10) == ResultSetTally.Fate.Oversize
            && tally.Arrive(discard: true, mayBePlan: true, keptSets: 0, maxResultSets: 10) == ResultSetTally.Fate.Oversize
            && tally.Arrive(discard: true, mayBePlan: false, keptSets: 0, maxResultSets: 10) == ResultSetTally.Fate.Unkept
            && tally is { OversizeSets: 3, UnkeptSets: 1 },
            "after a set whose columns did not fit no later one is shown, plans included, and other sets are still discarded on request");
        tally = new ResultSetTally();
        check(tally.Told(discard: true, isPlan: false, prefetched: false, descriptorsTooLarge: true) == ResultSetTally.Fate.Unkept
            && tally.Told(discard: true, isPlan: true, prefetched: true, descriptorsTooLarge: false) == ResultSetTally.Fate.Open
            && tally.Told(discard: false, isPlan: false, prefetched: true, descriptorsTooLarge: false) == ResultSetTally.Fate.Open
            && tally is { UnkeptSets: 1, UnkeptRows: 0, OversizeSets: 0 },
            "once its first row has been read a set that is not a plan is discarded on request before its columns are measured, and a plan is kept");
        tally = new ResultSetTally();
        tally.Arrive(discard: true, mayBePlan: false, keptSets: 0, maxResultSets: 1);
        tally.Arrive(discard: false, mayBePlan: false, keptSets: 1, maxResultSets: 1);
        tally.Told(discard: false, isPlan: false, prefetched: false, descriptorsTooLarge: true);
        tally.Refused();
        check(tally is { Discarded: 4, UnkeptSets: 1, OverflowSets: 1, OversizeSets: 1, BudgetSets: 1 },
            "DiscardedResultSets counts the sets discarded on request with those past maxResultSets, past the descriptor limit and refused by the budget");

        check(ColumnPlan.MayBeExecutionPlan(Reader.Showplan())
            && ColumnPlan.MayBeExecutionPlan(new Reader([new(ColumnPlan.ShowplanColumn.ToUpperInvariant(), "nvarchar", true)], []))
            && !ColumnPlan.MayBeExecutionPlan(new Reader([new(ColumnPlan.ShowplanColumn, "nvarchar", false)], []))
            && !ColumnPlan.MayBeExecutionPlan(new Reader([new(ColumnPlan.ShowplanColumn, "varchar", true)], []))
            && !ColumnPlan.MayBeExecutionPlan(new Reader([new(ColumnPlan.ShowplanColumn, "nvarchar", true), new("b", "int", false)], []))
            && !ColumnPlan.MayBeExecutionPlan(new Reader([new("plan", "nvarchar", true)], [])),
            "only one nvarchar(max) column under the showplan's name may be a plan");
        check(ColumnPlan.IsShowplan(PlanXml) && ColumnPlan.IsShowplan(PlanXml[..(PlanXml.IndexOf('>') + 1)]) && !ColumnPlan.IsShowplan("<a/>") && !ColumnPlan.IsShowplan("not xml") && !ColumnPlan.IsShowplan(null),
            "a plan is told by the root of its first row's text, also from a cut prefix");
    }

    // Rows of discarded sets are counted as they pass, on both paths, and what was counted stays when the read stops.
    private static async Task CountsAsync(Action<bool, string> check)
    {
        var tally = new ResultSetTally();
        var plain = Reader.Ints(10);
        var sorted = await Sort(tally, plain);
        check(sorted is { Fate: ResultSetTally.Fate.Unkept, Prefetched: false, Plan: null } && tally is { UnkeptSets: 1, UnkeptRows: 10 }
            && plain.AsyncReads == 11 && plain.SyncReads == 0 && !plain.Asked,
            "a discarded set without long columns is read to its end inline, every row counted");

        tally = new ResultSetTally();
        var wide = Reader.Longs(7);
        sorted = await Sort(tally, wide);
        check(sorted.Fate == ResultSetTally.Fate.Unkept && tally is { UnkeptSets: 1, UnkeptRows: 7 } && wide.SyncReads == 8 && wide.AsyncReads == 0 && wide.PoolReads == 0,
            "a discarded set with a long column is read past synchronously on a thread of its own, every row counted");

        tally = new ResultSetTally();
        var failing = Reader.Ints(10);
        failing.FailAt = 4;
        var error = await Caught(() => Sort(tally, failing));
        check(error is InvalidOperationException && tally is { UnkeptSets: 1, UnkeptRows: 3 },
            "a discarded read that fails part-way inline keeps the rows it had counted: " + tally.UnkeptRows);

        tally = new ResultSetTally();
        failing = Reader.Longs(10);
        failing.FailAt = 4;
        error = await Caught(() => Sort(tally, failing));
        check(error is InvalidOperationException && tally is { UnkeptSets: 1, UnkeptRows: 3 },
            "a discarded read that fails part-way on its own thread keeps the rows it had counted: " + tally.UnkeptRows);

        tally = new ResultSetTally();
        using (var stop = new CancellationTokenSource())
        {
            var stopped = Reader.Longs(10);
            stopped.OnRead = row => { if (row == 5) stop.Cancel(); };
            error = await Caught(() => Sort(tally, stopped, token: stop.Token));
            check(error is OperationCanceledException && tally is { UnkeptSets: 1, UnkeptRows: 5 } && stopped.SyncReads == 5,
                "a discarded read stopped on its own thread ends at the next row and keeps the rows it had counted: " + tally.UnkeptRows);
        }

        // The three sets of the live check, read by one tally: 10 rows, a look-alike of 1 row, and 2 rows with a long column.
        tally = new ResultSetTally();
        await Sort(tally, Reader.Ints(10));
        await Sort(tally, Reader.Showplan("<a/>"));
        await Sort(tally, Reader.Longs(2));
        check(tally is { UnkeptSets: 3, UnkeptRows: 13, Discarded: 3 }
            && tally.Notes(10).SequenceEqual(["Discard results after execution is on: 3 result sets (13 rows) were read and not kept."]),
            "the counts add up across sets and the note says them");
    }

    // A set named like a plan is looked at: a plan is kept, rows under its name are discarded with the row read to tell.
    private static async Task PlansAsync(Action<bool, string> check)
    {
        var tally = new ResultSetTally();
        var lookAlike = Reader.Showplan("<a/>", "<b/>", "<c/>");
        string? told = "unset";
        var sorted = await Sort(tally, lookAlike, prefix => told = prefix);
        check(told == "<a/>" && sorted is { Fate: ResultSetTally.Fate.Unkept, Prefetched: false, Plan: null } && tally is { UnkeptSets: 1, UnkeptRows: 3 }
            && lookAlike.AsyncReads == 1 && lookAlike.SyncReads == 3 && lookAlike.PoolReads == 0,
            "a set named like a plan whose first row is not one is discarded, and the row read to tell is counted with the rest: " + tally.UnkeptRows);

        tally = new ResultSetTally();
        var empty = Reader.Showplan();
        told = "unset";
        sorted = await Sort(tally, empty, prefix => told = prefix);
        check(told is null && sorted.Fate == ResultSetTally.Fate.Unkept && tally is { UnkeptSets: 1, UnkeptRows: 0 },
            "a set named like a plan without rows is discarded, counting no row");

        tally = new ResultSetTally();
        var nullFirst = new Reader([new(ColumnPlan.ShowplanColumn, "nvarchar", true)], [null, "<b/>"]);
        told = "unset";
        sorted = await Sort(tally, nullFirst, prefix => told = prefix);
        check(told is null && sorted is { Fate: ResultSetTally.Fate.Unkept, Prefetched: false } && tally is { UnkeptSets: 1, UnkeptRows: 2 },
            "a set named like a plan whose first row is NULL is discarded, that row counted with the rest");

        // Only a set that may be a plan has its first row read before it is opened, with results kept or not.
        tally = new ResultSetTally();
        var ordinary = Reader.Ints(3);
        told = "unset";
        sorted = await Sort(tally, ordinary, prefix => told = prefix, discard: false);
        var overflowing = Reader.Showplan(PlanXml);
        var past = await Sort(tally, overflowing, keptSets: 10, discard: false);
        check(told is null && sorted is { Fate: ResultSetTally.Fate.Open, Prefetched: false, Plan: "plan" } && ordinary is { AsyncReads: 0, SyncReads: 0, Asked: false }
            && past.Fate == ResultSetTally.Fate.Overflow && overflowing is { AsyncReads: 0, SyncReads: 0 } && tally is { UnkeptSets: 0, OverflowSets: 1 },
            "a set that cannot be a plan is opened without reading a row, and a set past maxResultSets is not read before the loop reads past it");

        tally = new ResultSetTally();
        var planned = Reader.Showplan(PlanXml);
        sorted = await Sort(tally, planned);
        check(sorted is { Fate: ResultSetTally.Fate.Open, Prefetched: true, Plan: "plan" } && tally is { UnkeptSets: 0, UnkeptRows: 0, Discarded: 0 } && planned.AsyncReads == 1 && !tally.Notes(10).Any(),
            "with results discarded a plan is kept, the reader left on its plan row for the loop to store");

        tally = new ResultSetTally();
        sorted = await Sort(tally, Reader.Showplan(PlanXml), keptSets: 10);
        check(sorted is { Fate: ResultSetTally.Fate.Overflow, Prefetched: false, Plan: null } && tally is { OverflowSets: 1, UnkeptSets: 0, Discarded: 1 }
            && tally.Notes(10).SequenceEqual(["Only the first ten result sets are displayed. Display limits do not stop script execution."]),
            "with results discarded a plan past maxResultSets is not kept, and is counted as past the limit, not as discarded on request");

        tally = new ResultSetTally();
        var large = Reader.Showplan(PlanXml);
        sorted = await Sort(tally, large, tooLarge: true);
        var after = await Sort(tally, Reader.Showplan(PlanXml));
        check(sorted is { Fate: ResultSetTally.Fate.Oversize, Prefetched: true, Plan: null } && after is { Fate: ResultSetTally.Fate.Oversize, Prefetched: false }
            && tally is { OversizeSets: 2, UnkeptSets: 0, Discarded: 2 }
            && tally.Notes(10).SequenceEqual(["2 later result sets are not displayed because their column lists are too large to return. Display limits do not stop script execution."]),
            "with results discarded a plan past the descriptor limit is not kept, leaves its row for the loop to read past, and no later plan is kept");
    }

    // Which rows of an open set are stored.
    private static void Rows(Action<bool, string> check)
    {
        check(ResultSetTally.Stores(discard: true, maxRows: 0, storedRows: 0, planRow: true)
            && !ResultSetTally.Stores(discard: true, maxRows: 0, storedRows: 0, planRow: false)
            && !ResultSetTally.Stores(discard: true, maxRows: 100, storedRows: 0, planRow: false),
            "with results discarded a plan's set keeps only its plan row");
        check(ResultSetTally.Stores(discard: false, maxRows: 0, storedRows: 1_000_000, planRow: false)
            && ResultSetTally.Stores(discard: false, maxRows: 5, storedRows: 4, planRow: false)
            && !ResultSetTally.Stores(discard: false, maxRows: 5, storedRows: 5, planRow: false)
            && ResultSetTally.Stores(discard: false, maxRows: 5, storedRows: 5, planRow: true),
            "without discarding every row is stored up to the row limit, and a plan past it");
    }

    private static void Notes(Action<bool, string> check)
    {
        static string Note(int sets, long rows)
        {
            var tally = new ResultSetTally();
            for (var i = 0; i < sets; i++) tally.Told(discard: true, isPlan: false, prefetched: i == 0 && rows == 1, descriptorsTooLarge: false);
            return tally.Notes(10).Single();
        }
        check(Note(1, 1) == "Discard results after execution is on: 1 result set (1 row) was read and not kept."
            && Note(1, 0) == "Discard results after execution is on: 1 result set (0 rows) was read and not kept."
            && Note(2, 0) == "Discard results after execution is on: 2 result sets (0 rows) were read and not kept.",
            "the note's wording follows the counts of sets and rows: " + Note(1, 1));
        // It read "2 result sets (1 row) was read": the verb followed the rows.
        check(Note(2, 1) == "Discard results after execution is on: 2 result sets (1 row) were read and not kept.",
            "the note's verb follows the sets, not the rows: " + Note(2, 1));
        var many = new ResultSetTally();
        for (var i = 0; i < 1234; i++) many.Arrive(discard: true, mayBePlan: false, keptSets: 0, maxResultSets: 10);
        for (var i = 0; i < 1001; i++) many.Arrive(discard: false, mayBePlan: false, keptSets: 1000, maxResultSets: 1000);
        check(many.Notes(1000).SequenceEqual([
                "Discard results after execution is on: 1,234 result sets (0 rows) were read and not kept.",
                "Only the first 1,000 result sets are displayed. Display limits do not stop script execution."]) && many.Discarded == 2235,
            "the note's counts are grouped, and come before the other notes on sets not kept");
        check(!new ResultSetTally().Notes(10).Any(), "a run that kept every set says nothing about sets not kept");
    }

    private static Task<(ResultSetTally.Fate Fate, bool Prefetched, string? Plan)> Sort(ResultSetTally tally, Reader reader, Action<string?>? told = null,
        int keptSets = 0, bool tooLarge = false, CancellationToken token = default, bool discard = true) =>
        tally.SortAsync(reader, discard, keptSets, maxResultSets: 10, prefix =>
        {
            told?.Invoke(prefix);
            return ("plan", ColumnPlan.IsShowplan(prefix), tooLarge);
        }, token);

    private static async Task<Exception?> Caught(Func<Task> run)
    {
        try { await run(); return null; }
        catch (Exception error) { return error; }
    }

    private sealed record FakeColumnSpec(string Name, string Type, bool IsLong);

    private sealed class FakeColumn : DbColumn
    {
        public FakeColumn(FakeColumnSpec spec, int ordinal)
        {
            ColumnName = spec.Name;
            DataTypeName = spec.Type;
            IsLong = spec.IsLong;
            ColumnOrdinal = ordinal;
        }
    }

    /// <summary>One result set's columns and rows. Read counts which way each row was read; ReadAsync reads as SqlClient's
    /// does on the read loop's thread.</summary>
    private sealed class Reader(FakeColumnSpec[] columns, IEnumerable<object?> values) : DbDataReader, IDbColumnSchemaGenerator
    {
        // One value a row: a reader of more columns has no rows here.
        private readonly object?[] rows = [.. values];
        private int position = -1;
        public int AsyncReads, SyncReads, PoolReads;
        /// <summary>The row (counting from 1) whose read throws, as a broken connection or a cancelled command does.</summary>
        public int FailAt { get; set; }
        public Action<int>? OnRead { get; set; }
        /// <summary>Whether a value was asked for: reading past rows asks for none.</summary>
        public bool Asked { get; private set; }

        public static Reader Ints(int count) => new([new("object_id", "int", false)], Enumerable.Range(1, count).Select(value => (object?)value));
        public static Reader Longs(int count) => new([new("name", "nvarchar", true)], Enumerable.Range(1, count).Select(value => (object?)("row " + value)));
        public static Reader Showplan(params string[] values) => new([new(ColumnPlan.ShowplanColumn, "nvarchar", true)], values);

        private bool Advance()
        {
            var next = position + 1;
            if (FailAt > 0 && next + 1 == FailAt) throw new InvalidOperationException("The read failed.");
            if (next >= rows.Length) { position = rows.Length; return false; }
            position = next;
            OnRead?.Invoke(next + 1);
            return true;
        }

        public override bool Read()
        {
            SyncReads++;
            if (Thread.CurrentThread.IsThreadPoolThread) PoolReads++;
            return Advance();
        }

        public override Task<bool> ReadAsync(CancellationToken cancellationToken)
        {
            AsyncReads++;
            try { return Task.FromResult(Advance()); }
            catch (Exception error) { return Task.FromException<bool>(error); }
        }

        public ReadOnlyCollection<DbColumn> GetColumnSchema() => new([.. columns.Select((column, ordinal) => (DbColumn)new FakeColumn(column, ordinal))]);
        public override int FieldCount => columns.Length;
        public override string GetName(int ordinal) => columns[ordinal].Name;
        public override string GetDataTypeName(int ordinal) => columns[ordinal].Type;
        public override object GetValue(int ordinal) { Asked = true; return rows[position] ?? DBNull.Value; }
        public override bool IsDBNull(int ordinal) { Asked = true; return rows[position] is null; }
        public override long GetChars(int ordinal, long dataOffset, char[]? buffer, int bufferOffset, int length)
        {
            Asked = true;
            var text = (string)rows[position]!;
            var count = Math.Max(0, Math.Min(length, text.Length - (int)dataOffset));
            text.CopyTo((int)dataOffset, buffer!, bufferOffset, count);
            return count;
        }
        public override string GetString(int ordinal) => (string)GetValue(ordinal);
        public override int GetInt32(int ordinal) => (int)GetValue(ordinal);
        public override bool NextResult() => false;
        public override int Depth => 0;
        public override bool HasRows => rows.Length > 0;
        public override bool IsClosed => false;
        public override int RecordsAffected => -1;
        public override object this[int ordinal] => GetValue(ordinal);
        public override object this[string name] => GetValue(GetOrdinal(name));
        public override int GetOrdinal(string name) => Array.FindIndex(columns, column => column.Name == name);
        public override Type GetFieldType(int ordinal) => columns[ordinal].Type == "int" ? typeof(int) : typeof(string);
        public override int GetValues(object[] values) { var count = Math.Min(values.Length, FieldCount); for (var i = 0; i < count; i++) values[i] = GetValue(i); return count; }
        public override IEnumerator GetEnumerator() => throw new NotSupportedException();
        public override bool GetBoolean(int ordinal) => throw new NotSupportedException();
        public override byte GetByte(int ordinal) => throw new NotSupportedException();
        public override long GetBytes(int ordinal, long dataOffset, byte[]? buffer, int bufferOffset, int length) => throw new NotSupportedException();
        public override char GetChar(int ordinal) => throw new NotSupportedException();
        public override DateTime GetDateTime(int ordinal) => throw new NotSupportedException();
        public override decimal GetDecimal(int ordinal) => throw new NotSupportedException();
        public override double GetDouble(int ordinal) => throw new NotSupportedException();
        public override float GetFloat(int ordinal) => throw new NotSupportedException();
        public override Guid GetGuid(int ordinal) => throw new NotSupportedException();
        public override short GetInt16(int ordinal) => throw new NotSupportedException();
        public override long GetInt64(int ordinal) => throw new NotSupportedException();
    }
}
