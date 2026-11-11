using System.Globalization;

namespace Varia.Backend.Results;

/// <summary>An aligned entry's kind: the same row in both results, a row whose values changed, a row only in the second
/// result (added) or only in the first (removed).</summary>
internal enum DiffKind : byte { Same, Changed, Added, Removed }

/// <summary>One aligned entry: its kind, its row in each result (-1 where it has none), and its differing cells,
/// DiffModel.Cells[CellStart .. CellStart + CellCount]. A matched row whose only differences are soft is Same.</summary>
internal readonly record struct DiffEntry(DiffKind Kind, int Left, int Right, int CellStart = 0, int CellCount = 0);

/// <summary>Two results aligned row by row (results.diff), in unified order: the second result's order, each removed row
/// after the first result's row it followed. The unified result is one rendering of it (<see cref="UnifiedDiff"/>); a
/// side-by-side one would read the same entries. <see cref="Pairs"/> are the shared columns (left, right) compared; an
/// entry's cells are pair indexes, negative (~index) for a soft difference: equal by the collation but not character for
/// character.</summary>
internal sealed class DiffModel(DiffEntry[] entries, (int Left, int Right)[] pairs, int[] cells, int keyPair, bool approximate)
{
    public DiffEntry[] Entries { get; } = entries;
    public (int Left, int Right)[] Pairs { get; } = pairs;
    public int[] Cells { get; } = cells;
    public ReadOnlySpan<int> CellsOf(DiffEntry entry) => Cells.AsSpan(entry.CellStart, entry.CellCount);
    /// <summary>The pair whose values matched rows, or -1 when whole rows (their shared columns) did.</summary>
    public int KeyPair { get; } = keyPair;
    /// <summary>A matched or compared value was a truncated value's stored prefix.</summary>
    public bool Approximate { get; } = approximate;

    /// <summary>Entries of each kind, and soft differences (values equal only by collation).</summary>
    public (long Same, long Changed, long Added, long Removed, long Soft) Counts()
    {
        long same = 0, changed = 0, added = 0, removed = 0, soft = 0;
        foreach (var cell in Cells) if (cell < 0) soft++;
        foreach (var entry in Entries)
        {
            switch (entry.Kind)
            {
                case DiffKind.Same: same++; break;
                case DiffKind.Changed: changed++; break;
                case DiffKind.Added: added++; break;
                default: removed++; break;
            }
        }
        return (same, changed, added, removed, soft);
    }
}

/// <summary>Random access to a complete result's stored rows: each page's header is parsed once.</summary>
internal sealed class RowAccess
{
    private readonly StoredPage[] pages;
    private readonly long[] starts;
    private readonly (int[] Layout, int BlobStart)?[] parsed;
    private readonly int columns;

    public RowAccess(StoredPage[] pages, int columns)
    {
        this.pages = pages;
        this.columns = columns;
        starts = new long[pages.Length];
        parsed = new (int[], int)?[pages.Length];
        long rows = 0;
        for (var i = 0; i < pages.Length; i++) { starts[i] = pages[i].FirstRow; rows += pages[i].Rows; }
        Rows = rows;
    }

    public long Rows { get; }

    /// <summary>The page holding a row, and the row's index within it.</summary>
    public PageView At(long row, out int index) => At(row, out index, out _);

    /// <summary>The page holding a row, the row's index within it, and the page's lengths sidecar.</summary>
    public PageView At(long row, out int index, out PageLengths lengths)
    {
        var page = PageOf(row, out index);
        return Page(page, out lengths);
    }

    /// <summary>The index of the page holding a row, and the row's index within it: a caller that reads one row many times
    /// finds its page once and then reads it through <see cref="Page"/>.</summary>
    public int PageOf(long row, out int index)
    {
        var page = Array.BinarySearch(starts, row);
        if (page < 0) page = ~page - 1;
        index = (int)(row - pages[page].FirstRow);
        return page;
    }

    /// <summary>A page by its index (from <see cref="PageOf"/>), parsed once, and its lengths sidecar.</summary>
    public PageView Page(int page, out PageLengths lengths)
    {
        var stored = pages[page];
        lengths = stored.Lengths;
        if (parsed[page] is not { } layout)
        {
            var first = PageView.Parse(stored.Body, columns);
            parsed[page] = layout = (first.Layout, first.BlobStart);
        }
        return PageView.At(stored.Body, layout.BlobStart, layout.Layout, stored.FirstRow, stored.Rows, columns);
    }
}

/// <summary>Aligns two complete results (results.diff). Columns pair by name (case-insensitively, in the first result's
/// order) when both hold text or both binary; a pair's values compare by the first result's column type and collation, so
/// a column whose type or collation changed between the results still matches. Rows match by a key: the first candidate (RowIdentity.Candidates over the shared columns) that is unique, NULL-free
/// and untruncated in both results, else by their shared columns' values together, the k-th copy of a row matching the
/// k-th copy in the other result. Values compare as SQL Server would (CellHasher): numbers by value, text by its column's
/// collation, unless <c>exact</c>, which compares text character for character.</summary>
internal static class ResultDiffer
{
    private const int CancelEvery = 1 << 12;

    /// <summary>Bytes the alignment holds per row while it runs: a left row's identity, match, chain and lookup entry
    /// (8 + 4 + 4 + 24), a right row's identity and match (8 + 4), and up to one entry a row of both results (20), held
    /// twice while the list becomes the model's array. Differing cells are charged as they are found (<see cref="CellBytes"/>).</summary>
    public static long WorkingBytes(long leftRows, long rightRows) => 40 * leftRows + 12 * rightRows + 2 * EntryBytes * (leftRows + rightRows);

    private const long EntryBytes = 20;

    /// <summary>Bytes one differing cell can hold at most while the alignment runs: its index in a list grown by doubling
    /// (twice 4), and once more in the model's array.</summary>
    public const long CellBytes = 12;

    /// <summary>Differing cells charged at a time, through Compare's <c>reserve</c>.</summary>
    public const int CellChunk = 1 << 16;

    /// <summary>The most shared columns a diff compares: the unified result adds a marker, two row numbers and a tone.</summary>
    public const int MaxPairs = PageBuilder.MaxColumns - 4;

    /// <summary>The shared columns: each visible column of the first result with a visible column of the same name and wire
    /// (text or binary) in the second, in the first result's order. A column whose wire differs is one-sided: the unified
    /// result's cells take the second result's wire, which a first result's binary value could not be stored in.</summary>
    public static (int Left, int Right)[] Pairs(IReadOnlyList<ResultColumn> left, IReadOnlyList<ResultColumn> right, IReadOnlyList<WireKind>? leftWires = null, IReadOnlyList<WireKind>? rightWires = null)
    {
        var used = new bool[right.Count];
        var pairs = new List<(int, int)>();
        for (var l = 0; l < left.Count; l++)
        {
            if (ResultTextWriter.Hidden(left[l])) continue;
            for (var r = 0; r < right.Count; r++)
            {
                if (used[r] || ResultTextWriter.Hidden(right[r]) || !string.Equals(left[l].Name, right[r].Name, StringComparison.OrdinalIgnoreCase)) continue;
                if (leftWires is not null && rightWires is not null && leftWires[l] != rightWires[r]) continue;
                used[r] = true;
                pairs.Add((l, r));
                break;
            }
        }
        return [.. pairs];
    }

    /// <summary>Aligns the two results. <paramref name="reserve"/> is asked for <see cref="CellBytes"/> per differing cell,
    /// <see cref="CellChunk"/> cells at a time, beyond the <see cref="WorkingBytes"/> the caller reserved; a refusal fails
    /// the diff with TOO_LARGE, since every value of two wide results can differ.</summary>
    public static DiffModel Compare(ResultSetBuffer left, StoredPage[] leftPages, ResultSetBuffer right, StoredPage[] rightPages, bool exact, CancellationToken token,
        Func<long, bool>? reserve = null)
    {
        var pairs = Pairs(left.Columns, right.Columns, left.Wires, right.Wires);
        if (pairs.Length == 0)
            throw new RequestException("INVALID_PARAMS", Pairs(left.Columns, right.Columns).Length == 0
                ? "These results have no column names in common, so they cannot be compared."
                : "The columns these results share hold binary data in one and text in the other, so they cannot be compared.");
        if (pairs.Length > MaxPairs)
            throw new RequestException("INVALID_PARAMS", "These results share more than " + MaxPairs.ToString("N0", CultureInfo.InvariantCulture) + " columns, more than a diff can show.");
        long leftTotal = 0, rightTotal = 0;
        foreach (var page in leftPages) leftTotal += page.Rows;
        foreach (var page in rightPages) rightTotal += page.Rows;
        if (leftTotal > int.MaxValue / 2 || rightTotal > int.MaxValue / 2) throw new RequestException("TOO_LARGE", "These results have too many rows to compare.");
        var leftHasher = new CellHasher(left.Columns, left.Wires);
        // The second result's shared columns hash by the first's type and collation, so equal values hash alike in both.
        var compared = right.Columns.ToArray();
        foreach (var (l, r) in pairs) compared[r] = compared[r] with { DataType = left.Columns[l].DataType, Collation = left.Columns[l].Collation };
        var rightHasher = new CellHasher(compared, right.Wires);
        var leftIds = new long[leftTotal];
        var rightIds = new long[rightTotal];
        var keyPair = -1;
        var approximate = false;
        var rightCandidates = RowIdentity.Candidates(right.Columns, right.Wires).ToHashSet();
        var tried = 0;
        foreach (var candidate in RowIdentity.Candidates(left.Columns, left.Wires))
        {
            var pair = Array.FindIndex(pairs, item => item.Left == candidate);
            if (pair < 0 || !rightCandidates.Contains(pairs[pair].Right)) continue;
            if (++tried > RowIdentity.MaxCandidates) break;
            var (leftUnique, leftApproximate) = RowIdentity.Fill(leftHasher, leftPages, candidate, leftIds, stopEarly: true, token);
            if (!leftUnique || leftApproximate) continue;
            var (rightUnique, rightApproximate) = RowIdentity.Fill(rightHasher, rightPages, pairs[pair].Right, rightIds, stopEarly: true, token);
            if (!rightUnique || rightApproximate) continue;
            keyPair = pair;
            break;
        }
        if (keyPair < 0)
        {
            var leftColumns = pairs.Select(pair => pair.Left).ToArray();
            var rightColumns = pairs.Select(pair => pair.Right).ToArray();
            approximate |= Rows(leftHasher, leftPages, leftColumns, leftIds, token);
            approximate |= Rows(rightHasher, rightPages, rightColumns, rightIds, token);
        }

        // Match: each right row to a left row with its identity, the k-th copy to the k-th copy.
        var matchedLeft = new int[leftTotal];
        Array.Fill(matchedLeft, -1);
        var rightMatch = new int[rightTotal];
        Dictionary<long, int>? heads = new((int)Math.Min(leftTotal, int.MaxValue));
        var next = new int[leftTotal];
        for (var i = (int)leftTotal - 1; i >= 0; i--)
        {
            next[i] = heads.TryGetValue(leftIds[i], out var head) ? head : -1;
            heads[leftIds[i]] = i;
        }
        var counter = 0;
        for (var j = 0; j < rightTotal; j++)
        {
            if (++counter == CancelEvery) { counter = 0; token.ThrowIfCancellationRequested(); }
            if (heads.TryGetValue(rightIds[j], out var i) && i >= 0)
            {
                rightMatch[j] = i;
                matchedLeft[i] = j;
                heads[rightIds[j]] = next[i];
            }
            else rightMatch[j] = -1;
        }
        heads = null;

        // Unified order: removed rows before the first match go first; then each right row, and after a matched one the
        // left rows that followed its left row up to the next matched one.
        var entries = new List<DiffEntry>((int)(leftTotal + rightTotal));
        var cells = new List<int>();
        long cellsCharged = 0;
        var leftAccess = new RowAccess(leftPages, left.Wires.Count);
        var rightAccess = new RowAccess(rightPages, right.Wires.Count);
        var at = 0;
        while (at < leftTotal && matchedLeft[at] < 0) entries.Add(new DiffEntry(DiffKind.Removed, at++, -1));
        for (var j = 0; j < rightTotal; j++)
        {
            if (++counter == CancelEvery) { counter = 0; token.ThrowIfCancellationRequested(); }
            var i = rightMatch[j];
            if (i < 0) { entries.Add(new DiffEntry(DiffKind.Added, -1, j)); continue; }
            var before = cells.Count;
            approximate |= CompareCells(leftHasher, leftAccess, i, rightHasher, rightAccess, j, pairs, exact, cells, out var hard);
            while (cells.Count > cellsCharged)
            {
                if (reserve is not null && !reserve(CellChunk * CellBytes))
                    throw new RequestException("TOO_LARGE", "These results differ in too many values to compare in the result memory left. Close other results and try again.");
                cellsCharged += CellChunk;
            }
            entries.Add(new DiffEntry(hard ? DiffKind.Changed : DiffKind.Same, i, j, before, cells.Count - before));
            for (var k = i + 1; k < leftTotal && matchedLeft[k] < 0; k++) entries.Add(new DiffEntry(DiffKind.Removed, k, -1));
        }
        return new DiffModel([.. entries], pairs, [.. cells], keyPair, approximate);
    }

    /// <summary>Each row's identity over the given columns.</summary>
    private static bool Rows(CellHasher hasher, StoredPage[] pages, int[] columns, long[] ids, CancellationToken token)
    {
        var approximate = false;
        var scratch = new int[PageView.ScratchLength(hasher.Count)];
        var counter = 0;
        foreach (var page in pages)
        {
            token.ThrowIfCancellationRequested();
            var view = PageView.Parse(page.Body, hasher.Count, scratch);
            for (var r = 0; r < page.Rows; r++)
            {
                if (++counter == CancelEvery) { counter = 0; token.ThrowIfCancellationRequested(); }
                ids[page.FirstRow + r] = hasher.Row(view, r, columns, ref approximate) & RowIdentity.Mask;
            }
        }
        return approximate;
    }

    /// <summary>Appends the pairs whose values differ (~pair for a soft difference); whether a truncated value was compared.</summary>
    private static bool CompareCells(CellHasher leftHasher, RowAccess leftAccess, int leftRow, CellHasher rightHasher, RowAccess rightAccess, int rightRow,
        (int Left, int Right)[] pairs, bool exact, List<int> cells, out bool hard)
    {
        var approximate = false;
        hard = false;
        var leftView = leftAccess.At(leftRow, out var l);
        var rightView = rightAccess.At(rightRow, out var r);
        for (var p = 0; p < pairs.Length; p++)
        {
            var (lc, rc) = pairs[p];
            var leftNull = leftView.IsNull(lc, l);
            var rightNull = rightView.IsNull(rc, r);
            if (leftNull || rightNull)
            {
                if (leftNull != rightNull || leftView.IsError(lc, l) != rightView.IsError(rc, r)) { cells.Add(p); hard = true; }
                continue;
            }
            if (leftView.IsTruncated(lc, l) || rightView.IsTruncated(rc, r)) approximate = true;
            if (leftView.Span(lc, l).SequenceEqual(rightView.Span(rc, r))) continue;
            var text = leftHasher.IsText(lc);
            // Values of other types that differ only in form (2.0 and 2.00) are the same value; text equal by its collation
            // is a soft difference, or a change when compared exactly. Values compare, not their hashes, which can collide.
            var equal = leftHasher.Same(leftView, lc, l, rightHasher, rightView, rc, r);
            if (equal && !text) continue;
            if (!equal || exact) { cells.Add(p); hard = true; }
            else cells.Add(~p);
        }
        return approximate;
    }
}

/// <summary>Renders a diff as a result (results.diff), unified like git: each entry of the model in order, a changed one
/// as its first result's row (−) then its second's (+), and only <c>context</c> unchanged rows around each change (all of
/// them with <c>context</c> -1). Its columns are a marker ("Change": " ", "−" or "+"), each row's number in the first result ("R1")
/// and the second ("R2"), the shared columns (the second result's names and types), and a hidden tone column: "added" or
/// "removed" ("same" for an unchanged row with soft differences), then the differing cells as column indexes, a soft one with
/// a leading "~". Each data cell's bytes are its source cell's, so the row-size bar sums the values shown, not the marker,
/// row numbers or tone. Rows stop at the first one refused, and the set then says why it was truncated: a full budget never
/// stops between a changed row's two halves, though a page sealed under low system memory can. results.diff refuses a
/// diff cut short either way whole (SqlService.DiffAsync).</summary>
internal static class UnifiedDiff
{
    public const string Removed = "−", Added = "+";

    /// <summary>The longest tone text: under the 512 characters a grid reads of a cell (src/renderer/src/grid/constants.ts
    /// maxCellChars), so the grid always reads it whole. Runs of adjacent columns are listed as ranges, which keeps a row
    /// that differs everywhere short; a tone that would still be longer stops at a whole entry and ends with "…".</summary>
    public const int MaxToneChars = 500;

    public static IReadOnlyList<ResultColumn> Columns(ResultSetBuffer right, DiffModel model) =>
    [
        new("Change", "nvarchar(1)", "text", MaxLength: 1),
        new("R1", "bigint", "text"),
        new("R2", "bigint", "text"),
        .. model.Pairs.Select(pair => right.Columns[pair.Right]),
        new("", "nvarchar(" + MaxToneChars.ToString(CultureInfo.InvariantCulture) + ")", "text", Role: "tone", MaxLength: MaxToneChars)
    ];

    public static IReadOnlyList<WireKind> Wires(ResultSetBuffer right, DiffModel model) =>
        [WireKind.Text, WireKind.Text, WireKind.Text, .. model.Pairs.Select(pair => right.Wires[pair.Right]), WireKind.Text];

    public static IReadOnlyList<ColumnLength> Lengths(ResultSetBuffer right, DiffModel model) =>
        [ColumnLength.Utf16, ColumnLength.Utf16, ColumnLength.Utf16, .. model.Pairs.Select(pair => right.Lengths[pair.Right]), ColumnLength.Utf16];

    /// <summary>The entries the unified result shows: every change, and up to <paramref name="context"/> unchanged entries on
    /// each side of one (all with -1).</summary>
    public static bool[] Shown(DiffModel model, int context)
    {
        var entries = model.Entries;
        var shown = new bool[entries.Length];
        if (context < 0) { Array.Fill(shown, true); return shown; }
        var last = int.MinValue / 2;
        for (var k = 0; k < entries.Length; k++)
        {
            if (entries[k] is { Kind: DiffKind.Same, CellCount: 0 }) continue;
            shown[k] = true;
            for (var b = Math.Max(Math.Max(0, k - context), last + 1); b < k; b++) shown[b] = true;
            last = k;
            for (var a = k + 1; a <= Math.Min(entries.Length - 1, k + context); a++) if (entries[a] is { Kind: DiffKind.Same, CellCount: 0 }) shown[a] = true; else break;
        }
        return shown;
    }

    /// <summary>Writes the rows into <paramref name="set"/> (opened with <see cref="Columns"/> and <see cref="Wires"/>), then
    /// completes it.</summary>
    public static void Write(ResultSetBuffer set, ResultSetBuffer left, StoredPage[] leftPages, ResultSetBuffer right, StoredPage[] rightPages, DiffModel model, int context, CancellationToken token)
    {
        var sides = (Left: new Side(new RowAccess(leftPages, left.Wires.Count), model.Pairs, true, left.Lengths, right.Lengths),
            Right: new Side(new RowAccess(rightPages, right.Wires.Count), model.Pairs, false, right.Lengths, right.Lengths));
        var shown = Shown(model, context);
        var tone = new System.Text.StringBuilder(64);
        var counter = 0;
        try
        {
            for (var k = 0; k < model.Entries.Length; k++)
            {
                if (++counter == 1 << 10) { counter = 0; token.ThrowIfCancellationRequested(); }
                if (!shown[k]) continue;
                var entry = model.Entries[k];
                var cells = model.CellsOf(entry);
                var stored = entry.Kind switch
                {
                    DiffKind.Same => Row(set, sides.Right, entry.Right, " ", entry.Left, entry.Right, cells.IsEmpty ? null : Tone(tone, "same", cells)),
                    DiffKind.Added => Row(set, sides.Right, entry.Right, Added, -1, entry.Right, "added"),
                    DiffKind.Removed => Row(set, sides.Left, entry.Left, Removed, entry.Left, -1, "removed"),
                    _ => Pair(set, sides, entry, Tone(tone, "removed", cells), Tone(tone, "added", cells))
                };
                if (!stored) break;
            }
        }
        finally { set.Complete(); }
    }

    /// <summary>The tone text: the kind, then the differing cells' column numbers in order, each run of adjacent columns of
    /// one kind (changed, or soft with "~") as "first-last", cut at a whole entry with " …" past <see cref="MaxToneChars"/>.</summary>
    internal static string Tone(System.Text.StringBuilder tone, string kind, ReadOnlySpan<int> cells)
    {
        tone.Clear().Append(kind);
        Span<char> entry = stackalloc char[32];
        for (var i = 0; i < cells.Length;)
        {
            var soft = cells[i] < 0;
            var first = soft ? ~cells[i] : cells[i];
            var last = first;
            var j = i + 1;
            while (j < cells.Length && cells[j] < 0 == soft && (soft ? ~cells[j] : cells[j]) == last + 1) { last++; j++; }
            // Data columns follow the marker and the two row numbers.
            var length = 0;
            entry[length++] = ' ';
            if (soft) entry[length++] = '~';
            (first + 3).TryFormat(entry[length..], out var written, provider: CultureInfo.InvariantCulture);
            length += written;
            if (last > first)
            {
                entry[length++] = '-';
                (last + 3).TryFormat(entry[length..], out written, provider: CultureInfo.InvariantCulture);
                length += written;
            }
            if (tone.Length + length > MaxToneChars - 2) { tone.Append(" …"); break; }
            tone.Append(entry[..length]);
            i = j;
        }
        return tone.ToString();
    }

    /// <summary>One result's side of the diff: its rows, which of each pair's columns is its, its columns' byte rules, and
    /// the unified result's (the second result's).</summary>
    private sealed record Side(RowAccess Access, (int Left, int Right)[] Pairs, bool IsLeft, IReadOnlyList<ColumnLength> Rules, IReadOnlyList<ColumnLength> Shown)
    {
        public int Column(int pair) => IsLeft ? Pairs[pair].Left : Pairs[pair].Right;
    }

    /// <summary>A changed entry's two rows, "−" then "+": the budget is asked for room for both before either is written,
    /// so the result never holds one half of a change.</summary>
    private static bool Pair(ResultSetBuffer set, (Side Left, Side Right) sides, DiffEntry entry, string removedTone, string addedTone)
    {
        var bytes = RowBound(sides.Left, entry.Left, removedTone) + RowBound(sides.Right, entry.Right, addedTone);
        if (!set.TryReserveRows(bytes))
        {
            set.CountRow();
            set.CountRow();
            return false;
        }
        return Row(set, sides.Left, entry.Left, Removed, entry.Left, -1, removedTone)
            && Row(set, sides.Right, entry.Right, Added, -1, entry.Right, addedTone);
    }

    /// <summary>At most what one row of the unified result stores: its cells' bytes, the marker, row numbers and tone, each
    /// cell's offset and a lengths entry for each.</summary>
    private static long RowBound(Side side, int row, string tone)
    {
        var view = side.Access.At(row, out var at);
        long bytes = 3 + 2 * CellFormat.MaxFixedBytes + 3L * tone.Length;
        for (var p = 0; p < side.Pairs.Length; p++)
        {
            var c = side.Column(p);
            if (!view.IsNull(c, at)) bytes += view.Span(c, at).Length;
        }
        return bytes + (4L + PageLengths.CellBytes) * (side.Pairs.Length + 4) + 4;
    }

    /// <summary>Copies one source row's shared cells behind its marker and row numbers, each measured with its source cell's
    /// characters and bytes; false once the set stores no more.</summary>
    private static bool Row(ResultSetBuffer set, Side side, int row, string marker, int leftRow, int rightRow, string? tone)
    {
        set.CountRow();
        var builder = set.BeginRow();
        if (builder is null) return false;
        builder.AppendText(marker);
        Number(builder, leftRow);
        Number(builder, rightRow);
        var view = side.Access.At(row, out var at, out var lengths);
        var truncated = 0;
        for (var p = 0; p < side.Pairs.Length; p++)
        {
            var c = side.Column(p);
            if (view.IsNull(c, at)) { builder.AppendNull(view.IsError(c, at)); continue; }
            var cut = view.IsTruncated(c, at);
            if (cut) truncated++;
            var span = view.Span(c, at);
            if (view.Wire(c) == WireKind.Binary) builder.AppendBinary(span, cut);
            else builder.AppendUtf8(span, cut);
            var rule = side.Rules[c];
            CellSize size;
            if (lengths.TryCell(at, c, out var kept)) size = new CellSize(kept.Chars, kept.Bytes, kept.Exact && !rule.Estimated);
            else
            {
                size = rule.Derive(span, view.Wire(c));
                if (cut) size = size with { Exact = false };
            }
            // Kept beside the page when the unified column's own rule would not give the source's size again.
            builder.Measure(size.Chars, size.Bytes, keep: rule.Rule == LengthRule.Recorded || !ReferenceEquals(rule, side.Shown[side.Pairs[p].Right]), exact: size.Exact);
        }
        if (tone is null) builder.AppendNull();
        else builder.AppendText(tone);
        return set.TryCommitRow(truncated);
    }

    private static void Number(PageBuilder builder, int row)
    {
        if (row < 0) builder.AppendNull();
        else builder.EndFormatted(CellFormat.WriteInteger(builder.BeginFormatted(), row + 1L));
    }
}
