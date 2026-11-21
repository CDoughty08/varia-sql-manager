namespace Varia.Backend.Results;

/// <summary>The one place a result column's type name is classified. <see cref="SortKindOf"/> sets every
/// <see cref="ResultColumn.SortKind"/>; sort, filter, pivot, profiles, row identity and Copy read that kind, never the type
/// name. The few SQL Server distinctions the engine-neutral kinds lack (uniqueidentifier's order, money's scale, text and
/// ntext as candidate keys) are the predicates below. src/shared/results/sort-kind.ts mirrors this, and
/// tests/fixtures/sort-kinds/sql-server.json pins both.</summary>
internal static class ColumnTypes
{
    public const string Integer = "integer", Decimal = "decimal", Float = "float", Boolean = "boolean", Date = "date", Time = "time",
        DateTime = "datetime", Timestamp = "timestamp", Binary = "binary", Text = "text", Json = "json", Other = "other";

    public static readonly string[] SortKinds = [Integer, Decimal, Float, Boolean, Date, Time, DateTime, Timestamp, Binary, Text, Json, Other];

    /// <summary>A type name without its size or precision ("decimal(18,2)" is decimal), in lower case.</summary>
    public static string BaseName(string dataType)
    {
        var cut = dataType.IndexOf('(');
        return (cut < 0 ? dataType : dataType[..cut]).Trim().ToLowerInvariant();
    }

    /// <summary>A SQL Server type's sort kind. datetimeoffset is the one instant with a zone (timestamp); SQL Server's own
    /// timestamp type is rowversion, bytes. xml shares json's kind (documents, sorted by their text, sized by length);
    /// uniqueidentifier, sql_variant and CLR types are other.</summary>
    public static string SortKindOf(string dataType) => BaseName(dataType) switch
    {
        "tinyint" or "smallint" or "int" or "bigint" => Integer,
        "decimal" or "numeric" or "money" or "smallmoney" => Decimal,
        "real" or "float" => Float,
        "bit" => Boolean,
        "date" => Date,
        "time" => Time,
        "datetime" or "datetime2" or "smalldatetime" => DateTime,
        "datetimeoffset" => Timestamp,
        "binary" or "varbinary" or "image" or "timestamp" or "rowversion" => Binary,
        "char" or "varchar" or "nchar" or "nvarchar" or "text" or "ntext" or "sysname" => Text,
        "xml" or "json" => Json,
        _ => Other
    };

    /// <summary>Exact numerics: integers, decimals and bit, which sort and hash by numeric value.</summary>
    public static bool IsExact(ResultColumn column) => column.SortKind is Integer or Decimal or Boolean;

    /// <summary>Date and time kinds, whose values are instants.</summary>
    public static bool IsTemporal(ResultColumn column) => column.SortKind is Date or Time or DateTime or Timestamp;

    /// <summary>uniqueidentifier, which sorts and hashes by its 16 bytes in SQL Server's order.</summary>
    public static bool IsGuid(ResultColumn column) => column.SortKind == Other && BaseName(column.DataType) == "uniqueidentifier";

    /// <summary>money and smallmoney, whose values have 4 decimals whatever the descriptor's scale says.</summary>
    public static bool IsMoney(ResultColumn column) => column.SortKind == Decimal && BaseName(column.DataType) is "money" or "smallmoney";

    /// <summary>float and real: the columns whose cells may keep an exact value beside their display text
    /// (<see cref="ExactValue"/>). A sql_variant sorts and groups by its text, so it keeps none.</summary>
    public static bool HoldsExact(ResultColumn column) => column.SortKind == Float;

    /// <summary>text and ntext, the deprecated large character types Auto never tries as a row key.</summary>
    public static bool IsLargeText(ResultColumn column) => column.SortKind == Text && BaseName(column.DataType) is "text" or "ntext";
}
