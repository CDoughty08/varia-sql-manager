using System.Buffers;
using System.Diagnostics;
using System.Globalization;
using System.IO.Compression;
using System.Text.Json;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>The page compression benchmark, run by hand (docs/page-compression-findings.md holds what it measured):
/// <c>dotnet run --project backend/Varia.Backend.Tests --configuration Release -- --page-compression-bench &lt;GiB&gt; &lt;shape&gt;
/// [--codecs name,name] [--keep name] [--no-ops]</c>, one size and shape a process so each memory reading is its own.
/// Fills one query budget of that size with rows of the shape, then measures, without changing how the product stores
/// pages: each codec's ratio and its compress and decompress speed (one thread over a sample of pages, and the results'
/// worker count over all of them); what the operations that read pages cost when the pages must be decompressed first
/// (a results.read of three pages with and without a small cache, a sort key build, a filter, a profile, a pivot, and a
/// Save over the whole result); and the memory the operating system gets back once the raw pages are dropped and only the
/// kept codec's pages remain, through a non-compacting and then a compacting gen2 collection. VARIA_BENCH_CORES=n holds
/// the process to n cores and the results' threads to what such a machine would have. Prints one JSON line per metric;
/// measures only, no checks, and is not part of <c>npm run check</c> or CI.</summary>
internal static class PageCompressionBench
{
    public const string Argument = "--page-compression-bench";
    private static readonly ResultCollation CaseInsensitive = new(1033, 0, 1252, false, 1 | 8 | 16);
    private static readonly DateTime Epoch = new(2024, 1, 1, 0, 0, 0, DateTimeKind.Unspecified);
    private const int SamplePages = 384;

    private sealed record Column(ResultColumn Meta, Action<PageBuilder, long> Write);

    /// <summary>A shape and the columns its operations use: an int sort, a text sort, an IN filter on a low-cardinality
    /// column (the values of row 0), a profile of two columns, and a pivot by the low-cardinality column.</summary>
    private sealed record Shape(Column[] Columns, int IntColumn, int TextColumn, int LowColumn, int[] Profile, int SumColumn, int MaxColumn);

    private delegate byte[] Compress(ReadOnlySpan<byte> source, Scratch scratch);
    private delegate void Decompress(byte[] packed, Span<byte> destination);
    private sealed record Codec(string Name, Compress Pack, Decompress Unpack);

    private sealed class Scratch
    {
        public byte[] Buffer = new byte[BrotliEncoder.GetMaxCompressedLength(PageBuilder.SealBytes * 2)];
        public readonly MemoryStream Stream = new(PageBuilder.SealBytes * 2);
        public byte[] Raw = new byte[PageBuilder.SealBytes * 2];

        public byte[] Room(int length)
        {
            if (Buffer.Length < length) Buffer = new byte[length];
            return Buffer;
        }

        public Span<byte> RawFor(int length)
        {
            if (Raw.Length < length) Raw = new byte[length];
            return Raw.AsSpan(0, length);
        }
    }

    /// <summary>A compressed page: what a compressed store would keep in place of the body. The lengths sidecar stays as is.</summary>
    private sealed record Packed(long FirstRow, int Rows, int RawLength, byte[] Data, PageLengths Lengths);

    // ---- Deterministic values: every cell is a function of (row, column salt), so any page can be regenerated.

    private static ulong Mix(long row, ulong salt)
    {
        var z = (ulong)row * 0x9E3779B97F4A7C15UL + salt * 0xBF58476D1CE4E5B9UL + 0x94D049BB133111EBUL;
        z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9UL;
        z = (z ^ (z >> 27)) * 0x94D049BB133111EBUL;
        return z ^ (z >> 31);
    }
    private static long Below(long row, ulong salt, long limit) => (long)(Mix(row, salt) % (ulong)limit);
    private static double Unit(long row, ulong salt) => (Mix(row, salt) >> 11) * (1.0 / (1UL << 53));
    private static bool Null(long row, ulong salt, double share) => Unit(row, salt ^ 0x5555) < share;
    private static void Integer(PageBuilder builder, long value) => builder.EndFormatted(CellFormat.WriteInteger(builder.BeginFormatted(), value));

    /// <summary>Common English words then identifier-like words, picked with a skew toward the front (a rough Zipf), so text
    /// compresses about as prose and log messages do rather than as repeated filler.</summary>
    private static readonly string[] Words = BuildWords();
    private static string[] BuildWords()
    {
        string[] common = ["the", "of", "and", "to", "a", "in", "is", "that", "for", "it", "as", "was", "with", "be", "by", "on", "not", "he", "this", "are",
            "or", "his", "from", "at", "which", "but", "have", "an", "had", "they", "you", "were", "their", "one", "all", "we", "can", "her", "has", "there",
            "been", "if", "more", "when", "will", "would", "who", "so", "no", "customer", "order", "shipped", "delayed", "invoice", "payment", "received",
            "warehouse", "account", "request", "error", "timeout", "connection", "retry", "failed", "completed", "pending", "approved", "returned", "item",
            "items", "quantity", "price", "discount", "region", "contact", "phone", "email", "address", "service", "support", "ticket", "priority", "high",
            "low", "normal", "update", "status", "changed", "note", "please", "call", "back", "tomorrow", "morning", "after", "before", "delivery", "window",
            "missing", "damaged", "replacement", "credit", "refund", "issued", "manager", "review", "escalated", "resolved", "closed", "opened", "again"];
        var words = new List<string>(common);
        const string consonants = "bcdfghjklmnprstvwz", vowels = "aeiou";
        for (var i = 0; words.Count < 4000; i++)
        {
            var length = 3 + (int)Below(i, 77, 7);
            var chars = new char[length];
            for (var c = 0; c < length; c++) chars[c] = c % 2 == 0 ? consonants[(int)Below(i * 16 + c, 78, consonants.Length)] : vowels[(int)Below(i * 16 + c, 79, vowels.Length)];
            words.Add(new string(chars));
        }
        return [.. words];
    }
    private static string Word(long row, ulong salt)
    {
        var u = Unit(row, salt);
        return Words[(int)(u * u * u * Words.Length)];
    }
    private static int Sentence(Span<char> text, long row, ulong salt, int minChars, int maxChars)
    {
        var target = minChars + (int)Below(row, salt, maxChars - minChars + 1);
        var length = 0;
        for (var w = 0; length < target; w++)
        {
            var word = w % 9 == 8 ? Below(row, salt + (ulong)w * 31 + 7, 100_000).ToString(CultureInfo.InvariantCulture) : Word(row, salt + (ulong)w * 31);
            if (length > 0 && length < text.Length) text[length++] = ' ';
            var take = Math.Min(word.Length, text.Length - length);
            word.AsSpan(0, take).CopyTo(text[length..]);
            length += take;
            if (length >= text.Length) break;
        }
        return Math.Min(length, maxChars);
    }

    private static readonly string[] Statuses = ["Open", "Pending", "Shipped", "Delivered", "Cancelled", "Returned"];
    private static readonly string[] Regions = ["North", "South", "East", "West", "Central", "Northeast", "Northwest", "Southeast", "Southwest", "Overseas", "Online", "Wholesale"];
    private static readonly string[] Levels = ["INFO", "INFO", "INFO", "INFO", "DEBUG", "DEBUG", "WARN", "ERROR"];
    private static readonly string[] Domains = ["example.com", "contoso.com", "fabrikam.net", "northwind.org", "adventure-works.com", "mail.test"];

    private static Column Id(string name) => new(new ResultColumn(name, "int", "text", Nullable: false), Integer);
    private static Column RandomInt(string name, ulong salt, long limit, double nulls = 0) => new(new ResultColumn(name, "int", "text"), (b, row) =>
    {
        if (nulls > 0 && Null(row, salt, nulls)) b.AppendNull();
        else Integer(b, Below(row, salt, limit));
    });
    private static Column RandomBigint(string name, ulong salt) => new(new ResultColumn(name, "bigint", "text"), (b, row) => Integer(b, (long)(Mix(row, salt) >> 2)));
    private static Column Money(string name, ulong salt, long cents, double nulls = 0, int precision = 18) => new(new ResultColumn(name, "decimal(" + precision + ",2)", "text", Precision: precision, Scale: 2), (b, row) =>
    {
        if (nulls > 0 && Null(row, salt, nulls)) b.AppendNull();
        else b.EndFormatted(CellFormat.WriteDecimal(b.BeginFormatted(), new decimal(Below(row, salt, cents)) / 100m));
    });
    private static Column BigDecimal(string name, ulong salt) => new(new ResultColumn(name, "decimal(38,10)", "text", Precision: 38, Scale: 10), (b, row) =>
    {
        Span<char> text = stackalloc char[48];
        text.TryWrite(CultureInfo.InvariantCulture, $"{Below(row, salt, 1_000_000_000_000)}.{Below(row, salt + 1, 10_000_000_000):D10}", out var length);
        b.AppendText(text[..length]);
    });
    private static Column Float(string name, ulong salt) => new(new ResultColumn(name, "float", "text", Precision: 53), (b, row) => b.EndFormatted(CellFormat.WriteFloat(b.BeginFormatted(), Unit(row, salt) * 1000)));
    /// <summary>Increasing with the row, a few seconds apart, with sub-second ticks: a typical created or logged column.</summary>
    private static Column Moment(string name, ulong salt, long secondsPerRow) => new(new ResultColumn(name, "datetime2(7)", "text", Scale: 7), (b, row) =>
        b.EndFormatted(CellFormat.WriteDateTime2(b.BeginFormatted(), Epoch.AddTicks(row * secondsPerRow * 10_000_000 + Below(row, salt, secondsPerRow * 10_000_000)), 7)));
    private static Column RandomMoment(string name, ulong salt) => new(new ResultColumn(name, "datetime2(7)", "text", Scale: 7), (b, row) =>
        b.EndFormatted(CellFormat.WriteDateTime2(b.BeginFormatted(), Epoch.AddTicks(Below(row, salt, 3L * 365 * 86_400 * 10_000_000)), 7)));
    private static Column Date(string name, ulong salt, double nulls) => new(new ResultColumn(name, "date", "text"), (b, row) =>
    {
        if (Null(row, salt, nulls)) b.AppendNull();
        else b.EndFormatted(CellFormat.WriteDate(b.BeginFormatted(), Epoch.AddSeconds(row * 4).AddDays(1 + Below(row, salt, 9)).Date));
    });
    private static Column Guid(string name, ulong salt) => new(new ResultColumn(name, "uniqueidentifier", "text"), (b, row) =>
    {
        Span<byte> bytes = stackalloc byte[16];
        BitConverter.TryWriteBytes(bytes, Mix(row, salt));
        BitConverter.TryWriteBytes(bytes[8..], Mix(row, salt + 1));
        b.EndFormatted(CellFormat.WriteGuid(b.BeginFormatted(), new System.Guid(bytes)));
    });
    private static Column Bit(string name, ulong salt) => new(new ResultColumn(name, "bit", "text"), (b, row) => b.EndFormatted(CellFormat.WriteBit(b.BeginFormatted(), Below(row, salt, 4) == 0)));
    private static Column Pick(string name, ulong salt, string[] values, int size) => new(new ResultColumn(name, "nvarchar(" + size + ")", "text", Collation: CaseInsensitive), (b, row) => b.AppendText(values[Below(row, salt, values.Length)]));
    private static Column Label(string name, ulong salt, string prefix, long values) => new(new ResultColumn(name, "nvarchar(40)", "text", Collation: CaseInsensitive), (b, row) =>
    {
        Span<char> text = stackalloc char[40];
        text.TryWrite(CultureInfo.InvariantCulture, $"{prefix} {Below(row, salt, values)}", out var length);
        b.AppendText(text[..length]);
    });
    private static Column Email(string name, ulong salt) => new(new ResultColumn(name, "nvarchar(100)", "text", Collation: CaseInsensitive), (b, row) =>
    {
        Span<char> text = stackalloc char[100];
        text.TryWrite(CultureInfo.InvariantCulture, $"{Word(row, salt)}.{Word(row, salt + 1)}{Below(row, salt + 2, 1000)}@{Domains[Below(row, salt + 3, Domains.Length)]}", out var length);
        b.AppendText(text[..length]);
    });
    private static Column Prose(string name, string type, ulong salt, int min, int max, double nulls) => new(new ResultColumn(name, type, "text", Collation: CaseInsensitive), (b, row) =>
    {
        if (nulls > 0 && Null(row, salt, nulls)) { b.AppendNull(); return; }
        Span<char> text = max <= 512 ? stackalloc char[max] : new char[max];
        b.AppendText(text[..Sentence(text, row, salt, min, max)]);
    });

    private static Shape Build(string shape)
    {
        switch (shape)
        {
            case "orders":
                // A typical OLTP query: keys, low- and high-cardinality text, money, dates, a GUID, NULL-heavy columns, a note.
                return new([
                    Id("order_id"), RandomInt("customer_id", 1, 200_000), Pick("status", 2, Statuses, 20), Pick("region", 3, Regions, 30),
                    Money("amount", 4, 10_000_000), RandomInt("quantity", 5, 20), Moment("created", 6, 4), Date("shipped", 7, 0.6),
                    Guid("row_guid", 8), Email("email", 9), Money("discount", 10, 5_000, 0.85, 5), Prose("note", "nvarchar(400)", 11, 20, 300, 0.5),
                    Bit("is_active", 12), Float("tax", 13)], 1, 9, 2, [9, 4], 4, 5);
            case "wide":
            {
                // 120 columns: wide reporting rows. Ints, mid-cardinality labels, dates, money, NULL-heavy ints and bits.
                var columns = new List<Column> { Id("id") };
                for (var c = 1; c < 120; c++)
                {
                    var salt = 100 + (ulong)c;
                    var name = "c" + c.ToString("D3", CultureInfo.InvariantCulture);
                    columns.Add((c % 6) switch
                    {
                        0 => RandomInt(name, salt, 1_000_000),
                        1 => Label(name, salt, "Item", 5_000),
                        2 => RandomMoment(name, salt),
                        3 => Money(name, salt, 100_000_000),
                        4 => RandomInt(name, salt, 1000, 0.9),
                        _ => Bit(name, salt)
                    });
                }
                return new([.. columns], 6, 1, 5, [1, 3], 3, 6);
            }
            case "log":
                // Text heavy: application log rows with messages of 100 to 1,500 characters.
                return new([
                    Id("id"), Moment("logged", 20, 1), Pick("level", 21, Levels, 10), Label("source", 22, "Service.Component", 40),
                    RandomInt("thread", 23, 64), Prose("message", "nvarchar(max)", 24, 100, 1500, 0), Guid("correlation", 25)], 4, 3, 2, [5, 1], 4, 4);
            case "numeric":
                // Narrow numbers and dates only.
                return new([
                    Id("id"), RandomInt("account", 30, 50_000), RandomBigint("big", 31), BigDecimal("balance", 32), Float("rate", 33),
                    Date("value_date", 34, 0.1), Money("fee", 35, 100_000, 0.3), RandomInt("bucket", 36, 16)], 1, 3, 7, [3, 2], 6, 1);
            case "w1":
            {
                // SyntheticRows W1: every cell a near-copy of its neighbour's, so far more compressible than real data. For reference only.
                var meta = SyntheticRows.Columns("W1");
                Column[] columns = [.. meta.Select((column, index) => new Column(new ResultColumn(column.Name, column.DataType, "text",
                    Collation: column.DataType.StartsWith("nvarchar", StringComparison.Ordinal) ? CaseInsensitive : null), (_, _) => { }))];
                return new(columns, 7, 1, 6, [1, 3], 3, 7);
            }
            default: throw new ArgumentOutOfRangeException(nameof(shape), "orders, wide, log, numeric or w1");
        }
    }

    // ---- Codecs that .NET 10 already had: Brotli, Deflate and ZLib.

    private static Codec BrotliCodec(int quality, int window) => new("brotli" + quality + (window == 18 ? "" : "w" + window),
        (source, scratch) =>
        {
            var room = scratch.Room(BrotliEncoder.GetMaxCompressedLength(source.Length));
            if (!BrotliEncoder.TryCompress(source, room, out var written, quality, window)) throw new InvalidOperationException("Brotli failed.");
            return room.AsSpan(0, written).ToArray();
        },
        (packed, destination) =>
        {
            if (!BrotliDecoder.TryDecompress(packed, destination, out var written) || written != destination.Length) throw new InvalidDataException("Brotli failed.");
        });

    private static Codec DeflateCodec(int level, bool zlib) => new((zlib ? "zlib" : "deflate") + level,
        (source, scratch) =>
        {
            var stream = scratch.Stream;
            stream.SetLength(0);
            var options = new ZLibCompressionOptions { CompressionLevel = level };
            using (Stream compressor = zlib ? new ZLibStream(stream, options, leaveOpen: true) : new DeflateStream(stream, options, leaveOpen: true)) compressor.Write(source);
            return stream.GetBuffer().AsSpan(0, (int)stream.Length).ToArray();
        },
        (packed, destination) =>
        {
            using var input = new MemoryStream(packed, writable: false);
            using Stream decompressor = zlib ? new ZLibStream(input, CompressionMode.Decompress) : new DeflateStream(input, CompressionMode.Decompress);
            decompressor.ReadExactly(destination);
        });

    // ---- Zstandard, new in .NET 11's System.IO.Compression, and LZ4 from K4os.Compression.LZ4 (managed code, no native
    // library; referenced only by this test project) for comparison.

    /// <summary>Zstandard through the one-shot API, which sets up a compression context on every call.</summary>
    private static Codec ZstdCodec(int quality, int window) => new("zstd" + (quality < 0 ? "m" + -quality : quality.ToString(CultureInfo.InvariantCulture)) + (window == 18 ? "" : "w" + window),
        (source, scratch) =>
        {
            var room = scratch.Room((int)ZstandardEncoder.GetMaxCompressedLength(source.Length));
            if (!ZstandardEncoder.TryCompress(source, room, out var written, quality, window)) throw new InvalidOperationException("Zstandard failed.");
            return room.AsSpan(0, written).ToArray();
        },
        (packed, destination) =>
        {
            if (!ZstandardDecoder.TryDecompress(packed, destination, out var written) || written != destination.Length) throw new InvalidDataException("Zstandard failed.");
        });

    [ThreadStatic] private static Dictionary<int, ZstandardEncoder>? encoders;
    [ThreadStatic] private static ZstandardDecoder? decoder;

    /// <summary>Zstandard with one encoder and decoder a thread, reset between pages, as a store would keep them.</summary>
    private static Codec ZstdReusedCodec(int quality) => new("zstd" + (quality < 0 ? "m" + -quality : quality.ToString(CultureInfo.InvariantCulture)) + "r",
        (source, scratch) =>
        {
            encoders ??= [];
            if (!encoders.TryGetValue(quality, out var encoder)) encoders[quality] = encoder = new ZstandardEncoder(quality, 18);
            var room = scratch.Room((int)ZstandardEncoder.GetMaxCompressedLength(source.Length));
            var status = encoder.Compress(source, room, out var consumed, out var written, isFinalBlock: true);
            encoder.Reset();
            if (status != OperationStatus.Done || consumed != source.Length) throw new InvalidOperationException("Zstandard failed.");
            return room.AsSpan(0, written).ToArray();
        },
        (packed, destination) =>
        {
            decoder ??= new ZstandardDecoder();
            var status = decoder.Decompress(packed, destination, out _, out var written);
            decoder.Reset();
            if (status != OperationStatus.Done || written != destination.Length) throw new InvalidDataException("Zstandard failed.");
        });

    private static Codec Lz4Codec(K4os.Compression.LZ4.LZ4Level level, string name) => new(name,
        (source, scratch) =>
        {
            var room = scratch.Room(K4os.Compression.LZ4.LZ4Codec.MaximumOutputSize(source.Length));
            var written = K4os.Compression.LZ4.LZ4Codec.Encode(source, room, level);
            if (written <= 0) throw new InvalidOperationException("LZ4 failed.");
            return room.AsSpan(0, written).ToArray();
        },
        (packed, destination) =>
        {
            if (K4os.Compression.LZ4.LZ4Codec.Decode(packed, destination) != destination.Length) throw new InvalidDataException("LZ4 failed.");
        });

    private static readonly Codec[] AllCodecs =
    [
        BrotliCodec(0, 18), BrotliCodec(1, 18), BrotliCodec(2, 18), BrotliCodec(3, 18), BrotliCodec(5, 18), BrotliCodec(1, 22),
        DeflateCodec(1, false), DeflateCodec(6, false), DeflateCodec(1, true),
        ZstdCodec(-5, 18), ZstdCodec(-1, 18), ZstdCodec(1, 18), ZstdCodec(2, 18), ZstdCodec(3, 18), ZstdCodec(6, 18), ZstdCodec(1, 22),
        ZstdReusedCodec(-1), ZstdReusedCodec(1), ZstdReusedCodec(3),
        Lz4Codec(K4os.Compression.LZ4.LZ4Level.L00_FAST, "lz4"), Lz4Codec(K4os.Compression.LZ4.LZ4Level.L03_HC, "lz4hc3"),
    ];

    /// <summary>A Save's output: counts the bytes and drops them, so only formatting and page reads are timed.</summary>
    private sealed class Discard : IBufferWriter<byte>
    {
        private readonly byte[] buffer = new byte[1 << 20];
        public long Written;
        public void Advance(int count) => Written += count;
        public Memory<byte> GetMemory(int sizeHint = 0) => buffer;
        public Span<byte> GetSpan(int sizeHint = 0) => buffer;
    }

    private static string label = "";

    public static void Run(string[] args)
    {
        var gib = double.Parse(args[1], CultureInfo.InvariantCulture);
        var shapeName = args[2];
        string? Option(string name) => Array.IndexOf(args, name) is var at and >= 0 && at + 1 < args.Length ? args[at + 1] : null;
        Codec[] codecs = Option("--codecs") is { } names ? [.. names.Split(',').Select(name => AllCodecs.First(codec => codec.Name == name))] : AllCodecs;
        var keep = AllCodecs.First(codec => codec.Name == (Option("--keep") ?? "brotli1"));
        var runOps = !args.Contains("--no-ops");
        var cores = 0;
        if (int.TryParse(Environment.GetEnvironmentVariable("VARIA_BENCH_CORES"), out cores) && cores > 0)
        {
            if (OperatingSystem.IsWindows() || OperatingSystem.IsLinux()) Process.GetCurrentProcess().ProcessorAffinity = (nint)((1L << cores) - 1);
            ViewSorter.Workers = Math.Clamp(cores * 3 / 4, 1, 16);
        }
        var workers = ViewSorter.Workers;
        label = gib.ToString("0.##", CultureInfo.InvariantCulture) + "GiB." + shapeName + (cores > 0 ? "." + cores + "cores" : "");
        var shape = Build(shapeName);
        ResultColumn[] columns = [.. shape.Columns.Select(column => column.Meta)];
        var none = CancellationToken.None;

        // ---- Fill.
        var budget = (long)(gib * (1L << 30));
        var store = new ResultStore(4 * budget, budget);
        var query = store.BeginQuery("compression");
        var set = store.Open(query, 0, 1, 1, "rows", columns, [.. columns.Select(_ => WireKind.Text)]) ?? throw new InvalidOperationException("The result set was not kept.");
        var watch = Stopwatch.StartNew();
        long rows = 0;
        while (set.BeginRow() is { } builder)
        {
            set.CountRow();
            if (shapeName == "w1") SyntheticRows.WriteCells("W1", rows, builder);
            else foreach (var column in shape.Columns) column.Write(builder, rows);
            if (!set.TryCommitRow()) break;
            rows++;
        }
        set.Complete();
        // The bench reads the pages as every reader does: through the accessor, the set pinned while it measures.
        using var measuring = set.Pin();
        StoredPage[]? pages = set.SealedSnapshot();
        long bodyBytes = 0, lengthBytes = 0;
        foreach (var page in pages) { bodyBytes += page.Length; lengthBytes += page.Lengths.MemoryBytes; }
        var detail = rows.ToString("N0", CultureInfo.InvariantCulture) + " rows, " + pages.Length.ToString("N0", CultureInfo.InvariantCulture) + " pages, " + columns.Length + " columns";
        Print("rows", rows, "rows", detail);
        Print("pages", pages.Length, "pages", detail);
        Print("bytesPerRow", (double)bodyBytes / rows, "B", "page bodies only");
        Print("lengthsShare", (double)lengthBytes / (bodyBytes + lengthBytes), "x", "the lengths sidecar's share of the stored bytes (" + (lengthBytes >> 20) + " MiB)");
        Print("fillSeconds", watch.Elapsed.TotalSeconds, "s", detail);
        Print("workers", workers, "threads", "ViewSorter.Workers on " + Environment.ProcessorCount + " logical processors");
        Memory("raw", "after the fill and a compacting collection", compact: true);

        // ---- Codecs: ratio, and speed one thread over a sample and the workers over all pages.
        StoredPage[]? sample = Enumerable.Range(0, Math.Min(SamplePages, pages.Length)).Select(i => pages[(int)((long)i * pages.Length / Math.Min(SamplePages, pages.Length))]).ToArray();
        long sampleBytes = sample.Sum(page => (long)page.Length);
        Packed[]? kept = null;
        Codec[] run = codecs.Contains(keep) ? codecs : [.. codecs, keep];
        foreach (var codec in run)
        {
            var name = "codec." + codec.Name;
            var scratch = new Scratch();
            var packedSample = new byte[sample.Length][];
            // Warm up the codec (and its native state) on a few pages first.
            for (var i = 0; i < Math.Min(8, sample.Length); i++) codec.Unpack(codec.Pack(sample[i].Body(), scratch), scratch.RawFor(sample[i].Length));
            var perPage = new double[sample.Length];
            var timer = Stopwatch.StartNew();
            for (var i = 0; i < sample.Length; i++)
            {
                var start = timer.Elapsed.TotalMicroseconds;
                packedSample[i] = codec.Pack(sample[i].Body(), scratch);
                perPage[i] = timer.Elapsed.TotalMicroseconds - start;
            }
            var compressSeconds = timer.Elapsed.TotalSeconds;
            var sampleCompressed = packedSample.Sum(data => (long)data.Length);
            Print(name + ".compressMBps1", sampleBytes / 1e6 / compressSeconds, "MB/s", "one thread, " + sample.Length + " pages; median " + Median(perPage).ToString("0", CultureInfo.InvariantCulture) + " µs a page");
            timer.Restart();
            for (var i = 0; i < sample.Length; i++)
            {
                var start = timer.Elapsed.TotalMicroseconds;
                codec.Unpack(packedSample[i], scratch.RawFor(sample[i].Length));
                perPage[i] = timer.Elapsed.TotalMicroseconds - start;
            }
            var decompressSeconds = timer.Elapsed.TotalSeconds;
            Print(name + ".decompressMBps1", sampleBytes / 1e6 / decompressSeconds, "MB/s", "one thread, output bytes; median " + Median(perPage).ToString("0", CultureInfo.InvariantCulture) + " µs a page, p99 " + Percentile(perPage, 0.99).ToString("0", CultureInfo.InvariantCulture));
            // Every page on the workers, as a compressing pass over a whole result would run.
            var all = new Packed[pages.Length];
            var source = pages;
            timer.Restart();
            Parallel.For(0, source.Length, new ParallelOptions { MaxDegreeOfParallelism = workers }, () => new Scratch(), (i, _, local) =>
            {
                var page = source[i];
                all[i] = new Packed(page.FirstRow, page.Rows, page.Length, codec.Pack(page.Body(), local), page.Lengths);
                return local;
            }, _ => { });
            var parallelCompress = timer.Elapsed.TotalSeconds;
            var compressed = all.Sum(packed => (long)packed.Data.Length);
            Print(name + ".ratio", (double)bodyBytes / compressed, "x", "page bodies " + (bodyBytes >> 20) + " MiB to " + (compressed >> 20) + " MiB; with the lengths sidecar kept raw " +
                ((double)(bodyBytes + lengthBytes) / (compressed + lengthBytes)).ToString("0.00", CultureInfo.InvariantCulture) + "x");
            Print(name + ".compressSecondsAll", parallelCompress, "s", workers + " workers, every page; " + (bodyBytes / 1e6 / parallelCompress).ToString("0", CultureInfo.InvariantCulture) + " MB/s");
            var largeShare = all.Count(packed => packed.Data.Length >= 85_000) / (double)all.Length;
            timer.Restart();
            Parallel.For(0, all.Length, new ParallelOptions { MaxDegreeOfParallelism = workers }, () => new Scratch(), (i, _, local) =>
            {
                codec.Unpack(all[i].Data, local.RawFor(all[i].RawLength));
                return local;
            }, _ => { });
            var parallelDecompress = timer.Elapsed.TotalSeconds;
            Print(name + ".decompressSecondsAll", parallelDecompress, "s", workers + " workers into reused buffers; " + (bodyBytes / 1e6 / parallelDecompress).ToString("0", CultureInfo.InvariantCulture) + " MB/s; " +
                (largeShare * 100).ToString("0", CultureInfo.InvariantCulture) + " % of compressed pages are large objects");
            if (codec == keep) kept = all;
            else
            {
                // Collect this codec's copies now, so later memory readings hold only the kept codec's pages.
                all = null!;
                GC.Collect(2, GCCollectionMode.Aggressive, true, true);
            }
        }
        if (kept is null) throw new InvalidOperationException("The kept codec did not run.");

        Discard Save(IEnumerable<StoredPage> source)
        {
            var output = new Discard();
            var writer = new ResultTextWriter(output, TextOptions.Export(TextFormat.Csv, true, "NULL"), columns);
            int[] selected = [.. Enumerable.Range(0, columns.Length)];
            var scratch = new int[PageView.ScratchLength(columns.Length)];
            writer.Begin();
            writer.Header(selected);
            foreach (var page in source)
            {
                var view = PageView.Parse(page.Body(), columns.Length, scratch);
                for (var row = 0; row < view.Rows; row++) writer.Row(view, row, selected);
            }
            writer.End();
            return output;
        }

        // ---- Operations on the raw pages: the baseline.
        var pivotSpec = new PivotSpec([shape.LowColumn], -1, [new(PivotAggregate.Count, -1), new(PivotAggregate.Sum, shape.SumColumn), new(PivotAggregate.Max, shape.MaxColumn)]);
        void Operations(string prefix, StoredPage[] source, bool print = true)
        {
            // Warm every path on a slice first, so no timed run pays for compiling it.
            var warm = source[..Math.Min(4, source.Length)];
            for (var w = 0; w < 60; w++)
            {
                ViewSorter.Build(set, warm, [new ViewKey(shape.IntColumn, true, SortMode.Value)], [], none);
                ViewSorter.Build(set, warm, [new ViewKey(shape.TextColumn, false, SortMode.Value)], [], none);
                ViewSorter.Build(set, warm, [], [new ViewFilter(FilterOp.In, shape.LowColumn, [0], false, null, [])], none);
                ColumnProfiler.Profile(set, warm, null, shape.Profile, true, none);
                ResultPivoter.Build(set, warm, null, pivotSpec, none, _ => true);
                Save(warm);
            }
            // Tiered compilation promotes hot methods on a background thread after a short delay; let it finish.
            Thread.Sleep(1000);
            Repeat(prefix + ".sortInt", print, () => ViewSorter.Build(set, source, [new ViewKey(shape.IntColumn, true, SortMode.Value)], [], none), view => view.Order.Length + " rows");
            Repeat(prefix + ".sortText", print, () => ViewSorter.Build(set, source, [new ViewKey(shape.TextColumn, false, SortMode.Value)], [], none), view => view.Order.Length + " rows");
            Repeat(prefix + ".filterIn", print, () => ViewSorter.Build(set, source, [], [new ViewFilter(FilterOp.In, shape.LowColumn, [0], false, null, [])], none), view => view.Order.Length + " rows kept");
            Repeat(prefix + ".profile", print, () => ColumnProfiler.Profile(set, source, null, shape.Profile, true, none), result => result.Columns.Length + " columns");
            Repeat(prefix + ".pivot", print, () => ResultPivoter.Build(set, source, null, pivotSpec, none, _ => true), _ => "count, sum and max by a low-cardinality column");
            Repeat(prefix + ".save", print, () => Save(source), output => (output.Written >> 20) + " MiB of CSV, one thread");
        }
        if (runOps) Operations("warm", pages, print: false);
        if (runOps) Operations("raw", pages);

        // ---- A results.read of three pages: a raw read hands the stored bytes to main; a compressed one decompresses first.
        {
            var scratch = new Scratch();
            var trials = Math.Min(200, Math.Max(1, pages.Length - 3));
            var raw = new double[trials];
            var cold = new double[trials];
            var timer = new Stopwatch();
            var copy = new byte[PageBuilder.SealBytes * 4];
            for (var t = 0; t < trials; t++)
            {
                var first = (int)Below(t, 900, Math.Max(1, pages.Length - 3));
                timer.Restart();
                long sum = 0;
                for (var p = first; p < Math.Min(first + 3, pages.Length); p++) { pages[p].Body().AsSpan(0, Math.Min(pages[p].Length, copy.Length)).CopyTo(copy); sum += copy[0]; }
                raw[t] = timer.Elapsed.TotalMicroseconds;
                timer.Restart();
                for (var p = first; p < Math.Min(first + 3, kept.Length); p++)
                {
                    var body = new byte[kept[p].RawLength];
                    keep.Unpack(kept[p].Data, body);
                    sum += body[0];
                }
                cold[t] = timer.Elapsed.TotalMicroseconds;
                GC.KeepAlive(sum);
            }
            Print("read.rawMicroseconds", Median(raw), "µs", "three pages copied once, median of " + trials);
            Print("read." + keep.Name + ".coldMicroseconds", Median(cold), "µs", "three pages decompressed into new arrays, one thread, median; p99 " + Percentile(cold, 0.99).ToString("0", CultureInfo.InvariantCulture));

            // A read through a view sorted by a random int: 256 consecutive view rows come from scattered source pages,
            // each of which a compressed store would decompress whole.
            if (runOps)
            {
                var order = ViewSorter.Build(set, pages, [new ViewKey(shape.IntColumn, true, SortMode.Value)], [], none).Order;
                var starts = kept.Select(packed => packed.FirstRow).ToArray();
                var viewTrials = 40;
                var viewTimes = new double[viewTrials];
                var viewParallel = new double[viewTrials];
                var touched = new double[viewTrials];
                for (var t = 0; t < viewTrials; t++)
                {
                    var from = (int)Below(t, 902, Math.Max(1, order.Length - 256));
                    var distinct = new HashSet<int>();
                    for (var position = from; position < Math.Min(order.Length, from + 256); position++)
                    {
                        var index = Array.BinarySearch(starts, (long)order[position]);
                        distinct.Add(index < 0 ? ~index - 1 : index);
                    }
                    timer.Restart();
                    foreach (var index in distinct) keep.Unpack(kept[index].Data, scratch.RawFor(kept[index].RawLength));
                    viewTimes[t] = timer.Elapsed.TotalMilliseconds;
                    int[] pagesNeeded = [.. distinct];
                    timer.Restart();
                    Parallel.For(0, pagesNeeded.Length, new ParallelOptions { MaxDegreeOfParallelism = workers }, () => new Scratch(), (i, _, local) =>
                    {
                        keep.Unpack(kept[pagesNeeded[i]].Data, local.RawFor(kept[pagesNeeded[i]].RawLength));
                        return local;
                    }, _ => { });
                    viewParallel[t] = timer.Elapsed.TotalMilliseconds;
                    touched[t] = distinct.Count;
                }
                Print("viewRead." + keep.Name + ".milliseconds", Median(viewTimes), "ms", "256 rows of a view sorted by a random int: median " + Median(touched).ToString("0", CultureInfo.InvariantCulture) +
                    " distinct source pages decompressed, one thread; p99 " + Percentile(viewTimes, 0.99).ToString("0.0", CultureInfo.InvariantCulture) + " ms");
                Print("viewRead." + keep.Name + ".parallelMilliseconds", Median(viewParallel), "ms", "the same pages decompressed on " + workers + " workers; p99 " +
                    Percentile(viewParallel, 0.99).ToString("0.0", CultureInfo.InvariantCulture) + " ms");
            }

            // A scroll: forward a page at a time through 300 pages reading three, back 100, then 50 jumps; each
            // window's pages come from an LRU of decompressed pages.
            var trace = new List<int>();
            var span = Math.Max(1, Math.Min(300, kept.Length - 3));
            for (var p = 0; p < span; p++) trace.Add(p);
            for (var p = span - 1; p >= Math.Max(0, span - 100); p--) trace.Add(p);
            for (var j = 0; j < 50; j++) trace.Add((int)Below(j, 901, Math.Max(1, kept.Length - 3)));
            foreach (var capacity in new[] { 0, 6, 24 })
            {
                var cache = new LinkedList<int>();
                var misses = 0;
                timer.Restart();
                foreach (var first in trace)
                {
                    for (var p = first; p < Math.Min(first + 3, kept.Length); p++)
                    {
                        if (cache.Contains(p)) { cache.Remove(p); cache.AddFirst(p); continue; }
                        misses++;
                        var body = new byte[kept[p].RawLength];
                        keep.Unpack(kept[p].Data, body);
                        if (capacity == 0) continue;
                        cache.AddFirst(p);
                        if (cache.Count > capacity) cache.RemoveLast();
                    }
                }
                var seconds = timer.Elapsed.TotalSeconds;
                Print("scroll." + keep.Name + ".cache" + capacity + ".microsecondsPerRead", seconds * 1e6 / trace.Count, "µs", trace.Count + " reads of three pages; " + misses + " decompressions; cache holds " + capacity + " pages (" + (capacity * PageBuilder.SealBytes >> 20) + " MiB)");
            }
        }

        // ---- Save streamed from compressed pages: each page decompressed into one reused buffer just before it is written.
        if (runOps)
        {
            var reused = new byte[PageBuilder.SealBytes * 2];
            IEnumerable<StoredPage> Streamed()
            {
                foreach (var packed in kept)
                {
                    if (reused.Length < packed.RawLength) reused = new byte[packed.RawLength];
                    keep.Unpack(packed.Data, reused.AsSpan(0, packed.RawLength));
                    // PageView reads only the page's own bytes (its header gives every offset), so a longer buffer is fine.
                    yield return new StoredPage(packed.FirstRow, packed.Rows, reused, packed.Lengths);
                }
            }
            Repeat(keep.Name + ".saveStreamed", true, () => Save(Streamed()), output => (output.Written >> 20) + " MiB of CSV, one thread, decompressing as it goes");
        }

        // ---- Memory: drop the raw pages, keep only the compressed ones, and see what the operating system gets back.
        set.Release();
        pages = null;
        sample = null;
        Memory("dropped", "raw pages unreachable, no collection yet", compact: false, collect: false);
        var pause = Stopwatch.StartNew();
        GC.Collect(2, GCCollectionMode.Forced, blocking: true, compacting: false);
        Print("gc.nonCompactingSeconds", pause.Elapsed.TotalSeconds, "s", "a blocking gen2 collection that does not compact");
        Memory("nonCompacting", "after the non-compacting gen2 collection", compact: false, collect: false);
        // Whether the space the raw pages left is reused: allocate new pages for as many bytes as compression saved, as
        // later results would, and see how far the commit grows. Then drop them again.
        {
            var saved = bodyBytes - kept.Sum(packed => (long)packed.Data.Length);
            var refill = new List<byte[]>();
            for (long bytes = 0; bytes < saved; bytes += PageBuilder.SealBytes) refill.Add(new byte[PageBuilder.SealBytes]);
            Memory("refilled", "after allocating " + (saved >> 20) + " MiB of new 256 KiB pages without a collection", compact: false, collect: false);
            refill = null;
            GC.Collect(2, GCCollectionMode.Forced, blocking: true, compacting: false);
        }
        pause.Restart();
        GC.Collect(2, GCCollectionMode.Aggressive, blocking: true, compacting: true);
        Print("gc.compactingSeconds", pause.Elapsed.TotalSeconds, "s", "an aggressive compacting collection (ResultStore.CollectNow's) over " + (kept.Sum(p => (long)p.Data.Length + p.Lengths.MemoryBytes) >> 20) + " MiB kept");
        Memory("compacted", "after the compacting collection: what a compressed store would hold", compact: false, collect: false);

        // ---- Operations on compressed pages: decompress every page on the workers into new arrays (rehydrate), then run.
        if (runOps)
        {
            StoredPage[] Rehydrate()
            {
                var result = new StoredPage[kept.Length];
                Parallel.For(0, kept.Length, new ParallelOptions { MaxDegreeOfParallelism = workers }, i =>
                {
                    var packed = kept[i];
                    var body = new byte[packed.RawLength];
                    keep.Unpack(packed.Data, body);
                    result[i] = new StoredPage(packed.FirstRow, packed.Rows, body, packed.Lengths);
                });
                return result;
            }
            StoredPage[]? rehydrated = Time(keep.Name + ".rehydrate", Rehydrate, result => result.Length + " pages decompressed on " + workers + " workers into new arrays");
            Operations(keep.Name + ".rehydrated", rehydrated);
            using (var process = Process.GetCurrentProcess()) Print("peakWorkingSetMiB", process.PeakWorkingSet64 >> 20, "MiB", "over the whole run");
            rehydrated = null;
            pause.Restart();
            GC.Collect(2, GCCollectionMode.Aggressive, blocking: true, compacting: true);
            Print("gc.afterRehydrateSeconds", pause.Elapsed.TotalSeconds, "s", "a compacting collection after the decompressed pages are dropped");
            Memory("afterRehydrate", "after dropping the decompressed pages and compacting", compact: false, collect: false);
        }
        GC.KeepAlive(kept);
    }

    private static T Time<T>(string name, Func<T> work, Func<T, string> about)
    {
        var before = GC.GetTotalAllocatedBytes(true);
        var timer = Stopwatch.StartNew();
        var result = work();
        timer.Stop();
        Print(name + "Seconds", timer.Elapsed.TotalSeconds, "s", about(result) + "; allocated " + ((GC.GetTotalAllocatedBytes(true) - before) >> 20) + " MiB");
        return result;
    }

    /// <summary>Three timed runs; prints the median, with the fastest and slowest beside it.</summary>
    private static void Repeat<T>(string name, bool print, Func<T> work, Func<T, string> about)
    {
        var seconds = new double[print ? 3 : 1];
        var text = "";
        long allocated = 0;
        for (var i = 0; i < seconds.Length; i++)
        {
            var before = GC.GetTotalAllocatedBytes(true);
            var timer = Stopwatch.StartNew();
            var result = work();
            seconds[i] = timer.Elapsed.TotalSeconds;
            allocated = GC.GetTotalAllocatedBytes(true) - before;
            text = about(result);
        }
        if (print) Print(name + "Seconds", Median(seconds), "s", text + "; median of 3 (" + seconds.Min().ToString("0.000", CultureInfo.InvariantCulture) + " to " +
            seconds.Max().ToString("0.000", CultureInfo.InvariantCulture) + "); allocated " + (allocated >> 20) + " MiB a run");
    }

    private static void Memory(string stage, string about, bool compact, bool collect = true)
    {
        if (collect) GC.Collect(2, compact ? GCCollectionMode.Aggressive : GCCollectionMode.Forced, true, compact);
        using var process = Process.GetCurrentProcess();
        process.Refresh();
        var info = GC.GetGCMemoryInfo();
        Print("memory." + stage + ".privateMiB", process.PrivateMemorySize64 >> 20, "MiB", about);
        Print("memory." + stage + ".workingSetMiB", process.WorkingSet64 >> 20, "MiB", about);
        Print("memory." + stage + ".gcCommittedMiB", info.TotalCommittedBytes >> 20, "MiB", "GC heap committed; GC.GetTotalMemory " + (GC.GetTotalMemory(false) >> 20) + " MiB");
    }

    private static double Median(double[] values) => Percentile(values, 0.5);
    private static double Percentile(double[] values, double share)
    {
        var sorted = values.Order().ToArray();
        return sorted.Length == 0 ? 0 : sorted[Math.Min(sorted.Length - 1, (int)(share * sorted.Length))];
    }

    private static void Print(string id, double value, string unit, string detail) =>
        Console.WriteLine(JsonSerializer.Serialize(new { id = "pageCompression." + label + "." + id, value = Math.Round(value, 3), unit, detail }));
}
