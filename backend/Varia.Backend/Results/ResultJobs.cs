using System.Buffers;
using System.Diagnostics;
using System.Globalization;
using Varia.Backend.Protocol;

namespace Varia.Backend.Results;

/// <summary>An output of fixed-size chunks: a write never makes a chunk larger than <see cref="Size"/>, and full chunks
/// wait in order until the job sends them (copy DATA) or writes them (export).</summary>
internal sealed class ChunkedBuffer(int size = ChunkedBuffer.DefaultSize) : IBufferWriter<byte>
{
    public const int DefaultSize = 1024 * 1024;
    private readonly Queue<byte[]> full = new();
    private byte[]? chunk;
    private int used;
    public int Size { get; } = size;
    /// <summary>Full-size chunks the caller has finished with, reused by the next ones (export).</summary>
    public Stack<byte[]> Spare { get; } = new();

    public Span<byte> GetSpan(int sizeHint = 0)
    {
        sizeHint = Math.Max(sizeHint, 1);
        if (sizeHint > Size) throw new ArgumentOutOfRangeException(nameof(sizeHint));
        if (chunk is null || chunk.Length - used < sizeHint)
        {
            Seal();
            chunk = Spare.TryPop(out var spare) ? spare : new byte[Size];
        }
        return chunk.AsSpan(used);
    }

    public Memory<byte> GetMemory(int sizeHint = 0)
    {
        GetSpan(sizeHint);
        return chunk.AsMemory(used);
    }

    public void Advance(int count) => used += count;

    /// <summary>Queues the chunk being written: whole when full, otherwise as an exact-size copy.</summary>
    public void Seal()
    {
        if (chunk is null || used == 0) return;
        full.Enqueue(used == chunk.Length ? chunk : chunk.AsSpan(0, used).ToArray());
        if (used != chunk.Length) Spare.Push(chunk);
        chunk = null;
        used = 0;
    }

    public bool TryTake(out byte[] next) => full.TryDequeue(out next!);

    /// <summary>A chunk waits to be taken: a writer of one long line stops here so the job can send or write it.</summary>
    public bool HasFull => full.Count > 0;
}

/// <summary>results.copy and results.export: the text of a stored result, formatted by <see cref="ResultTextWriter"/>
/// and either streamed to main as DATA (copy, which main puts on the clipboard) or written to the file main's save
/// dialog chose (export). Both lease the result, so a release while they run takes effect when they end. Transposed, they
/// write a grid drawn transposed as it is drawn, with nothing stored: a line per source column and a field per source row,
/// for the rows such a grid draws (the view's first <see cref="ResultTextWriter.MaxTransposedRows"/>), read row by row
/// through the stored pages; the rows past them are counted in the answer's Capped.</summary>
internal sealed class ResultJobs(ResultStore store)
{
    public const long MaxCopyBytes = 64L * 1024 * 1024;
    public const long MaxSafeInteger = 9_007_199_254_740_991;
    private const int MaxParts = 64;
    private const int MaxRanges = 64;
    private const int MaxPathCharacters = 32_767;
    /// <summary>Read, write and execute for owner, group and others: a replaced file's mode without set-id or sticky bits.</summary>
    private const UnixFileMode PermissionBits = (UnixFileMode)0b111_111_111;
    /// <summary>Read and write for owner, group and others: the most a new file gets before the umask.</summary>
    private const UnixFileMode NewFileBits = (UnixFileMode)0b110_110_110;
    /// <summary>How often a job reports its progress at most; the checks shorten it to see every report.</summary>
    internal TimeSpan ProgressInterval { get; init; } = TimeSpan.FromMilliseconds(250);

    /// <summary>Called after each page is written: the checks release or cancel mid-job through it.</summary>
    internal Action? AfterPage { get; init; }

    /// <summary>What a job reads: a result's stored rows, or a view of them (rows are then view positions).</summary>
    private sealed record Source(ResultSetBuffer Set, ResultView? View)
    {
        public long Available => View?.Rows ?? Set.RowsAvailable;
    }

    /// <summary>A part with its rows clamped to what is stored and its column ranges expanded to indexes.</summary>
    private sealed record Plan(List<(long First, long Last)> Rows, int[] Columns);

    /// <summary>A part as a transposed grid draws it: the rows written (their view positions, each one's page and index in
    /// it), their fields' names, the columns (its lines), and the rows left out for lying past the rows drawn.</summary>
    private sealed record TurnedPlan(int[] Positions, int[] PageOf, int[] IndexOf, string[] Names, int[] Columns, long Capped);

    /// <summary>Reads a source column by column: each row's page is found once, then every line reads it there, so no rows
    /// are copied and nothing is held but the stored pages themselves.</summary>
    /// <param name="named">The fields' names are written (headers, or JSON): otherwise none are read or made.</param>
    /// <remarks>It keeps every page it reads, so it pins the set and, for each part it plans, unpacks the packed pages that
    /// part's rows lie on together as working memory held until it is disposed (TOO_LARGE without room): a small selection
    /// of a large packed result unpacks only its own pages. Dispose it when the job ends.</remarks>
    private sealed class Turner : IDisposable
    {
        /// <summary>Cells written between looks at the token and the output.</summary>
        private const int Step = 1 << 10;
        private readonly Source source;
        private readonly int? headerColumn;
        private readonly bool named;
        private readonly CancellationToken token;
        private readonly PagePin? pin;
        private readonly StoredPage[] pages;
        private readonly RowAccess access;
        /// <summary>Working memory reserved for the unpacked pages <see cref="access"/> keeps, returned at disposal.</summary>
        private long held;

        /// <param name="fetched">A windowed result's rows, read through its block cache for this job (it has no stored pages).</param>
        public Turner(Source source, int? headerColumn, bool named, CancellationToken token = default, StoredPage[]? fetched = null)
        {
            this.source = source;
            this.headerColumn = headerColumn;
            this.named = named;
            this.token = token;
            if (fetched is not null)
            {
                pages = fetched;
                access = new(pages, source.Set.Columns.Count);
                return;
            }
            pin = source.Set.Pin();
            // A set switched to windowed since its lease is refused (REMOTE_RESULT): the pin goes with it.
            try { pages = source.Set.SealedSnapshot(); }
            catch
            {
                pin.Dispose();
                throw;
            }
            access = new(pages, source.Set.Columns.Count);
        }

        public void Dispose()
        {
            source.Set.ReturnWork(held);
            held = 0;
            pin?.Dispose();
        }

        /// <summary>Unpacks together the packed pages of these rows that are not yet kept, as working memory.</summary>
        private void Hold(int[] pageOf)
        {
            if (pin is null || !source.Set.HasPacked) return;
            int[] wanted = [.. pageOf.Distinct().Where(page => !access.Keeps(page))];
            if (wanted.Length == 0) return;
            var bodies = source.Set.BodiesTogether([.. wanted.Select(page => pages[page])], out var reserved, token)
                ?? throw new RequestException("TOO_LARGE", "There is not enough result memory to turn these rows. Close other results and try again.");
            held += reserved;
            for (var i = 0; i < wanted.Length; i++) access.Keep(wanted[i], bodies[i]);
        }

        public TurnedPlan Plan(Plan plan)
        {
            var positions = new List<int>();
            long capped = 0;
            foreach (var (first, last) in plan.Rows)
            {
                for (var position = first; position <= Math.Min(last, ResultTextWriter.MaxTransposedRows - 1); position++) positions.Add((int)position);
                capped += Math.Max(0, last - Math.Max(first, ResultTextWriter.MaxTransposedRows) + 1);
            }
            var pageOf = new int[positions.Count];
            var indexOf = new int[positions.Count];
            var names = new string[named ? positions.Count : 0];
            for (var i = 0; i < pageOf.Length; i++) pageOf[i] = access.PageOf(source.View is { } view ? view.Order[positions[i]] : positions[i], out indexOf[i]);
            Hold(pageOf);
            if (named)
                for (var i = 0; i < pageOf.Length; i++)
                    names[i] = headerColumn is { } header ? ResultTextWriter.FieldName(access.Page(pageOf[i], out _), indexOf[i], header) : ResultTextWriter.RowName(positions[i]);
            return new TurnedPlan([.. positions], pageOf, indexOf, ResultTextWriter.UniqueFields(names), plan.Columns, capped);
        }

        /// <summary>Whether the part writes anything: rows, or with names its columns' names alone.</summary>
        public static bool Written(TurnedPlan plan, bool names) => plan.Columns.Length > 0 && (names || plan.Positions.Length > 0);

        /// <summary>An upper bound on the part's Copy bytes: its cells, read in runs of neighbouring rows, and the rest.</summary>
        public long Estimate(TurnedPlan plan, bool headers, int eolBytes)
        {
            if (!Written(plan, headers)) return 0;
            var total = ResultTextWriter.EstimateTransposed(source.Set.Columns, plan.Columns, plan.Positions.Length, plan.Names, headers, eolBytes);
            for (var i = 0; i < plan.PageOf.Length;)
            {
                var last = i;
                while (last + 1 < plan.PageOf.Length && plan.PageOf[last + 1] == plan.PageOf[i] && plan.IndexOf[last + 1] == plan.IndexOf[last] + 1) last++;
                total += ResultTextWriter.EstimateCopyCells(access.Page(plan.PageOf[i], out _), plan.IndexOf[i], plan.IndexOf[last], plan.Columns);
                i = last + 1;
            }
            return total;
        }

        /// <summary>Writes a column's cells from row <paramref name="next"/> on, until a chunk is full or a step's cells
        /// are written; returns the row to go on from.</summary>
        public int Write(ResultTextWriter writer, TurnedPlan plan, int column, int next, ChunkedBuffer output)
        {
            var end = Math.Min(plan.Positions.Length, next + Step);
            for (; next < end && !output.HasFull; next++) writer.ColumnCell(access.Page(plan.PageOf[next], out _), plan.IndexOf[next], column);
            return next;
        }
    }

    public async Task<ResultsJobResult> CopyAsync(ResultsCopyArgs args, RequestContext? context)
    {
        if (args.ResultId == 0 || args.Parts is not { Length: >= 1 and <= MaxParts } || args.Parts.Any(part => part is null) || args.Eol is not ("crlf" or "lf")
            || args.MaxBytes is < 1 or > MaxCopyBytes || args.ViewId == 0 || !ValidTurn(args.Transposed, args.HeaderColumn))
            throw new RequestException("INVALID_PARAMS", "The copy request is invalid.");
        if (context is not { IsStream: true }) throw new RequestException("INVALID_REQUEST", "Copied text is sent as a stream with credit.");
        var set = Lease(args.ResultId);
        try
        {
            CheckHeaderColumn(set, args.HeaderColumn);
            // A windowed result's rows are read through its block cache (docs/bigquery.md, Copy): it has no stored pages.
            var remote = set.Remote;
            if (remote is not null && args.ViewId is not null) throw ViewGone();
            var source = remote is null ? SourceOf(set, args.ResultId, args.ViewId) : new Source(set, null);
            var available = remote?.Rows ?? source.Available;
            var partial = remote is null && (source.View is { } view ? !view.Complete : set.IsOpen);
            var plans = args.Parts.Select(part => Resolve(part, set.Columns, available)).ToList();
            var eolBytes = args.Eol == "crlf" ? 2 : 1;
            // Nothing is read of a windowed selection the limit refuses anyway: its rows' separators alone pass it.
            if (remote is not null && CopyFloor(plans, args.Transposed, eolBytes) is var floor && floor > args.MaxBytes) throw CopyTooLarge(floor, args.MaxBytes, exact: false);
            using var fetched = remote is not null && args.Transposed ? await TurnedRowsAsync(remote, set, plans, save: false, context.Token) : null;
            using var turner = args.Transposed ? new Turner(source, args.HeaderColumn, args.Headers, context.Token, fetched?.Pages) : null;
            var turned = turner is null ? [] : plans.Select(turner.Plan).ToList();
            // A windowed selection's text is measured as it is written (its rows are read once): past the limit, it stops
            // before the chunk that passes it is sent.
            var estimate = turner is not null ? turned.Sum(plan => turner.Estimate(plan, args.Headers, eolBytes)) : remote is null ? Estimate(source, plans, args.Headers, eolBytes) : 0;
            if (estimate > args.MaxBytes) throw CopyTooLarge(estimate, args.MaxBytes, exact: true);
            var output = new ChunkedBuffer();
            var writer = new ResultTextWriter(output, TextOptions.Copy(args.Headers, args.Eol == "crlf"), set.Columns);
            // Transposed, progress counts lines (source columns): no source row is finished before the last line.
            var total = turner is null ? plans.Sum(plan => plan.Rows.Sum(range => range.Last - range.First + 1)) : turned.Sum(plan => (long)plan.Columns.Length);
            var progress = new Progress(context, total, ProgressInterval);
            async Task Drain()
            {
                if (writer.Bytes > args.MaxBytes) throw CopyTooLarge(writer.Bytes, args.MaxBytes);
                while (output.TryTake(out var chunk)) await context.SendDataAsync(chunk);
                progress.Report(turner is null ? writer.Rows : writer.Columns, writer.Bytes);
            }
            writer.Begin();
            foreach (var plan in plans)
            {
                if (turner is not null) break;
                if (args.Headers) writer.Header(plan.Columns);
                foreach (var (first, last) in plan.Rows)
                {
                    if (remote is null) await WriteRowsAsync(source, writer, plan.Columns, first, last, Drain, context.Token);
                    else await ReadRemoteAsync(remote, set, first, last, context, (page, from, to) => { for (var row = from; row <= to; row++) writer.Row(page, row, plan.Columns); }, Drain);
                }
            }
            foreach (var plan in turned)
                if (Turner.Written(plan, args.Headers)) await WriteColumnsAsync(turner!, writer, plan, output, Drain, context.Token);
            writer.End();
            output.Seal();
            if (writer.Bytes > args.MaxBytes) throw CopyTooLarge(writer.Bytes, args.MaxBytes);
            while (output.TryTake(out var chunk)) await context.SendDataAsync(chunk);
            return turner is null ? new ResultsJobResult(writer.Rows, writer.Bytes, writer.TruncatedCells, partial)
                : new ResultsJobResult(turned.Sum(plan => (long)plan.Positions.Length), writer.Bytes, writer.TruncatedCells, partial, turned.Sum(plan => plan.Capped));
        }
        finally { set.ReleaseLease(); }
    }

    // `exact`: the selection's whole size is known (the estimate of rows in memory); otherwise `bytes` is only how far the
    // text got before it passed the limit.
    private static RequestException CopyTooLarge(long bytes, long limit, bool exact = false) =>
        new("TOO_LARGE", "The selection is too large to copy (" + (exact ? Size(bytes) : "more than " + Size(limit)) + "; the limit is " + Size(limit) + "). Use Save Results As instead.");

    private static RequestException ViewGone() => new("VIEW_NOT_FOUND", "This sorted view was closed. Sort the results again.");

    /// <summary>The least text a windowed selection writes: each row's field separators and line end (transposed, each line's),
    /// so a selection over the limit is refused before any of its rows are read.</summary>
    private static long CopyFloor(List<Plan> plans, bool transposed, int eolBytes)
    {
        long floor = 0;
        foreach (var plan in plans)
        {
            if (plan.Columns.Length == 0) continue;
            var rows = transposed ? plan.Rows.Sum(range => Math.Max(0, Math.Min(range.Last, ResultTextWriter.MaxTransposedRows - 1) - range.First + 1))
                : plan.Rows.Sum(range => range.Last - range.First + 1);
            // A line of n fields has n - 1 separators (a transposed line's name field may be off), and the last line no end.
            floor += transposed ? plan.Columns.Length * (rows - 1 + eolBytes) : rows * (plan.Columns.Length - 1 + eolBytes);
        }
        return Math.Max(0, floor - eolBytes);
    }

    /// <summary>Each job reads a windowed result's blocks as a viewer of its own, so its read-ahead runs in the direction it
    /// writes, apart from every grid's (the renderer's viewers are 31-bit) and other jobs'; it is forgotten when the job ends.</summary>
    private static int jobViewers;
    private static uint NextJobViewer() => 0x8000_0000u | ((uint)Interlocked.Increment(ref jobViewers) & 0x7FFF_FFFFu);

    /// <summary>How long one read of a windowed result's blocks waits before the job asks again (within its own deadline).</summary>
    internal TimeSpan RemoteWait { get; init; } = TimeSpan.FromSeconds(20);

    /// <summary>The most a transposed job of a windowed result holds of the rows it reads (it reads them whole first).</summary>
    internal const long MaxTurnedBytes = 2 * MaxCopyBytes;

    private delegate void RowsWriter(PageView page, int from, int to);

    /// <summary>Reads rows [first, last] of a windowed result through its block cache, a block at a time, handing each page
    /// (built for the read) to <paramref name="each"/>. A read that answers short asks again from where it stopped, within the
    /// request's deadline. The result released meanwhile is RESULT_RELEASED, and loaded into memory RESULT_OPEN: never a short
    /// copy that looks whole. The table gone is REMOTE_EXPIRED, and the engine maps its other failures.</summary>
    private async Task ReadRemotePagesAsync(RemoteResult remote, ResultSetBuffer set, long first, long last, CancellationToken token, Func<RemotePage, long, Task> each)
    {
        var viewer = NextJobViewer();
        try { await ReadRemotePagesAsync(remote, set, first, last, viewer, token, each); }
        finally { remote.Forget(viewer); }
    }

    private async Task ReadRemotePagesAsync(RemoteResult remote, ResultSetBuffer set, long first, long last, uint viewer, CancellationToken token, Func<RemotePage, long, Task> each)
    {
        for (var row = first; row <= last;)
        {
            var bodies = new List<RemotePage>();
            long next;
            try { next = await remote.ReadPagesAsync(row, (int)Math.Min(last - row + 1, remote.BlockRows), viewer, page => { bodies.Add(page); return ValueTask.CompletedTask; }, RemoteWait, token); }
            catch (RemoteExpiredException) { throw SqlService.Expired(); }
            catch (Exception error) when (error is not (RequestException or OperationCanceledException))
            {
                throw remote.Export?.Failure(error) ?? new RequestException("BACKEND_ERROR", "The rows could not be read.");
            }
            if (next <= row && remote.Disposed)
                throw set.IsReleased ? new RequestException("RESULT_RELEASED", "These results were closed. Execute the query again to see them.")
                    : new RequestException("RESULT_OPEN", "The result started loading into memory. Try again once it has loaded.");
            next = Math.Min(next, last + 1);
            foreach (var body in bodies) await each(body, next);
            row = Math.Max(row, next);
        }
    }

    /// <summary>Writes rows [first, last] of a windowed result, page by page, then <paramref name="drain"/>.</summary>
    private Task ReadRemoteAsync(RemoteResult remote, ResultSetBuffer set, long first, long last, RequestContext context, RowsWriter write, Func<Task> drain)
    {
        var scratch = new int[PageView.ScratchLength(set.Columns.Count)];
        var row = first;
        return ReadRemotePagesAsync(remote, set, first, last, context.Token, async (body, end) =>
        {
            Write(body, end);
            AfterPage?.Invoke();
            await drain();
        });

        void Write(RemotePage stored, long end)
        {
            var page = PageView.Parse(stored.Body, set.Columns.Count, scratch);
            var from = (int)(Math.Max(row, page.FirstRow) - page.FirstRow);
            var to = (int)(Math.Min(end, page.FirstRow + page.Rows) - 1 - page.FirstRow);
            if (from > to) return;
            write(page, from, to);
            row = page.FirstRow + to + 1;
        }
    }

    /// <summary>The rows a transposed job of a windowed result writes, read through its block cache into pages kept for the
    /// job (the first <see cref="ResultTextWriter.MaxTransposedRows"/> at most, from the first row asked).
    /// The pages are working memory reserved from the result's budget (the cache may evict its own copies meanwhile), given
    /// back when the job disposes them.</summary>
    private async Task<TurnedRows> TurnedRowsAsync(RemoteResult remote, ResultSetBuffer set, List<Plan> plans, bool save, CancellationToken token)
    {
        var ranges = plans.SelectMany(plan => plan.Rows).Where(range => range.First < ResultTextWriter.MaxTransposedRows).ToList();
        var rows = new TurnedRows(set);
        if (ranges.Count == 0) return rows;
        var first = ranges.Min(range => range.First);
        var last = Math.Min(ranges.Max(range => range.Last), ResultTextWriter.MaxTransposedRows - 1);
        var pages = new List<StoredPage>();
        try
        {
            await ReadRemotePagesAsync(remote, set, first, last, token, (page, _) =>
            {
                // A page that continues the rows kept: a later read answers from where an earlier one stopped, so it may repeat one.
                var end = pages.Count == 0 ? -1 : pages[^1].FirstRow + pages[^1].Rows;
                // One that overlaps the kept rows and runs past them (a block fetched again, cut differently) cannot be kept
                // without repeating rows, nor skipped without losing some.
                if (page.FirstRow < end && page.FirstRow + page.Rows > end)
                    throw new RequestException("BACKEND_ERROR", "The rows changed shape while they were read. Try again.");
                if (pages.Count == 0 || page.FirstRow >= end)
                {
                    if (rows.Reserved + page.Cost > MaxTurnedBytes)
                        throw save ? new RequestException("TOO_LARGE", "These rows are too large to save transposed (more than " + Size(MaxTurnedBytes) + "). Save them without Transpose instead.")
                            : CopyTooLarge(rows.Reserved + page.Cost, MaxTurnedBytes);
                    if (!set.TryReserveWork(page.Cost))
                        throw new RequestException("TOO_LARGE", "There is not enough result memory to turn these rows. Close other results to free memory, then try again.");
                    rows.Reserved += page.Cost;
                    pages.Add(new StoredPage(page.FirstRow, page.Rows, page.Body, page.Lengths));
                }
                return Task.CompletedTask;
            });
        }
        catch
        {
            rows.Dispose();
            throw;
        }
        rows.Pages = [.. pages];
        return rows;
    }

    /// <summary>A transposed windowed job's pages and the working memory reserved for them, given back on dispose.</summary>
    private sealed class TurnedRows(ResultSetBuffer set) : IDisposable
    {
        public StoredPage[] Pages { get; set; } = [];
        public long Reserved { get; set; }
        public void Dispose()
        {
            set.ReturnWork(Reserved);
            Reserved = 0;
        }
    }

    public async Task<ResultsJobResult> ExportAsync(ResultsExportArgs args, RequestContext? context)
    {
        var format = args.Format switch { "csv" => TextFormat.Csv, "tsv" => TextFormat.Tsv, "json" => TextFormat.Json, _ => (TextFormat?)null };
        if (args.ResultId == 0 || format is null || args.NullText is not ("empty" or "NULL") || !IsExportPath(args.Path)
            || args.TemporaryId is not { Length: 32 } || !Guid.TryParseExact(args.TemporaryId, "N", out _) || args.ViewId == 0 || !ValidTurn(args.Transposed, args.HeaderColumn))
            throw new RequestException("INVALID_PARAMS", "The export request is invalid.");
        var set = Lease(args.ResultId);
        string? temporary = null;
        try
        {
            CheckHeaderColumn(set, args.HeaderColumn);
            // A diff's rows are entries with their markers (SavedColumns): turned, they would make no sense as columns.
            if (args.Transposed && set.Kind == "diff") throw new RequestException("INVALID_PARAMS", "A comparison cannot be saved transposed.");
            if (!set.IsComplete) throw new RequestException("RESULT_OPEN", "Save the results after this result set finishes loading.");
            // A windowed result is saved from its remote table, every row its query keeps, never through the block cache or
            // the store (docs/bigquery.md, Save): the rows touch disk only in the file the user chose.
            var remote = set.Remote;
            if (remote is not null && args.ViewId is not null) throw ViewGone();
            var export = remote is null || args.Transposed ? null : remote.Export ?? throw SqlService.RemoteRefused();
            var source = remote is null ? SourceOf(set, args.ResultId, args.ViewId) : new Source(set, null);
            // A view sorted while rows were still arriving lacks the later ones; the grid sorts again once they are in.
            if (source.View is { Complete: false }) throw new RequestException("RESULT_OPEN", "Save the results after they are sorted again.");
            var token = context?.Token ?? CancellationToken.None;
            var available = remote?.Rows ?? source.Available;
            // Transposed, the rows a transposed grid draws (the first MaxTransposedRows), read through the cache first.
            using var fetched = remote is not null && args.Transposed
                ? await TurnedRowsAsync(remote, set, [new Plan(available > 0 ? [(0, available - 1)] : [], SavedColumns(set))], save: true, token) : null;
            var directory = Path.GetDirectoryName(args.Path);
            if (string.IsNullOrEmpty(directory) || !Directory.Exists(directory)) throw Failed("NOT_FOUND");
            if (Directory.Exists(args.Path)) throw Failed("IS_DIRECTORY");
            // Main chose the name, so it can remove the file if this process dies before the finally below runs.
            temporary = Path.Combine(directory, ".varia-" + args.TemporaryId + ".tmp");
            var output = new ChunkedBuffer();
            var writer = new ResultTextWriter(output, TextOptions.Export(format.Value, args.Headers, args.NullText), set.Columns);
            int[] all = SavedColumns(set);
            // A JSON object always names its column and its fields; a line without headers has only its rows' values.
            var named = args.Headers || format == TextFormat.Json;
            using var turner = args.Transposed ? new Turner(source, args.HeaderColumn, named, token, fetched?.Pages) : null;
            var turned = turner?.Plan(new Plan(available > 0 ? [(0, available - 1)] : [], all));
            var progress = new Progress(context, turned is null ? export?.Rows ?? available : all.Length, ProgressInterval);
            // A file the user chose to replace keeps its permissions: a private (0600) results file must not come back
            // readable by others. A symbolic link there is replaced, not followed; the file it points to may only narrow
            // the new file's default permissions.
            var target = new FileInfo(args.Path);
            var replacing = target.Exists && target.LinkTarget is null;
            var options = new FileStreamOptions { Mode = FileMode.CreateNew, Access = FileAccess.Write, Share = FileShare.None, BufferSize = 0, Options = FileOptions.Asynchronous };
            UnixFileMode? mode = null;
            if (replacing && !OperatingSystem.IsWindows())
            {
                // Created with them (never wider, as the umask only narrows), then set exactly.
                mode = target.UnixFileMode & PermissionBits;
                options.UnixCreateMode = mode;
            }
            else if (target.LinkTarget is not null && !OperatingSystem.IsWindows() && LinkedMode(target) is { } linked) options.UnixCreateMode = linked;
            // The target is touched only by the final rename, so a failure or cancel leaves it as it was.
            await using (var file = new FileStream(temporary, options))
            {
                if (mode is { } exact && !OperatingSystem.IsWindows()) File.SetUnixFileMode(file.SafeFileHandle, exact);
                async Task Drain()
                {
                    while (output.TryTake(out var chunk))
                    {
                        await file.WriteAsync(chunk, token);
                        if (chunk.Length == output.Size) output.Spare.Push(chunk);
                    }
                    progress.Report(turned is null ? writer.Rows : writer.Columns, writer.Bytes);
                }
                writer.Begin();
                if (turned is not null)
                {
                    if (Turner.Written(turned, named)) await WriteColumnsAsync(turner!, writer, turned, output, Drain, token);
                }
                else if (export is not null)
                {
                    writer.Header(all);
                    var scratch = new int[PageView.ScratchLength(set.Columns.Count)];
                    await export.ExportAsync(async page =>
                    {
                        token.ThrowIfCancellationRequested();
                        WriteAll(page);
                        AfterPage?.Invoke();
                        await Drain();
                    }, token);

                    void WriteAll(RemotePage stored)
                    {
                        var view = PageView.Parse(stored.Body, set.Columns.Count, scratch);
                        for (var row = 0; row < view.Rows; row++) writer.Row(view, row, all);
                    }
                }
                else
                {
                    writer.Header(all);
                    if (source.Available > 0) await WriteRowsAsync(source, writer, all, 0, source.Available - 1, Drain, token);
                }
                writer.End();
                output.Seal();
                await Drain();
                file.Flush(flushToDisk: true);
            }
            // On Windows, Replace keeps the replaced file's ACLs (where the user may set them) and attributes, which a move
            // over it would drop.
            if (replacing && OperatingSystem.IsWindows()) ReplaceFile(temporary, args.Path, Path.Combine(directory, ".varia-" + args.TemporaryId + ".bak"), File.Replace);
            else File.Move(temporary, args.Path, overwrite: true);
            temporary = null;
            return turned is null ? new ResultsJobResult(writer.Rows, writer.Bytes, writer.TruncatedCells, false)
                : new ResultsJobResult(turned.Positions.Length, writer.Bytes, writer.TruncatedCells, false, turned.Capped);
        }
        catch (Exception error) when (error is not (RequestException or OperationCanceledException)) { throw Failed(ExportToken(error)); }
        finally
        {
            if (temporary is not null) try { File.Delete(temporary); } catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
            set.ReleaseLease();
        }
    }

    /// <summary>Replaces <paramref name="path"/> with <paramref name="temporary"/>, keeping the replaced file at
    /// <paramref name="backup"/> until that succeeds. Without a backup name, ReplaceFile can fail after it removed the
    /// original (ERROR_UNABLE_TO_MOVE_REPLACEMENT, e.g. while antivirus holds the new file), leaving neither; with one, a
    /// failure leaves both names as they were, or the original at the backup name, and then the new file is moved into
    /// place, or failing that the original is put back. ACL merge errors are ignored: on a share that lets the user write
    /// but not set permissions (Change rather than Full Control), the new file takes the folder's, as a new file would,
    /// instead of the save failing.</summary>
    internal static void ReplaceFile(string temporary, string path, string backup, Action<string, string, string?, bool> replace)
    {
        try { replace(temporary, path, backup, true); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException && !File.Exists(path))
        {
            try { File.Move(temporary, path); }
            catch (Exception) when (File.Exists(backup) && !File.Exists(path))
            {
                File.Move(backup, path);
                throw;
            }
        }
        finally
        {
            // The backup is the only copy of the old file while the target is missing.
            if (File.Exists(path)) try { File.Delete(backup); } catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
        }
    }

    /// <summary>The mode for a new file that replaces a symbolic link: the permissions of the file it points to, within a
    /// new file's (the umask narrows them further); null for a link to nothing.</summary>
    private static UnixFileMode? LinkedMode(FileInfo link)
    {
        try { return link.ResolveLinkTarget(returnFinalTarget: true) is FileInfo { Exists: true } file ? file.UnixFileMode & NewFileBits : null; }
        catch (IOException) { return null; }
    }

    /// <summary>The one-word reason an export failed; never the exception's message, which names the path.</summary>
    public static string ExportToken(Exception error)
    {
        const int access = unchecked((int)0x80070005), sharing = unchecked((int)0x80070020), locked = unchecked((int)0x80070021);
        // ERROR_UNABLE_TO_REMOVE_REPLACED: ReplaceFile could not remove the old file, which another program holds.
        const int replacedHeld = unchecked((int)0x80070497);
        const int diskFull = unchecked((int)0x80070070), handleDiskFull = unchecked((int)0x80070027), noSpace = 28;
        return error switch
        {
            UnauthorizedAccessException => "ACCESS",
            DirectoryNotFoundException => "NOT_FOUND",
            IOException { HResult: access } => "ACCESS",
            IOException { HResult: sharing or locked or replacedHeld } => "IN_USE",
            IOException { HResult: diskFull or handleDiskFull } => "DISK_FULL",
            // On Linux and macOS an IOException's HResult is the errno.
            IOException { HResult: noSpace } when !OperatingSystem.IsWindows() => "DISK_FULL",
            _ => "IO"
        };
    }

    private static RequestException Failed(string token) => new("EXPORT_FAILED", token);

    /// <summary>A full path from a save dialog: rooted, with no NUL and no device or extended-length prefix.</summary>
    public static bool IsExportPath(string? path) =>
        path is { Length: >= 1 and <= MaxPathCharacters } && !path.Contains('\0') && Path.IsPathFullyQualified(path)
        && !path.StartsWith(@"\\.\", StringComparison.Ordinal) && !path.StartsWith(@"\\?\", StringComparison.Ordinal)
        && !path.StartsWith("//./", StringComparison.Ordinal) && !path.StartsWith("//?/", StringComparison.Ordinal);

    /// <summary>The columns Save writes: the visible ones, and for a diff its marker and row numbers first ("Change", "Old row",
    /// "New row"), and in the one-row layout each data column followed by its previous-value column ("&lt;name&gt; (old)"),
    /// decided here from the result's kind so that no renderer flag or dialog choice is needed. Copy never writes them
    /// (<see cref="Resolve"/>).</summary>
    internal static int[] SavedColumns(ResultSetBuffer set)
    {
        var columns = set.Columns;
        IEnumerable<int> visible = Enumerable.Range(0, columns.Count).Where(column => !ResultTextWriter.Hidden(columns[column]));
        if (set.Kind != "diff") return [.. visible];
        int Role(string role) => Enumerable.Range(0, columns.Count).First(column => columns[column].Role == role);
        // A data column's pair is its index (the data columns come first, in pair order).
        var old = new Dictionary<int, int>();
        for (var c = 0; c < columns.Count; c++) if (columns[c] is { Role: "old", Of: { } of }) old[of] = c;
        return [Role("mark"), Role("leftRow"), Role("rightRow"), .. visible.SelectMany(column => old.TryGetValue(column, out var previous) ? new[] { column, previous } : [column])];
    }

    /// <summary>The changed pairs of a one-row comparison's stored row, for Save's previous values: none unless the row is
    /// changed; a cut row's from its full list in the change index, another's from the cells its tone lists (soft ones are
    /// not changed). <paramref name="changed"/> has one entry a pair and is filled here.</summary>
    internal static void ChangedPairs(DiffIndex index, in PageView page, int at, int storedRow, int toneColumn, Span<bool> changed)
    {
        changed.Clear();
        if (storedRow >= index.Rows || index.KindOf(storedRow) != DiffRowKind.Changed) return;
        if (index.IsCut(storedRow) && index.ChangedPairs(storedRow) is { IsEmpty: false } bits)
        {
            for (var p = 0; p < changed.Length; p++) changed[p] = (bits[p / 64] & (1UL << (p % 64))) != 0;
            return;
        }
        if (page.IsNull(toneColumn, at)) return;
        foreach (var (first, last) in DiffIndex.ListedCells(System.Text.Encoding.UTF8.GetString(page.Span(toneColumn, at))))
            for (var p = first; p <= last && p < changed.Length; p++) changed[p] = true;
    }

    /// <summary>A header column names a transposed job's fields, so only such a job has one.</summary>
    private static bool ValidTurn(bool transposed, int? headerColumn) => headerColumn is null || transposed && headerColumn is >= 0 and < PageBuilder.MaxColumns;

    private static void CheckHeaderColumn(ResultSetBuffer set, int? headerColumn)
    {
        if (headerColumn is { } header && (header >= set.Columns.Count || ResultTextWriter.Hidden(set.Columns[header])))
            throw new RequestException("INVALID_PARAMS", "The header column must be a column of the result.");
    }

    private ResultSetBuffer Lease(uint resultId)
    {
        var set = store.Find(resultId);
        // A windowed result is leased too: Copy reads it through its block cache and Save from its remote table
        // (docs/bigquery.md, Copy). One that switches residence under a job is refused by the reader it uses.
        if (set is not null && set.TryLease()) return set;
        throw store.WasReleased(resultId)
            ? new RequestException("RESULT_RELEASED", "These results were closed. Execute the query again to see them.")
            : new RequestException("RESULT_NOT_FOUND", "These results do not exist.");
    }

    /// <summary>The result itself, or its view: a view that was closed or replaced is VIEW_NOT_FOUND.</summary>
    private Source SourceOf(ResultSetBuffer set, uint resultId, uint? viewId) =>
        new(set, viewId is { } id ? store.FindView(resultId, id) ?? throw new RequestException("VIEW_NOT_FOUND", "This sorted view was closed. Sort the results again.") : null);

    /// <summary>Validates a part (1 to 64 ascending, disjoint ranges of each kind) and clamps its rows to the rows stored
    /// now: open-ended blocks end at the last available row. Hidden columns (a tone, a diff's suffix) are left out.</summary>
    private static Plan Resolve(CopyPartArgs part, IReadOnlyList<ResultColumn> columnList, long available)
    {
        static bool Valid<T>(T[][]? ranges, long max) where T : struct, IConvertible
        {
            if (ranges is not { Length: >= 1 and <= MaxRanges }) return false;
            long previous = -1;
            foreach (var range in ranges)
            {
                if (range is not { Length: 2 }) return false;
                var first = range[0].ToInt64(CultureInfo.InvariantCulture);
                var last = range[1].ToInt64(CultureInfo.InvariantCulture);
                if (first <= previous || first > last || last > max) return false;
                previous = last;
            }
            return true;
        }
        if (!Valid(part.Rows, MaxSafeInteger) || !Valid(part.Columns, columnList.Count - 1)) throw new RequestException("INVALID_PARAMS", "The copy request is invalid.");
        var rows = part.Rows.Where(range => range[0] < available).Select(range => (range[0], Math.Min(range[1], available - 1))).ToList();
        var columns = part.Columns.SelectMany(range => Enumerable.Range(range[0], range[1] - range[0] + 1)).Where(column => !ResultTextWriter.Hidden(columnList[column])).ToArray();
        return new Plan(rows, columns);
    }

    /// <summary>Copy's size estimate for parts of a set (the checks compare it with the text written).</summary>
    internal static long EstimateCopy(ResultSetBuffer set, CopyPartArgs[] parts, bool headers, bool crlf, bool transposed = false, int? headerColumn = null, ResultView? view = null)
    {
        using var pin = set.Pin();
        var source = new Source(set, view);
        var available = source.Available;
        var plans = parts.Select(part => Resolve(part, set.Columns, available)).ToList();
        if (!transposed) return Estimate(source, plans, headers, crlf ? 2 : 1);
        using var turner = new Turner(source, headerColumn, headers);
        return plans.Sum(plan => turner.Estimate(turner.Plan(plan), headers, crlf ? 2 : 1));
    }

    private static long Estimate(Source source, List<Plan> plans, bool headers, int eolBytes)
    {
        long total = 0;
        var set = source.Set;
        var scratch = new int[PageView.ScratchLength(set.Columns.Count)];
        using var room = new ReadRoom(set);
        foreach (var plan in plans)
        {
            if (headers) total += ResultTextWriter.EstimateHeader(set.Columns, plan.Columns, eolBytes);
            foreach (var (first, last) in plan.Rows)
                foreach (var page in Pages(source, first, last))
                {
                    var (from, to) = Within(page, first, last);
                    total += ResultTextWriter.EstimateCopyRows(PageView.Parse(room.Body(page), set.Columns.Count, scratch), from, to, plan.Columns, eolBytes);
                }
        }
        return total;
    }

    /// <summary>The pages holding rows [first, last], fetched a bounded batch at a time; a view's are built in its order.</summary>
    private static IEnumerable<StoredPage> Pages(Source source, long first, long last)
    {
        if (source.View is { } view)
        {
            foreach (var page in ViewPages.Stored(view, first, (int)Math.Min(last - first + 1, int.MaxValue))) yield return page;
            yield break;
        }
        var set = source.Set;
        using var pin = set.Pin();
        for (var row = first; row <= last;)
        {
            var pages = set.PagesFor(row, (int)Math.Min(last - row + 1, 1 << 24));
            // A set switched to windowed under the copy has no pages left: refused, never a short copy that looks whole.
            if (pages.Count == 0) { if (set.IsRemote) throw SqlService.RemoteRefused(); yield break; }
            foreach (var page in pages)
            {
                yield return page;
                row = page.FirstRow + page.Rows;
            }
        }
    }

    private static (int From, int To) Within(StoredPage page, long first, long last) =>
        ((int)(Math.Max(first, page.FirstRow) - page.FirstRow), (int)(Math.Min(last, page.FirstRow + page.Rows - 1) - page.FirstRow));

    /// <summary>Writes rows [first, last] page by page; after each page the token is checked and <paramref name="drain"/>
    /// sends or writes what is ready.</summary>
    private async Task WriteRowsAsync(Source source, ResultTextWriter writer, int[] columns, long first, long last, Func<Task> drain, CancellationToken token)
    {
        var set = source.Set;
        var scratch = new int[PageView.ScratchLength(set.Columns.Count)];
        using var room = new ReadRoom(set);
        // A one-row comparison's Save writes each changed cell's previous value, and only those: its changed pairs come from
        // the tone and, for a cut row, the change index. Copy never selects previous-value columns.
        var index = set.Kind == "diff" && columns.Any(column => set.Columns[column].Role == "old") ? set.DiffIndex : null;
        var changed = index is null ? null : new bool[set.Columns.Count(column => column.Role == "old")];
        foreach (var page in Pages(source, first, last))
        {
            token.ThrowIfCancellationRequested();
            var (from, to) = Within(page, first, last);
            var view = PageView.Parse(room.Body(page), set.Columns.Count, scratch);
            for (var row = from; row <= to; row++)
            {
                if (index is null) { writer.Row(view, row, columns); continue; }
                var position = page.FirstRow + row;
                ChangedPairs(index, view, row, (int)(source.View is { } sorted ? sorted.Order[position] : position), set.Columns.Count - 1, changed);
                writer.Row(view, row, columns, changed);
            }
            AfterPage?.Invoke();
            await drain();
        }
    }

    /// <summary>Writes a transposed part: the line that names its fields, then a line per column. Within a line the token is
    /// checked every step and <paramref name="drain"/> runs whenever a chunk is ready, so one long line is never held whole.</summary>
    private async Task WriteColumnsAsync(Turner turner, ResultTextWriter writer, TurnedPlan plan, ChunkedBuffer output, Func<Task> drain, CancellationToken token)
    {
        writer.TransposedHeader(plan.Names);
        foreach (var column in plan.Columns)
        {
            token.ThrowIfCancellationRequested();
            writer.BeginColumn(column);
            for (var next = 0; next < plan.Positions.Length;)
            {
                next = turner.Write(writer, plan, column, next, output);
                token.ThrowIfCancellationRequested();
                if (output.HasFull) await drain();
            }
            writer.EndColumn();
            AfterPage?.Invoke();
            await drain();
        }
    }

    private static string Size(long bytes) => bytes >= 1024 * 1024
        ? Math.Ceiling(bytes / (1024.0 * 1024)).ToString("N0", CultureInfo.InvariantCulture) + " MB"
        : bytes.ToString("N0", CultureInfo.InvariantCulture) + " bytes";

    /// <summary>job.progress EVENTs, droppable, at most every 250 ms.</summary>
    private sealed class Progress(RequestContext? context, long total, TimeSpan interval)
    {
        private readonly Stopwatch since = Stopwatch.StartNew();

        public void Report(long rows, long bytes)
        {
            if (context is null || since.Elapsed < interval) return;
            since.Restart();
            context.SendEvent(new { Type = "job.progress", RowsDone = rows, RowsTotal = total, Bytes = bytes }, true);
        }
    }
}
