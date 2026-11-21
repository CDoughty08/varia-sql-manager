using System.Globalization;
using Varia.Backend;
using Varia.Backend.Protocol;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>Each reservation that grows with the rows stored answers DIFF_ROWS_TOO_LARGE through results.diff when refused
/// for All rows, and TOO_LARGE for Changes only: the change index (reserved up front) and a cut row's changed-pair bitset
/// (reserved as the row is met). The rows' own refusal is EntryRefusals'.</summary>
internal static partial class DiffChecks
{
    private static void RefusalKinds(Action<bool, string> check)
    {
        IndexRefusal(check);
        CutRefusal(check);
    }

    /// <summary>The change index refused after the alignment fits: a budget of the sources, the alignment, one chunk of
    /// differing cells and half the index.</summary>
    private static void IndexRefusal(Action<bool, string> check)
    {
        static string?[][] Rows(int count, string price) => [.. Enumerable.Range(1, count).Select(i => new[] { i.ToString(CultureInfo.InvariantCulture), "n", price })];
        var store = new ResultStore(1L << 30, 1L << 29) { Packing = PagePacking.Off };
        using var service = new SqlService(store);
        var (left, right) = Pair(store, Rows(300, "1.00"), Rows(300, "2.00"));
        store.Resize(1L << 30, Held.Bytes(store) + ResultDiffer.WorkingBytes(300, 300) + ResultDiffer.CellChunk * ResultDiffer.CellBytes + DiffIndex.BytesFor(300, 0) / 2);
        var used = Held.Bytes(store);
        string? Code(int context) => Refusal(service, "results.diff", new { left = left.ResultId, right = right.ResultId, context, layout = "entry" })?.Split(':')[0];
        var (all, only) = (Code(-1), Code(0));
        check(all == "DIFF_ROWS_TOO_LARGE" && only == "TOO_LARGE" && Held.Bytes(store) == used && left.Budget.Stopped == TruncationReason.None,
            $"a change index the budget refuses answers DIFF_ROWS_TOO_LARGE for All rows and TOO_LARGE for Changes only, keeping nothing: {all} / {only}");
    }

    /// <summary>A cut row's bitset refused: with the cut row first, its bitset is the first reservation after the set is
    /// opened (whose own refusal is TOO_LARGE), so the least budget past the open answers DIFF_ROWS_TOO_LARGE for the
    /// bitset, at the same budget as the same diff with no cut row (whose first row's room is refused there instead).</summary>
    private static void CutRefusal(Action<bool, string> check)
    {
        const int width = 300;
        ResultColumn[] columns = [new("Id", "int", "text"), .. Enumerable.Range(1, width).Select(c => new ResultColumn("c" + c.ToString(CultureInfo.InvariantCulture), "int", "text"))];
        // Row 1 changes every odd column, more than a tone lists, so it is cut; or one column, so it is not. Rows 2 and 3
        // change one column.
        static string?[] Row(int id, int value, bool scattered) => [id.ToString(CultureInfo.InvariantCulture), .. Enumerable.Range(1, width).Select(c => (scattered ? (c % 2 == 1 ? value : 0) : c == 1 ? value : 0).ToString(CultureInfo.InvariantCulture))];
        (long Past, string? Code, int Cuts) Least(bool cut)
        {
            var store = new ResultStore(1L << 30, 1L << 29) { Packing = PagePacking.Off };
            using var service = new SqlService(store);
            var (left, right) = Pair(store, [Row(1, 1, cut), Row(2, 1, false), Row(3, 1, false)], [Row(1, 2, cut), Row(2, 2, false), Row(3, 2, false)], columns, columns);
            var sources = Held.Bytes(store);
            var cuts = 0;
            string? Try(long room)
            {
                store.Resize(1L << 30, sources + room);
                try
                {
                    var diff = Call<ResultsDiffResult>(service, "results.diff", new { left = left.ResultId, right = right.ResultId, context = -1, layout = "entry" });
                    cuts = store.Find(diff.Descriptor.ResultId)!.DiffIndex!.CutLists;
                    store.Release(diff.Descriptor.ResultId);
                    return null;
                }
                catch (RequestException error) { return error.Code; }
            }
            long low = 0, high = 64L << 20;
            while (low < high)
            {
                var middle = (low + high) / 2;
                if (Try(middle) != "TOO_LARGE") high = middle; else low = middle + 1;
            }
            var code = Try(low);
            Try(64L << 20);
            return (low, code, cuts);
        }
        var plain = Least(false);
        var scattered = Least(true);
        check(plain.Cuts == 0 && scattered.Cuts == 1 && plain.Code == "DIFF_ROWS_TOO_LARGE" && scattered.Code == "DIFF_ROWS_TOO_LARGE" && scattered.Past == plain.Past,
            $"an All rows one-row diff whose cut row's bitset the budget refuses answers DIFF_ROWS_TOO_LARGE, at the least budget past the open as without a cut row: {scattered} / {plain}");
    }
}
