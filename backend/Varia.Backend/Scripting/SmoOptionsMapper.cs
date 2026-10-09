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

    /// <param name="databaseContext">False for a pass after the first: the script already starts with its USE.</param>
    public static MappedOptions Map(ScriptingOptionsDto dto, ScriptVerb verb, ServerProfile profile, bool headers, bool cloud = false, bool databaseContext = true)
    {
        var warnings = new List<string>();
        var (version, edition, type) = dto.MatchSourceSettings ? FromServer(profile, warnings) : FromOptions(dto);
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
            IncludeDatabaseContext = dto.ScriptUseDatabase && !cloud && databaseContext,
            IncludeIfNotExists = dto.CheckExistence,
            WithDependencies = dto.GenerateDependentObjects,
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

    /// <summary>The SMO passes of a DDL verb. Scripter ignores ScriptForCreateDrop for a list of URNs, so DROP And CREATE
    /// is a DROP pass followed by a CREATE pass, as SSMS writes it; the second pass writes no second USE.</summary>
    public static IReadOnlyList<ScriptVerb> Passes(ScriptVerb verb) => verb == ScriptVerb.DropAndCreate ? [ScriptVerb.Drop, ScriptVerb.Create] : [verb];

    /// <summary>The server's own version, edition and engine type (spec B8).</summary>
    private static (SqlServerVersion, DatabaseEngineEdition, DatabaseEngineType) FromServer(ServerProfile profile, List<string> warnings)
    {
        var edition = Edition(profile.EngineEdition);
        var type = profile.EngineEdition is 5 or 6 or 11 ? DatabaseEngineType.SqlAzureDatabase : DatabaseEngineType.Standalone;
        return (Version(profile.Major, warnings), edition, type);
    }

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
