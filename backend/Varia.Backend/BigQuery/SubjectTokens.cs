using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Xml;
using Google.Apis.Auth.OAuth2;
using Google.Apis.Http;
using Microsoft.Win32.SafeHandles;

namespace Varia.Backend.BigQuery;

/// <summary>
/// Subject tokens for workload and workforce identity federation's file and Azure sources. A file source rotates (projected
/// Kubernetes and OIDC tokens), so it is read again on every token exchange, under the rules the user's confirmation of
/// the file relies on: a regular file of at most 64 KiB that is none of Varia's own files (<see cref="RefusedRoots"/>) and no known
/// credential file (ADC, gcloud's configuration, a Google key, SSH and AWS credentials). Azure's token comes from its
/// instance metadata endpoint, pinned when the configuration was checked.
/// </summary>
internal sealed class SubjectTokens(IReadOnlyList<string> refusedRoots, string? adcFile = null)
{
    public const int MaxBytes = 64 * 1024;
    /// <summary>Directories whose files are never a subject token: Varia's user data (main passes it as VARIA_USER_DATA)
    /// and the usual homes of other credentials.</summary>
    public IReadOnlyList<string> RefusedRoots { get; } = refusedRoots;
    /// <summary>The file GOOGLE_APPLICATION_CREDENTIALS names, which is never a subject token either.</summary>
    public string? AdcFile { get; } = adcFile;

    /// <summary>The roots for this process: Varia's user data, gcloud's configuration directory, and the user's .ssh and .aws.</summary>
    public static SubjectTokens FromEnvironment()
    {
        var roots = new List<string>();
        if (Environment.GetEnvironmentVariable("VARIA_USER_DATA") is { Length: > 0 } userData && Path.IsPathFullyQualified(userData)) roots.Add(userData);
        roots.Add(GcloudDirectory());
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        if (home.Length > 0) { roots.Add(Path.Combine(home, ".ssh")); roots.Add(Path.Combine(home, ".aws")); }
        var adc = Environment.GetEnvironmentVariable("GOOGLE_APPLICATION_CREDENTIALS");
        return new(roots, adc is { Length: > 0 } && Path.IsPathFullyQualified(adc) ? adc : null);
    }

    /// <summary>gcloud's configuration directory: CLOUDSDK_CONFIG, else %APPDATA%\gcloud on Windows and ~/.config/gcloud elsewhere.</summary>
    public static string GcloudDirectory()
    {
        if (Environment.GetEnvironmentVariable("CLOUDSDK_CONFIG") is { Length: > 0 } configured) return configured;
        return OperatingSystem.IsWindows()
            ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "gcloud")
            : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".config", "gcloud");
    }

    public SubjectTokenSupplier For(JsonElement credentialSource, IHttpClientFactory http)
    {
        string? field = null;
        if (credentialSource.TryGetProperty("format", out var format) && format.TryGetProperty("type", out var type) && type.GetString() == "json")
            field = format.GetProperty("subject_token_field_name").GetString();
        if (credentialSource.TryGetProperty("file", out var file))
        {
            var path = file.GetString()!;
            return new(token => ReadFileAsync(path, token), field);
        }
        var url = credentialSource.GetProperty("url").GetString()!;
        return new(async token =>
        {
            using var client = http.CreateHttpClient(new CreateHttpClientArgs());
            using var request = new HttpRequestMessage(HttpMethod.Get, url);
            request.Headers.Add("Metadata", "True");
            using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, token);
            if (!response.IsSuccessStatusCode) throw new RequestException("AUTH_KEY_FILE", "Azure's instance metadata service did not issue a token (HTTP " + (int)response.StatusCode + ").");
            return await BoundedText(response, token);
        }, field ?? "access_token");
    }

    static async Task<string> BoundedText(HttpResponseMessage response, CancellationToken token)
    {
        await using var stream = await response.Content.ReadAsStreamAsync(token);
        var buffer = new byte[MaxBytes + 1];
        var read = 0;
        while (read < buffer.Length && await stream.ReadAsync(buffer.AsMemory(read), token) is var count and > 0) read += count;
        if (read > MaxBytes) throw new RequestException("AUTH_KEY_FILE", "The federated subject token is larger than 64 KiB.");
        return Encoding.UTF8.GetString(buffer, 0, read);
    }

    static RequestException Refused(string why) => new("AUTH_KEY_FILE", "The federation configuration's credential file " + why + ".");

    /// <summary>A full path on a local disk: never a UNC share or network drive (opening one sends the user's Windows
    /// credentials to that host) or a device or NT path (<c>\\?\</c>, <c>\\.\</c>, <c>\??\</c>). On Windows only a drive
    /// letter path with no <c>?</c> or <c>*</c>, on a fixed or removable drive; elsewhere one rooted at a single <c>/</c>.</summary>
    public static bool IsLocalPath(string path)
    {
        if (path.Length < 3 || path.Contains('\0')) return false;
        if (!OperatingSystem.IsWindows()) return path[0] == '/' && path[1] != '/' && !Automounted(path);
        if (!char.IsAsciiLetter(path[0]) || path[1] != ':' || path[2] is not ('\\' or '/') || path.IndexOfAny(['?', '*']) >= 0) return false;
        try { return new DriveInfo(path[..1]).DriveType is DriveType.Fixed or DriveType.Removable; }
        catch (ArgumentException) { return false; }
    }

    /// <summary>
    /// Whether a path lies under an automounter, where merely resolving it mounts a share from the host it names (macOS's
    /// <c>/net</c> and <c>/Network</c>, and on Linux every <c>autofs</c> mount point /proc/mounts lists, which reading
    /// contacts nothing).
    /// </summary>
    internal static bool Automounted(string path, IEnumerable<string>? autofsMounts = null, bool? caseInsensitive = null)
    {
        // macOS's APFS is case-insensitive, so /NET and /network name the same folders there.
        var comparison = caseInsensitive ?? OperatingSystem.IsMacOS() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
        bool Under(string path, string root) => path.Equals(root, comparison) || path.StartsWith(root.TrimEnd('/') + "/", comparison);
        var lexical = Path.GetFullPath(path);
        if (Under(lexical, "/net") || ((caseInsensitive ?? OperatingSystem.IsMacOS()) && Under(lexical, "/Network"))) return true;
        return (autofsMounts ?? AutofsMounts()).Any(root => Under(lexical, root));
    }

    /// <summary>The autofs mount points: Linux's from /proc/mounts (octal escapes such as \040 decoded), macOS's from
    /// getfsstat without waiting (neither contacts anything); none elsewhere.</summary>
    static IEnumerable<string> AutofsMounts()
    {
        if (OperatingSystem.IsMacOS()) return FinalPath.MacAutofsMounts();
        if (!OperatingSystem.IsLinux()) return [];
        try
        {
            return File.ReadLines("/proc/mounts").Select(line => line.Split(' ')).Where(fields => fields.Length > 2 && fields[2] == "autofs")
                .Select(fields => System.Text.RegularExpressions.Regex.Replace(fields[1], @"\\([0-7]{3})", match => ((char)Convert.ToInt32(match.Groups[1].Value, 8)).ToString())).ToArray();
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { return ["/"]; }
    }

    /// <summary>
    /// Reads a file source under the rules above, waiting at most <paramref name="wait"/> (a FIFO or a stalled disk fails
    /// the exchange instead of holding it). The message names the rule, never the path or the content.
    /// </summary>
    public async Task<string> ReadFileAsync(string path, CancellationToken token, TimeSpan? wait = null)
    {
        var read = Task.Run(() => ReadFile(path), CancellationToken.None);
        try { return await read.WaitAsync(wait ?? TimeSpan.FromSeconds(5), token); }
        catch (TimeoutException) { throw Refused("could not be read in time"); }
    }

    /// <summary>
    /// Reads a file source under the rules above. The rules are checked against the file's canonical path (links,
    /// junctions and short names resolved), so no other spelling of a refused folder reaches it.
    /// </summary>
    public string ReadFile(string path)
    {
        if (!IsLocalPath(path)) throw Refused("is not on a local disk");
        var comparison = OperatingSystem.IsWindows() || OperatingSystem.IsMacOS() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
        try
        {
            // A link (a folder's on the way, or the file's) that leads to a share would contact it as soon as anything touched
            // the path through it (sending Windows credentials, or mounting from an automounter elsewhere), so the links are
            // read first, from the root down, before any other use.
            if (LinksOffDisk(path)) throw Refused("is not on a local disk");
            if (Directory.Exists(path)) throw Refused("is not a regular file");
            if (OperatingSystem.IsWindows())
            {
                // Open, then check the path the open handle has: nothing can swap the file between check and read.
                using var handle = File.OpenHandle(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                if (FinalPath.FileType(handle) != FinalPath.DiskFile) throw Refused("is not a regular file");
                Check(FinalPath.Of(handle) ?? throw Refused("is not on a local disk"), comparison);
                return Read(handle);
            }
            var canonical = FinalPath.Real(path) ?? throw Refused(File.Exists(path) ? "could not be read" : "does not exist");
            if (Directory.Exists(canonical)) throw Refused("is not a regular file");
            Check(canonical, comparison);
            // Non-blocking, so a FIFO opens at once instead of waiting for a writer; a file that cannot seek is no regular file.
            using var descriptor = FinalPath.OpenNonBlocking(canonical) ?? throw Refused("could not be read");
            using var stream = new FileStream(descriptor, FileAccess.Read, 1);
            if (!stream.CanSeek) throw Refused("is not a regular file");
            return Read(descriptor);
        }
        catch (FileNotFoundException) { throw Refused("does not exist"); }
        catch (DirectoryNotFoundException) { throw Refused("does not exist"); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException) { throw Refused("could not be read"); }
    }

    /// <summary>Whether the file or any folder on its path is a link whose final target is not a local path.</summary>
    /// <remarks>
    /// Walks from the root down. Each part is read as a link without following it (<see cref="FileSystemInfo.LinkTarget"/>
    /// opens the link itself), and only after every part above it proved local, so nothing is followed before it is checked.
    /// At a link the walk starts again from its target joined with the rest of the path (at most 32 links in all); a target
    /// that is not a local path, or more links than that, counts as off the disk.
    /// </remarks>
    internal static bool LinksOffDisk(string path)
    {
        var links = 0;
        var pending = path;
        while (true)
        {
            if (!IsLocalPath(pending)) return true;
            var full = Path.GetFullPath(pending);
            var root = Path.GetPathRoot(full)!;
            // Off Windows a backslash is part of a name, not a separator.
            var parts = full[root.Length..].Split(OperatingSystem.IsWindows() ? ['\\', '/'] : ['/'], StringSplitOptions.RemoveEmptyEntries);
            var current = root;
            string? next = null;
            for (var index = 0; index < parts.Length && next is null; index++)
            {
                current = Path.Combine(current, parts[index]);
                if (new FileInfo(current).LinkTarget is not { } target) continue;
                // Every part before this one is a real folder (the walk restarts at each link), so a relative target is
                // resolved where the link really is; the rest of the path then continues from the link's target.
                if (++links > 32) return true;
                // .NET strips an absolute target's \??\ prefix, so an NT object path (a share through GLOBALROOT or UNC, a
                // volume by its GUID) comes back unrooted, like a relative target. None is a drive-letter path, so all count
                // as off the disk; a volume mounted in a folder is refused with them.
                if (OperatingSystem.IsWindows() && !Path.IsPathRooted(target) && NtObjectTarget(target)) return true;
                var resolved = Path.IsPathRooted(target) ? target : Path.Combine(Path.GetDirectoryName(current)!, target);
                next = Path.Combine([resolved, .. parts[(index + 1)..]]);
            }
            if (next is null) return false;
            pending = next;
        }
    }

    /// <summary>Whether an unrooted link target is an NT object path with its \??\ prefix removed.</summary>
    internal static bool NtObjectTarget(string target)
    {
        var first = target.Split(['\\', '/'], 2)[0];
        return first.Equals("GLOBALROOT", StringComparison.OrdinalIgnoreCase) || first.Equals("Global", StringComparison.OrdinalIgnoreCase)
            || first.Equals("UNC", StringComparison.OrdinalIgnoreCase) || first.StartsWith("Volume{", StringComparison.OrdinalIgnoreCase)
            || first.Equals("?", StringComparison.Ordinal) || first.Equals("??", StringComparison.Ordinal) || first.Contains(':');
    }

    void Check(string canonical, StringComparison comparison)
    {
        // Linux and macOS pseudo-filesystems: a process's environment, memory or another file descriptor, never a token.
        if (!OperatingSystem.IsWindows())
            foreach (var system in (string[])["/proc/", "/sys/", "/dev/"])
                if (canonical.StartsWith(system, StringComparison.Ordinal)) throw Refused("is a system file, not a subject token");
        foreach (var root in RefusedRoots)
            foreach (var spelling in Spellings(root))
                if (canonical.StartsWith(Path.TrimEndingDirectorySeparator(spelling) + Path.DirectorySeparatorChar, comparison))
                    throw Refused("is in a folder that holds other credentials or Varia's own files");
        if (AdcFile is { } adc && Spellings(adc).Any(spelling => string.Equals(spelling, canonical, comparison)))
            throw Refused("is the Application Default Credentials file");
    }

    /// <summary>A refused path as given and canonically (when it exists), so a root reached through a link still matches.</summary>
    static IEnumerable<string> Spellings(string path)
    {
        string full;
        try { full = Path.GetFullPath(path); } catch (Exception error) when (error is ArgumentException or NotSupportedException or PathTooLongException) { yield break; }
        yield return full;
        if (FinalPath.Canonical(full) is { } canonical && canonical != full) yield return canonical;
    }

    string Read(Microsoft.Win32.SafeHandles.SafeFileHandle handle)
    {
        if (RandomAccess.GetLength(handle) > MaxBytes) throw Refused("is larger than 64 KiB");
        var bytes = new byte[MaxBytes + 1];
        var read = 0;
        while (read < bytes.Length && RandomAccess.Read(handle, bytes.AsSpan(read), read) is var count and > 0) read += count;
        if (read > MaxBytes) throw Refused("is larger than 64 KiB");
        // Without its byte order mark (Notepad writes one), so a key saved that way is still recognised.
        var text = Encoding.UTF8.GetString(bytes, 0, read).TrimStart('﻿');
        if (LooksLikeGoogleCredential(text)) throw Refused("is a Google credential file, not a subject token");
        return text;
    }

    /// <summary>A Google key, ADC or configuration file: JSON whose <c>type</c> names a credential.</summary>
    static bool LooksLikeGoogleCredential(string text)
    {
        if (!text.TrimStart().StartsWith('{')) return false;
        try
        {
            using var document = JsonDocument.Parse(text, new JsonDocumentOptions { MaxDepth = 16 });
            return document.RootElement.ValueKind == JsonValueKind.Object && document.RootElement.TryGetProperty("type", out var type) && type.ValueKind == JsonValueKind.String
                && type.GetString() is "service_account" or "authorized_user" or "external_account" or "external_account_authorized_user" or "impersonated_service_account";
        }
        catch (JsonException) { return false; }
    }
}

/// <summary>
/// A file's canonical path: Windows' final path of an open handle (links, junctions, short names and mapped drives
/// resolved; null for a network share), and realpath elsewhere.
/// </summary>
internal static partial class FinalPath
{
    public const uint DiskFile = 1;
    const uint FileReadAttributes = 0x80, ShareAll = 7, OpenExisting = 3, BackupSemantics = 0x02000000;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern uint GetFinalPathNameByHandleW(SafeFileHandle file, [Out] char[] path, uint length, uint flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint GetFileType(SafeFileHandle file);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);

    [DllImport("libc", EntryPoint = "realpath", SetLastError = true)]
    static extern IntPtr RealPath([MarshalAs(UnmanagedType.LPUTF8Str)] string path, IntPtr resolved);

    [DllImport("libc", EntryPoint = "free")]
    static extern void Free(IntPtr pointer);

    [DllImport("libc", EntryPoint = "getfsstat")]
    static extern int GetFsStat(IntPtr buffer, int size, int flags);

    [DllImport("libc", EntryPoint = "getfsstat$INODE64")]
    static extern int GetFsStat64(IntPtr buffer, int size, int flags);

    // macOS's 64-bit-inode struct statfs: 2,168 bytes, f_fstypename (16) at 72 and f_mntonname (1,024) at 88.
    const int StatFsSize = 2168, TypeNameOffset = 72, MountOnOffset = 88, NoWait = 2;

    /// <summary>
    /// macOS's autofs mount points (the maps auto_master names, such as /net, /home and an administrator's own), from the
    /// mount table with MNT_NOWAIT, which asks no file system anything. Intel Macs export the 64-bit-inode layout under
    /// getfsstat$INODE64; Apple silicon only has that layout, as getfsstat.
    /// </summary>
    public static string[] MacAutofsMounts()
    {
        int Call(IntPtr buffer, int size) => RuntimeInformation.ProcessArchitecture == Architecture.X64 ? GetFsStat64(buffer, size, NoWait) : GetFsStat(buffer, size, NoWait);
        try
        {
            // A table that cannot be read in full may hide a map: then everything counts as automounted.
            var count = Call(IntPtr.Zero, 0);
            if (count <= 0 || count > 65536) return ["/"];
            // Room for mounts added between the two calls; a full buffer may have dropped some.
            var capacity = count + 64;
            var buffer = Marshal.AllocHGlobal(capacity * StatFsSize);
            try
            {
                var filled = Call(buffer, capacity * StatFsSize);
                if (filled <= 0 || filled >= capacity) return ["/"];
                var mounts = new List<string>();
                for (var index = 0; index < filled; index++)
                {
                    var entry = buffer + index * StatFsSize;
                    if (Marshal.PtrToStringUTF8(entry + TypeNameOffset) == "autofs" && Marshal.PtrToStringUTF8(entry + MountOnOffset) is { Length: > 0 } on) mounts.Add(on);
                }
                return [.. mounts];
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }
        catch (Exception error) when (error is EntryPointNotFoundException or DllNotFoundException) { return ["/"]; }
    }

    [DllImport("libc", EntryPoint = "open", SetLastError = true)]
    static extern int Open([MarshalAs(UnmanagedType.LPUTF8Str)] string path, int flags);

    /// <summary>open(2) read-only, non-blocking and close-on-exec (the flag values differ between Linux and macOS), or null.</summary>
    public static SafeFileHandle? OpenNonBlocking(string path)
    {
        var flags = OperatingSystem.IsMacOS() ? 0x4 | 0x1000000 : 0x800 | 0x80000;
        var descriptor = Open(path, flags);
        return descriptor < 0 ? null : new SafeFileHandle(descriptor, ownsHandle: true);
    }

    /// <summary>The handle's type: 1 for a disk file, otherwise a pipe, console or other device.</summary>
    public static uint FileType(SafeFileHandle handle) => GetFileType(handle);

    /// <summary>The final path of an open Windows handle, or null when it is not on a local volume.</summary>
    public static string? Of(SafeFileHandle handle)
    {
        var buffer = new char[1024];
        var length = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Length, 0);
        if (length > buffer.Length) { buffer = new char[length]; length = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Length, 0); }
        if (length == 0 || length > buffer.Length) return null;
        var path = new string(buffer, 0, (int)length);
        if (path.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) return null;
        return path.StartsWith(@"\\?\", StringComparison.Ordinal) ? path[4..] : null;
    }

    /// <summary>realpath(3): the path with every link resolved, or null when it does not resolve.</summary>
    public static string? Real(string path)
    {
        var result = RealPath(path, IntPtr.Zero);
        if (result == IntPtr.Zero) return null;
        try { return Marshal.PtrToStringUTF8(result); } finally { Free(result); }
    }

    /// <summary>A file's or directory's canonical path, or null when it cannot be resolved (it does not exist, say).</summary>
    public static string? Canonical(string path)
    {
        if (!OperatingSystem.IsWindows()) return Real(path);
        using var handle = CreateFileW(path, FileReadAttributes, ShareAll, IntPtr.Zero, OpenExisting, BackupSemantics, IntPtr.Zero);
        return handle.IsInvalid ? null : Of(handle);
    }
}

/// <summary>
/// The library's subject token provider for one credential: reads the token (a file again on every exchange, or Azure's
/// endpoint), takes the JSON field the configuration names, and keeps the subject the token carries. Once the connection
/// has pinned that subject, a token for another subject fails AUTH_IDENTITY rather than switching accounts.
/// </summary>
internal sealed class SubjectTokenSupplier(Func<CancellationToken, Task<string>> read, string? jsonField) : ProgrammaticExternalAccountCredential.ISubjectTokenProvider
{
    private readonly Lock gate = new();
    private string? pinned;

    /// <summary>The subject of the last token read (a JWT's <c>sub</c>, a SAML assertion's NameID), or null when it had none.</summary>
    public string? LastSubject { get; private set; }

    public void Pin(string subject) { lock (gate) pinned = subject; }

    public async Task<string> GetSubjectTokenAsync(ProgrammaticExternalAccountCredential caller, CancellationToken taskCancellationToken)
    {
        var text = await read(taskCancellationToken);
        var token = jsonField is null ? text.Trim() : Field(text, jsonField);
        if (token.Length == 0) throw new RequestException("AUTH_KEY_FILE", "The federated subject token is empty.");
        var subject = SubjectOf(token);
        lock (gate)
        {
            LastSubject = subject;
            if (pinned is not null && subject != pinned)
                throw new RequestException("AUTH_IDENTITY", "The federated credential now signs in as a different subject than this connection was opened with. Reconnect to use it.");
        }
        return token;
    }

    static string Field(string text, string field)
    {
        try
        {
            using var document = JsonDocument.Parse(text, new JsonDocumentOptions { MaxDepth = 16 });
            if (document.RootElement.ValueKind == JsonValueKind.Object && document.RootElement.TryGetProperty(field, out var value) && value.ValueKind == JsonValueKind.String)
                return value.GetString()!;
        }
        catch (JsonException) { }
        throw new RequestException("AUTH_KEY_FILE", "The federated subject token is not the JSON the configuration describes.");
    }

    /// <summary>A JWT's <c>sub</c>, or a base64 SAML assertion's NameID; null for anything else.</summary>
    public static string? SubjectOf(string token)
    {
        var parts = token.Split('.');
        if (parts.Length == 3)
        {
            try
            {
                var payload = parts[1].Replace('-', '+').Replace('_', '/');
                payload = payload.PadRight(payload.Length + (4 - payload.Length % 4) % 4, '=');
                using var document = JsonDocument.Parse(Convert.FromBase64String(payload));
                return document.RootElement.ValueKind == JsonValueKind.Object && document.RootElement.TryGetProperty("sub", out var sub) && sub.ValueKind == JsonValueKind.String
                    && sub.GetString() is { Length: > 0 } value ? value : null;
            }
            catch (Exception error) when (error is FormatException or JsonException) { return null; }
        }
        try
        {
            var xml = Convert.FromBase64String(token);
            var settings = new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = SubjectTokens.MaxBytes * 2 };
            using var reader = XmlReader.Create(new MemoryStream(xml), settings);
            while (reader.Read())
                if (reader.NodeType == XmlNodeType.Element && reader.LocalName == "NameID")
                    return reader.ReadElementContentAsString().Trim() is { Length: > 0 } name ? name : null;
        }
        catch (Exception error) when (error is FormatException or XmlException) { }
        return null;
    }

    /// <summary>A stable, nonsecret fingerprint of a long subject, for a pin over its length limit.</summary>
    public static string Fingerprint(string value) => "sha256:" + Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));
}
