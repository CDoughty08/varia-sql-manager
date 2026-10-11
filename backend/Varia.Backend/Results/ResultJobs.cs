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
}

/// <summary>results.copy and results.export: the text of a stored result, formatted by <see cref="ResultTextWriter"/>
/// and either streamed to main as DATA (copy, which main puts on the clipboard) or written to the file main's save
/// dialog chose (export). Both lease the result, so a release while they run takes effect when they end.</summary>
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
    private static readonly TimeSpan ProgressInterval = TimeSpan.FromMilliseconds(250);

    /// <summary>Called after each page is written: the checks release or cancel mid-job through it.</summary>
    internal Action? AfterPage { get; init; }

    /// <summary>A part with its rows clamped to what is stored and its column ranges expanded to indexes.</summary>
    private sealed record Plan(List<(long First, long Last)> Rows, int[] Columns);

    public async Task<ResultsJobResult> CopyAsync(ResultsCopyArgs args, RequestContext? context)
    {
        if (args.ResultId == 0 || args.Parts is not { Length: >= 1 and <= MaxParts } || args.Parts.Any(part => part is null) || args.Eol is not ("crlf" or "lf")
            || args.MaxBytes is < 1 or > MaxCopyBytes)
            throw new RequestException("INVALID_PARAMS", "The copy request is invalid.");
        if (context is not { IsStream: true }) throw new RequestException("INVALID_REQUEST", "Copied text is sent as a stream with credit.");
        var set = Lease(args.ResultId);
        try
        {
            var available = set.RowsAvailable;
            var partial = set.IsOpen;
            var plans = args.Parts.Select(part => Resolve(part, set.Columns.Count, available)).ToList();
            var eolBytes = args.Eol == "crlf" ? 2 : 1;
            var estimate = Estimate(set, plans, args.Headers, eolBytes);
            if (estimate > args.MaxBytes)
                throw new RequestException("TOO_LARGE", "The selection is too large to copy (" + Size(estimate) + "; the limit is " + Size(args.MaxBytes) + "). Use Save Results As instead.");
            var output = new ChunkedBuffer();
            var writer = new ResultTextWriter(output, TextOptions.Copy(args.Headers, args.Eol == "crlf"), set.Columns);
            var total = plans.Sum(plan => plan.Rows.Sum(range => range.Last - range.First + 1));
            var progress = new Progress(context, total);
            writer.Begin();
            foreach (var plan in plans)
            {
                if (args.Headers) writer.Header(plan.Columns);
                foreach (var (first, last) in plan.Rows)
                    await WriteRowsAsync(set, writer, plan.Columns, first, last, async () =>
                    {
                        while (output.TryTake(out var chunk)) await context.SendDataAsync(chunk);
                        progress.Report(writer.Rows, writer.Bytes);
                    }, context.Token);
            }
            writer.End();
            output.Seal();
            while (output.TryTake(out var chunk)) await context.SendDataAsync(chunk);
            return new ResultsJobResult(writer.Rows, writer.Bytes, writer.TruncatedCells, partial);
        }
        finally { set.ReleaseLease(); }
    }

    public async Task<ResultsJobResult> ExportAsync(ResultsExportArgs args, RequestContext? context)
    {
        var format = args.Format switch { "csv" => TextFormat.Csv, "tsv" => TextFormat.Tsv, "json" => TextFormat.Json, _ => (TextFormat?)null };
        if (args.ResultId == 0 || format is null || args.NullText is not ("empty" or "NULL") || !IsExportPath(args.Path)
            || args.TemporaryId is not { Length: 32 } || !Guid.TryParseExact(args.TemporaryId, "N", out _))
            throw new RequestException("INVALID_PARAMS", "The export request is invalid.");
        var set = Lease(args.ResultId);
        string? temporary = null;
        try
        {
            if (!set.IsComplete) throw new RequestException("RESULT_OPEN", "Save the results after this result set finishes loading.");
            var token = context?.Token ?? CancellationToken.None;
            var directory = Path.GetDirectoryName(args.Path);
            if (string.IsNullOrEmpty(directory) || !Directory.Exists(directory)) throw Failed("NOT_FOUND");
            if (Directory.Exists(args.Path)) throw Failed("IS_DIRECTORY");
            // Main chose the name, so it can remove the file if this process dies before the finally below runs.
            temporary = Path.Combine(directory, ".varia-" + args.TemporaryId + ".tmp");
            var output = new ChunkedBuffer();
            var writer = new ResultTextWriter(output, TextOptions.Export(format.Value, args.Headers, args.NullText), set.Columns);
            var progress = new Progress(context, set.RowsAvailable);
            int[] all = [.. Enumerable.Range(0, set.Columns.Count)];
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
                    progress.Report(writer.Rows, writer.Bytes);
                }
                writer.Begin();
                writer.Header(all);
                if (set.RowsAvailable > 0) await WriteRowsAsync(set, writer, all, 0, set.RowsAvailable - 1, Drain, token);
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
            return new ResultsJobResult(writer.Rows, writer.Bytes, writer.TruncatedCells, false);
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

    private ResultSetBuffer Lease(uint resultId)
    {
        var set = store.Find(resultId);
        if (set is not null && set.TryLease()) return set;
        throw store.WasReleased(resultId)
            ? new RequestException("RESULT_RELEASED", "These results were closed. Execute the query again to see them.")
            : new RequestException("RESULT_NOT_FOUND", "These results do not exist.");
    }

    /// <summary>Validates a part (1 to 64 ascending, disjoint ranges of each kind) and clamps its rows to the rows stored
    /// now: open-ended blocks end at the last available row.</summary>
    private static Plan Resolve(CopyPartArgs part, int columnCount, long available)
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
        if (!Valid(part.Rows, MaxSafeInteger) || !Valid(part.Columns, columnCount - 1)) throw new RequestException("INVALID_PARAMS", "The copy request is invalid.");
        var rows = part.Rows.Where(range => range[0] < available).Select(range => (range[0], Math.Min(range[1], available - 1))).ToList();
        var columns = part.Columns.SelectMany(range => Enumerable.Range(range[0], range[1] - range[0] + 1)).ToArray();
        return new Plan(rows, columns);
    }

    /// <summary>Copy's size estimate for parts of a set (the checks compare it with the text written).</summary>
    internal static long EstimateCopy(ResultSetBuffer set, CopyPartArgs[] parts, bool headers, bool crlf)
    {
        var available = set.RowsAvailable;
        return Estimate(set, [.. parts.Select(part => Resolve(part, set.Columns.Count, available))], headers, crlf ? 2 : 1);
    }

    private static long Estimate(ResultSetBuffer set, List<Plan> plans, bool headers, int eolBytes)
    {
        long total = 0;
        var scratch = new int[PageView.ScratchLength(set.Columns.Count)];
        foreach (var plan in plans)
        {
            if (headers) total += ResultTextWriter.EstimateHeader(set.Columns, plan.Columns, eolBytes);
            foreach (var (first, last) in plan.Rows)
                foreach (var page in Pages(set, first, last))
                {
                    var (from, to) = Within(page, first, last);
                    total += EstimatePage(page, from, to, plan.Columns, eolBytes, scratch, set.Columns.Count);
                }
        }
        return total;
    }

    private static long EstimatePage(StoredPage page, int from, int to, int[] columns, int eolBytes, int[] scratch, int columnCount) =>
        ResultTextWriter.EstimateCopyRows(PageView.Parse(page.Body, columnCount, scratch), from, to, columns, eolBytes);

    /// <summary>The pages holding rows [first, last], fetched a bounded batch at a time.</summary>
    private static IEnumerable<StoredPage> Pages(ResultSetBuffer set, long first, long last)
    {
        for (var row = first; row <= last;)
        {
            var pages = set.PagesFor(row, (int)Math.Min(last - row + 1, 1 << 24));
            if (pages.Count == 0) yield break;
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
    private async Task WriteRowsAsync(ResultSetBuffer set, ResultTextWriter writer, int[] columns, long first, long last, Func<Task> drain, CancellationToken token)
    {
        var scratch = new int[PageView.ScratchLength(set.Columns.Count)];
        foreach (var page in Pages(set, first, last))
        {
            token.ThrowIfCancellationRequested();
            var (from, to) = Within(page, first, last);
            WritePage(page, set.Columns.Count, writer, columns, from, to, scratch);
            AfterPage?.Invoke();
            await drain();
        }
    }

    private static void WritePage(StoredPage page, int columnCount, ResultTextWriter writer, int[] columns, int from, int to, int[] scratch)
    {
        var view = PageView.Parse(page.Body, columnCount, scratch);
        for (var row = from; row <= to; row++) writer.Row(view, row, columns);
    }

    private static string Size(long bytes) => bytes >= 1024 * 1024
        ? Math.Ceiling(bytes / (1024.0 * 1024)).ToString("N0", CultureInfo.InvariantCulture) + " MB"
        : bytes.ToString("N0", CultureInfo.InvariantCulture) + " bytes";

    /// <summary>job.progress EVENTs, droppable, at most every 250 ms.</summary>
    private sealed class Progress(RequestContext? context, long total)
    {
        private readonly Stopwatch since = Stopwatch.StartNew();

        public void Report(long rows, long bytes)
        {
            if (context is null || since.Elapsed < ProgressInterval) return;
            since.Restart();
            context.SendEvent(new { Type = "job.progress", RowsDone = rows, RowsTotal = total, Bytes = bytes }, true);
        }
    }
}
