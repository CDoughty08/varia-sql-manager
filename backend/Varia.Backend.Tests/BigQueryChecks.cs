using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Varia.Backend.BigQuery;

namespace Varia.Backend.Tests;

/// <summary>
/// The BigQuery engine offline (docs/bigquery.md, Testing): connect, disconnect and the pre-connect methods through
/// SqlService.DispatchAsync against <see cref="BigQueryFake"/>, for every sign-in mode, identity pin and error row. No
/// request leaves the process: every check ends with the fake's unmatched list empty.
/// </summary>
internal static partial class BigQueryChecks
{
    static readonly JsonSerializerOptions Wire = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull, UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow
    };

    /// <summary>An unsigned JSON Web Token for a subject (the fake STS never checks signatures).</summary>
    public static string Jwt(string subject) => Base64Url("{\"alg\":\"RS256\",\"typ\":\"JWT\"}") + "." + Base64Url("{\"sub\":\"" + subject + "\",\"aud\":\"varia\"}") + ".c2lnbmF0dXJl";
    static string Base64Url(string text) => Convert.ToBase64String(Encoding.UTF8.GetBytes(text)).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    sealed class Harness : IDisposable
    {
        public BigQueryFake Fake { get; }
        public SqlService Service { get; }
        public Harness(BigQueryFake? fake = null, Uri? endpoint = null, SubjectTokens? subjects = null)
        {
            Fake = fake ?? BigQueryFake.Google();
            Service = new SqlService(CheckStores.Unprobed(), bigQuery: new BigQueryEnvironment(endpoint, Fake.Factory, subjects ?? new SubjectTokens([])));
        }
        public async Task<(string Code, JsonElement Result, string Message)> Call(string method, JsonNode parameters)
        {
            using var document = JsonDocument.Parse(parameters.ToJsonString());
            try
            {
                var result = await Service.DispatchAsync(method, document.RootElement.Clone(), Wire);
                return ("ok", JsonSerializer.SerializeToElement(result, result.GetType(), Wire), "");
            }
            catch (RequestException error) { return (error.Code, default, error.Message); }
            catch (JsonException) { return ("INVALID_PARAMS", default, ""); }
        }
        public void Dispose() => Service.Dispose();
    }

    static JsonObject Connect(string authentication, string source, JsonNode? json, string? keyFile = null, Action<JsonObject>? change = null)
    {
        var options = new JsonObject
        {
            ["provider"] = "bigquery", ["project"] = "varia-alpha", ["authentication"] = authentication,
            ["credential"] = json is null ? new JsonObject { ["source"] = source } : new JsonObject { ["source"] = source, ["json"] = json.ToJsonString() }
        };
        if (keyFile is not null) options["keyFile"] = keyFile;
        change?.Invoke(options);
        return options;
    }

    static JsonObject KeyConnect(JsonObject key, Action<JsonObject>? change = null) => Connect("serviceAccountKey", "file", key, Guid.NewGuid().ToString(), change);
    static JsonObject AdcConnect(JsonNode file, Action<JsonObject>? change = null) => Connect("gcloud", "adc", file, change: change);
    static JsonObject FederationConnect(JsonNode file) => Connect("externalAccount", "file", file, Guid.NewGuid().ToString());
    static JsonObject Args(JsonObject connect, string? pageToken = null)
    {
        var args = new JsonObject { ["authentication"] = connect["authentication"]!.DeepClone(), ["credential"] = connect["credential"]!.DeepClone() };
        if (connect["keyFile"] is { } keyFile) args["keyFile"] = keyFile.DeepClone();
        if (pageToken is not null) args["pageToken"] = pageToken;
        return args;
    }

    static string[] Datasets(JsonElement value) => value.ValueKind == JsonValueKind.Array ? value.EnumerateArray().Select(dataset => Text(dataset, "name") + "@" + Text(dataset, "location")).ToArray() : [];

    static string Text(JsonElement value, string name) => value.ValueKind == JsonValueKind.Object && value.TryGetProperty(name, out var member) && member.ValueKind == JsonValueKind.String ? member.GetString()! : "";

    public static async Task RunAsync(Action<bool, string> check)
    {
        using var rsa = System.Security.Cryptography.RSA.Create(2048);
        var key = BigQueryCredentialChecks.Key(rsa.ExportPkcs8PrivateKeyPem());
        var temp = Directory.CreateTempSubdirectory("varia-bigquery-");
        try
        {
            FileGuards(check, temp.FullName, key);
            await ConnectAsync(check, key);
            await PinsAsync(check, key, temp.FullName);
            await ErrorsAsync(check, key);
            await PreConnectAsync(check, key);
            await EmulatorAsync(check);
            await DryRunAsync(check, key);
        }
        finally { temp.Delete(recursive: true); }
    }

    /// <summary>The rules a federation file source is read under on every exchange (with the Connect dialog's confirmation
    /// as the first guard): a regular file of at most 64 KiB, none of Varia's own files, no known credential file. A refusal names the
    /// rule, never the path or the content.</summary>
    static void FileGuards(Action<bool, string> check, string temp, JsonObject key)
    {
        var root = Directory.CreateDirectory(Path.Combine(temp, "guards")).FullName;
        string Make(string relative, string text)
        {
            var path = Path.Combine(root, relative);
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.WriteAllText(path, text);
            return path;
        }
        var userData = Path.Combine(root, "varia-user-data");
        var gcloud = Path.Combine(root, "gcloud");
        var ssh = Path.Combine(root, "home", ".ssh");
        var aws = Path.Combine(root, "home", ".aws");
        var adc = Make(Path.Combine("adc", "credentials.jwt"), BigQueryCredentialChecks.Secret);
        var tokens = new SubjectTokens([userData, gcloud, ssh, aws], adc);
        string Outcome(string path)
        {
            try { return "ok:" + tokens.ReadFile(path); }
            catch (RequestException error) { return error.Code + ": " + error.Message; }
        }
        var token = Jwt("workload-1");
        check(Outcome(Make("token.jwt", token)) == "ok:" + token, "a regular file source of at most 64 KiB is read");
        check(Outcome(Make("exact.jwt", new string('t', SubjectTokens.MaxBytes))).StartsWith("ok:", StringComparison.Ordinal), "a file source of exactly 64 KiB is read");
        (string Path, string Rule, string Name)[] refused =
        [
            (Make("big.jwt", new string('t', SubjectTokens.MaxBytes + 1)), "is larger than 64 KiB", "a file over 64 KiB"),
            (Directory.CreateDirectory(Path.Combine(root, "folder.jwt")).FullName, "is not a regular file", "a directory"),
            (Path.Combine(root, "missing.jwt"), "does not exist", "a missing file"),
            (Make(Path.Combine("varia-user-data", "settings.json"), BigQueryCredentialChecks.Secret), "is in a folder that holds other credentials or Varia's own files", "a file in Varia's user data"),
            (Make(Path.Combine("varia-user-data", "deep", "mssql-saved-passwords.json"), BigQueryCredentialChecks.Secret), "is in a folder that holds other credentials or Varia's own files", "a file deep in Varia's user data"),
            (Make(Path.Combine("gcloud", "application_default_credentials.json"), BigQueryCredentialChecks.Secret), "is in a folder that holds other credentials or Varia's own files", "gcloud's ADC file"),
            (Make(Path.Combine("home", ".ssh", "id_ed25519"), BigQueryCredentialChecks.Secret), "is in a folder that holds other credentials or Varia's own files", "an SSH key"),
            (Make(Path.Combine("home", ".aws", "credentials"), BigQueryCredentialChecks.Secret), "is in a folder that holds other credentials or Varia's own files", "AWS credentials"),
            (adc, "is the Application Default Credentials file", "the file GOOGLE_APPLICATION_CREDENTIALS names"),
            (Make("key.json", key.ToJsonString()), "is a Google credential file, not a subject token", "a Google service account key elsewhere"),
            (Make("user.json", BigQueryCredentialChecks.User().ToJsonString()), "is a Google credential file, not a subject token", "a gcloud user credential elsewhere"),
        ];
        foreach (var (path, rule, name) in refused)
        {
            var outcome = Outcome(path);
            check(outcome == "AUTH_KEY_FILE: The federation configuration's credential file " + rule + "." && !outcome.Contains(root, StringComparison.OrdinalIgnoreCase),
                $"{name} is refused as a federation file source, naming the rule only: {outcome}");
        }
        // A link into a refused folder is judged by its target.
        var link = Path.Combine(root, "link.jwt");
        try { File.CreateSymbolicLink(link, Path.Combine(ssh, "id_ed25519")); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { link = ""; }
        if (link.Length > 0)
            check(Outcome(link).Contains("is in a folder that holds other credentials", StringComparison.Ordinal), "a link to an SSH key is refused by its target");
        // A folder link or junction into a refused folder is judged by where it leads, as is a link to a refused root.
        var folderLink = Path.Combine(root, "folder-link");
        if (FolderLink(folderLink, ssh))
            check(Outcome(Path.Combine(folderLink, "id_ed25519")).Contains("is in a folder that holds other credentials", StringComparison.Ordinal),
                "a file reached through a folder link or junction into .ssh is refused by its canonical path");
        else check(true, "a folder link could not be created here; the canonical path check is covered elsewhere");
        var linkedRoot = Path.Combine(root, "linked-root");
        if (FolderLink(linkedRoot, ssh))
        {
            var throughLink = new SubjectTokens([linkedRoot]);
            string LinkedOutcome(string path) { try { return "ok:" + throughLink.ReadFile(path); } catch (RequestException error) { return error.Message; } }
            check(LinkedOutcome(Path.Combine(ssh, "id_ed25519")).Contains("is in a folder that holds other credentials", StringComparison.Ordinal),
                "a refused root given through a link still refuses the files of the folder it leads to");
        }
        // UNC shares and device paths are refused before anything opens them (a share would receive the user's credentials).
        foreach (var path in (string[])[@"\\files.example.com\share\token.jwt", "//files.example.com/share/token.jwt", @"\\?\" + Path.Combine(root, "token.jwt"), @"\\.\pipe\token",
            @"\??\UNC\files.example.com\share\token.jwt", @"\??\C:\token.jwt", @"\/files.example.com/share/token.jwt",
            // Off Windows a backslash is an ordinary character, so this one is a local path there.
            .. (OperatingSystem.IsWindows() ? (string[])[@"/\files.example.com\share\token.jwt"] : [])])
            check(Outcome(path) == "AUTH_KEY_FILE: The federation configuration's credential file is not on a local disk.", "a UNC, device or NT path is refused unopened: " + Outcome(path));
        // A key saved with a byte order mark is still recognised as a key, never sent as a subject token.
        check(Outcome(Make("bom-key.json", "\uFEFF" + key.ToJsonString())) == "AUTH_KEY_FILE: The federation configuration's credential file is a Google credential file, not a subject token.",
            "a service account key saved with a byte order mark is refused as a file source");
        if (OperatingSystem.IsWindows())
        {
            // A file link whose target is a share is refused before the open that would contact it.
            var shareLink = Path.Combine(root, "share-link.jwt");
            try { File.CreateSymbolicLink(shareLink, @"\\files.example.com\share\token.jwt"); }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException) { shareLink = ""; }
            if (shareLink.Length > 0)
            {
                check(Outcome(shareLink) == "AUTH_KEY_FILE: The federation configuration's credential file is not on a local disk.", "a link to a share is refused: " + Outcome(shareLink));
                // The walk reads link text only: a link to a share counts as off the disk, and so does a path beneath one.
                check(SubjectTokens.LinksOffDisk(shareLink) && SubjectTokens.LinksOffDisk(Path.Combine(shareLink, "deeper", "token.jwt")),
                    "the link walk finds a share behind a link from its text, on the link and beneath it");
            }
            else check(true, "symbolic links need a privilege here; the walk's local cases are checked below");
            // Junctions only reach local volumes; a chain of them (one through another) stays on the disk, and the walk
            // follows each hop's own text, so the walk and the read accept a file reached that way.
            var outer = Path.Combine(root, "junction-outer");
            var inner = Path.Combine(root, "junction-inner");
            var real = Directory.CreateDirectory(Path.Combine(root, "junction-real")).FullName;
            File.WriteAllText(Path.Combine(real, "token.jwt"), token);
            if (FolderLink(inner, real) && FolderLink(outer, inner))
            {
                var chained = Path.Combine(outer, "token.jwt");
                check(!SubjectTokens.LinksOffDisk(chained) && Outcome(chained) == "ok:" + token, "a file reached through a chain of local junctions is read: " + Outcome(chained));
            }
            check(SubjectTokens.LinksOffDisk(@"\\files.example.com\share\token.jwt"), "the link walk counts a share path itself as off the disk");
            // Link text .NET returns without its \??\ prefix: an NT object path, never mistaken for a relative target.
            check(SubjectTokens.NtObjectTarget(@"GLOBALROOT\Device\Mup\files.example.com\share\t") && SubjectTokens.NtObjectTarget(@"Global\UNC\files.example.com\share\t")
                && SubjectTokens.NtObjectTarget(@"UNC\files.example.com\share") && SubjectTokens.NtObjectTarget(@"Volume{00000000-0000-0000-0000-000000000000}\")
                && !SubjectTokens.NtObjectTarget(@"..\y") && !SubjectTokens.NtObjectTarget("tokens"), "NT object link targets are told apart from relative ones");
            // A junction to a volume by its GUID (a mount point) comes back unrooted; the walk counts it as off the disk.
            var volume = Path.Combine(root, "volume-junction");
            using (var mountvol = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("mountvol", [Path.GetPathRoot(root)!, "/L"]) { RedirectStandardOutput = true, UseShellExecute = false })!)
            {
                var guid = mountvol.StandardOutput.ReadToEnd().Trim();
                mountvol.WaitForExit();
                if (guid.StartsWith(@"\\?\Volume{", StringComparison.Ordinal) && FolderLink(volume, guid))
                {
                    // The junction leads to a whole volume: remove the link itself (not recursively) as soon as it is checked.
                    try
                    {
                        check(SubjectTokens.LinksOffDisk(Path.Combine(volume, "token.jwt")) && Outcome(Path.Combine(volume, "token.jwt")).EndsWith("is not on a local disk.", StringComparison.Ordinal),
                            "a file beneath a volume-GUID junction is refused by the link walk: " + Outcome(Path.Combine(volume, "token.jwt")));
                    }
                    finally { Directory.Delete(volume, recursive: false); }
                }
                else check(true, "no volume-GUID junction could be made here");
            }
            // A relative link beneath a junction resolves where the link really is: the junction's target, not the written path.
            var deep = Directory.CreateDirectory(Path.Combine(root, "x", "deep")).FullName;
            var junction = Path.Combine(root, "t-junction");
            try
            {
                File.CreateSymbolicLink(Path.Combine(root, "x", "y"), @"\\files.example.com\share");
                Directory.CreateSymbolicLink(Path.Combine(deep, "b"), @"..\y");
                if (FolderLink(junction, deep))
                    check(SubjectTokens.LinksOffDisk(Path.Combine(junction, "b", "token.jwt")), "a relative link beneath a junction is resolved from the junction's target and found to lead to a share");
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException) { check(true, "symbolic links need a privilege here"); }
        }
        if (!OperatingSystem.IsWindows())
        {
            // An automounter mounts a share from the host a path names as soon as the path is resolved: /net (and the autofs
            // mount points /proc/mounts lists) are refused before any filesystem call, and so is a link leading there.
            check(Outcome("/net/files.example.com/export/token.jwt") == "AUTH_KEY_FILE: The federation configuration's credential file is not on a local disk.",
                "a path under /net is refused before anything resolves it: " + Outcome("/net/files.example.com/export/token.jwt"));
            check(SubjectTokens.Automounted("/home/auto/files/token.jwt", ["/home/auto"]) && SubjectTokens.Automounted("/home/auto", ["/home/auto"])
                && !SubjectTokens.Automounted("/home/autox/token.jwt", ["/home/auto"]) && !SubjectTokens.Automounted(Path.Combine(root, "token.jwt"), []),
                "an autofs mount point and paths beneath it count as automounted, and a sibling with the same prefix does not");
            // macOS: its own maps (the Data-volume path included) come from the mount table, compared without case, as APFS does.
            check(SubjectTokens.Automounted("/System/Volumes/Data/net/files.example.com/t", ["/System/Volumes/Data/net"], caseInsensitive: true)
                && SubjectTokens.Automounted("/network/servers/files.example.com/t", [], caseInsensitive: true) && SubjectTokens.Automounted("/NET/files.example.com/t", [], caseInsensitive: true)
                && SubjectTokens.Automounted("/volumes/CORP/t", ["/Volumes/corp"], caseInsensitive: true) && !SubjectTokens.Automounted("/NET/files.example.com/t", [], caseInsensitive: false),
                "on a case-insensitive disk an automount map matches in any case, and the Data-volume path of a map is refused");
            if (OperatingSystem.IsMacOS())
            {
                // Every stock macOS mounts auto_master's maps (auto_home and -hosts) as autofs, so an empty answer means the
                // struct layout, entry point or flag is wrong.
                var macMounts = FinalPath.MacAutofsMounts();
                check(macMounts.Any(mount => mount.EndsWith("/home", StringComparison.Ordinal) || mount.EndsWith("/net", StringComparison.Ordinal)),
                    "macOS's mount table lists its autofs maps: " + string.Join(", ", macMounts));
            }
            var netLink = Path.Combine(root, "net-link");
            Directory.CreateSymbolicLink(netLink, "/net/files.example.com/export");
            check(Outcome(Path.Combine(netLink, "token.jwt")) == "AUTH_KEY_FILE: The federation configuration's credential file is not on a local disk.",
                "a link into /net is refused from its text before it is followed: " + Outcome(Path.Combine(netLink, "token.jwt")));
            // macOS has no /proc; /dev is refused on every Unix.
            if (OperatingSystem.IsLinux())
                check(Outcome("/proc/self/environ") == "AUTH_KEY_FILE: The federation configuration's credential file is a system file, not a subject token.",
                    "a process's environment under /proc is refused: " + Outcome("/proc/self/environ"));
            check(Outcome("/dev/null") == "AUTH_KEY_FILE: The federation configuration's credential file is a system file, not a subject token.",
                "a device under /dev is refused: " + Outcome("/dev/null"));
            var systemLink = Path.Combine(root, "environ.jwt");
            File.CreateSymbolicLink(systemLink, OperatingSystem.IsLinux() ? "/proc/self/environ" : "/dev/null");
            check(Outcome(systemLink).Contains("is a system file", StringComparison.Ordinal), "a link to a system file is refused by its target: " + Outcome(systemLink));
            // A FIFO would hold the exchange (and a thread) until a writer came; it is refused at once, with no writer.
            var fifo = Path.Combine(root, "fifo.jwt");
            using (var mkfifo = System.Diagnostics.Process.Start("mkfifo", [fifo])) mkfifo.WaitForExit();
            if (File.Exists(fifo))
            {
                string waited;
                var clock = System.Diagnostics.Stopwatch.StartNew();
                try { waited = "ok:" + tokens.ReadFileAsync(fifo, CancellationToken.None, TimeSpan.FromSeconds(30)).GetAwaiter().GetResult(); }
                catch (RequestException error) { waited = error.Message; }
                check(waited == "The federation configuration's credential file is not a regular file." && clock.Elapsed < TimeSpan.FromSeconds(10),
                    "a FIFO is refused without waiting for a writer: " + waited);
            }
        }
        // A prefix that is not the folder itself is not refused.
        check(Outcome(Make(Path.Combine("varia-user-data-other", "token.jwt"), token)) == "ok:" + token, "a sibling folder whose name only starts like a refused one is read");
    }

    /// <summary>Runs <paramref name="run"/> with the named environment variables set (null clears one), then restores them.</summary>
    static async Task<T> WithEnvironment<T>(string[] names, string?[] values, Func<Task<T>> run)
    {
        var previous = names.Select(Environment.GetEnvironmentVariable).ToArray();
        for (var index = 0; index < names.Length; index++) Environment.SetEnvironmentVariable(names[index], values[index]);
        try { return await run(); }
        finally { for (var index = 0; index < names.Length; index++) Environment.SetEnvironmentVariable(names[index], previous[index]); }
    }

    /// <summary>A folder link: a junction on Windows (no privilege needed), a symbolic link elsewhere. False when it cannot be made.</summary>
    static bool FolderLink(string link, string target)
    {
        Directory.CreateDirectory(target);
        try
        {
            if (!OperatingSystem.IsWindows()) { Directory.CreateSymbolicLink(link, target); return true; }
            using var mklink = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("cmd.exe", ["/c", "mklink", "/J", link, target]) { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false })!;
            mklink.WaitForExit();
            return mklink.ExitCode == 0 && Directory.Exists(link);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or System.ComponentModel.Win32Exception) { return false; }
    }

    static void Clean(Action<bool, string> check, BigQueryFake fake, string name) =>
        check(fake.Unmatched.IsEmpty, name + ": no request went anywhere the fake does not answer: " + string.Join(", ", fake.Unmatched.Select(request => request.Method + " " + request.Url)));

    static async Task ConnectAsync(Action<bool, string> check, JsonObject key)
    {
        using var harness = new Harness();
        var fake = harness.Fake;
        var (code, info, message) = await harness.Call("connections.connect", KeyConnect(key, options => { options["dataset"] = "sales"; options["displayName"] = "Analytics"; }));
        var id = Text(info, "id");
        check(code == "ok" && Text(info, "server") == "varia-alpha" && Text(info, "database") == "sales" && Text(info, "serverVersion") == "BigQuery"
            && Text(info, "login") == BigQueryCredentialChecks.ServiceAccount && Text(info, "principalId") == "bigquery:serviceAccount:" + BigQueryCredentialChecks.ServiceAccount
            && Text(info, "providerId") == "bigquery" && Text(info, "displayName") == "Analytics",
            $"a service account key connects: the project is the server, the dataset the database, the key's email the login and pin: {code} {message} {info}");
        var tokenRequest = fake.To(BigQueryFake.Token).FirstOrDefault();
        check(tokenRequest?.Form("grant_type") == "urn:ietf:params:oauth:grant-type:jwt-bearer" && tokenRequest.Form("assertion")?.Split('.').Length == 3,
            "the key signs a JWT assertion for a token at the pinned token URI");
        var probe = fake.To(BigQueryFake.Jobs).FirstOrDefault();
        var body = probe is null ? default : JsonDocument.Parse(probe.Body).RootElement;
        check(probe is not null && probe.Url.EndsWith("/projects/varia-alpha/jobs", StringComparison.Ordinal) && probe.Header("Authorization") == "Bearer ya29.fake-access-token"
            && body.GetProperty("configuration").GetProperty("dryRun").GetBoolean() && body.GetProperty("configuration").GetProperty("query").GetProperty("query").GetString() == "SELECT 1"
            && !body.GetProperty("configuration").GetProperty("query").GetProperty("useLegacySql").GetBoolean()
            && body.GetProperty("configuration").GetProperty("labels").GetProperty("varia_client").GetString() == "varia"
            && probe.Header("User-Agent")?.Contains(BigQueryService.ApplicationName, StringComparison.Ordinal) == true,
            "the connect probe is a labelled GoogleSQL dry run of SELECT 1 in the billing project, signed with the key's token");
        check(fake.To(BigQueryFake.Jobs).Count() == 1 && fake.To(BigQueryFake.Datasets).Count() == 1 && harness.Service.BigQuery.Find(id)?.Location == "EU",
            "connect probes once and takes the default dataset's location when the options name none");
        var (listed, datasets, listMessage) = await harness.Call("databases.list", new JsonObject { ["connectionId"] = id });
        check(listed == "ok" && Datasets(datasets).SequenceEqual(["archive@us-east1", "sales@", "staging@US"]) && fake.To(BigQueryFake.DatasetList).Count() == 2
            && fake.To(BigQueryFake.DatasetList).First().Uri.Query.Contains("maxResults=1000", StringComparison.Ordinal),
            $"databases.list for a BigQuery handle lists every page of the billing project's datasets by name, dropping names BigQuery refuses and locations that are not ids: {listed} {listMessage} {datasets}");
        var (columns, _, _) = await harness.Call("tables.columns", new JsonObject { ["connectionId"] = id, ["database"] = "sales", ["schema"] = "dbo", ["name"] = "t" });
        check(columns == "UNSUPPORTED_PROVIDER", $"a SQL Server-only method for a BigQuery handle is refused with UNSUPPORTED_PROVIDER: {columns}");
        var (closed, disconnected, _) = await harness.Call("connections.disconnect", new JsonObject { ["connectionId"] = id });
        var (again, twice, _) = await harness.Call("connections.disconnect", new JsonObject { ["connectionId"] = id });
        check(closed == "ok" && disconnected.GetProperty("disconnected").GetBoolean() && again == "ok" && !twice.GetProperty("disconnected").GetBoolean() && harness.Service.BigQuery.Count == 0,
            "disconnect removes the BigQuery handle once; a second disconnect reports none");

        var located = await harness.Call("connections.connect", KeyConnect(key, options => { options["dataset"] = "sales"; options["location"] = "us-east1"; }));
        check(located.Code == "ok" && fake.To(BigQueryFake.Datasets).Count() == 1 && harness.Service.BigQuery.Find(Text(located.Result, "id"))?.Location == "us-east1"
            && fake.To(BigQueryFake.Jobs).Last().Body.Contains("\"location\":\"us-east1\"", StringComparison.Ordinal),
            "a location in the options is used for the probe and skips the dataset lookup");
        var (refused, _, _) = await harness.Call("connections.connect", KeyConnect(key, options => options["project"] = "Not-A-Project"));
        check(refused == "INVALID_PARAMS", $"invalid BigQuery options are refused before any request: {refused}");
        Clean(check, fake, "connect");
    }

    static async Task PinsAsync(Action<bool, string> check, JsonObject key, string temp)
    {
        async Task<(string Code, JsonElement Info, string Message, BigQueryFake Fake)> Open(JsonObject options, BigQueryFake? fake = null, SubjectTokens? subjects = null)
        {
            using var harness = new Harness(fake, subjects: subjects);
            var (code, info, message) = await harness.Call("connections.connect", options);
            Clean(check, harness.Fake, "pin " + options["authentication"]);
            return (code, info, message, harness.Fake);
        }

        var user = await Open(AdcConnect(BigQueryCredentialChecks.User()));
        check(user.Code == "ok" && Text(user.Info, "login") == "ada@example.com" && Text(user.Info, "principalId") == "bigquery:user:ada@example.com"
            && user.Fake.To(BigQueryFake.Token).First().Form("grant_type") == "refresh_token" && user.Fake.To(BigQueryFake.TokenInfo).First().Form("access_token") == "ya29.fake-access-token",
            $"gcloud's user ADC pins the email tokeninfo names for the refreshed token: {user.Code} {user.Message} {user.Info}");

        var metadata = await Open(Connect("gcloud", "metadata", null));
        check(metadata.Code == "ok" && Text(metadata.Info, "principalId") == "bigquery:computeEngine:vm-runner@varia-alpha.iam.gserviceaccount.com"
            && metadata.Fake.To(BigQueryFake.MetadataEmail).All(request => request.Header("Metadata-Flavor") == "Google"),
            $"ADC on a Google Cloud VM pins the metadata server's service account: {metadata.Code} {metadata.Message} {metadata.Info}");
        // GCE_METADATA_HOST would move the library's default token URL to any host; Varia's is fixed to the link-local address.
        var previousHost = Environment.GetEnvironmentVariable("GCE_METADATA_HOST");
        Environment.SetEnvironmentVariable("GCE_METADATA_HOST", "metadata-elsewhere.example.com");
        try
        {
            var moved = await Open(Connect("gcloud", "metadata", null));
            check(moved.Code == "ok" && moved.Fake.Seen.All(request => !request.Url.Contains("metadata-elsewhere", StringComparison.Ordinal))
                && moved.Fake.Seen.Any(request => request.Url == BigQueryIdentity.MetadataTokenUrl),
                $"GCE_METADATA_HOST cannot move the metadata server's token request to another host: {moved.Code} {moved.Message}");
        }
        finally { Environment.SetEnvironmentVariable("GCE_METADATA_HOST", previousHost); }
        // Anything on the network may answer the metadata address off-cloud; an answer over 64 KiB is refused, not held.
        // Environment that would move Google's hosts: the universe for BigQuery itself, and the metadata host for the
        // universe an impersonation takes its IAM host from. Every request stays on Google's own hosts.
        var previousUniverse = Environment.GetEnvironmentVariable("GOOGLE_CLOUD_UNIVERSE_DOMAIN");
        var previousMetadataHost = Environment.GetEnvironmentVariable("GCE_METADATA_HOST");
        Environment.SetEnvironmentVariable("GOOGLE_CLOUD_UNIVERSE_DOMAIN", "universe-elsewhere.example.com");
        Environment.SetEnvironmentVariable("GCE_METADATA_HOST", "metadata-elsewhere.example.com");
        try
        {
            static bool GoogleOnly(BigQueryFake fake) => fake.Unmatched.IsEmpty && fake.Seen.All(request => !request.Url.Contains("elsewhere", StringComparison.Ordinal));
            var universe = await Open(KeyConnect(key));
            check(universe.Code == "ok" && GoogleOnly(universe.Fake) && universe.Fake.To(BigQueryFake.Jobs).Any(),
                $"GOOGLE_CLOUD_UNIVERSE_DOMAIN cannot move BigQuery or its token to another host: {universe.Code} {universe.Message}");
            var metadataImpersonation = await Open(Connect("gcloud", "metadata", null, change: options => options["impersonateServiceAccount"] = BigQueryCredentialChecks.Target));
            check(metadataImpersonation.Code == "ok" && GoogleOnly(metadataImpersonation.Fake) && metadataImpersonation.Fake.To(BigQueryFake.Impersonate).Any(),
                $"impersonating from the metadata server's account asks Google's IAM host, whatever the environment names: {metadataImpersonation.Code} {metadataImpersonation.Message}");
        }
        finally
        {
            Environment.SetEnvironmentVariable("GOOGLE_CLOUD_UNIVERSE_DOMAIN", previousUniverse);
            Environment.SetEnvironmentVariable("GCE_METADATA_HOST", previousMetadataHost);
        }
        var huge = await Open(Connect("gcloud", "metadata", null), BigQueryFake.Google()
            .On("GET", BigQueryFake.MetadataEmail, BigQueryFake.Text(new string('a', 70 * 1024), new Dictionary<string, string> { ["Metadata-Flavor"] = "Google" })));
        check(huge.Code == "AUTH_IDENTITY", $"a metadata answer over 64 KiB fails the sign-in with AUTH_IDENTITY: {huge.Code} {huge.Message}");
        var none = BigQueryFake.Google();
        none.Fault = request => request.Url.Contains("169.254.169.254", StringComparison.Ordinal) ? new HttpRequestException("no route") : null;
        var absent = await Open(Connect("gcloud", "metadata", null), none);
        check(absent.Code == "AUTH_EXPIRED" && absent.Message == BigQueryErrors.NoCredentials, $"ADC with no file and no metadata server answers AUTH_EXPIRED telling how to sign in: {absent.Code} {absent.Message}");

        // Federation: the file is read again on every exchange, and its subject is pinned.
        string Write(string name, string text) { var path = Path.Combine(temp, name); File.WriteAllText(path, text); return path; }
        var jwtPath = Write("token.jwt", Jwt("workload-1"));
        var external = await Open(FederationConnect(BigQueryCredentialChecks.External(new JsonObject { ["file"] = jwtPath })));
        var exchange = external.Fake.To(BigQueryFake.Sts).FirstOrDefault();
        check(external.Code == "ok" && Text(external.Info, "login") == "workload-1"
            && Text(external.Info, "principalId") == "bigquery:" + BigQueryIdentity.Pin("external", BigQueryCredentialChecks.Audience + "|workload-1")
            && exchange?.Form("subject_token") == Jwt("workload-1") && exchange.Form("audience") == BigQueryCredentialChecks.Audience
            && external.Fake.To(BigQueryFake.Jobs).First().Header("Authorization") == "Bearer ya29.sts-access-token",
            $"a federation file source exchanges its JWT at STS and pins audience and subject: {external.Code} {external.Message} {external.Info}");
        var jsonPath = Write("token.json", "{\"id_token\":\"" + Jwt("workload-json") + "\"}");
        var fromJson = await Open(FederationConnect(BigQueryCredentialChecks.External(new JsonObject { ["file"] = jsonPath, ["format"] = new JsonObject { ["type"] = "json", ["subject_token_field_name"] = "id_token" } })));
        check(fromJson.Code == "ok" && Text(fromJson.Info, "login") == "workload-json", $"a JSON file source sends the named field's token: {fromJson.Code} {fromJson.Message}");
        var samlPath = Write("token.saml", Convert.ToBase64String("<Assertion xmlns='urn:oasis:names:tc:SAML:2.0:assertion'><Subject><NameID>grace@example.com</NameID></Subject></Assertion>"u8.ToArray()));
        var saml = await Open(FederationConnect(BigQueryCredentialChecks.External(new JsonObject { ["file"] = samlPath }, "urn:ietf:params:oauth:token-type:saml2")));
        check(saml.Code == "ok" && Text(saml.Info, "login") == "grace@example.com", $"a SAML file source pins the assertion's NameID: {saml.Code} {saml.Message}");
        var opaque = await Open(FederationConnect(BigQueryCredentialChecks.External(new JsonObject { ["file"] = Write("token.opaque", "opaque-token-value") })));
        check(opaque.Code == "AUTH_IDENTITY" && !opaque.Message.Contains("opaque-token-value", StringComparison.Ordinal), $"a subject token with no subject cannot be pinned and is refused: {opaque.Code} {opaque.Message}");
        var googleFile = await Open(FederationConnect(BigQueryCredentialChecks.External(new JsonObject { ["file"] = Write("adc.json", key.ToJsonString()) })));
        check(googleFile.Code == "AUTH_KEY_FILE" && !googleFile.Message.Contains("PRIVATE KEY", StringComparison.Ordinal) && googleFile.Fake.To(BigQueryFake.Sts).Any() is false,
            $"a file source that is a Google credential file is never sent to STS: {googleFile.Code} {googleFile.Message}");
        var refusedRoot = await Open(FederationConnect(BigQueryCredentialChecks.External(new JsonObject { ["file"] = jwtPath })), subjects: new SubjectTokens([temp]));
        check(refusedRoot.Code == "AUTH_KEY_FILE" && refusedRoot.Message.Contains("folder that holds other credentials", StringComparison.Ordinal) && !refusedRoot.Fake.To(BigQueryFake.Sts).Any(),
            $"a file source under a refused folder (gcloud's, ~/.ssh, ~/.aws, Varia's own) is not read: {refusedRoot.Code} {refusedRoot.Message}");
        var missing = await Open(FederationConnect(BigQueryCredentialChecks.External(new JsonObject { ["file"] = Path.Combine(temp, "missing.jwt") })));
        check(missing.Code == "AUTH_KEY_FILE", $"a missing file source is AUTH_KEY_FILE: {missing.Code} {missing.Message}");

        // A rotating file whose subject changes fails the connection's next exchange instead of switching identities.
        {
            var rotating = BigQueryFake.Google();
            var issued = 0;
            rotating.On("POST", BigQueryFake.Sts, _ => new(200, "{\"access_token\":\"ya29.sts-" + Interlocked.Increment(ref issued) + "\",\"issued_token_type\":\"urn:ietf:params:oauth:token-type:access_token\",\"token_type\":\"Bearer\",\"expires_in\":1}"));
            using var harness = new Harness(rotating);
            var rotatePath = Write("rotate.jwt", Jwt("workload-1"));
            var (code, info, message) = await harness.Call("connections.connect", FederationConnect(BigQueryCredentialChecks.External(new JsonObject { ["file"] = rotatePath })));
            var connection = harness.Service.BigQuery.Find(Text(info, "id"));
            var same = await Outcome(() => harness.Service.BigQuery.EstimateAsync(connection!, "SELECT 2", CancellationToken.None));
            File.WriteAllText(rotatePath, Jwt("workload-2"));
            var rotated = await Outcome(() => harness.Service.BigQuery.EstimateAsync(connection!, "SELECT 2", CancellationToken.None));
            check(code == "ok" && same == "ok" && rotated.StartsWith("AUTH_IDENTITY", StringComparison.Ordinal) && !rotated.Contains("workload", StringComparison.Ordinal),
                $"a federated token refreshed for the same subject is used; one for another subject fails AUTH_IDENTITY naming no subject: {code} {message} {same} {rotated}");
            Clean(check, rotating, "rotating federation");
        }
        // A refreshed user token that tokeninfo names for another account fails the pin check (PinnedCredential).
        {
            var switching = BigQueryFake.Google();
            var issued = 0;
            switching.On("POST", BigQueryFake.Token, _ => new(200, "{\"access_token\":\"ya29.user-" + Interlocked.Increment(ref issued) + "\",\"expires_in\":1,\"token_type\":\"Bearer\"}"));
            using var harness = new Harness(switching);
            var (code, info, _) = await harness.Call("connections.connect", AdcConnect(BigQueryCredentialChecks.User()));
            var connection = harness.Service.BigQuery.Find(Text(info, "id"));
            var same = await Outcome(() => harness.Service.BigQuery.EstimateAsync(connection!, "SELECT 2", CancellationToken.None));
            switching.On("POST", BigQueryFake.TokenInfo, new BigQueryFake.Reply(200, "{\"email\":\"mallory@example.com\",\"sub\":\"2\"}"));
            var switched = await Outcome(() => harness.Service.BigQuery.EstimateAsync(connection!, "SELECT 2", CancellationToken.None));
            check(code == "ok" && same == "ok" && switched.StartsWith("AUTH_IDENTITY: The Google credentials now sign in as a different user account", StringComparison.Ordinal)
                && !switched.Contains("mallory", StringComparison.Ordinal) && !switching.To(BigQueryFake.Jobs).Any(request => request.Header("Authorization") == "Bearer ya29.user-" + issued),
                $"a refreshed token for another user fails AUTH_IDENTITY before it signs any request, naming kinds only: {code} {same} {switched}");
            Clean(check, switching, "switching user");
        }

        // The AWS checks clear the developer's own AWS variables, which the library would otherwise sign with.
        string?[] AwsEnvironment(string? keyId) => [keyId, null, null, null, null];
        string[] awsNames = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_REGION", "AWS_DEFAULT_REGION"];
        var (aws, keyIdOnly) = await WithEnvironment(awsNames, AwsEnvironment(null), async () =>
        {
            var role = await Open(FederationConnect(BigQueryCredentialChecks.External(BigQueryCredentialChecks.Aws(), "urn:ietf:params:aws:token-type:aws4_request")));
            // An access key id without its secret: the library signs with the instance role, so the pin names the role too.
            var keyOnly = await WithEnvironment(awsNames, AwsEnvironment("AKIAEXAMPLEKEYID"),
                () => Open(FederationConnect(BigQueryCredentialChecks.External(BigQueryCredentialChecks.Aws(), "urn:ietf:params:aws:token-type:aws4_request"))));
            return (role, keyOnly);
        });
        var awsExchange = aws.Fake.To(BigQueryFake.Sts).FirstOrDefault();
        check(aws.Code == "ok" && Text(aws.Info, "login") == "role:varia-role"
            && Text(aws.Info, "principalId") == "bigquery:" + BigQueryIdentity.Pin("aws", BigQueryCredentialChecks.Audience + "|role:varia-role")
            && aws.Fake.To(BigQueryFake.AwsRoles).All(request => request.Header("X-aws-ec2-metadata-token") == "imds-session-token")
            && awsExchange?.Form("subject_token")?.Contains("GetCallerIdentity", StringComparison.Ordinal) == true
            && awsExchange.Form("subject_token")?.Contains("example-secret-access-key", StringComparison.Ordinal) == false,
            $"an AWS source signs GetCallerIdentity with the instance role's keys (IMDSv2) and pins audience and role: {aws.Code} {aws.Message} {aws.Info}");
        check(keyIdOnly.Code == "ok" && Text(keyIdOnly.Info, "login") == "role:varia-role",
            $"an AWS key id without its secret pins the instance role the library signs with: {keyIdOnly.Code} {keyIdOnly.Message} {keyIdOnly.Info}");
        var azureFake = BigQueryFake.Google().On("GET", BigQueryFake.Azure, new BigQueryFake.Reply(200, "{\"access_token\":\"" + Jwt("azure-mi") + "\",\"expires_in\":\"3599\"}"));
        var azure = await Open(FederationConnect(BigQueryCredentialChecks.External(BigQueryCredentialChecks.Azure())), azureFake);
        check(azure.Code == "ok" && Text(azure.Info, "login") == "azure-mi" && azure.Fake.To(BigQueryFake.Azure).All(request => request.Header("Metadata") == "True")
            && azure.Fake.To(BigQueryFake.Sts).First().Form("subject_token") == Jwt("azure-mi"),
            $"an Azure source takes the managed identity's token from the instance metadata service and pins its subject: {azure.Code} {azure.Message}");
        var workforce = await Open(FederationConnect(BigQueryCredentialChecks.WorkforceUser()));
        var introspect = workforce.Fake.To(BigQueryFake.StsIntrospect).FirstOrDefault();
        check(workforce.Code == "ok" && Text(workforce.Info, "login").EndsWith("/subject/grace@example.com", StringComparison.Ordinal)
            && introspect?.Header("Authorization") == "Basic " + Convert.ToBase64String(Encoding.UTF8.GetBytes("workforce-client:" + BigQueryCredentialChecks.Secret))
            && introspect.Form("token") == "ya29.workforce-access-token",
            $"a workforce user file refreshes at STS and pins the username STS introspection names: {workforce.Code} {workforce.Message} {workforce.Info}");

        var impersonating = await Open(KeyConnect(key, options => options["impersonateServiceAccount"] = BigQueryCredentialChecks.Target));
        check(impersonating.Code == "ok" && Text(impersonating.Info, "login") == BigQueryCredentialChecks.ServiceAccount
            && Text(impersonating.Info, "principalId") == "bigquery:" + BigQueryIdentity.Pin("impersonated", BigQueryCredentialChecks.Target + "|serviceAccount:" + BigQueryCredentialChecks.ServiceAccount)
            && impersonating.Fake.To(BigQueryFake.Impersonate).First().Url.Contains(BigQueryCredentialChecks.Target, StringComparison.Ordinal)
            && impersonating.Fake.To(BigQueryFake.Impersonate).First().Header("Authorization") == "Bearer ya29.fake-access-token"
            && impersonating.Fake.To(BigQueryFake.Jobs).First().Header("Authorization") == "Bearer ya29.impersonated-access-token",
            $"impersonating a service account signs requests with the IAM Credentials token and pins target and base: {impersonating.Code} {impersonating.Message} {impersonating.Info}");
        using var accountHarness = new Harness();
        var account = await accountHarness.Call("bigquery.account", AddImpersonation(Args(KeyConnect(key))));
        check(account.Code == "ok" && Text(account.Result, "kind") == "impersonated" && Text(account.Result, "impersonated") == BigQueryCredentialChecks.Target,
            $"bigquery.account reports the impersonation target beside the signed-in account: {account.Code} {account.Message} {account.Result}");
        var nested = await Open(AdcConnect(BigQueryCredentialChecks.Impersonated(BigQueryCredentialChecks.User())));
        check(nested.Code == "ok" && Text(nested.Info, "login") == "ada@example.com"
            && Text(nested.Info, "principalId") == "bigquery:" + BigQueryIdentity.Pin("impersonated", BigQueryCredentialChecks.Target + "|user:ada@example.com")
            && nested.Fake.To(BigQueryFake.Token).Any(request => request.Form("grant_type") == "refresh_token") && nested.Fake.To(BigQueryFake.Impersonate).Any(),
            $"gcloud's impersonated_service_account ADC file refreshes its source user and impersonates: {nested.Code} {nested.Message} {nested.Info}");
        // Google's library impersonates only from a service account, a user, the metadata server or a federation that
        // impersonates nothing itself; anything else is a clear AUTH_KEY_FILE, never an internal error.
        foreach (var (options, what) in new[]
        {
            (Connect("externalAccount", "file", BigQueryCredentialChecks.WorkforceUser(), Guid.NewGuid().ToString(), Impersonating), "a workforce user"),
            (AdcConnect(BigQueryCredentialChecks.Impersonated(BigQueryCredentialChecks.User()), Impersonating), "an impersonated ADC file"),
            (Connect("externalAccount", "file", BigQueryCredentialChecks.ImpersonatingExternal(), Guid.NewGuid().ToString(), Impersonating), "a federation that already impersonates"),
        })
        {
            var refused = await Open(options);
            check(refused.Code == "AUTH_KEY_FILE" && refused.Message.Contains("cannot impersonate a service account", StringComparison.Ordinal) && !refused.Fake.To(BigQueryFake.Impersonate).Any(),
                $"impersonating on top of {what} fails AUTH_KEY_FILE before any impersonation call: {refused.Code} {refused.Message}");
        }
    }

    static void Impersonating(JsonObject options) => options["impersonateServiceAccount"] = BigQueryCredentialChecks.Target;

    static JsonObject AddImpersonation(JsonObject args)
    {
        args["impersonateServiceAccount"] = BigQueryCredentialChecks.Target;
        return args;
    }

    static async Task<string> Outcome(Func<Task> call)
    {
        try { await call(); return "ok"; }
        catch (RequestException error) { return error.Code + ": " + error.Message; }
    }

    static async Task ErrorsAsync(Action<bool, string> check, JsonObject key)
    {
        async Task<(string Code, string Message)> Fails(JsonObject options, Action<BigQueryFake> change, Action<BigQueryService>? limits = null)
        {
            var fake = BigQueryFake.Google();
            change(fake);
            using var harness = new Harness(fake);
            limits?.Invoke(harness.Service.BigQuery);
            var (code, _, message) = await harness.Call("connections.connect", options);
            Clean(check, fake, "error " + code);
            check(harness.Service.BigQuery.Count == 0, "a failed connect registers no handle: " + code);
            return (code, message);
        }
        var keyed = KeyConnect(key);
        (string Fixture, int Status, string Code, string Text)[] api =
        [
            ("error-access-denied", 403, "PERMISSION_DENIED", "bigquery.jobs.create permission in project varia-alpha"),
            ("error-access-not-configured", 403, "API_DISABLED", "The BigQuery API is not enabled for project varia-alpha"),
            ("error-billing-not-enabled", 403, "BILLING_DISABLED", "BigQuery sandbox"),
            ("error-quota-exceeded", 403, "QUOTA", "A BigQuery quota was exceeded"),
            ("error-rate-limit", 403, "QUOTA", "rate limit"),
            ("error-too-many-requests", 429, "QUOTA", "rate limit"),
            ("error-unauthenticated", 401, "AUTH_EXPIRED", BigQueryErrors.SignInCommand),
            ("error-not-found", 404, "NOT_FOUND", "Check the project id"),
            ("error-backend", 500, "BACKEND_ERROR", "internal error (HTTP 500)")
        ];
        foreach (var (fixture, status, expected, text) in api)
        {
            var (code, message) = await Fails(keyed, fake => fake.On("POST", BigQueryFake.Jobs, BigQueryFake.Fixture(fixture, status)));
            check(code == expected && message.Contains(text, StringComparison.Ordinal) && !message.Contains("ya29", StringComparison.Ordinal) && !message.Contains('\n'),
                $"the probe's {fixture} answer is {expected} with a recovery: {code} {message}");
        }
        var revokedUser = await Fails(AdcConnect(BigQueryCredentialChecks.User()), fake => fake.On("POST", BigQueryFake.Token, BigQueryFake.Fixture("token-invalid-grant", 400)));
        check(revokedUser is ("AUTH_EXPIRED", BigQueryErrors.Expired), $"a revoked gcloud sign-in (invalid_grant) is AUTH_EXPIRED naming the sign-in command: {revokedUser}");
        var revokedKey = await Fails(keyed, fake => fake.On("POST", BigQueryFake.Token, BigQueryFake.Fixture("token-invalid-grant", 400)));
        check(revokedKey.Code == "AUTH_KEY_FILE" && revokedKey.Message.Contains("deleted or disabled", StringComparison.Ordinal), $"a deleted service account key (invalid_grant) is AUTH_KEY_FILE: {revokedKey}");
        var adcKey = await Fails(AdcConnect(key), fake => fake.On("POST", BigQueryFake.Token, BigQueryFake.Fixture("token-invalid-grant", 400)));
        check(adcKey.Code == "AUTH_KEY_FILE" && adcKey.Message.Contains("deleted or disabled", StringComparison.Ordinal),
            $"a deleted service account key found through ADC (invalid_grant) is AUTH_KEY_FILE, not an expired gcloud sign-in: {adcKey}");
        var federated = await Fails(FederationConnect(BigQueryCredentialChecks.External(BigQueryCredentialChecks.Azure())), fake => fake
            .On("GET", BigQueryFake.Azure, new BigQueryFake.Reply(200, "{\"access_token\":\"" + Jwt("workload-1") + "\"}"))
            .On("POST", BigQueryFake.Sts, BigQueryFake.Fixture("token-invalid-grant", 400)));
        check(federated.Code == "AUTH_KEY_FILE" && federated.Message.Contains("pool, provider and audience", StringComparison.Ordinal),
            $"a federation token Google's STS refuses (invalid_grant) is AUTH_KEY_FILE naming the configuration, not an expired sign-in: {federated}");
        var badPem = await Fails(KeyConnect(BigQueryCredentialChecks.Key("-----BEGIN PRIVATE KEY-----\nnot-a-key-" + BigQueryCredentialChecks.Secret + "\n-----END PRIVATE KEY-----\n")), _ => { });
        check(badPem.Code == "AUTH_KEY_FILE" && !badPem.Message.Contains(BigQueryCredentialChecks.Secret, StringComparison.Ordinal),
            $"a key whose private key the library cannot parse is AUTH_KEY_FILE without its content: {badPem}");
        var unreadable = await Fails(Connect("serviceAccountKey", "file", null, Guid.NewGuid().ToString(), options => options["credential"] = new JsonObject { ["source"] = "file", ["json"] = "not json " + BigQueryCredentialChecks.Secret }), _ => { });
        check(unreadable.Code == "AUTH_KEY_FILE" && !unreadable.Message.Contains(BigQueryCredentialChecks.Secret, StringComparison.Ordinal), $"an unreadable key file is AUTH_KEY_FILE without its content: {unreadable}");
        var offline = await Fails(keyed, fake => fake.Fault = request => request.Url.Contains("bigquery.googleapis.com", StringComparison.Ordinal) ? new HttpRequestException("No such host is known.") : null);
        check(offline is ("CONNECTION_LOST", BigQueryErrors.Unreachable), $"an unreachable BigQuery is CONNECTION_LOST naming the network and proxy: {offline}");
        var hung = await Fails(keyed, fake => fake.Hang = request => request.Url.Contains("/jobs", StringComparison.Ordinal), service => service.ConnectLimit = TimeSpan.FromMilliseconds(400));
        check(hung.Code == "TIMEOUT", $"a probe that never answers ends at connect's budget with TIMEOUT: {hung}");
        var hungSource = await Fails(FederationConnect(BigQueryCredentialChecks.External(BigQueryCredentialChecks.Azure())),
            fake => fake.Hang = request => request.Url.Contains("/metadata/identity/oauth2/token", StringComparison.Ordinal), service => service.ConnectLimit = TimeSpan.FromMilliseconds(400));
        check(hungSource.Code == "TIMEOUT", $"a federation source whose metadata host never answers ends with TIMEOUT, not a bad configuration: {hungSource}");
        var unreachableSource = await Fails(FederationConnect(BigQueryCredentialChecks.External(BigQueryCredentialChecks.Azure())),
            fake => fake.Fault = request => request.Url.Contains("/metadata/identity/oauth2/token", StringComparison.Ordinal) ? new HttpRequestException("no route", new System.Net.Sockets.SocketException(10065)) : null);
        check(unreachableSource.Code == "CONNECTION_LOST", $"a federation source whose metadata host cannot be reached is CONNECTION_LOST, not a bad configuration: {unreachableSource}");
        var droppedSource = await Fails(FederationConnect(BigQueryCredentialChecks.External(BigQueryCredentialChecks.Azure())),
            fake => fake.Fault = request => request.Url.Contains("/metadata/identity/oauth2/token", StringComparison.Ordinal) ? new IOException("connection reset") : null);
        check(droppedSource.Code == "CONNECTION_LOST", $"a federation source whose metadata host drops the connection is CONNECTION_LOST, not a bad configuration: {droppedSource}");

        using var harness = new Harness();
        var (connected, info, _) = await harness.Call("connections.connect", keyed);
        var connection = harness.Service.BigQuery.Find(Text(info, "id"))!;
        var jobs = harness.Fake.To(BigQueryFake.Jobs).Count();
        var legacy = await Outcome(() => harness.Service.BigQuery.EstimateAsync(connection, "-- daily\n#legacySQL\nSELECT * FROM [varia-alpha:sales.orders]", CancellationToken.None));
        var estimate = await harness.Service.BigQuery.EstimateAsync(connection, "SELECT 2", CancellationToken.None);
        check(connected == "ok" && legacy == "LEGACY_SQL: " + BigQueryErrors.LegacySql && harness.Fake.To(BigQueryFake.Jobs).Count() == jobs + 1 && estimate is { BytesProcessed: 0, Faked: false },
            $"legacy SQL is refused before any job; a GoogleSQL estimate is a real dry run: {legacy} {estimate}");
    }

    static async Task PreConnectAsync(Action<bool, string> check, JsonObject key)
    {
        using var harness = new Harness();
        var user = AdcConnect(BigQueryCredentialChecks.User());
        var account = await harness.Call("bigquery.account", Args(user));
        check(account.Code == "ok" && Text(account.Result, "kind") == "user" && Text(account.Result, "account") == "ada@example.com" && harness.Fake.To(BigQueryFake.Jobs).Any() is false,
            $"bigquery.account names the signed-in account without creating any job: {account.Code} {account.Message} {account.Result}");
        var keyAccount = await harness.Call("bigquery.account", Args(KeyConnect(key)));
        check(keyAccount.Code == "ok" && Text(keyAccount.Result, "kind") == "serviceAccount" && Text(keyAccount.Result, "account") == BigQueryCredentialChecks.ServiceAccount,
            $"bigquery.account names a key's service account: {keyAccount.Code} {keyAccount.Result}");
        var first = await harness.Call("bigquery.projects", Args(user));
        var listed = harness.Fake.To(BigQueryFake.Projects).Last();
        var projects = first.Code == "ok" ? first.Result.GetProperty("projects").EnumerateArray().Select(project => Text(project, "id") + "=" + Text(project, "friendlyName")).ToArray() : [];
        check(first.Code == "ok" && projects.SequenceEqual(["varia-alpha=Varia Alpha", "example.com:varia-beta=Beta  project"]) && Text(first.Result, "nextPageToken") == "page-2"
            && listed.Uri.Query.Contains("maxResults=1000", StringComparison.Ordinal) && listed.Header("Authorization") == "Bearer ya29.fake-access-token",
            $"bigquery.projects lists a page of projects, dropping ids that are not projects and control characters in names: {first.Code} {first.Message} {string.Join(", ", projects)}");
        var second = await harness.Call("bigquery.projects", Args(user, "page-2"));
        check(second.Code == "ok" && second.Result.GetProperty("projects").EnumerateArray().Select(project => Text(project, "id")).SequenceEqual(["bigquery-public-data"])
            && !second.Result.TryGetProperty("nextPageToken", out _) && harness.Fake.To(BigQueryFake.Projects).Last().Uri.Query.Contains("pageToken=page-2", StringComparison.Ordinal),
            $"the next page is asked for with the token the last page returned: {second.Code} {second.Result}");
        var badToken = await harness.Call("bigquery.projects", Args(user, "page\n2"));
        var connectOnly = await harness.Call("bigquery.projects", AdcConnect(BigQueryCredentialChecks.User()));
        check(badToken.Code == "INVALID_PARAMS" && connectOnly.Code == "INVALID_PARAMS", $"a page token with a control character, and connect options, are not projects arguments: {badToken.Code} {connectOnly.Code}");
        var denied = BigQueryFake.Google().On("GET", BigQueryFake.Projects, BigQueryFake.Fixture("error-access-denied", 403));
        using var deniedHarness = new Harness(denied);
        var refused = await deniedHarness.Call("bigquery.projects", Args(user));
        check(refused.Code == "PERMISSION_DENIED", $"a refused projects.list is PERMISSION_DENIED: {refused.Code} {refused.Message}");
        var discovered = await harness.Call("connections.databases", user);
        check(discovered.Code == "ok" && Datasets(discovered.Result).SequenceEqual(["archive@us-east1", "sales@", "staging@US"]) && harness.Fake.To(BigQueryFake.Jobs).Any() is false,
            $"connections.databases with BigQuery's options lists the project's datasets for the Connect dialog without creating any job: {discovered.Code} {discovered.Message}");
        // bigquery.connectionProjects: lists projects on a live BigQuery handle through the shared rate limiter.
        var connected = await harness.Call("connections.connect", user);
        var connectionId = Text(connected.Result, "id");
        var connFirst = await harness.Call("bigquery.connectionProjects", new JsonObject { ["connectionId"] = connectionId });
        var connListed = harness.Fake.To(BigQueryFake.Projects).Last();
        var connProjects = connFirst.Code == "ok" ? connFirst.Result.GetProperty("projects").EnumerateArray().Select(project => Text(project, "id") + "=" + Text(project, "friendlyName")).ToArray() : [];
        var connSecond = await harness.Call("bigquery.connectionProjects", new JsonObject { ["connectionId"] = connectionId, ["pageToken"] = "page-2" });
        var connBadToken = await harness.Call("bigquery.connectionProjects", new JsonObject { ["connectionId"] = connectionId, ["pageToken"] = "page\n2" });
        var connUnknown = await harness.Call("bigquery.connectionProjects", new JsonObject { ["connectionId"] = Guid.NewGuid().ToString() });
        var directDisconnected = false;
        try { await harness.Service.BigQuery.ConnectionProjectsAsync(new BigQueryConnectionProjectsArgs(Guid.NewGuid().ToString()), CancellationToken.None); }
        catch (RequestException error) { directDisconnected = error.Code == "NOT_CONNECTED"; }
        check(connFirst.Code == "ok" && connProjects.SequenceEqual(["varia-alpha=Varia Alpha", "example.com:varia-beta=Beta  project"]) && Text(connFirst.Result, "nextPageToken") == "page-2"
            && connListed.Uri.Query.Contains("maxResults=1000", StringComparison.Ordinal) && connListed.Header("Authorization") == "Bearer ya29.fake-access-token"
            && connSecond.Code == "ok" && connSecond.Result.GetProperty("projects").EnumerateArray().Select(project => Text(project, "id")).SequenceEqual(["bigquery-public-data"])
            && !connSecond.Result.TryGetProperty("nextPageToken", out _) && connBadToken.Code == "INVALID_PARAMS" && connUnknown.Code == "UNSUPPORTED_PROVIDER" && directDisconnected
            && harness.Service.LaneOf("bigquery.connectionProjects") == Protocol.RequestLane.Metadata && !harness.Service.Sensitive("bigquery.connectionProjects"),
            $"bigquery.connectionProjects pages projects on a live connection with shared mapping, metadata lane and provider/connection guards: {connFirst.Code} {connSecond.Code} {connBadToken.Code} {connUnknown.Code} {directDisconnected}");
        var deniedConn = await deniedHarness.Call("connections.connect", user);
        var connRefused = await deniedHarness.Call("bigquery.connectionProjects", new JsonObject { ["connectionId"] = Text(deniedConn.Result, "id") });
        check(connRefused.Code == "PERMISSION_DENIED", $"bigquery.connectionProjects maps 403 to PERMISSION_DENIED: {connRefused.Code} {connRefused.Message}");
        Clean(check, harness.Fake, "pre-connect");
        Clean(check, denied, "pre-connect refused");
    }

    static async Task EmulatorAsync(Action<bool, string> check)
    {
        var fake = new BigQueryFake()
            .On("GET", @"http://localhost:9050/bigquery/v2/projects", new BigQueryFake.Reply(200, "{\"projects\":[{\"id\":\"varia-emulator\"}]}"))
            .On("GET", @"http://localhost:9050/bigquery/v2/projects/varia-emulator/datasets/varia_fixture", new BigQueryFake.Reply(200, "{\"datasetReference\":{\"projectId\":\"varia-emulator\",\"datasetId\":\"varia_fixture\"}}"));
        using var harness = new Harness(fake, new Uri("http://localhost:9050/"));
        var anonymous = Connect("gcloud", "anonymous", null, change: options => { options["project"] = "varia-emulator"; options["dataset"] = "varia_fixture"; });
        var (code, info, message) = await harness.Call("connections.connect", anonymous);
        var connection = harness.Service.BigQuery.Find(Text(info, "id"));
        var estimate = connection is null ? null : await harness.Service.BigQuery.EstimateAsync(connection, "SELECT 1", CancellationToken.None);
        check(code == "ok" && Text(info, "login") == "Anonymous (emulator)" && Text(info, "principalId") == "bigquery:anonymous:emulator" && connection?.Location is null
            && !fake.To(".*/jobs").Any() && estimate is { Faked: true },
            $"emulator mode connects anonymously with no probe, and estimates are faked: {code} {message} {info}");
        var projects = await harness.Call("bigquery.projects", Args(anonymous));
        var connProjects = await harness.Call("bigquery.connectionProjects", new JsonObject { ["connectionId"] = Text(info, "id") });
        check(projects.Code == "ok" && projects.Result.GetProperty("projects").EnumerateArray().Select(project => Text(project, "id")).SequenceEqual(["varia-emulator"])
            && connProjects.Code == "ok" && connProjects.Result.GetProperty("projects").EnumerateArray().Select(project => Text(project, "id")).SequenceEqual(["varia-emulator"]),
            $"emulator mode lists the emulator's projects, which name only their id: {projects.Code} {projects.Message} / {connProjects.Code}");
        check(fake.Seen.All(request => request.Header("Authorization") is null && request.Uri.Host == "localhost"), "emulator mode sends no credential and nothing beyond the emulator's address");
        var google = await harness.Call("connections.connect", AdcConnect(BigQueryCredentialChecks.User(), options => options["project"] = "varia-emulator"));
        check(google.Code == "INVALID_PARAMS", $"emulator mode refuses real credential material: {google.Code}");
        Clean(check, fake, "emulator");
    }
}
