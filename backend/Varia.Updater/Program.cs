using System.Diagnostics;
using System.Runtime.Versioning;
using System.Text.RegularExpressions;
using Microsoft.Win32;

namespace Varia.Updater;

/// <summary>
/// Varia SQL Manager's update helper for the installed Windows build (src/main/update-staging.ts starts it):
/// <c>stage</c> runs from the installation while Varia is open; <c>swap</c> runs as a copy beside the staged release,
/// after Restart to Update, and outlives the app; <c>recover</c> is that copy again at the next sign-in, when a swap was
/// cut short; <c>check</c> answers main whether a release is staged, and <c>forget</c> ends a recovery that is no
/// longer wanted. It takes paths only from main (or the journal its own swap wrote), works only in the one folder
/// beside the installation that main stages in, and only when that folder is this user's alone
/// (<see cref="UpdateFiles.IsOwnRoot"/>), and asks for no elevation.
/// Exit codes: 0 done (check: staged), 1 failed, 2 not a request it serves, 3 the staging folder is not this user's
/// alone (or, for check, nothing is staged), 4 another stage is still running.
/// </summary>
internal static partial class Program
{
    /// <summary>How long the swap waits for Varia to end, and then for the installation's files to be free.</summary>
    private static readonly TimeSpan ExitPatience = TimeSpan.FromSeconds(30), SwapPatience = TimeSpan.FromSeconds(20);
    /// <summary>Sign-ins that try to finish an interrupted swap before it is left for Setup to repair.</summary>
    private const int RecoveryAttempts = 5;

    // As main's schema has it (src/shared/updates.ts): ASCII digits only, at most 64 characters.
    [GeneratedRegex(@"^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?\z")]
    private static partial Regex VersionPattern();

    private static bool ValidVersion([System.Diagnostics.CodeAnalysis.NotNullWhen(true)] string? version) => version is { Length: > 0 and <= 64 } && VersionPattern().IsMatch(version);
    /// <summary>A plain file name: no folder, no stream (<c>name:stream</c>), nothing a file name cannot hold.</summary>
    private static bool Valid(string exe, string version) => ValidVersion(version) && exe.Length <= 128 && exe == Path.GetFileName(exe) && exe.IndexOfAny(Path.GetInvalidFileNameChars()) < 0 && !exe.Contains(':') && exe.EndsWith(".exe", StringComparison.OrdinalIgnoreCase);

    private static int Main(string[] args)
    {
        if (args is ["recover"]) return Recover();
        var options = new Dictionary<string, string>(StringComparer.Ordinal);
        var flags = new HashSet<string>(StringComparer.Ordinal);
        for (var index = 1; index < args.Length; index++)
        {
            if (!args[index].StartsWith("--", StringComparison.Ordinal)) return 2;
            if (index + 1 < args.Length && !args[index + 1].StartsWith("--", StringComparison.Ordinal)) options[args[index]] = args[++index];
            else flags.Add(args[index]);
        }
        string Need(string name) => options.TryGetValue(name, out var value) && value.Length > 0 ? value : throw new ArgumentException(name);
        string? root = null;
        try
        {
            var command = args.Length > 0 ? args[0] : "";
            var installDir = Path.GetFullPath(Need("--install"));
            var given = Path.GetFullPath(Need("--root"));
            // Before anything is read or written: only the staging folder main uses for this installation is worked in.
            if (!UpdateFiles.IsStagingRoot(given, installDir)) return 2;
            if (command == "forget")
            {
                // The running version is the latest: a recovery still registered for this folder has nothing to finish.
                if (UpdateFiles.IsOwnRoot(given)) EndRecovery(given);
                return 0;
            }
            var exe = Need("--exe");
            var version = Need("--version");
            // Only shown in Apps &amp; features: a version main has that is not one is left out, not a reason to stop.
            var from = options.GetValueOrDefault("--from") is { } previous && ValidVersion(previous) ? previous : null;
            if (!Valid(exe, version)) return 2;
            switch (command)
            {
                case "check":
                    return UpdateFiles.IsOwnRoot(given) && UpdateFiles.IsStaged(given, exe, version, Need("--sha512")) ? 0 : 3;
                case "stage":
                    // Varia is in use while this runs.
                    try { using var self = Process.GetCurrentProcess(); self.PriorityClass = ProcessPriorityClass.BelowNormal; } catch (Exception error) when (error is InvalidOperationException or System.ComponentModel.Win32Exception or PlatformNotSupportedException) { }
                    // Made for this user alone, or refused when someone else made it first.
                    UpdateFiles.PrepareRoot(given);
                    root = given;
                    UpdateFiles.Stage(Path.GetFullPath(Need("--archive")), Need("--sha512"), root, installDir, exe, version);
                    UpdateFiles.Log(root, $"staged {version}");
                    return 0;
                case "swap":
                    if (!UpdateFiles.IsOwnRoot(given)) return 3;
                    root = given;
                    return Swap(root, installDir, exe, version, from, int.Parse(Need("--pid")), start: !flags.Contains("--no-start"));
                default:
                    return 2;
            }
        }
        catch (UpdateFiles.StageBusyException) { return 4; }
        catch (UpdateFiles.ForeignRootException) { return 3; }
        catch (Exception error)
        {
            // Nothing is written into a folder that was not accepted as this user's.
            if (root is not null) UpdateFiles.Log(root, $"failed: {error.GetType().Name}: {error.Message}");
            return 1;
        }
    }

    /// <summary>A step whose failure must not stop the ones after it (starting Varia, above all).</summary>
    private static void Attempt(string root, string what, Action step)
    {
        try { step(); }
        catch (Exception error) { UpdateFiles.Log(root, $"{what} failed: {error.GetType().Name}: {error.Message}"); }
    }

    private static int Swap(string root, string installDir, string exe, string version, string? from, int pid, bool start)
    {
        var target = Path.Combine(installDir, exe);
        try
        {
            // A process whose current folder is in the installation holds it, and it could not be renamed.
            Environment.CurrentDirectory = root;
            if (pid > 0)
            {
                try { using var app = Process.GetProcessById(pid); app.WaitForExit(ExitPatience); }
                catch (Exception error) when (error is ArgumentException or InvalidOperationException or System.ComponentModel.Win32Exception) { /* Already gone, or not ours to wait for. */ }
            }
            // Between the two renames there is no installation. Should this process end there (the power goes), the
            // journal and the sign-in entry have the next sign-in finish the swap before the shortcut is used.
            UpdateFiles.WriteJournal(root, new UpdateFiles.SwapJournal(installDir, exe, version, from));
            if (OperatingSystem.IsWindows()) RegisterRecovery(root);
            // A copy of Varia the user started meanwhile is using its backend: nothing of it is ended, and the swap
            // gives up once its patience is spent.
            UpdateFiles.Swap(root, installDir, exe, SwapPatience, () => { if (!Running(target)) EndStragglers(installDir, exe); });
        }
        catch (Exception error)
        {
            UpdateFiles.Log(root, $"swap to {version} failed: {error.GetType().Name}: {error.Message}");
            // Only with the installation where it was (its executable, not merely a folder of that name) is there
            // nothing left to finish; otherwise (the staged release and then the old version both refused to move)
            // the journal stays for the next sign-in.
            if (File.Exists(target)) EndRecovery(root);
            else UpdateFiles.Log(root, "the installation is still moved aside: the next sign-in finishes the swap");
            Attempt(root, "marking the swap as failed", () => UpdateFiles.WriteMarker(UpdateFiles.FailedMarker(root), version));
            // Another copy of Varia holding the installation is already what the user wants open.
            if (start && File.Exists(target) && !Running(target)) Attempt(root, "starting Varia", () => Start(target));
            return 1;
        }
        if (start) Attempt(root, "starting Varia", () => Start(target));
        if (OperatingSystem.IsWindows() && from is not null) UpdateUninstallEntry(installDir, from, version);
        EndRecovery(root);
        UpdateFiles.Log(root, $"swapped to {version}");
        UpdateFiles.DeleteTree(UpdateFiles.OldDir(root), attempts: 10);
        return 0;
    }

    /// <summary>
    /// At sign-in, from the staging folder: finishes the swap its journal describes. Varia is not started (nobody asked
    /// for it now); an old version that had to go back is reported by Varia's next start, like any failed swap.
    /// </summary>
    private static int Recover()
    {
        var root = Path.TrimEndingDirectorySeparator(AppContext.BaseDirectory);
        UpdateFiles.SwapJournal? journal = null;
        try
        {
            if (!UpdateFiles.IsOwnRoot(root)) return 0;
            journal = UpdateFiles.ReadJournal(root);
            if (journal is null || !Valid(journal.Exe, journal.Version) || !Path.IsPathFullyQualified(journal.InstallDir) || !UpdateFiles.IsStagingRoot(root, journal.InstallDir)) return 0;
            Environment.CurrentDirectory = root;
            // A scanner reading the folders just after sign-in is waited for, as in the swap.
            var outcome = UpdateFiles.Recover(root, journal.InstallDir, journal.Exe, SwapPatience);
            // The version Apps &amp; features shows changes only when this run put the release in place: an installation that
            // was already there may be another version, installed since.
            if (outcome == UpdateFiles.Recovery.Completed && OperatingSystem.IsWindows() && ValidVersion(journal.From)) UpdateUninstallEntry(journal.InstallDir, journal.From, journal.Version);
            if (outcome is UpdateFiles.Recovery.Completed or UpdateFiles.Recovery.Tidied) UpdateFiles.DeleteTree(UpdateFiles.OldDir(root), attempts: 10);
            else if (outcome == UpdateFiles.Recovery.RolledBack) Attempt(root, "marking the swap as failed", () => UpdateFiles.WriteMarker(UpdateFiles.FailedMarker(root), journal.Version));
            UpdateFiles.Log(root, $"recovered an interrupted swap to {journal.Version}: {outcome}");
            EndRecovery(root);
            return 0;
        }
        catch (Exception error)
        {
            UpdateFiles.Log(root, $"recovery failed: {error.GetType().Name}: {error.Message}");
            // Windows removed the entry before running it: the next sign-in tries again, a few times.
            // Only once the count is on disk, or it would never reach its bound.
            if (journal is not null && journal.Attempts + 1 < RecoveryAttempts)
            {
                var counted = false;
                Attempt(root, "keeping the journal", () => { UpdateFiles.WriteJournal(root, journal with { Attempts = journal.Attempts + 1 }); counted = true; });
                if (counted && OperatingSystem.IsWindows()) RegisterRecovery(root);
            }
            return 1;
        }
    }

    private const string RunOnceKey = @"Software\Microsoft\Windows\CurrentVersion\RunOnce", RunOnceName = "VariaSqlManagerUpdate";

    /// <summary>
    /// Has Windows run this copy with <c>recover</c> at the user's next sign-in. Only the copy in the staging folder
    /// registers itself, and only when the command fits what RunOnce runs (260 characters). The key is flushed: it is
    /// there for a power failure. Best effort.
    /// </summary>
    [SupportedOSPlatform("windows")]
    private static void RegisterRecovery(string root)
    {
        try
        {
            var self = Environment.ProcessPath;
            if (self is null || !string.Equals(Path.GetDirectoryName(self), root, StringComparison.OrdinalIgnoreCase)) return;
            var command = $"\"{self}\" recover";
            if (command.Length > 260) return;
            using var key = Registry.CurrentUser.CreateSubKey(RunOnceKey);
            key.SetValue(RunOnceName, command);
            key.Flush();
        }
        catch (Exception error) when (error is System.Security.SecurityException or UnauthorizedAccessException or IOException) { }
    }

    /// <summary>Removes the journal and the sign-in entry, when that entry is this staging folder's.</summary>
    private static void EndRecovery(string root)
    {
        try { File.Delete(UpdateFiles.Journal(root)); } catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
        if (!OperatingSystem.IsWindows()) return;
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(RunOnceKey, writable: true);
            if (key?.GetValue(RunOnceName) is string command && command.StartsWith($"\"{root}{Path.DirectorySeparatorChar}", StringComparison.OrdinalIgnoreCase)) key.DeleteValue(RunOnceName, throwOnMissingValue: false);
        }
        catch (Exception error) when (error is System.Security.SecurityException or UnauthorizedAccessException or IOException) { }
    }

    private static void Start(string target)
    {
        using var started = Process.Start(new ProcessStartInfo(target) { UseShellExecute = false, WorkingDirectory = Path.GetDirectoryName(target)! });
    }

    private static string? ImagePath(Process process)
    {
        try { return process.MainModule?.FileName; }
        catch (Exception error) when (error is System.ComponentModel.Win32Exception or InvalidOperationException or NotSupportedException) { return null; }
    }

    /// <summary>
    /// Whether Varia runs from <paramref name="target"/>. A process of its name whose path cannot be read (it is still
    /// starting, or runs elevated) counts: taking it for absent would end a live copy's backend.
    /// </summary>
    private static bool Running(string target)
    {
        var name = Path.GetFileNameWithoutExtension(target);
        var found = false;
        foreach (var process in Process.GetProcesses())
        {
            using (process)
            {
                var path = ImagePath(process);
                found |= path is null ? NamedLike(process, name) : string.Equals(path, target, StringComparison.OrdinalIgnoreCase);
            }
        }
        return found;
    }

    private static bool NamedLike(Process process, string name)
    {
        try { return string.Equals(process.ProcessName, name, StringComparison.OrdinalIgnoreCase); }
        catch (Exception error) when (error is InvalidOperationException or NotSupportedException or System.ComponentModel.Win32Exception) { return false; }
    }

    /// <summary>
    /// What Varia left running from its folder (the backend or the SQL language service, when it was ended abruptly)
    /// holds that folder's files: they are ended, as the installer does. Only called while no Varia runs from there.
    /// </summary>
    private static void EndStragglers(string installDir, string exe)
    {
        var prefix = Path.TrimEndingDirectorySeparator(installDir) + Path.DirectorySeparatorChar;
        foreach (var process in Process.GetProcesses())
        {
            using (process)
            {
                var path = ImagePath(process);
                if (path is null || !path.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) || string.Equals(path, prefix + exe, StringComparison.OrdinalIgnoreCase)) continue;
                try { process.Kill(); process.WaitForExit(TimeSpan.FromSeconds(5)); }
                catch (Exception error) when (error is System.ComponentModel.Win32Exception or InvalidOperationException or NotSupportedException) { }
            }
        }
    }

    /// <summary>
    /// Apps &amp; features shows the version the installer wrote ("Varia SQL Manager 0.7.0"); the entry whose uninstaller
    /// is this installation's gets the new one. Nothing else about the installation changed. Best effort.
    /// </summary>
    [SupportedOSPlatform("windows")]
    private static void UpdateUninstallEntry(string installDir, string from, string version)
    {
        var uninstaller = "\"" + Path.TrimEndingDirectorySeparator(installDir) + "\\Uninstall ";
        foreach (var hive in new[] { Registry.CurrentUser, Registry.LocalMachine })
        {
            try
            {
                using var entries = hive.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall");
                if (entries is null) continue;
                foreach (var name in entries.GetSubKeyNames())
                {
                    using var entry = entries.OpenSubKey(name);
                    if (entry?.GetValue("UninstallString") is not string command || !command.StartsWith(uninstaller, StringComparison.OrdinalIgnoreCase)) continue;
                    using var writable = entries.OpenSubKey(name, writable: true);
                    if (writable is null) continue;
                    writable.SetValue("DisplayVersion", version);
                    if (writable.GetValue("DisplayName") is string display && display.EndsWith(" " + from, StringComparison.Ordinal)) writable.SetValue("DisplayName", display[..^from.Length] + version);
                }
            }
            // Best effort: whatever the registry refuses, Varia is already swapped in.
            catch (Exception error) when (error is System.Security.SecurityException or UnauthorizedAccessException or IOException or InvalidOperationException or ArgumentException) { }
        }
    }
}
