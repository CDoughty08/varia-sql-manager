using System.Data;
using Microsoft.Data.SqlClient;

namespace Varia.Backend.Results;

/// <summary>SQL Server sends FOR XML and FOR JSON output as rows of about 2,033 characters in one ntext or nvarchar column
/// with a fixed name; SSMS shows them joined as one value. The collector appends every row's text to one buffer of up to
/// the document cap (one more character marks the value truncated), reserving the memory of the array it holds from the
/// query's budget in 256 KiB steps, and the caller stores the value as the set's only row when the set ends. The buffer is
/// allocated, not rented: the shared pool keeps arrays of this size once they are returned, per thread and per core, and
/// that memory would stay out of the budget's sight after the collector gave its reservation back. FOR XML ... TYPE already
/// arrives as one xml cell and is not collected.</summary>
internal sealed class ForXmlCollector : IDisposable
{
    public const string XmlColumn = "XML_F52E2B61-18A1-11d1-B105-00805F49916B";
    public const string JsonColumn = "JSON_F52E2B61-18A1-11d1-B105-00805F49916B";
    private const int Chunk = 8192;
    private readonly ResultStore store;
    private readonly QueryBudget budget;
    private readonly int cap;
    private char[]? scratch;
    private char[] buffer;
    private int length;
    private long reserved;

    public ForXmlCollector(ResultStore store, QueryBudget budget, int cap = ColumnPlan.DocumentCap)
    {
        this.store = store;
        this.budget = budget;
        this.cap = cap;
        buffer = new char[Chunk];
    }

    /// <summary>"xml" or "json" for the single column of FOR XML or FOR JSON output, otherwise null.</summary>
    public static string? RoleOf(string name, int providerType) =>
        providerType is (int)SqlDbType.NText or (int)SqlDbType.NVarChar ? name switch { XmlColumn => "xml", JsonColumn => "json", _ => null } : null;

    /// <summary>Rows appended (the server's chunks), not the one row stored.</summary>
    public long Rows { get; private set; }
    /// <summary>The value is longer than the cap; only its prefix is kept.</summary>
    public bool Truncated { get; private set; }
    /// <summary>Set when the budget refused memory for more text: nothing is stored, for this reason.</summary>
    public TruncationReason Stopped { get; private set; }
    /// <summary>The budget figure in force at the refusal that stopped this collector, if any.</summary>
    public long RefusedBytes { get; private set; }
    public int Length => length;
    /// <summary>Characters of the whole value, kept or not: the stored cell's full length.</summary>
    public long TotalChars { get; private set; }
    /// <summary>The characters the buffer holds, which the budget covers (the offline checks compare them).</summary>
    internal int Capacity => buffer.Length;

    /// <summary>Appends one row's value (column 0 of the reader's current row), read in chunks; once the cap is passed the
    /// rest of the output is still read row by row but not kept. The server's rows are short, but a query can name any
    /// nvarchar(max) column like FOR XML output: what is not kept of a row is read past in chunks too, since the next
    /// ReadAsync would buffer all of it, in time quadratic in its size.</summary>
    public void AppendRow(SqlDataReader reader, CancellationToken token)
    {
        Rows++;
        if (reader.IsDBNull(0)) return;
        using var text = reader.GetTextReader(0);
        Keep(text, token);
        scratch ??= new char[Chunk];
        for (int read; (read = text.Read(scratch, 0, Chunk)) > 0; TotalChars += read) token.ThrowIfCancellationRequested();
    }

    private void Keep(TextReader text, CancellationToken token)
    {
        while (!Full)
        {
            token.ThrowIfCancellationRequested();
            var room = cap - length;
            if (room >= Chunk)
            {
                if (!Ensure(Chunk)) return;
                var read = text.Read(buffer, length, Chunk);
                if (read <= 0) return;
                length += read;
                TotalChars += read;
                continue;
            }
            // The last characters before the cap go through a full chunk: the provider's sequential reader fails on a
            // read of a few characters from a value it has read in part, and one character past the cap marks it truncated.
            if (room > 0 && !Ensure(room)) return;
            scratch ??= new char[Chunk];
            var tail = text.Read(scratch, 0, Chunk);
            if (tail <= 0) return;
            TotalChars += tail;
            var keep = Math.Min(tail, room);
            scratch.AsSpan(0, keep).CopyTo(buffer.AsSpan(length));
            length += keep;
            if (tail > keep) Truncated = true;
        }
    }

    /// <summary>Appends text, as one row or part of one (the offline checks feed synthetic rows through it).</summary>
    public void Append(ReadOnlySpan<char> text, bool newRow = true)
    {
        if (newRow) Rows++;
        TotalChars += text.Length;
        while (!text.IsEmpty && !Full)
        {
            if (length == cap)
            {
                Truncated = true;
                return;
            }
            var take = Math.Min(text.Length, Math.Min(Chunk, cap - length));
            if (!Ensure(take)) return;
            text[..take].CopyTo(buffer.AsSpan(length));
            length += take;
            text = text[take..];
        }
    }

    private bool Full => Truncated || Stopped != TruncationReason.None;

    /// <summary>Room for <paramref name="more"/> characters, with the budget reserved for the buffer (2 bytes a character).</summary>
    private bool Ensure(int more)
    {
        more = Math.Min(more, cap - length);
        if (length + more <= buffer.Length) return true;
        var size = (int)Math.Min(cap, Math.Max(length + (long)more, 2L * buffer.Length));
        var needed = 2L * size - reserved;
        if (needed > 0)
        {
            var step = Math.Max(needed, ResultStore.ReserveStep);
            if (!store.TryReserve(budget, step, false, out var reason, out var refusedBytes) && (step == needed || !store.TryReserve(budget, step = needed, false, out reason, out refusedBytes)))
            {
                Stopped = reason;
                RefusedBytes = refusedBytes;
                return false;
            }
            reserved += step;
        }
        // Reserved before it is allocated, so the budget never trails the array held.
        var larger = GC.AllocateUninitializedArray<char>(size);
        buffer.AsSpan(0, length).CopyTo(larger);
        buffer = larger;
        return true;
    }

    /// <summary>Writes the value as the row's one cell; returns whether it was stored truncated.</summary>
    public bool Write(PageBuilder builder)
    {
        var text = buffer.AsSpan(0, length);
        // A surrogate pair the cap splits is dropped whole.
        if (Truncated && text.Length > 0 && char.IsHighSurrogate(text[^1])) text = text[..^1];
        builder.AppendText(text, Truncated);
        // The joined output counts as one nvarchar value.
        builder.Measure(TotalChars, 2 * TotalChars);
        return Truncated;
    }

    public void Dispose()
    {
        buffer = [];
        store.Return(budget, reserved);
        reserved = 0;
    }
}
