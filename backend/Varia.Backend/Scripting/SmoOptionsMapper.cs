using System.Globalization;
using Microsoft.SqlServer.Management.Common;
using Microsoft.SqlServer.Management.Smo;
using Varia.Backend.Explorer;

namespace Varia.Backend.Scripting;

/// <summary>SMO's options for one DDL script, and the version they target.</summary>
internal sealed record MappedOptions(ScriptingOptions Options, SqlServerVersion Target, DatabaseEngineEdition Edition, DatabaseEngineType EngineType, IReadOnlyList<string> Warnings);

/// <summary>Turns the scripting options a request carries into SMO's ScriptingOptions (spec B7, B8). Every setting the
/// result depends on is set explicitly, so a change in SMO's defaults cannot change a script.</summary>
internal static class SmoOptionsMapper
{
    /// <summary>SMO's named versions by number (Version160 is 160); VersionLatest and VersionOldestSupported are aliases.</summary>
    public static readonly IReadOnlyList<(int Number, SqlServerVersion Value)> Known = [.. Enum.GetNames<SqlServerVersion>()
        .Where(name => name.Length > 7 && name.StartsWith("Version", StringComparison.Ordinal) && name[7..].All(char.IsAsciiDigit))
        .Select(name => (int.Parse(name[7..], CultureInfo.InvariantCulture), Enum.Parse<SqlServerVersion>(name))).OrderBy(item => item.Item1)];
    public static (int Number, SqlServerVersion Value) Newest => Known[^1];

    /// <param name="dependencies">The target is a kind SMO's dependency discovery takes (<see cref="DependencyTypes"/>):
    /// for the others Generate script for dependent objects has nothing to add, and SMO would refuse the script.</param>
    /// <param name="sourceMajor">The SMO server's own major version, which for Managed Instance is its engine's.</param>
    public static MappedOptions Map(ScriptingOptionsDto dto, ScriptVerb verb, ServerProfile profile, bool headers, bool cloud = false, bool dependencies = true, int? sourceMajor = null)
    {
        var warnings = new List<string>();
        var (version, edition, type) = dto.MatchSourceSettings ? FromServer(profile, sourceMajor, warnings) : FromOptions(dto);
        var options = new ScriptingOptions
        {
            // Fixed: what Script As always does, as sqltoolsservice's Script As does.
            ScriptSchema = true, ScriptData = false, AllowSystemObjects = true, EnforceScriptingOptions = true, IncludeDatabaseRoleMemberships = true,
            ContinueScriptingOnError = false, IncludeScriptingParametersHeader = false, ScriptBatchTerminator = false, PrimaryObject = true,
            ToFileOnly = false, TimestampToBinary = false, LoginSid = false, NoExecuteAs = false, AgentAlertJob = false,
            // The options page.
            IncludeHeaders = headers,
            NoVardecimal = !dto.IncludeVarDecimal,
            ChangeTracking = dto.ScriptChangeTracking,
            FullTextCatalogs = dto.ScriptFullTextCatalogs,
            // Cloud databases cannot switch databases with USE.
            IncludeDatabaseContext = dto.ScriptUseDatabase && !cloud,
            IncludeIfNotExists = dto.CheckExistence,
            WithDependencies = dto.GenerateDependentObjects && dependencies,
            SchemaQualify = dto.SchemaQualify,
            ScriptDataCompression = dto.ScriptDataCompression,
            ScriptXmlCompression = dto.ScriptDataCompression,
            ExtendedProperties = dto.ScriptExtendedProperties,
            ScriptOwner = dto.ScriptOwner,
            Permissions = dto.ScriptPermissions,
            ConvertUserDefinedDataTypesToBaseType = dto.ConvertUserDefinedDataTypes,
            AnsiPadding = dto.GenerateAnsiPadding,
            NoCollation = !dto.IncludeCollation,
            NoIdentities = !dto.IncludeIdentity,
            SchemaQualifyForeignKeysReferences = dto.SchemaQualifyForeignKeys,
            Bindings = dto.ScriptBindings,
            DriChecks = dto.ScriptCheckConstraints,
            DriDefaults = dto.ScriptDefaults,
            NoFileGroup = !dto.ScriptFileGroups,
            DriForeignKeys = dto.ScriptForeignKeys,
            FullTextIndexes = dto.ScriptFullTextIndexes,
            Indexes = dto.ScriptIndexes, ClusteredIndexes = dto.ScriptIndexes, NonClusteredIndexes = dto.ScriptIndexes, XmlIndexes = dto.ScriptIndexes,
            SpatialIndexes = dto.ScriptIndexes, ColumnStoreIndexes = dto.ScriptIndexes,
            NoTablePartitioningSchemes = !dto.ScriptPartitionSchemes, NoIndexPartitioningSchemes = !dto.ScriptPartitionSchemes,
            DriPrimaryKey = dto.ScriptPrimaryKeys,
            Statistics = dto.ScriptStatistics, OptimizerData = false,
            Triggers = dto.ScriptTriggers,
            DriUniqueKeys = dto.ScriptUniqueKeys,
            NoViewColumns = !dto.ScriptViewColumns,
            DriIncludeSystemNames = dto.IncludeDriSystemNames,
            TargetDatabaseEngineType = type,
            TargetDatabaseEngineEdition = edition,
            TargetServerVersion = version
        };
        // The verb flags share one setting in SMO: clearing one clears whichever is set, so only the verb's is touched.
        switch (verb)
        {
            case ScriptVerb.Drop: options.ScriptDrops = true; break;
            case ScriptVerb.Alter: options.ScriptForAlter = true; break;
            case ScriptVerb.CreateOrAlter: options.ScriptForCreateOrAlter = true; break;
            case ScriptVerb.Create: break;
            default: throw new InvalidOperationException("SMO scripts " + verb + " in passes: " + string.Join(", ", Passes(verb)));
        }
        return new(options, version, edition, type, warnings);
    }

    /// <summary>The URN types SMO 181's DependencyWalker discovers dependencies for; it refuses every other type (a
    /// database, an index, a key, a default constraint, a schema, a principal) with "… is not supported in dependency
    /// discovery". Catalogue URN types, so a default constraint (Column/Default) is not taken for a bound default.</summary>
    public static readonly HashSet<string> DependencyTypes = ["UserDefinedFunction", "View", "Table", "StoredProcedure", "Default", "Rule", "Trigger", "UserDefinedAggregate",
        "Synonym", "Sequence", "SecurityPolicy", "UserDefinedDataType", "XmlSchemaCollection", "UserDefinedType", "UserDefinedTableType", "PartitionScheme", "PartitionFunction",
        "DdlTrigger", "PlanGuide", "SqlAssembly"];

    /// <summary>Whether Generate script for dependent objects applies to an object of this catalogue URN type. Discovery
    /// works inside one database, so not for a server trigger (a DdlTrigger too), and SMO 181 also fails on a view's
    /// trigger (it looks for a View below the View).</summary>
    public static bool Dependencies(string urnType, string? parentUrnType, bool server) =>
        !server && DependencyTypes.Contains(urnType) && !(urnType == "Trigger" && parentUrnType == "View");

    /// <summary>The SMO passes of a DDL verb. Scripter ignores ScriptForCreateDrop for a list of URNs, so DROP And CREATE
    /// is a DROP pass followed by a CREATE pass, as SSMS writes it; SmoScriptRunner drops the second pass's leading USE.</summary>
    public static IReadOnlyList<ScriptVerb> Passes(ScriptVerb verb) => verb == ScriptVerb.DropAndCreate ? [ScriptVerb.Drop, ScriptVerb.Create] : [verb];

    /// <summary>Which way SMO 181's Scripter walks dependencies for a pass with WithDependencies (SmoDependencyDiscoverer
    /// takes parents only for CREATE): a CREATE adds the objects the target refers to, a CREATE OR ALTER or a DROP the
    /// objects that refer to it, and an ALTER nothing (ScriptMaker scripts it alone).</summary>
    public static DependencyType? Walk(ScriptVerb pass) => pass switch
    {
        ScriptVerb.Create => DependencyType.Parents,
        ScriptVerb.CreateOrAlter or ScriptVerb.Drop => DependencyType.Children,
        ScriptVerb.Alter => null,
        _ => throw new InvalidOperationException("SMO scripts " + pass + " in passes: " + string.Join(", ", Passes(pass)))
    };

    /// <summary>The server's own version, edition and engine type (spec B8). Managed Instance (8) reports ProductMajorVersion
    /// 12, but SMO scripts it as a stand-alone server of the engine version @@MICROSOFTVERSION gives (ServerInformation), so
    /// a target of SQL Server 2014 would leave out what that engine has (a ledger clause, for one): there the SMO server's
    /// own major (<paramref name="sourceMajor"/>) decides, capped at SMO's newest version so it never warns. Azure SQL
    /// Database keeps the version it reports: SMO's Scripter holds SqlAzureDatabase targets at Version120 itself and scripts
    /// cloud properties at any version.</summary>
    private static (SqlServerVersion, DatabaseEngineEdition, DatabaseEngineType) FromServer(ServerProfile profile, int? sourceMajor, List<string> warnings)
    {
        var edition = Edition(profile.EngineEdition);
        var type = profile.EngineEdition is 5 or 6 or 11 ? DatabaseEngineType.SqlAzureDatabase : DatabaseEngineType.Standalone;
        var major = profile.EngineEdition == 8 && sourceMajor is int source ? Math.Max(profile.Major, Math.Min(source, Newest.Number / 10)) : profile.Major;
        return (Version(major, warnings), edition, type);
    }

    /// <summary>Whether a pass would script a ledger table or view for a stand-alone target older than SQL Server 2022, where
    /// SMO 181 drops the LEDGER clause and keeps the ledger columns: a script no older server runs. SqlAzureDatabase targets
    /// keep the clause at any version (SMO's ledger properties have cloud_min_major 12), and a DROP is the same everywhere.</summary>
    public static bool LedgerNeedsNewer(string subtype, ScriptVerb pass, SqlServerVersion target, DatabaseEngineType engineType) =>
        engineType == DatabaseEngineType.Standalone && pass != ScriptVerb.Drop && LedgerSubtypes.Contains(subtype) && Known.First(item => item.Value == target).Number < 160;

    /// <summary>Ledger tables and views' catalogue subtypes.</summary>
    private static readonly HashSet<string> LedgerSubtypes = ["updatableLedger", "appendOnlyLedger", "ledgerHistory", "ledger"];

    public static SqlServerVersion Version(int major, List<string>? warnings = null)
    {
        foreach (var (number, value) in Known) if (major > 0 && number == major * 10) return value;
        if (major * 10 > Newest.Number)
        {
            warnings?.Add("SQL Server " + major.ToString(CultureInfo.InvariantCulture) + " is newer than this version of SQL Server Management Objects supports; the script targets "
                + ScriptingErrors.VersionName(Newest.Value) + ".");
            return Newest.Value;
        }
        // A server whose version the connect probe could not read: the options page's default.
        return SqlServerVersion.Version160;
    }

    public static DatabaseEngineEdition Edition(int engineEdition) => engineEdition switch
    {
        1 => DatabaseEngineEdition.Personal,
        2 => DatabaseEngineEdition.Standard,
        3 => DatabaseEngineEdition.Enterprise,
        4 => DatabaseEngineEdition.Express,
        5 => DatabaseEngineEdition.SqlDatabase,
        6 => DatabaseEngineEdition.SqlDataWarehouse,
        8 => DatabaseEngineEdition.SqlManagedInstance,
        9 => DatabaseEngineEdition.SqlDatabaseEdge,
        11 => DatabaseEngineEdition.SqlOnDemand,
        _ => DatabaseEngineEdition.Standard
    };

    /// <summary>The options page's version rows, when Match script settings to source is False.</summary>
    private static (SqlServerVersion, DatabaseEngineEdition, DatabaseEngineType) FromOptions(ScriptingOptionsDto dto) => (
        dto.TargetServerVersion switch
        {
            "130" => SqlServerVersion.Version130, "140" => SqlServerVersion.Version140, "150" => SqlServerVersion.Version150, "160" => SqlServerVersion.Version160,
            "170" => SqlServerVersion.Version170, _ => throw new RequestException("INVALID_PARAMS", "Invalid scripting option targetServerVersion.")
        },
        dto.TargetEngineEdition switch
        {
            "personal" => DatabaseEngineEdition.Personal, "standard" => DatabaseEngineEdition.Standard, "enterprise" => DatabaseEngineEdition.Enterprise,
            "express" => DatabaseEngineEdition.Express, _ => throw new RequestException("INVALID_PARAMS", "Invalid scripting option targetEngineEdition.")
        },
        dto.TargetEngineType == "standalone" ? DatabaseEngineType.Standalone : throw new RequestException("INVALID_PARAMS", "Invalid scripting option targetEngineType."));
}
