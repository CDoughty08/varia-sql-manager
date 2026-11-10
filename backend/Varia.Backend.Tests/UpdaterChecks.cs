using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;
using Varia.Updater;

namespace Varia.Backend.Tests;

/// <summary>Offline checks of the update helper's file work (backend/Varia.Updater): staging a release and swapping it in.</summary>
internal static class UpdaterChecks
{
    private const string Exe = "Varia SQL Manager.exe";

    public static void Run(Action<bool, string> check)
    {
        var temp = Directory.CreateTempSubdirectory("varia-updater-checks-").FullName;
        try
        {
            Stage(check, Path.Combine(temp, "stage"));
            Refusals(check, Path.Combine(temp, "refuse"));
            Swap(check, Path.Combine(temp, "swap"));
            Recovery(check, Path.Combine(temp, "recover"));
        }
        finally { UpdateFiles.DeleteTree(temp); }
    }

    private static string Archive(string path, params (string Name, string Text)[] files)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        using (var zip = ZipFile.Open(path, ZipArchiveMode.Create))
        {
            foreach (var (name, text) in files)
            {
                var entry = zip.CreateEntry(name);
                if (name.EndsWith('/')) continue;
                using var writer = new StreamWriter(entry.Open());
                writer.Write(text);
            }
        }
        return Convert.ToBase64String(SHA512.HashData(File.ReadAllBytes(path)));
    }

    private static string Installation(string folder, string version)
    {
        Directory.CreateDirectory(Path.Combine(folder, "resources"));
        File.WriteAllText(Path.Combine(folder, Exe), version);
        File.WriteAllText(Path.Combine(folder, "resources", "app.asar"), version);
        File.WriteAllText(Path.Combine(folder, $"Uninstall {Exe}"), "uninstaller");
        File.WriteAllText(Path.Combine(folder, "resources", "elevate.exe"), "elevate");
        return folder;
    }

    private static bool Throws<T>(Action action) where T : Exception
    {
        try { action(); return false; }
        catch (T) { return true; }
    }

    private static void Stage(Action<bool, string> check, string temp)
    {
        var install = Installation(Path.Combine(temp, "Varia SQL Manager"), "1.0.0");
        var root = Path.Combine(temp, ".Varia SQL Manager.update");
        var archive = Path.Combine(temp, "release.zip");
        var sha = Archive(archive, (Exe, "1.1.0"), ("resources/", ""), ("resources/app.asar", "1.1.0"), ("locales/en-US.pak", "pak"));
        // What an interrupted earlier stage left is replaced.
        UpdateFiles.PrepareRoot(root);
        Directory.CreateDirectory(Path.Combine(root, "app.tmp", "stale"));
        UpdateFiles.Stage(archive, sha, root, install, Exe, "1.1.0");
        var app = UpdateFiles.AppDir(root);
        check(File.ReadAllText(Path.Combine(app, Exe)) == "1.1.0" && File.ReadAllText(Path.Combine(app, "resources", "app.asar")) == "1.1.0" && File.Exists(Path.Combine(app, "locales", "en-US.pak")) && !Directory.Exists(Path.Combine(root, "app.tmp")),
            "staging unpacks the release beside the installation, replacing what an interrupted stage left");
        check(File.ReadAllText(Path.Combine(app, $"Uninstall {Exe}")) == "uninstaller" && File.ReadAllText(Path.Combine(app, "resources", "elevate.exe")) == "elevate",
            "the staged release carries what Setup added to the installation and the archive lacks: the uninstaller and the elevation helper");
        check(UpdateFiles.IsStagingRoot(root, install) && UpdateFiles.IsStagingRoot(root + Path.DirectorySeparatorChar, install + Path.DirectorySeparatorChar)
            && !UpdateFiles.IsStagingRoot(Path.Combine(temp, "elsewhere"), install) && !UpdateFiles.IsStagingRoot(install, install) && !UpdateFiles.IsStagingRoot(Path.Combine(install, ".x.update"), install)
            && !UpdateFiles.IsStagingRoot(Path.Combine(Path.GetPathRoot(install)!, "..update"), Path.GetPathRoot(install)!),
            "only the folder beside the installation that is named after it is a staging folder, and an installation at a drive's root has none");
        using var marker = JsonDocument.Parse(File.ReadAllText(UpdateFiles.StagedMarker(root)));
        check(marker.RootElement.GetProperty("version").GetString() == "1.1.0" && marker.RootElement.GetProperty("sha512").GetString() == sha, "the staged marker names the version and the archive's checksum, written last");
        check(File.ReadAllText(Path.Combine(install, Exe)) == "1.0.0", "staging leaves the running installation alone");
        var sha512 = marker.RootElement.GetProperty("sha512").GetString()!;
        check(UpdateFiles.IsOwnRoot(root) && UpdateFiles.IsStaged(root, Exe, "1.1.0", sha512) && !UpdateFiles.IsStaged(root, Exe, "1.2.0", sha512) && !UpdateFiles.IsStaged(root, Exe, "1.1.0", Convert.ToBase64String(SHA512.HashData("another archive"u8)))
            && !UpdateFiles.IsStaged(root, "Other.exe", "1.1.0", sha512) && !UpdateFiles.IsStaged(Path.Combine(temp, "nowhere"), Exe, "1.1.0", sha512),
            "a release is staged only where the marker names its version and checksum and its application is in place");
        check(!File.Exists(Path.Combine(root, "stage.lock")), "a finished stage leaves no lock behind");
        // A helper that Varia left unpacking (it was ended meanwhile) is neither unpacked over nor deleted under.
        using (new FileStream(Path.Combine(root, "stage.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None))
            check(Throws<UpdateFiles.StageBusyException>(() => UpdateFiles.Stage(archive, sha, root, install, Exe, "1.1.0")) && UpdateFiles.IsStaged(root, Exe, "1.1.0", sha512),
                "a stage that finds another still running stops, and touches nothing of it");
        if (OperatingSystem.IsWindows())
        {
            // The folder's name can be guessed: one that somebody else made first (here: made without the access rules
            // the helper gives its own) is not staged into, and nothing in it is believed.
            var foreign = Path.Combine(temp, "foreign", ".Varia SQL Manager.update");
            var beside = Installation(Path.Combine(temp, "foreign", "Varia SQL Manager"), "1.0.0");
            Directory.CreateDirectory(Path.Combine(foreign, "app"));
            File.WriteAllText(Path.Combine(foreign, "app", Exe), "planted");
            UpdateFiles.WriteMarker(UpdateFiles.StagedMarker(foreign), "1.1.0", sha512);
            check(!UpdateFiles.IsOwnRoot(foreign) && UpdateFiles.IsStaged(foreign, Exe, "1.1.0", sha512), "a staging folder made without the helper's access rules is not this user's alone, whatever its marker says");
            check(Throws<UpdateFiles.ForeignRootException>(() => UpdateFiles.Stage(archive, sha, foreign, beside, Exe, "1.1.0")) && File.ReadAllText(Path.Combine(foreign, "app", Exe)) == "planted", "nothing is staged into a folder that is not this user's alone, and nothing in it is removed");
            check(Throws<UpdateFiles.ForeignRootException>(() => UpdateFiles.PrepareRoot(foreign)) && !UpdateFiles.IsOwnRoot(Path.Combine(temp, "foreign", "absent")), "such a folder is refused, and one that is not there is not anybody's");
        }
    }

    private static void Refusals(Action<bool, string> check, string temp)
    {
        var install = Installation(Path.Combine(temp, "Varia SQL Manager"), "1.0.0");
        var root = Path.Combine(temp, "root");
        var archive = Path.Combine(temp, "release.zip");
        var sha = Archive(archive, (Exe, "1.1.0"));
        var other = Convert.ToBase64String(SHA512.HashData("something else"u8));
        check(Throws<InvalidDataException>(() => UpdateFiles.Stage(archive, other, root, install, Exe, "1.1.0")) && !Directory.Exists(UpdateFiles.AppDir(root)) && !File.Exists(UpdateFiles.StagedMarker(root)),
            "an archive that does not match its checksum is not unpacked");
        UpdateFiles.Stage(archive, sha, root, install, Exe, "1.1.0");
        check(Throws<InvalidDataException>(() => UpdateFiles.Stage(archive, other, root, install, Exe, "1.1.0")) && !Directory.Exists(UpdateFiles.AppDir(root)) && !File.Exists(UpdateFiles.StagedMarker(root)),
            "a failed stage removes the release staged before it and its marker");
        var escaping = Path.Combine(temp, "escaping.zip");
        var escapingSha = Archive(escaping, (Exe, "1.1.0"), ("../outside.txt", "x"));
        check(Throws<InvalidDataException>(() => UpdateFiles.Stage(escaping, escapingSha, root, install, Exe, "1.1.0")) && !File.Exists(Path.Combine(temp, "outside.txt")) && !File.Exists(Path.Combine(root, "outside.txt")) && !Directory.Exists(UpdateFiles.AppDir(root)),
            "an archive entry that would land outside the staging folder is refused, and nothing stays staged");
        // Other ways out of the folder: an absolute name everywhere; a drive, a rooted name and backslashes on Windows.
        string[] outside = OperatingSystem.IsWindows() ? ["/absolute.txt", @"C:\Windows\Temp\varia-outside.txt", @"..\outside.txt", @"sub\..\..\outside.txt", @"\rooted.txt"] : ["/absolute.txt", "sub/../../outside.txt"];
        var refused = 0;
        foreach (var name in outside)
        {
            var bad = Path.Combine(temp, $"outside-{refused}.zip");
            Archive(bad, (Exe, "1.1.0"), (name, "x"));
            using var stream = File.OpenRead(bad);
            var into = Path.Combine(temp, $"into-{refused}");
            if (Throws<InvalidDataException>(() => UpdateFiles.Unpack(stream, into)) && !File.Exists(Path.Combine(temp, "outside.txt"))) refused++;
        }
        check(refused == outside.Length, "an entry with an absolute, rooted or climbing name is refused however it is written");
        // The bounds on what an archive may unpack to, at sizes a check can afford.
        var bulky = Path.Combine(temp, "bulky.zip");
        Archive(bulky, ("a.txt", new string('a', 600)), ("b.txt", new string('b', 600)));
        using (var stream = File.OpenRead(bulky))
            check(Throws<InvalidDataException>(() => UpdateFiles.Unpack(stream, Path.Combine(temp, "into-bulky"), maxBytes: 1000)), "an archive that unpacks to more than its bound is refused, counted as it is written");
        using (var stream = File.OpenRead(bulky))
            check(Throws<InvalidDataException>(() => UpdateFiles.Unpack(stream, Path.Combine(temp, "into-many"), maxEntries: 1)), "an archive with more files than its bound is refused");
        check(UpdateFiles.MaxUnpackedBytes == 8L << 30 && UpdateFiles.MaxEntries == 200_000, "an archive may unpack to at most 8 GiB and 200,000 files");
        var twice = Path.Combine(temp, "twice.zip");
        Archive(twice, (Exe, "1.1.0"), (Exe, "another"));
        using (var stream = File.OpenRead(twice)) check(Throws<IOException>(() => UpdateFiles.Unpack(stream, Path.Combine(temp, "into-twice"))), "an archive that names a file twice is refused, not unpacked one over the other");
        if (OperatingSystem.IsWindows())
        {
            // What an earlier stage left and cannot be removed is not unpacked over.
            Directory.CreateDirectory(Path.Combine(root, "app.tmp"));
            using (new FileStream(Path.Combine(root, "app.tmp", "left.txt"), FileMode.Create, FileAccess.Write, FileShare.None))
                check(Throws<IOException>(() => UpdateFiles.Stage(archive, sha, root, install, Exe, "1.1.0")) && !Directory.Exists(UpdateFiles.AppDir(root)), "a stage does not unpack into what an earlier one left and could not remove");
        }
        var hollow = Path.Combine(temp, "hollow.zip");
        var hollowSha = Archive(hollow, ("readme.txt", "no application"));
        check(Throws<InvalidDataException>(() => UpdateFiles.Stage(hollow, hollowSha, root, install, Exe, "1.1.0")) && !File.Exists(UpdateFiles.StagedMarker(root)), "an archive without the application is not staged");
    }

    /// <summary>A swap cut short between its renames (the power went): each place it can stop is finished at sign-in.</summary>
    private static void Recovery(Action<bool, string> check, string temp)
    {
        (string Install, string Root) Staged(string name)
        {
            var install = Installation(Path.Combine(temp, name, "Varia SQL Manager"), "1.0.0");
            var root = Path.Combine(temp, name, ".Varia SQL Manager.update");
            var archive = Path.Combine(temp, name, "release.zip");
            UpdateFiles.Stage(archive, Archive(archive, (Exe, "1.1.0"), ("resources/app.asar", "1.1.0")), root, install, Exe, "1.1.0");
            return (install, root);
        }
        // The installation is moved aside as an interrupted swap left it; a scanner still reading what was just written
        // there is waited for (really: these files exist for a moment only).
        void Aside(string install, string root)
        {
            for (var attempt = 1; ; attempt++)
            {
                try { Directory.Move(install, UpdateFiles.OldDir(root)); return; }
                catch (Exception error) when (error is IOException or UnauthorizedAccessException && attempt < 50) { Thread.Sleep(100); }
            }
        }
        string Version(string install) => File.Exists(Path.Combine(install, Exe)) ? File.ReadAllText(Path.Combine(install, Exe)) : "none";

        var (install, root) = Staged("before");
        check(UpdateFiles.Recover(root, install, Exe) == UpdateFiles.Recovery.Nothing && Version(install) == "1.0.0" && File.Exists(UpdateFiles.StagedMarker(root)),
            "a swap stopped before its first rename leaves the installation and the staged release as they are");

        (install, root) = Staged("between");
        Aside(install, root);
        UpdateFiles.WriteMarker(UpdateFiles.FailedMarker(root), "1.1.0");
        check(UpdateFiles.Recover(root, install, Exe) == UpdateFiles.Recovery.Completed && Version(install) == "1.1.0" && File.Exists(Path.Combine(install, $"Uninstall {Exe}")) && Version(UpdateFiles.OldDir(root)) == "1.0.0"
            && !Directory.Exists(UpdateFiles.AppDir(root)) && !File.Exists(UpdateFiles.StagedMarker(root)) && !File.Exists(UpdateFiles.FailedMarker(root)),
            "a swap stopped between its renames, with no installation in place, is finished: the staged release becomes the installation");
        File.WriteAllText(UpdateFiles.StagedMarker(root), "{}");
        check(UpdateFiles.Recover(root, install, Exe) == UpdateFiles.Recovery.Tidied && UpdateFiles.Recover(root, install, Exe) == UpdateFiles.Recovery.Tidied && Version(install) == "1.1.0" && !File.Exists(UpdateFiles.StagedMarker(root)),
            "a swap stopped after both renames only has its tidying left, however often that is asked, and is not taken for one this run completed");
        UpdateFiles.DeleteTree(UpdateFiles.OldDir(root));
        check(UpdateFiles.Recover(root, install, Exe) == UpdateFiles.Recovery.Nothing && Version(install) == "1.1.0", "a finished swap has nothing to recover");

        // Something made a folder of the installation's name after it was moved aside: empty, it is not the installation.
        (install, root) = Staged("stub");
        Aside(install, root);
        Directory.CreateDirectory(install);
        check(UpdateFiles.Recover(root, install, Exe) == UpdateFiles.Recovery.Completed && Version(install) == "1.1.0", "an empty folder where the installation was does not stop the staged release from going there");
        (install, root) = Staged("occupied");
        Aside(install, root);
        Directory.CreateDirectory(install);
        File.WriteAllText(Path.Combine(install, "somebody.log"), "x");
        check(UpdateFiles.Recover(root, install, Exe) == UpdateFiles.Recovery.Nothing && Version(UpdateFiles.OldDir(root)) == "1.0.0" && File.Exists(Path.Combine(UpdateFiles.AppDir(root), Exe)) && File.Exists(Path.Combine(install, "somebody.log")),
            "a folder there that holds something is left alone, with both versions kept for Setup to repair");

        (install, root) = Staged("broken");
        Aside(install, root);
        File.Delete(Path.Combine(UpdateFiles.AppDir(root), Exe));
        check(UpdateFiles.Recover(root, install, Exe) == UpdateFiles.Recovery.RolledBack && Version(install) == "1.0.0" && !Directory.Exists(UpdateFiles.OldDir(root)) && !Directory.Exists(UpdateFiles.AppDir(root)) && !File.Exists(UpdateFiles.StagedMarker(root)),
            "when the staged release is not whole, the old version goes back and nothing stays staged");
        Directory.Delete(install, recursive: true);
        check(UpdateFiles.Recover(root, install, Exe) == UpdateFiles.Recovery.Nothing && !Directory.Exists(install), "with neither version to hand, recovery does nothing");

        var journal = new UpdateFiles.SwapJournal(install, Exe, "1.1.0", "1.0.0");
        UpdateFiles.WriteJournal(root, journal);
        check(UpdateFiles.ReadJournal(root) == journal, "the swap's journal reads back as it was written, backslashes and spaces included");
        UpdateFiles.WriteJournal(root, journal with { From = null, Attempts = 3 });
        check(UpdateFiles.ReadJournal(root) == journal with { From = null, Attempts = 3 }, "a journal may lack the version it came from, and counts the sign-ins that tried to finish it");
        if (OperatingSystem.IsWindows())
        {
            // A scanner reading the staged release at sign-in is waited for.
            (install, root) = Staged("waited");
            Aside(install, root);
            long clock = 0;
            var held = new FileStream(Path.Combine(UpdateFiles.AppDir(root), "resources", "app.asar"), FileMode.Open, FileAccess.Read, FileShare.None);
            try
            {
                check(Throws<Exception>(() => UpdateFiles.Recover(root, install, Exe)) && !Directory.Exists(install), "a recovery without patience fails while a file of the staged release is in use");
                var outcome = UpdateFiles.Recover(root, install, Exe, TimeSpan.FromSeconds(10), span => { clock += (long)span.TotalMilliseconds; if (clock >= 600) held.Dispose(); }, () => clock);
                check(outcome == UpdateFiles.Recovery.Completed && Version(install) == "1.1.0" && clock >= 600, "a recovery waits for a file in use and then finishes the swap");
            }
            finally { held.Dispose(); }
        }
        File.WriteAllText(UpdateFiles.Journal(root), "{\"installDir\":5,\"exe\":\"x.exe\",\"version\":\"1.1.0\"}");
        var wrongType = UpdateFiles.ReadJournal(root);
        File.WriteAllText(UpdateFiles.Journal(root), "[not a journal");
        var notJson = UpdateFiles.ReadJournal(root);
        File.WriteAllText(UpdateFiles.Journal(root), new string(' ', 9000));
        var tooLarge = UpdateFiles.ReadJournal(root);
        File.Delete(UpdateFiles.Journal(root));
        check(wrongType is null && notJson is null && tooLarge is null && UpdateFiles.ReadJournal(root) is null, "a journal that is missing, too large, not JSON or of the wrong shape is no journal");
    }

    private static void Swap(Action<bool, string> check, string temp)
    {
        var install = Installation(Path.Combine(temp, "Varia SQL Manager"), "1.0.0");
        File.WriteAllText(Path.Combine(install, "left-by-1.0.0.txt"), "old");
        var root = Path.Combine(temp, ".Varia SQL Manager.update");
        var archive = Path.Combine(temp, "release.zip");
        var sha = Archive(archive, (Exe, "1.1.0"), ("resources/app.asar", "1.1.0"));
        check(Throws<InvalidDataException>(() => UpdateFiles.Swap(root, install, Exe, TimeSpan.Zero)) && File.ReadAllText(Path.Combine(install, Exe)) == "1.0.0", "a swap with nothing staged leaves the installation alone");
        UpdateFiles.Stage(archive, sha, root, install, Exe, "1.1.0");

        if (OperatingSystem.IsWindows())
        {
            // Windows refuses to rename a folder while one of its files is open; elsewhere the rename goes through.
            var waits = 0;
            var asked = 0;
            using (new FileStream(Path.Combine(install, "resources", "app.asar"), FileMode.Open, FileAccess.Read, FileShare.None))
            {
                var failed = Throws<Exception>(() => UpdateFiles.Swap(root, install, Exe, TimeSpan.Zero, () => asked++, _ => waits++));
                check(failed && File.ReadAllText(Path.Combine(install, Exe)) == "1.0.0" && File.Exists(Path.Combine(UpdateFiles.AppDir(root), Exe)) && File.Exists(UpdateFiles.StagedMarker(root)) && !Directory.Exists(UpdateFiles.OldDir(root)),
                    "a swap that cannot move the installation (a file in use) leaves it and the staged release as they were");
            }
            // Half its patience spent (on a clock the waits move), it asks once for what holds the file to be ended, and
            // goes through once that is gone. An earlier failure's marker goes with it.
            UpdateFiles.WriteMarker(UpdateFiles.FailedMarker(root), "1.1.0");
            var held = new FileStream(Path.Combine(install, "resources", "app.asar"), FileMode.Open, FileAccess.Read, FileShare.None);
            long clock = 0;
            try { UpdateFiles.Swap(root, install, Exe, TimeSpan.FromSeconds(2), () => { asked++; held.Dispose(); }, span => { waits++; clock += (long)span.TotalMilliseconds; }, () => clock); }
            finally { held.Dispose(); }
            check(asked == 1 && waits >= 6 && !File.Exists(UpdateFiles.FailedMarker(root)), "a swap waits for a file in use, asks once (half way) for what holds it to be ended, and clears an earlier failure once it goes through");
        }
        else UpdateFiles.Swap(root, install, Exe, TimeSpan.Zero);

        check(File.ReadAllText(Path.Combine(install, Exe)) == "1.1.0" && File.ReadAllText(Path.Combine(install, "resources", "app.asar")) == "1.1.0" && File.ReadAllText(Path.Combine(install, $"Uninstall {Exe}")) == "uninstaller" && !File.Exists(Path.Combine(install, "left-by-1.0.0.txt")),
            "the swap puts the staged release, with the uninstaller, where the installation was, and none of the old version's files stay");
        check(File.ReadAllText(Path.Combine(UpdateFiles.OldDir(root), Exe)) == "1.0.0" && !Directory.Exists(UpdateFiles.AppDir(root)) && !File.Exists(UpdateFiles.StagedMarker(root)),
            "the old version waits beside it to be removed, and nothing is marked as staged any more");
        check(UpdateFiles.DeleteTree(UpdateFiles.OldDir(root)) && !Directory.Exists(UpdateFiles.OldDir(root)), "the old version is removed");

        if (OperatingSystem.IsWindows())
        {
            // The staged release cannot be moved (a scanner holds one of its files): the installation goes back.
            var (back, backRoot) = (Installation(Path.Combine(temp, "back", "Varia SQL Manager"), "1.0.0"), Path.Combine(temp, "back", ".Varia SQL Manager.update"));
            var backArchive = Path.Combine(temp, "back", "release.zip");
            UpdateFiles.Stage(backArchive, Archive(backArchive, (Exe, "1.1.0"), ("resources/app.asar", "1.1.0")), backRoot, back, Exe, "1.1.0");
            long clock = 0;
            var waits = 0;
            using (new FileStream(Path.Combine(UpdateFiles.AppDir(backRoot), "resources", "app.asar"), FileMode.Open, FileAccess.Read, FileShare.None))
            {
                var failed = Throws<Exception>(() => UpdateFiles.Swap(backRoot, back, Exe, TimeSpan.FromSeconds(4), null, span => { waits++; clock += (long)span.TotalMilliseconds; }, () => clock));
                check(failed && waits >= 5 && File.ReadAllText(Path.Combine(back, Exe)) == "1.0.0" && !Directory.Exists(UpdateFiles.OldDir(backRoot)) && File.Exists(Path.Combine(UpdateFiles.AppDir(backRoot), Exe)) && File.Exists(UpdateFiles.StagedMarker(backRoot)),
                    "when the staged release cannot be moved into place, even after waiting, the installation goes back and the release stays staged");
            }
            // The version an earlier update replaced is still held: the swap fails at once, before anything moves.
            Directory.CreateDirectory(UpdateFiles.OldDir(backRoot));
            using (new FileStream(Path.Combine(UpdateFiles.OldDir(backRoot), "held.txt"), FileMode.Create, FileAccess.Write, FileShare.None))
            {
                waits = 0;
                check(Throws<IOException>(() => UpdateFiles.Swap(backRoot, back, Exe, TimeSpan.FromMinutes(1), () => waits++, _ => waits++)) && waits == 0 && File.ReadAllText(Path.Combine(back, Exe)) == "1.0.0",
                    "a swap that cannot clear the version an earlier update replaced fails at once, without waiting or ending anything");
            }
        }

        UpdateFiles.WriteMarker(UpdateFiles.FailedMarker(root), "1.2.0");
        using var failure = JsonDocument.Parse(File.ReadAllText(UpdateFiles.FailedMarker(root)));
        check(failure.RootElement.GetProperty("version").GetString() == "1.2.0" && failure.RootElement.EnumerateObject().Count() == 1, "a failed swap's marker names only the version");
    }
}
