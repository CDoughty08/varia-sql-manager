using System.Globalization;

namespace Varia.Backend.Scripting;

/// <summary>A column's or parameter's type as the preflight reads it from sys.types.</summary>
/// <param name="Name">sys.types.name: the system type, or the user type's own name.</param>
/// <param name="Schema">The type's schema (sys for system types).</param>
/// <param name="UserDefined">An alias, CLR or table type created in the database.</param>
/// <param name="Cursor">A CURSOR parameter, which the catalog records as int.</param>
internal sealed record TypeRow(string Name, string? Schema = null, bool UserDefined = false, int MaxLength = 0, int Precision = 0, int Scale = 0, string? XmlSchema = null,
    string? XmlCollection = null, int? VectorDimensions = null, bool Cursor = false);

/// <summary>Type text in the templates (spec B9), a port of sqltoolsservice's GetDatatype over catalog rows: user types by
/// their quoted name, lengths as declared, everything else by the system type's name.</summary>
internal static class SqlTypeText
{
    public static string ForTemplate(TypeRow type, bool schemaQualify)
    {
        if (type.Cursor) return "cursor";
        if (type.UserDefined) return schemaQualify && type.Schema is { } schema ? ScriptFormatter.Quote(schema) + "." + ScriptFormatter.Quote(type.Name) : ScriptFormatter.Quote(type.Name);
        var name = type.Name;
        return name switch
        {
            "char" or "varchar" or "binary" or "varbinary" => name + "(" + Length(type.MaxLength) + ")",
            "nchar" or "nvarchar" => name + "(" + (type.MaxLength == -1 ? "max" : Number(type.MaxLength / 2)) + ")",
            "decimal" or "numeric" => name + "(" + Number(type.Precision) + "," + Number(type.Scale) + ")",
            "time" or "datetime2" or "datetimeoffset" => name + "(" + Number(type.Scale) + ")",
            "xml" when type.XmlCollection is { } collection => "xml (" + ScriptFormatter.Quote(type.XmlSchema ?? "dbo") + "." + ScriptFormatter.Quote(collection) + ")",
            "vector" when type.VectorDimensions is { } dimensions => "vector(" + Number(dimensions) + ")",
            _ => name
        };
    }

    private static string Length(int maxLength) => maxLength == -1 ? "max" : Number(maxLength);
    private static string Number(int value) => value.ToString(CultureInfo.InvariantCulture);
}
