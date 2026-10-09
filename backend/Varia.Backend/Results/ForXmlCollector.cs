using System.Buffers;
using System.Data;
using Microsoft.Data.SqlClient;

namespace Varia.Backend.Results;

/// <summary>SQL Server sends FOR XML and FOR JSON output as rows of about 2,033 characters in one ntext or nvarchar column
/// with a fixed name; SSMS shows them joined as one value. The collector appends every row's text to one pooled buffer
/// of up to the document cap plus one character (the excess marks the value truncated), reserving that memory from the
/// query's budget in 256 KiB steps, and the caller stores the value as the set's only row when the set ends.
/// FOR XML ... TYPE already arrives as one xml cell and is not collected.</summary>
internal sealed class ForXmlCollector : IDisposable
{
    public const string XmlColumn = "XML_F52E2B61-18A1-11d1-B105-00805F49916B";
    public const string JsonColumn = "JSON_F52E2B61-18A1-11d1-B105-00805F49916B";
    private const int Chunk = 8192;
    private readonly ResultStore store;
    private readonly QueryBudget budget;
    private readonly int cap;
    private char[] buffer;
    private int length;
    private long reserved;

    public ForXmlCollector(ResultStore store, QueryBudget budget, int cap = ColumnPlan.DocumentCap)
    {
        this.store = store;
        this.budget = budget;
        this.cap = cap;
        buffer = ArrayPool<char>.Shared.Rent(Chunk);
    }

    /// <summary>"xml" or "json" for the single column of FOR XML or FOR JSON output, otherwise null.</summary>
    public static string? RoleOf(string name, int providerType) =>
        providerType is (int)SqlDbType.NText or (int)SqlDbType.NVarChar ? name switch { XmlColumn => "xml", JsonColumn => "json", _ => null } : null;

    /// <summary>Rows appended (the server's chunks), not the one row stored.</summary>
    public long Rows { get; private set; }
    /// <summary>The value is longer than the cap; only its prefix is kept.</summary>
    public bool Truncated => length > cap;
    /// <summary>Set when the budget refused memory for more text: nothing is stored, for this reason.</summary>
    public TruncationReason Stopped { get; private set; }
    public int Length => Math.Min(length, cap);

    /// <summary>Appends one row's value (column 0 of the reader's current row), read in chunks; once the cap is passed the
    /// rest of the output is still read row by row but not kept.</summary>
    public void AppendRow(SqlDataReader reader, CancellationToken token)
    {
        Rows++;
        if (Full || reader.IsDBNull(0)) return;
        using var text = reader.GetTextReader(0);
        while (!Full)
        {
            token.ThrowIfCancellationRequested();
            if (!Ensure(Chunk)) return;
            var read = text.Read(buffer, length, Math.Min(Chunk, cap + 1 - length));
            if (read <= 0) return;
            length += read;
        }
    }

    /// <summary>Appends text, as one row or part of one (the offline checks feed synthetic rows through it).</summary>
    public void Append(ReadOnlySpan<char> text, bool newRow = true)
    {
        if (newRow) Rows++;
        while (!text.IsEmpty && !Full)
        {
            var take = Math.Min(text.Length, Math.Min(Chunk, cap + 1 - length));
            if (!Ensure(take)) return;
            text[..take].CopyTo(buffer.AsSpan(length));
            length += take;
            text = text[take..];
        }
    }

    private bool Full => length > cap || Stopped != TruncationReason.None;

    /// <summary>Room for <paramref name="more"/> characters, with the budget reserved for the buffer (2 bytes a character).</summary>
    private bool Ensure(int more)
    {
        more = Math.Min(more, cap + 1 - length);
        if (length + more <= buffer.Length) return true;
        var size = (int)Math.Min(cap + 1L, Math.Max(length + (long)more, 2L * buffer.Length));
        var needed = 2L * size - reserved;
        if (needed > 0)
        {
            var step = Math.Max(needed, ResultStore.ReserveStep);
            if (!store.TryReserve(budget, step, false, out var reason) && (step == needed || !store.TryReserve(budget, step = needed, false, out reason)))
            {
                Stopped = reason;
                return false;
            }
            reserved += step;
        }
        var larger = ArrayPool<char>.Shared.Rent(size);
        buffer.AsSpan(0, length).CopyTo(larger);
        ArrayPool<char>.Shared.Return(buffer);
        buffer = larger;
        return true;
    }

    /// <summary>Writes the value as the row's one cell; returns whether it was stored truncated.</summary>
    public bool Write(PageBuilder builder)
    {
        var text = CellFormat.Prefix(buffer.AsSpan(0, length), cap, out var truncated);
        builder.AppendText(text, truncated);
        return truncated;
    }

    public void Dispose()
    {
        ArrayPool<char>.Shared.Return(buffer);
        buffer = [];
        store.Return(budget, reserved);
        reserved = 0;
    }
}
