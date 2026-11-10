using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Varia.Updater;

/// <summary>
/// The file work of a staged update (docs/updates.md). Stage unpacks a release beside the installation while Varia
/// runs: <c>&lt;root&gt;/app</c>, then <c>staged.json</c> once it is whole. Swap, after Varia has closed, moves the
/// installation to <c>&lt;root&gt;/old</c> and the staged folder into its place, or puts the installation back.
/// </summary>
public static class UpdateFiles
{
    /// <summary>Bounds on what an archive may unpack to; the manifest already bounds the archive itself (1 GiB).</summary>
    public const long MaxUnpackedBytes = 8L << 30;
    public const int MaxEntries = 200_000;

    public static string AppDir(string root) => Path.Combine(root, "app");
    public static string OldDir(string root) => Path.Combine(root, "old");
    public static string StagedMarker(string root) => Path.Combine(root, "staged.json");
    public static string FailedMarker(string root) => Path.Combine(root, "failed.json");
    public static string Journal(string root) => Path.Combine(root, "swap.json");

    /// <summary>What a swap is doing, written before its first rename so that one cut short can be finished.</summary>
    public sealed record SwapJournal(string InstallDir, string Exe, string Version, string? From, int Attempts = 0);
    public enum Recovery { Nothing, Completed, RolledBack }

    /// <summary>
    /// Whether <paramref name="root"/> is the one folder main stages in for this installation: beside it, on its
    /// volume, named after it (<c>.&lt;name&gt;.update</c>). An installation at a drive's root has none.
    /// </summary>
    public static bool IsStagingRoot(string root, string installDir)
    {
        var install = Path.TrimEndingDirectorySeparator(Path.GetFullPath(installDir));
        var parent = Path.GetDirectoryName(install);
        var name = Path.GetFileName(install);
        if (string.IsNullOrEmpty(parent) || string.IsNullOrEmpty(name)) return false;
        return string.Equals(Path.TrimEndingDirectorySeparator(Path.GetFullPath(root)), Path.Combine(parent, $".{name}.update"), OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal);
    }

    /// <summary>
    /// Checks the archive against its SHA-512 once more, with the file held so that it cannot change in between, and
    /// unpacks it. What Setup adds to an installation and the archive does not carry (its uninstaller, the elevation
    /// helper) comes from the installation. Nothing is unpacked over what an earlier stage left and could not remove.
    /// </summary>
    public static void Stage(string archive, string sha512, string root, string installDir, string exe, string version)
    {
        Directory.CreateDirectory(root);
        var app = AppDir(root);
        var temp = Path.Combine(root, "app.tmp");
        File.Delete(StagedMarker(root));
        if (!DeleteTree(app) || !DeleteTree(temp)) throw new IOException("An earlier staged release is in use.");
        try
        {
            using (var stream = new FileStream(archive, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                var hash = SHA512.HashData(stream);
                if (!CryptographicOperations.FixedTimeEquals(hash, Convert.FromBase64String(sha512))) throw new InvalidDataException("The archive does not match its checksum.");
                stream.Position = 0;
                Unpack(stream, temp);
            }
            if (!File.Exists(Path.Combine(temp, exe))) throw new InvalidDataException("The archive does not hold the application.");
            foreach (var name in new[] { $"Uninstall {exe}", "uninstallerIcon.ico", Path.Combine("resources", "elevate.exe") })
            {
                var source = Path.Combine(installDir, name);
                var target = Path.Combine(temp, name);
                if (!File.Exists(source) || !Directory.Exists(Path.GetDirectoryName(target))) continue;
                File.Copy(source, target, overwrite: true);
            }
            Directory.Move(temp, app);
            WriteMarker(StagedMarker(root), version, sha512);
        }
        catch
        {
            DeleteTree(temp);
            DeleteTree(app);
            throw;
        }
    }

    /// <summary>Unpacks every entry under <paramref name="destination"/>, refusing one that would land outside it.</summary>
    public static void Unpack(Stream archive, string destination)
    {
        var rootPath = Path.TrimEndingDirectorySeparator(Path.GetFullPath(destination));
        var prefix = rootPath + Path.DirectorySeparatorChar;
        Directory.CreateDirectory(rootPath);
        using var zip = new ZipArchive(archive, ZipArchiveMode.Read, leaveOpen: true);
        if (zip.Entries.Count > MaxEntries) throw new InvalidDataException("The archive holds too many files.");
        long total = 0;
        var buffer = new byte[1 << 16];
        foreach (var entry in zip.Entries)
        {
            var target = Path.GetFullPath(Path.Combine(rootPath, entry.FullName));
            if (!target.StartsWith(prefix, StringComparison.Ordinal)) throw new InvalidDataException("The archive names a file outside its folder.");
            if (entry.FullName.EndsWith('/') || entry.FullName.EndsWith('\\'))
            {
                Directory.CreateDirectory(target);
                continue;
            }
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            using var input = entry.Open();
            using var output = new FileStream(target, FileMode.CreateNew, FileAccess.Write, FileShare.None);
            // Counted as it is written: an entry's declared length is the archive's word, not a bound.
            for (int read; (read = input.Read(buffer)) > 0;)
            {
                total += read;
                if (total > MaxUnpackedBytes) throw new InvalidDataException("The archive unpacks to too much.");
                output.Write(buffer, 0, read);
            }
        }
    }

    /// <summary>
    /// Moves the installation aside and the staged release into its place. A folder with a file still in use cannot be
    /// renamed, so the first move is tried again until <paramref name="patience"/> is spent (asking
    /// <paramref name="stragglers"/> to end what holds it, once, half way). The second move, and the move back when
    /// it fails, are each tried for a quarter as long. Throws with the installation as it was, unless the move back
    /// failed too: then there is no installation, which the caller sees and leaves to the journal. A swap that goes
    /// through removes an earlier one's failure marker.
    /// </summary>
    public static void Swap(string root, string installDir, string exe, TimeSpan patience, Action? stragglers = null, Action<TimeSpan>? wait = null, Func<long>? milliseconds = null)
    {
        milliseconds ??= () => Environment.TickCount64;
        var app = AppDir(root);
        var old = OldDir(root);
        if (!File.Exists(Path.Combine(app, exe))) throw new InvalidDataException("No staged release.");
        // Waiting would not help: the installation cannot be moved onto what an earlier swap left.
        if (!DeleteTree(old)) throw new IOException("The version an earlier update replaced is still in use.");
        var started = milliseconds();
        var asked = false;
        for (;;)
        {
            try { Directory.Move(installDir, old); break; }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException)
            {
                var spent = TimeSpan.FromMilliseconds(milliseconds() - started);
                if (spent >= patience) throw;
                if (!asked && spent >= patience / 2) { asked = true; stragglers?.Invoke(); }
                (wait ?? Thread.Sleep)(TimeSpan.FromMilliseconds(200));
            }
        }
        try { Move(app, installDir, patience / 4, wait, milliseconds); }
        catch
        {
            Move(old, installDir, patience / 4, wait, milliseconds);
            throw;
        }
        Remove(StagedMarker(root));
        Remove(FailedMarker(root));
    }

    /// <summary>A rename, tried again while a file in the folder is in use (a scanner reading what was just written).</summary>
    private static void Move(string from, string to, TimeSpan patience, Action<TimeSpan>? wait, Func<long>? milliseconds)
    {
        milliseconds ??= () => Environment.TickCount64;
        var started = milliseconds();
        for (;;)
        {
            try { Directory.Move(from, to); return; }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException)
            {
                if (TimeSpan.FromMilliseconds(milliseconds() - started) >= patience) throw;
                (wait ?? Thread.Sleep)(TimeSpan.FromMilliseconds(200));
            }
        }
    }

    /// <summary>Tidying that must not turn a finished swap into a failed one.</summary>
    private static void Remove(string file)
    {
        try { File.Delete(file); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
    }

    /// <summary>
    /// Finishes a swap that was cut short (the power went, the helper was ended), from where the folders are: with the
    /// installation moved aside, the staged release goes into its place, or the old version goes back when the staged
    /// one is not whole; with both renames done, only the tidying is left. Anything else was never started.
    /// </summary>
    public static Recovery Recover(string root, string installDir, string exe, TimeSpan patience = default, Action<TimeSpan>? wait = null, Func<long>? milliseconds = null)
    {
        var app = AppDir(root);
        var old = OldDir(root);
        if (Directory.Exists(installDir))
        {
            if (!Directory.Exists(old) || Directory.Exists(app)) return Recovery.Nothing;
        }
        else if (File.Exists(Path.Combine(app, exe))) Move(app, installDir, patience, wait, milliseconds);
        else if (Directory.Exists(old))
        {
            Move(old, installDir, patience, wait, milliseconds);
            DeleteTree(app);
            Remove(StagedMarker(root));
            return Recovery.RolledBack;
        }
        else return Recovery.Nothing;
        Remove(StagedMarker(root));
        Remove(FailedMarker(root));
        return Recovery.Completed;
    }

    public static void WriteJournal(string root, SwapJournal journal)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartObject();
            writer.WriteString("installDir", journal.InstallDir);
            writer.WriteString("exe", journal.Exe);
            writer.WriteString("version", journal.Version);
            if (journal.From is not null) writer.WriteString("from", journal.From);
            if (journal.Attempts > 0) writer.WriteNumber("attempts", journal.Attempts);
            writer.WriteEndObject();
        }
        // On the disk before the first rename: the journal is there for a power failure, which a write still in the
        // system's cache would not survive.
        var path = Journal(root);
        using (var file = new FileStream(path + ".tmp", FileMode.Create, FileAccess.Write, FileShare.None))
        {
            file.Write(stream.ToArray());
            file.Flush(flushToDisk: true);
        }
        File.Move(path + ".tmp", path, overwrite: true);
    }

    /// <summary>The journal a swap left, or null when there is none or it is not one.</summary>
    public static SwapJournal? ReadJournal(string root)
    {
        var path = Journal(root);
        try
        {
            if (!File.Exists(path) || new FileInfo(path).Length > 8192) return null;
            using var document = JsonDocument.Parse(File.ReadAllBytes(path));
            string? Text(string name) => document.RootElement.ValueKind == JsonValueKind.Object && document.RootElement.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
            var attempts = document.RootElement.ValueKind == JsonValueKind.Object && document.RootElement.TryGetProperty("attempts", out var count) && count.TryGetInt32(out var number) && number > 0 ? number : 0;
            return Text("installDir") is { Length: > 0 } installDir && Text("exe") is { Length: > 0 } exe && Text("version") is { Length: > 0 } version ? new SwapJournal(installDir, exe, version, Text("from"), attempts) : null;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException or InvalidOperationException) { return null; }
    }

    public static void WriteMarker(string path, string version, string? sha512 = null)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartObject();
            writer.WriteString("version", version);
            if (sha512 is not null) writer.WriteString("sha512", sha512);
            writer.WriteEndObject();
        }
        // Written whole or not at all: main reads it to decide that a release is staged.
        var temp = path + ".tmp";
        File.WriteAllBytes(temp, stream.ToArray());
        File.Move(temp, path, overwrite: true);
    }

    /// <summary>Removes a folder and what it holds; a file still in use is tried a few times, then left.</summary>
    public static bool DeleteTree(string path, int attempts = 1, Action<TimeSpan>? wait = null)
    {
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                if (Directory.Exists(path)) Directory.Delete(path, recursive: true);
                return true;
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException)
            {
                if (attempt >= attempts) return false;
                (wait ?? Thread.Sleep)(TimeSpan.FromMilliseconds(500));
            }
        }
    }

    /// <summary>One line per step in <c>&lt;root&gt;/update.log</c> (kept small), for when an update did not take.</summary>
    public static void Log(string root, string line)
    {
        try
        {
            var path = Path.Combine(root, "update.log");
            if (File.Exists(path) && new FileInfo(path).Length > 64 * 1024) File.Delete(path);
            File.AppendAllText(path, $"{DateTime.UtcNow:O} {line}{Environment.NewLine}", Encoding.UTF8);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
    }
}
