using System.Globalization;

namespace Varia.Backend.Explorer;

/// <summary>A column's or parameter's type as the catalog describes it.</summary>
/// <param name="Name">sys.types.name of the user type.</param>
/// <param name="BaseName">The system type under an alias type, otherwise null.</param>
/// <param name="TypeSchema">The type's schema, used for table-valued parameters.</param>
internal sealed record SqlTypeInfo(string Name, int MaxLength = 0, int Precision = 0, int Scale = 0, bool IsUserDefined = false, bool IsAssembly = false, bool IsTableType = false,
    string? BaseName = null, bool XmlDocument = false, string? XmlSchema = null, string? XmlCollection = null, int? VectorDimensions = null, string? TypeSchema = null);

/// <summary>SSMS's Object Explorer label text (golden tables in ExplorerChecks).</summary>
internal static class ExplorerLabels
{
    public const int MaxLabel = 300, MaxSublabel = 200, MaxDetail = 512;

    /// <summary>"nvarchar(50)", "decimal(8,2)", "Name(nvarchar(50))", "XML(CONTENT dbo.Coll)", "dbo.TableType", "vector(3)".</summary>
    public static string TypeText(SqlTypeInfo type)
    {
        if (type.XmlCollection is not null) return "XML(" + (type.XmlDocument ? "DOCUMENT " : "CONTENT ") + type.XmlSchema + "." + type.XmlCollection + ")";
        if (type.IsTableType) return type.TypeSchema is null ? type.Name : type.TypeSchema + "." + type.Name;
        if (type.IsUserDefined && !type.IsAssembly && type.BaseName is not null) return type.Name + "(" + BaseText(type.BaseName, type) + ")";
        if (type.IsUserDefined) return type.Name;
        return BaseText(type.Name, type);
    }

    private static string BaseText(string name, SqlTypeInfo type) => name switch
    {
        "char" or "varchar" or "binary" or "varbinary" => name + "(" + (type.MaxLength == -1 ? "max" : type.MaxLength.ToString(CultureInfo.InvariantCulture)) + ")",
        "nchar" or "nvarchar" => name + "(" + (type.MaxLength == -1 ? "max" : (type.MaxLength / 2).ToString(CultureInfo.InvariantCulture)) + ")",
        "decimal" or "numeric" => name + "(" + type.Precision.ToString(CultureInfo.InvariantCulture) + "," + type.Scale.ToString(CultureInfo.InvariantCulture) + ")",
        "datetime2" or "time" or "datetimeoffset" => name + "(" + type.Scale.ToString(CultureInfo.InvariantCulture) + ")",
        "vector" when type.VectorDimensions is { } dimensions => "vector(" + dimensions.ToString(CultureInfo.InvariantCulture) + ")",
        _ => name
    };

    /// <summary>"(PK, FK, Computed, int, not null)": the parts that apply, joined with ", ".</summary>
    public static string ColumnSublabel(bool primaryKey, bool foreignKey, bool computed, string typeText, bool nullable)
    {
        var parts = new List<string>(5);
        if (primaryKey) parts.Add("PK");
        if (foreignKey) parts.Add("FK");
        if (computed) parts.Add("Computed");
        parts.Add(typeText);
        parts.Add(nullable ? "null" : "not null");
        return "(" + string.Join(", ", parts) + ")";
    }

    /// <summary>sys.indexes.type with its uniqueness; type 3 needs to know whether the XML index is primary.</summary>
    public static string IndexSublabel(int type, bool unique, bool primaryXml, string? typeDescription) => type switch
    {
        1 => "(Clustered)",
        2 => unique ? "(Unique, Non-Clustered)" : "(Non-Unique, Non-Clustered)",
        3 => primaryXml ? "(Primary XML)" : "(Secondary XML)",
        4 => "(Spatial)",
        5 => "(Clustered Columnstore)",
        6 => "(Non-Clustered Columnstore)",
        7 => "(Non-Clustered Hash)",
        _ => "(" + TitleCase(typeDescription ?? "Index") + ")"
    };

    public static string IndexSubtype(int type) => type switch
    {
        1 => "clustered", 2 => "nonclustered", 3 => "xml", 4 => "spatial", 5 => "clusteredColumnstore", 6 => "nonclusteredColumnstore", 7 => "hash", _ => "other"
    };

    private static string TitleCase(string text) => string.Join(" ", text.Split(['_', ' '], StringSplitOptions.RemoveEmptyEntries)
        .Select(word => char.ToUpperInvariant(word[0]) + word[1..].ToLowerInvariant()));

    /// <summary>An SSIS project's deployment, in the catalog's own offset: "(Deployed 2026-10-21 14:05)".</summary>
    public static string? Deployed(DateTimeOffset? deployed) => deployed is { } value ? "(Deployed " + value.ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture) + ")" : null;

    /// <summary>An SSIS environment's variable count: "(1 variable)", "(3 variables)".</summary>
    public static string Variables(int count) => "(" + count.ToString("N0", CultureInfo.InvariantCulture) + (count == 1 ? " variable)" : " variables)");

    /// <summary>sys.databases.state text, or null for ONLINE.</summary>
    public static string? DatabaseState(int state) => state switch
    {
        0 => null, 1 => "Restoring...", 2 => "In Recovery", 3 => "Recovery Pending", 4 => "Suspect", 5 => "Emergency", 6 or 10 => "Offline", 7 => "Copying",
        _ => "State " + state.ToString(CultureInfo.InvariantCulture)
    };

    /// <summary>Why a database the login could not open (4060) is unavailable to everyone, from sys.databases: its state when it
    /// is not online, or single-user mode, which another session holds; null when it is online and open to others, so the
    /// login itself has no access.</summary>
    public static string? Unavailable(int state, int userAccess) => state != 0 ? DatabaseState(state) : userAccess == 1 ? "Single User, in use by another session" : null;

    /// <summary>A database's sublabel, status and whether it expands: state, read-only (or standby) and user access, in
    /// one pair of parentheses. One the login cannot open still expands, as in SSMS, so expanding it explains why.</summary>
    public static (string? Sublabel, string? Status, bool HasChildren) Database(int state, int userAccess, bool readOnly, bool standby, bool access)
    {
        var parts = new List<string>(3);
        if (DatabaseState(state) is { } text) parts.Add(text);
        if (readOnly || standby) parts.Add(standby ? "Standby / Read-Only" : "Read-Only");
        if (userAccess == 1) parts.Add("Single User");
        else if (userAccess == 2) parts.Add("Restricted User");
        var usable = state is 0 or 5;
        var status = !usable ? "unavailable" : !access ? "noAccess" : readOnly || standby ? "readOnly" : null;
        return (parts.Count == 0 ? null : "(" + string.Join(", ", parts) + ")", status, usable);
    }

    /// <summary>"(System-Versioned)", "(Updatable Ledger)" or "(Append-Only Ledger)"; dropped ledger tables have none.</summary>
    public static string? TableSublabel(int temporalType, int ledgerType, bool droppedLedger) =>
        droppedLedger ? null : ledgerType == 2 ? "(Updatable Ledger)" : ledgerType == 3 ? "(Append-Only Ledger)" : temporalType == 2 ? "(System-Versioned)" : null;

    public static string? TableSubtype(int temporalType, int ledgerType, bool node, bool edge, bool fileTable, bool external, bool droppedLedger, bool system) =>
        droppedLedger ? "droppedLedger"
        : ledgerType == 2 ? "updatableLedger"
        : ledgerType == 3 ? "appendOnlyLedger"
        : ledgerType == 1 ? "ledgerHistory"
        : temporalType == 2 ? "systemVersioned"
        : temporalType == 1 ? "history"
        : node ? "graphNode" : edge ? "graphEdge" : fileTable ? "fileTable" : external ? "external" : system ? "system" : null;

    /// <summary>"(int, Input, No default)"; <paramref name="hasDefault"/> null omits the token (no readable definition).</summary>
    public static string ParameterSublabel(string typeText, bool output, bool readOnly, bool? hasDefault) =>
        "(" + typeText + ", " + (output ? "Input/Output" : "Input") + (readOnly ? ", ReadOnly" : "") + (hasDefault is null ? "" : hasDefault.Value ? ", Default" : ", No default") + ")";

    /// <summary>The return row: procedures return an integer status; table-valued functions a table.</summary>
    public static string ReturnLabel(string objectType, string? scalarTypeText) => objectType switch
    {
        "P" or "PC" or "X" or "RF" => "Returns integer",
        "IF" or "TF" or "FT" => "Returns Table",
        _ => "Returns " + (scalarTypeText ?? "Table")
    };

    public static string ProcedureSubtype(string type) => type switch { "PC" => "clr", "X" => "extended", "RF" => "replicationFilter", _ => "sql" };

    public static string FunctionSubtype(string type) => type switch
    {
        "IF" => "inline", "TF" => "tableValued", "FT" => "clrTableValued", "FS" => "clrScalar", "AF" => "aggregate", _ => "scalar"
    };

    /// <summary>Tooltip facts for a column, joined with " · ".</summary>
    public static string? ColumnDetail(bool identity, bool sparse, bool columnSet, bool hidden, bool masked, bool encrypted, int generatedAlways, bool graph, string? collation)
    {
        var parts = new List<string>();
        if (identity) parts.Add("Identity");
        if (sparse) parts.Add("Sparse");
        if (columnSet) parts.Add("Column set");
        if (hidden) parts.Add("Hidden");
        if (masked) parts.Add("Masked");
        if (encrypted) parts.Add("Encrypted");
        if (generatedAlways != 0) parts.Add(generatedAlways switch { 1 => "Generated always (row start)", 2 => "Generated always (row end)", _ => "Generated always" });
        if (graph) parts.Add("Graph column");
        if (collation is not null) parts.Add("Collation " + collation);
        return Join(parts);
    }

    public static string? Join(IEnumerable<string?> parts)
    {
        var text = string.Join(" · ", parts.Where(part => !string.IsNullOrEmpty(part)));
        return text.Length == 0 ? null : Clip(text, MaxDetail);
    }

    public static string Clip(string text, int max) => text.Length <= max ? text : text[..(max - 1)] + "…";

    public static string Created(DateTime value) => value.ToString("yyyy-MM-dd'T'HH:mm:ss", CultureInfo.InvariantCulture);
}
