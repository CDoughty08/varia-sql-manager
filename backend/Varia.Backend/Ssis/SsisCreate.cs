using System.Data;
using System.Globalization;
using Microsoft.Data.SqlClient;
using Varia.Backend.Explorer;

namespace Varia.Backend.Ssis;

/// <summary>What Create Catalog reads on the server before it changes anything (SsisCreateSql.Setup). Paths are the server's;
/// PendingConfiguration names the other dynamic sp_configure changes a RECONFIGURE would apply, or is null.</summary>
internal sealed record CatalogFacts(bool Sysadmin, string Version, bool Exists, bool ClrEnabled, bool ScanForStartup, string? BackupFile, bool BackupExists, string? AssemblyFile,
    string? Directory, string? DataFile, bool DataExists, string? LogFile, bool LogExists, string? PendingConfiguration = null);

/// <summary>The catalog backup's logical files: one data file (a second, as SSMS allows, goes to an .ndf) and one log file.</summary>
internal sealed record CatalogBackupLayout(string DataName, string? SecondName, string LogName);

/// <summary>What Create Catalog made so far, which a Stop or a failure after the restore removes, and only that.</summary>
internal sealed class CreatedObjects
{
    /// <summary>The restore was sent; Recovered once it completed, so the database is this Create Catalog's for certain.</summary>
    public bool Restored;
    public bool Recovered;
    public bool Assembly;
    public byte[]? TrustedHash;
    public bool Startup;
    public bool Jobs;
}

/// <summary>Create Catalog's reads and rules (S9a), shared by the dialog's ssis.catalogSetup and the write's preflight, so both
/// refuse alike. Messages are SSMS's own where it has one; none carries the password, SQL text or a connection string.</summary>
internal static class SsisCreate
{
    /// <summary>What no server of this kind can do, answered before connecting: on Azure SQL Database (5) and Managed Instance (8) an
    /// Azure-SSIS integration runtime creates the catalog (SSMS hides the verb there); the explorer catalogue's other cloud editions
    /// (Synapse, Azure SQL Edge, SQL database in Fabric) host none; and there is none before 2016 or on Linux. The platform first: a
    /// cloud server's version says nothing of the catalog.</summary>
    public static SsisError? Unsupported(SsisCatalog catalog, ExplorerProfile served, int engineEdition, bool ignoreLinux)
    {
        if (engineEdition is 5 or 8)
            return SsisErrors.Create(catalog, "NOT_SUPPORTED", "Create Catalog is not available on Azure SQL Database or Azure SQL Managed Instance: an Azure-SSIS integration runtime in Azure Data Factory creates that catalog.");
        if (served.Cloud)
            return SsisErrors.Create(catalog, "NOT_SUPPORTED", "Create Catalog is not available on this platform (engine edition " + engineEdition.ToString(CultureInfo.InvariantCulture)
                + "): the SSIS Catalog runs on SQL Server 2016 or later on Windows, or in an Azure-SSIS integration runtime.");
        if (served.Band < 13) return SsisErrors.Create(catalog, "NOT_SUPPORTED", "The SSIS Catalog needs SQL Server 2016 or later.");
        if (served.Linux && !ignoreLinux) return SsisErrors.Create(catalog, "NOT_SUPPORTED", "The SSIS Catalog isn't supported on SQL Server on Linux.");
        return null;
    }

    private static SqlParameter Text(string name, int size, string? value)
    {
        // SqlClient cuts longer text to the size without an error; a cut path would name another file.
        if (value is not null && value.Length > size) throw new InvalidOperationException("A Create Catalog parameter is longer than its declaration: " + name + ".");
        return new SqlParameter(name, SqlDbType.NVarChar, size) { Value = (object?)value ?? DBNull.Value };
    }
    internal static SqlParameter Name(string name, string? value) => Text(name, 128, value);
    internal static SqlParameter Path(SsisCatalog catalog, string name, string? value) => Text(name, catalog.Limit("serverPath"), value);

    /// <summary>Runs SsisCreateSql.Setup for the catalog <paramref name="name"/> and the band's backup file.</summary>
    public static async Task<CatalogFacts> ReadAsync(SqlConnection connection, SsisCatalog catalog, string name, int band, CancellationToken token)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = SsisCreateSql.Setup.Text;
        command.CommandTimeout = 0;
        command.Parameters.Add(Name("@catalog", name));
        command.Parameters.Add(Name("@backup_name", catalog.BackupFile(band)));
        command.Parameters.Add(Name("@assembly_name", catalog.AssemblyFile));
        await using var reader = await command.ExecuteReaderAsync(token);
        // SET NOCOUNT ON, and the INSERT … EXEC of xp_fileexist returns no rows to the client: the one result is the last SELECT.
        do
        {
            if (reader.FieldCount != 14) continue;
            if (!await reader.ReadAsync(token)) break;
            string? Value(int index) => reader.IsDBNull(index) ? null : Convert.ToString(reader.GetValue(index), CultureInfo.InvariantCulture);
            bool Flag(int index) => !reader.IsDBNull(index) && Convert.ToInt32(reader.GetValue(index), CultureInfo.InvariantCulture) == 1;
            var facts = new CatalogFacts(Flag(0), Value(1) ?? "", Flag(2), Flag(3), Flag(4), Value(5), Flag(6), Value(7), Value(8), Value(9), Flag(10), Value(11), Flag(12), Value(13) is { Length: > 0 } pending ? pending : null);
            while (await reader.NextResultAsync(token)) { }
            return facts;
        }
        while (await reader.NextResultAsync(token));
        throw new InvalidOperationException("The Create Catalog setup read returned no row.");
    }

    /// <summary>Why Create Catalog cannot run, in SSMS's order and words (Catalog.Create): sysadmin, the catalog's database, the
    /// backup's path and the file, the files' folder, and files already there. CLR is the request's to agree to.</summary>
    public static SsisError? Refusal(SsisCatalog catalog, CatalogFacts facts, string name)
    {
        SsisError Error(string code, string message) => SsisErrors.Create(catalog, code, message);
        if (!facts.Sysadmin)
            return Error("PERMISSION_DENIED", "To create and use an SSIS catalog, you must be a member of the SQL Server sysadmin fixed server role and have permissions to enable CLR integration. "
                + "Contact the administrator of the SQL Server instance to obtain the necessary permissions.");
        if (facts.Exists) return Error("CATALOG_EXISTS", "There already exists a catalog (" + name + "), and only one catalog is supported on a server.");
        if (string.IsNullOrEmpty(facts.BackupFile) || string.IsNullOrEmpty(facts.AssemblyFile))
            return Error("NOT_SUPPORTED", "The path to the catalog backup file could not be determined. Integration Services might not be installed on this server, or the user may not have the appropriate access permissions.");
        if (!facts.BackupExists)
            return Error("NOT_SUPPORTED", "The catalog backup file '" + facts.BackupFile + "' could not be accessed. Make sure the database file exists, and the SQL Server service account is able to access it.");
        if (string.IsNullOrEmpty(facts.Directory) || facts.DataFile is null || facts.LogFile is null)
            return Error("NOT_SUPPORTED", "The folder of the master database's files could not be determined, so there is no folder for the catalog's files.");
        var existing = facts.DataExists ? facts.DataFile : facts.LogExists ? facts.LogFile : null;
        if (existing is not null)
        {
            var file = existing[facts.Directory.Length..];
            return Error("NOT_SUPPORTED", "The database file with name '" + file + "' already exists in directory '" + facts.Directory + "'. Make sure there is no existing database file with the name '"
                + file + "' under this directory and try again.");
        }
        var limit = catalog.Limit("serverPath");
        if (new[] { facts.BackupFile, facts.AssemblyFile, facts.DataFile, facts.LogFile }.Any(path => path.Length > limit))
            return Error("NOT_SUPPORTED", "A path of the catalog's files is longer than " + limit.ToString("N0", CultureInfo.InvariantCulture) + " characters.");
        // Enabling CLR ends with RECONFIGURE, and sys.sp_procoption (the startup procedure, an earlier one's removal, the removal after
        // a failure) with RECONFIGURE WITH OVERRIDE, which apply every pending change: the user agreed to none of them.
        if (facts.PendingConfiguration is { Length: > 0 } pending) return Pending(catalog, pending);
        return null;
    }

    /// <summary>CONFIGURATION_PENDING, naming the changes (from the setup read, or the guard's error in a step).</summary>
    public static SsisError Pending(SsisCatalog catalog, string pending) => SsisErrors.Create(catalog, "CONFIGURATION_PENDING",
        "Create Catalog reconfigures the server (RECONFIGURE to enable CLR integration, and sys.sp_procoption's RECONFIGURE WITH OVERRIDE for its startup procedure), which would also apply "
        + "these pending server configuration changes: " + pending + ". Apply them (RECONFIGURE) or undo them (sp_configure) first, then create the catalog.");

    /// <summary>Whether a step's error is the pending-configuration guard's (SsisCreateSql.PendingGuard), not the server's own.</summary>
    public static bool IsPendingGuard(int number, byte state) => number == 50000 && state == SsisCreateSql.PendingState;

    /// <summary>Create Catalog's agreement to enable CLR integration, read from the facts whatever else runs (a dry run too): CLR_REQUIRED
    /// when it is off and the request did not agree, before anything changes.</summary>
    public static SsisError? ClrRefusal(SsisCatalog catalog, CatalogFacts facts, SsisActionDto action) => !facts.ClrEnabled && action.EnableClr != true
        ? SsisErrors.Create(catalog, "CLR_REQUIRED", "Integration Services uses CLR stored procedures. Enable CLR integration to create the catalog.")
        : null;

    /// <summary>What Create Catalog does once its preflight passed (<see cref="Plan"/>): a refusal, or whether it enables CLR and its
    /// steps in order. The steps Create Catalog runs come only from here.</summary>
    internal sealed record CreatePlan(SsisError? Refusal, bool EnableClr, IReadOnlyList<string> Steps);

    /// <summary>The decisions after the preflight, as one pure function the write follows: CLR_REQUIRED when CLR is off and the request
    /// did not agree, with no step; CLR enabled first only when it is off and the request agreed (never in a dry run, which runs only
    /// the restore and the master key); then the restore, the master key, and outside a dry run the assembly and startup procedure
    /// and the maintenance job.</summary>
    public static CreatePlan Plan(SsisCatalog catalog, CatalogFacts facts, SsisActionDto action, bool dryRun)
    {
        var titles = catalog.Action("createCatalog")!.Steps;
        if (ClrRefusal(catalog, facts, action) is { } refused) return new(refused, false, []);
        var enableClr = !facts.ClrEnabled && !dryRun;
        return new(null, enableClr, [.. enableClr ? [titles[0]] : Array.Empty<string>(), titles[1], titles[2], .. dryRun ? Array.Empty<string>() : [titles[3], titles[4]]]);
    }

    /// <summary>Whether text is well-formed UTF-16: every surrogate in a pair. A lone one cannot cross the wire (UTF-8) unchanged.</summary>
    public static bool WellFormed(string text)
    {
        for (var index = 0; index < text.Length; index++)
        {
            if (char.IsHighSurrogate(text[index]) && index + 1 < text.Length && char.IsLowSurrogate(text[index + 1])) index++;
            else if (char.IsSurrogate(text[index])) return false;
        }
        return true;
    }

    /// <summary>The removal's step: done, or failed with what failed, clipped as every SSIS message is (messageChars).</summary>
    public static ActionStepDto CleanupStep(SsisCatalog catalog, string? failure) => failure is null
        ? new("done", catalog.CleanupStep)
        : new("failed", SsisErrors.Create(catalog, "SQL_ERROR", catalog.CleanupStep + ": " + failure).Message);

    /// <summary>sp_procoption's choice: on only when the request checked "Enable automatic execution of Integration Services stored
    /// procedure at SQL Server startup".</summary>
    public static SqlParameter StartupParameter(SsisActionDto action) => new("@startup", SqlDbType.Bit) { Value = action.StartupProcedure == true };

    /// <summary>What a Create Catalog that stopped or failed after its restore removes, in order: only what it made (the trusted hash
    /// it added, or before 14.0.800.11 the assembly loading login, sp_ssis_startup, the SSIS jobs and their login, the database it
    /// restored, while still restoring only when <paramref name="restoring"/>). The cleanup prologue runs before them.</summary>
    public static List<(SsisCreateCommand Command, SqlParameter[] Parameters)> Removal(CreatedObjects created, string name, bool restoring, string version)
    {
        var plan = new List<(SsisCreateCommand, SqlParameter[])>();
        if (created.TrustedHash is { } hash) plan.Add((SsisCreateSql.DropTrusted, [new SqlParameter("@hash", SqlDbType.VarBinary, 64) { Value = hash }]));
        if (created.Assembly && UsesAsymmetricKey(version)) plan.Add((SsisCreateSql.DropLoadingLogin, []));
        if (created.Startup) plan.Add((SsisCreateSql.DropStartup, []));
        if (created.Jobs) plan.Add((SsisCreateSql.DropJobs, []));
        if (created.Restored) plan.Add((SsisCreateSql.DropDatabase, [Name("@catalog", name), new SqlParameter("@restoring", SqlDbType.Bit) { Value = restoring }]));
        return plan;
    }

    /// <summary>What a removal command that failed leaves for the user to delete.</summary>
    public static string Leftover(SsisCatalog catalog, SsisCreateCommand command, string name) => command.Id switch
    {
        "dropTrusted" => "the trusted assembly Create Catalog added for " + catalog.AssemblyFile + " (sys.sp_drop_trusted_assembly with its hash from sys.trusted_assemblies)",
        "dropLoadingLogin" => "the ##MS_SQLEnableSystemAssemblyLoadingUser## login",
        "dropStartup" => "master.dbo.sp_ssis_startup",
        "dropJobs" => "the SSIS Server Maintenance Job and the ##MS_SSISServerCleanupJobLogin## login",
        "dropDatabase" => "the " + name + " database",
        _ => throw new InvalidOperationException("Not a removal command: " + command.Id + ".")
    };

    /// <summary>The end of a stopped or failed Create Catalog's message: what the removal did, or, naming only what is left (the
    /// <paramref name="left"/> commands of <see cref="Removal"/>, in order), what to delete by hand; and that CLR integration stays
    /// enabled when this request enabled it, either way.</summary>
    public static string Outcome(SsisCatalog catalog, string name, IReadOnlyList<SsisCreateCommand> left, string? failure, bool clrEnabled)
    {
        var clr = clrEnabled ? " CLR integration stays enabled." : "";
        if (left.Count == 0) return " Varia removed what Create Catalog had created, so the catalog does not exist." + clr;
        var items = left.Select(command => Leftover(catalog, command, name)).ToList();
        var list = items.Count == 1 ? items[0] : string.Join(", ", items[..^1]) + " and " + items[^1];
        return " Removing what Create Catalog had created failed too (" + failure + "): delete " + list + " before you try again." + clr;
    }

    /// <summary>The backup's logical files (RESTORE FILELISTONLY), or why it cannot serve: unreadable, or not the files a catalog
    /// backup holds.</summary>
    public static async Task<(CatalogBackupLayout? Layout, SsisError? Error)> LayoutAsync(SqlConnection connection, SsisCatalog catalog, string backup, CancellationToken token)
    {
        var rows = new List<(string Name, string Type)>();
        try
        {
            await using var command = connection.CreateCommand();
            command.CommandText = SsisCreateSql.FileList.Text;
            command.CommandTimeout = 0;
            command.Parameters.Add(Path(catalog, "@backup", backup));
            await using var reader = await command.ExecuteReaderAsync(token);
            var name = reader.GetOrdinal("LogicalName");
            var type = reader.GetOrdinal("Type");
            while (await reader.ReadAsync(token)) rows.Add((reader.GetString(name), reader.GetString(type).Trim()));
        }
        // 3201 and the like: the service account cannot open or read the file. Lost connections and locks are the caller's.
        catch (SqlException error) when (SsisErrors.CodeOf(error, connection) == "SQL_ERROR" && !token.IsCancellationRequested)
        {
            return (null, SsisErrors.Create(catalog, "NOT_SUPPORTED", "The catalog backup file '" + backup + "' could not be accessed. Make sure the database file exists, and the SQL Server service account is able to access it. ("
                + error.Message + ")"));
        }
        var data = rows.Where(row => row.Type == "D").Select(row => row.Name).ToList();
        var logs = rows.Where(row => row.Type == "L").Select(row => row.Name).ToList();
        if (data.Count is < 1 or > 2 || logs.Count != 1 || rows.Count != data.Count + logs.Count || rows.Any(row => row.Name.Length > 128))
            return (null, SsisErrors.Create(catalog, "NOT_SUPPORTED", "The catalog backup file '" + backup + "' does not hold what a catalog backup does: one or two data files and one log file."));
        return (new CatalogBackupLayout(data[0], data.Count > 1 ? data[1] : null, logs[0]), null);
    }

    /// <summary>Servers before 14.0.800.11 trust the ISSERVER assembly through an asymmetric key and its login (SSMS's version test).</summary>
    public static bool UsesAsymmetricKey(string version)
    {
        var parts = version.Split('.').Select(part => int.TryParse(part, NumberStyles.None, CultureInfo.InvariantCulture, out var value) ? value : 0).Concat(Enumerable.Repeat(0, 4)).Take(4).ToArray();
        var (major, minor, build, revision) = (parts[0], parts[1], parts[2], parts[3]);
        return !(major > 14 || (major == 14 && (minor > 0 || (minor == 0 && (build > 800 || (build == 800 && revision > 11))))));
    }

    /// <summary>What the dialog shows from the facts.</summary>
    public static SsisCatalogSetupDto Setup(string name, CatalogFacts facts) =>
        new(name, facts.ClrEnabled, facts.ScanForStartup, facts.BackupFile!, facts.DataFile!, facts.LogFile!);
}
