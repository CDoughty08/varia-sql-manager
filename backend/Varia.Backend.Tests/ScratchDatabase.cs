using System.Globalization;
using System.Security.Cryptography;
using System.Text.RegularExpressions;

namespace Varia.Backend.Tests;

/// <summary>A script's outcome with its rows already read (display text, null for NULL), so its session can close at once.</summary>
internal sealed record SqlRun(string Status, string? Error, List<List<string?[]>> Sets)
{
    public string? Scalar => Sets.Count > 0 && Sets[0].Count > 0 ? Sets[0][0][0] : null;
}

/// <summary>A uniquely named, marked scratch database for the Object Explorer checks, created only with
/// VARIA_TEST_SQL_SCRATCH=1 (a disposable development server): VariaScratch_&lt;yyyyMMddHHmmss&gt;_&lt;8 hex&gt; with a
/// case-sensitive collation, plus _ro (read-only), _off (offline), _su (single-user), _snap (a snapshot), and a
/// low-privilege login when the server allows SQL logins. Everything is dropped on dispose; leftovers older than 6 h are swept on the next run.</summary>
internal sealed partial class ScratchDatabase : IAsyncDisposable
{
    private readonly Func<string, string, Task<SqlRun>> run;
    private readonly List<string> created = [];
    private bool loginCreated;

    private ScratchDatabase(Func<string, string, Task<SqlRun>> run, string suffix)
    {
        this.run = run;
        Name = "VariaScratch_" + suffix;
        Password = RandomPassword();
    }

    public string Name { get; }
    public string ReadOnly => Name + "_ro";
    public string Offline => Name + "_off";
    public string SingleUser => Name + "_su";
    public string Snapshot => Name + "_snap";
    /// <summary>Where the Script As round trip runs scripts (created on demand).</summary>
    public string RoundTrip => Name + "_rt";
    /// <summary>Where the Script As injection matrix creates its objects and runs their scripts (created on demand).</summary>
    public string Injection => Name + "_inj";
    /// <summary>Where the object-action checks rename and drop objects, then rename and drop the database (created on demand).</summary>
    public string Actions => Name + "_act";
    /// <summary>The name the object-action checks rename <see cref="Actions"/> to and back.</summary>
    public string ActionsRenamed => Name + "_actr";
    /// <summary>Where the Database Properties checks change options, scoped configurations and the owner (created on demand).</summary>
    public string Properties => Name + "_dbp";
    /// <summary>Where the table designer checks create tables (created on demand).</summary>
    public string Designer => Name + "_tbd";
    /// <summary>A second table designer database, whose name HAS_PERMS_BY_NAME cannot read unbracketed (created on demand).</summary>
    public string DesignerOdd => Name + "_tbd.]";
    /// <summary>The fake SSIS catalog: tables named after SSISDB's catalog views, built from tests/fixtures/ssisdb (created on demand).</summary>
    public string Ssis => Name + "_ssis";
    /// <summary>The Integration Services feature's own catalog backup restored under a scratch name, so its schema can be read
    /// without a catalog (created on demand; never named SSISDB, never given a master key, CLR or jobs).</summary>
    public string SsisReference => Name + "_ssisref";
    /// <summary>Where Create Catalog's dry run restores the catalog backup and creates its master key (S9a; the backend creates it).</summary>
    public string SsisCreate => Name + "_ssiscc";
    /// <summary>The low-privilege login (same name as the database), when the server accepts SQL logins.</summary>
    public string? Login { get; private set; }
    /// <summary>Held in memory only, never printed.</summary>
    public string Password { get; }
    public bool HasSnapshot { get; private set; }
    public int Major { get; private set; }
    /// <summary>Whether the server has Full-Text Search installed, which changes what SMO scripts for a full-text catalog.</summary>
    public bool FullText { get; private set; }

    // _act and _actr are the object-action checks' database and the name they rename it to (PR17), so a run that crashes
    // mid-rename leaves nothing the sweep cannot find; _dbp is Database Properties' database, _tbd and _tbd.] the table designer's,
    // _ssis the fake SSIS catalog, _ssisref the restored catalog backup and _ssiscc Create Catalog's dry run.
    [GeneratedRegex(@"^VariaScratch_\d{14}_[0-9a-f]{8}(_ro|_off|_su|_snap|_rt|_inj|_act|_actr|_dbp|_tbd|_tbd\.\]|_ssis|_ssisref|_ssiscc)?$")]
    private static partial Regex Pattern();
    [GeneratedRegex(@"^VariaScratch_\d{14}_[0-9a-f]{8}$")]
    private static partial Regex LoginPattern();

    /// <summary>Whether the sweep drops a database of this name once it is stale and marked (or not online).</summary>
    internal static bool Sweepable(string name) => Pattern().IsMatch(name);

    /// <summary>Whether a name is a scratch object's, this run's or another's on the same server: the .NET checks'
    /// VariaScratch_ databases, logins and server objects, and the vitest and smoke suites' varia_scratch_ databases.
    /// Another run's can be mid-setup, single-user, offline or gone a moment later.</summary>
    public static bool IsScratchName(string name) =>
        name.StartsWith("VariaScratch_", StringComparison.Ordinal) || name.StartsWith("varia_scratch_", StringComparison.OrdinalIgnoreCase);

    private static string RandomPassword()
    {
        const string alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
        // Every character class appears, so the password satisfies any complexity policy.
        return "Vx9!" + new string(Enumerable.Range(0, 28).Select(_ => alphabet[RandomNumberGenerator.GetInt32(alphabet.Length)]).ToArray());
    }

    private async Task<SqlRun> Exec(string sql, string database = "master")
    {
        var result = await run(sql, database);
        if (result.Status != "completed") throw new InvalidOperationException("Scratch setup failed: " + result.Error);
        return result;
    }

    /// <summary>Drops scratch databases and logins older than 6 hours that carry the marker or are not online (names only are logged).</summary>
    public static async Task SweepAsync(Func<string, string, Task<SqlRun>> run, Action<string>? log = null)
    {
        log ??= Console.WriteLine;
        // HAS_DBACCESS waits on a single-user database another session is in; reading its marker then fails, which leaves it alone.
        var result = await run("SELECT d.name, d.state, CONVERT(bit, CASE WHEN d.create_date < DATEADD(hour, -6, GETDATE()) THEN 1 ELSE 0 END), "
            + "CONVERT(bit, ISNULL(CASE WHEN d.user_access = 1 THEN 1 ELSE HAS_DBACCESS(d.name) END, 0)) "
            + "FROM sys.databases AS d WHERE d.name LIKE N'VariaScratch[_]%' ORDER BY CASE WHEN d.source_database_id IS NULL THEN 1 ELSE 0 END;", "master");
        foreach (var row in result.Sets.Count == 0 ? [] : result.Sets[0])
        {
            var name = row[0]!;
            if (!Pattern().IsMatch(name) || row[2] != "1") continue;
            var online = row[1] == "0";
            // An online database is dropped only when its marker can be read and is there; one this login cannot open is left alone.
            if (online)
            {
                if (row[3] != "1") continue;
                var marker = await run("DECLARE @sql nvarchar(max) = N'SELECT COUNT(*) FROM ' + QUOTENAME(" + Quote(name) + ") + N'.sys.extended_properties WHERE class = 0 AND name = N''varia.scratch'';';\nEXEC (@sql);", "master");
                if (marker.Status != "completed" || marker.Scalar is null or "0") continue;
            }
            log("Dropping stale scratch database " + name);
            await Drop(run, name, online);
        }
        var logins = await run("SELECT name FROM sys.server_principals WHERE name LIKE N'VariaScratch[_]%' AND type = 'S' AND create_date < DATEADD(hour, -6, GETDATE());", "master");
        foreach (var row in logins.Sets.Count == 0 ? [] : logins.Sets[0])
            if (LoginPattern().IsMatch(row[0]!))
            {
                log("Dropping stale scratch login " + row[0]);
                await run("DROP LOGIN " + Bracket(row[0]!) + ";", "master");
            }
    }

    private static string Quote(string value) => "N'" + value.Replace("'", "''") + "'";
    private static string Bracket(string value) => "[" + value.Replace("]", "]]") + "]";

    private static Task<SqlRun> Drop(Func<string, string, Task<SqlRun>> run, string name, bool online) => run(
        (online ? "" : "ALTER DATABASE " + Bracket(name) + " SET ONLINE;\n")
        + "IF EXISTS (SELECT 1 FROM sys.databases WHERE name = " + Quote(name) + " AND source_database_id IS NULL AND state = 0) ALTER DATABASE " + Bracket(name) + " SET SINGLE_USER WITH ROLLBACK IMMEDIATE;\n"
        + "IF DB_ID(" + Quote(name) + ") IS NOT NULL DROP DATABASE " + Bracket(name) + ";", "master");

    /// <summary>A scratch name with none of the Object Explorer fixture, for checks that need only a database of their own.</summary>
    public static ScratchDatabase Bare(Func<string, string, Task<SqlRun>> run) =>
        new(run, DateTime.UtcNow.ToString("yyyyMMddHHmmss", CultureInfo.InvariantCulture) + "_" + Convert.ToHexString(RandomNumberGenerator.GetBytes(4)).ToLowerInvariant());

    public static async Task<ScratchDatabase> CreateAsync(Func<string, string, Task<SqlRun>> run, string fixtures)
    {
        var suffix = DateTime.UtcNow.ToString("yyyyMMddHHmmss", CultureInfo.InvariantCulture) + "_" + Convert.ToHexString(RandomNumberGenerator.GetBytes(4)).ToLowerInvariant();
        var scratch = new ScratchDatabase(run, suffix);
        try { await scratch.SetUpAsync(fixtures); }
        catch
        {
            await scratch.DisposeAsync();
            throw;
        }
        return scratch;
    }

    private async Task SetUpAsync(string fixtures)
    {
        var facts = await Exec("SELECT CONVERT(int, SERVERPROPERTY('ProductMajorVersion')), CONVERT(int, SERVERPROPERTY('IsIntegratedSecurityOnly')), CONVERT(int, FULLTEXTSERVICEPROPERTY('IsFulltextInstalled'));");
        var fact = facts.Sets[0][0];
        Major = int.Parse(fact[0]!, CultureInfo.InvariantCulture);
        var sqlLogins = fact[1] == "0";
        FullText = fact[2] == "1";
        const string marker = "EXEC sys.sp_addextendedproperty @name = N'varia.scratch', @value = 1;";
        foreach (var name in new[] { Name, ReadOnly, Offline, SingleUser })
        {
            created.Add(name);
            await Exec("CREATE DATABASE " + Bracket(name) + (name == Name ? " COLLATE Latin1_General_100_CS_AS_SC" : "") + ";\nALTER DATABASE " + Bracket(name) + " SET RECOVERY SIMPLE;");
            await Exec(marker, name);
        }
        var text = File.ReadAllText(Path.Combine(fixtures, "explorer-2016.sql"));
        await Exec(text.Replace("{{password}}", Password.Replace("'", "''")), Name);
        foreach (var (version, file) in new[] { (14, "explorer-2017.sql"), (15, "explorer-2019.sql"), (16, "explorer-2022.sql"), (17, "explorer-2025.sql") })
            if (Major >= version) await Exec(File.ReadAllText(Path.Combine(fixtures, file)), Name);
        if (sqlLogins)
        {
            Login = Name;
            await Exec("CREATE LOGIN " + Bracket(Login) + " WITH PASSWORD = " + Quote(Password) + ", CHECK_POLICY = OFF, DEFAULT_DATABASE = [master];");
            loginCreated = true;
            await Exec("CREATE USER " + Bracket(Login) + " FOR LOGIN " + Bracket(Login) + ";\nGRANT SELECT ON SCHEMA::[bulk] TO " + Bracket(Login) + ";", Name);
        }
        await Exec("ALTER DATABASE " + Bracket(ReadOnly) + " SET READ_ONLY WITH ROLLBACK IMMEDIATE;\nALTER DATABASE " + Bracket(Offline) + " SET OFFLINE WITH ROLLBACK IMMEDIATE;\n"
            + "ALTER DATABASE " + Bracket(SingleUser) + " SET SINGLE_USER WITH ROLLBACK IMMEDIATE;");
        // Snapshots need an edition that has them; the file goes to the instance's default data path.
        var snapshot = await run("DECLARE @path nvarchar(4000) = CONVERT(nvarchar(4000), SERVERPROPERTY('InstanceDefaultDataPath'));\n"
            + "DECLARE @logical sysname = (SELECT name FROM sys.master_files WHERE database_id = DB_ID(" + Quote(Name) + ") AND type = 0);\n"
            + "DECLARE @sql nvarchar(max) = N'CREATE DATABASE ' + QUOTENAME(" + Quote(Snapshot) + ") + N' ON (NAME = ' + QUOTENAME(@logical) + N', FILENAME = ' "
            + "+ QUOTENAME(@path + " + Quote(Snapshot + ".ss") + ", '''') + N') AS SNAPSHOT OF ' + QUOTENAME(" + Quote(Name) + ") + N';';\nEXEC (@sql);", "master");
        HasSnapshot = snapshot.Status == "completed";
        if (HasSnapshot) created.Insert(0, Snapshot);
        else Console.WriteLine("Database snapshot checks skipped: this server could not create a snapshot.");
    }

    /// <summary>Creates the empty, marked round-trip database with the scratch database's collation.</summary>
    public Task<string> CreateRoundTripAsync() => CreateMarkedAsync(RoundTrip);

    /// <summary>Creates the empty, marked injection-matrix database with the scratch database's collation.</summary>
    public Task<string> CreateInjectionAsync() => CreateMarkedAsync(Injection);

    /// <summary>Creates the empty, marked Database Properties database.</summary>
    public Task<string> CreatePropertiesAsync() => CreateMarkedAsync(Properties);

    /// <summary>Creates the empty, marked table designer database.</summary>
    public Task<string> CreateDesignerAsync() => CreateMarkedAsync(Designer);

    /// <summary>Creates the empty, marked fake SSIS catalog database with the real catalog's collation.</summary>
    public Task<string> CreateSsisAsync(string collation) => CreateMarkedAsync(Ssis, collation);

    /// <summary>Restores the Integration Services catalog backup at a server-side path as <see cref="SsisReference"/>, with its
    /// files in the instance's default folders, and marks it. Only its schema is read: it gets no master key, CLR or jobs, and
    /// nothing treats a database of this name as the catalog.</summary>
    public async Task<string> RestoreSsisReferenceAsync(string backup)
    {
        var paths = (await Exec("SELECT CONVERT(nvarchar(4000), SERVERPROPERTY('InstanceDefaultDataPath')), CONVERT(nvarchar(4000), SERVERPROPERTY('InstanceDefaultLogPath'));")).Sets[0][0];
        var files = await Exec("RESTORE FILELISTONLY FROM DISK = " + Quote(backup) + ";");
        var moves = files.Sets[0].Select((file, index) => "MOVE " + Quote(file[0]!) + " TO "
            + Quote((file[2] == "L" ? paths[1] : paths[0]) + SsisReference + "_" + index.ToString(CultureInfo.InvariantCulture) + (file[2] == "L" ? ".ldf" : ".mdf")));
        created.Add(SsisReference);
        await Exec("RESTORE DATABASE " + Bracket(SsisReference) + " FROM DISK = " + Quote(backup) + " WITH RECOVERY, " + string.Join(", ", moves) + ";\n"
            + "ALTER DATABASE " + Bracket(SsisReference) + " SET RECOVERY SIMPLE;");
        await Exec("EXEC sys.sp_addextendedproperty @name = N'varia.scratch', @value = 1;", SsisReference);
        return SsisReference;
    }

    /// <summary>Creates the empty, marked second table designer database, case- and accent-insensitive.</summary>
    public Task<string> CreateDesignerOddAsync() => CreateMarkedAsync(DesignerOdd, "Latin1_General_100_CI_AI");

    /// <summary>For a bare scratch name: the low-privilege login (named like the database, so the sweep finds it), when the
    /// server accepts SQL logins; false when it accepts Windows logins only.</summary>
    public async Task<bool> CreateLoginAsync()
    {
        if ((await Exec("SELECT CONVERT(int, SERVERPROPERTY('IsIntegratedSecurityOnly'));")).Scalar != "0") return false;
        Login = Name;
        await Exec("CREATE LOGIN " + Bracket(Login) + " WITH PASSWORD = " + Quote(Password) + ", CHECK_POLICY = OFF, DEFAULT_DATABASE = [master];");
        loginCreated = true;
        return true;
    }

    /// <summary>Creates the empty, marked object-action database; disposal also drops it under its renamed name.</summary>
    public Task<string> CreateActionsAsync()
    {
        created.Add(ActionsRenamed);
        return CreateMarkedAsync(Actions);
    }

    /// <summary>A second object-action database under <see cref="ActionsRenamed"/>, once <see cref="Actions"/> is gone
    /// (already in the dispose list).</summary>
    public async Task<string> CreateActionsRenamedAsync()
    {
        await CreateMarkedAsync(ActionsRenamed);
        created.Remove(ActionsRenamed);
        return ActionsRenamed;
    }

    private async Task<string> CreateMarkedAsync(string name, string collation = "Latin1_General_100_CS_AS_SC")
    {
        created.Add(name);
        await Exec("CREATE DATABASE " + Bracket(name) + " COLLATE " + collation + ";\nALTER DATABASE " + Bracket(name) + " SET RECOVERY SIMPLE;");
        await Exec("EXEC sys.sp_addextendedproperty @name = N'varia.scratch', @value = 1;", name);
        return name;
    }

    /// <summary>Drops the snapshot first, brings the offline database online so its files are deleted, then drops the rest and the login.</summary>
    /// <summary>A scratch database something else creates (the backend's Create Catalog dry run), dropped with the rest.</summary>
    public void Adopt(string name) { if (!created.Contains(name)) created.Add(name); }

    public async ValueTask DisposeAsync()
    {
        foreach (var name in created) await Drop(run, name, name != Offline);
        if (loginCreated) await run("DROP LOGIN " + Bracket(Login!) + ";", "master");
    }
}
