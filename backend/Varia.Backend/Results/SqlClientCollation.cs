using System.Data.SqlTypes;
using System.Reflection;
using System.Text;
using Microsoft.Data.SqlClient;

namespace Varia.Backend.Results;

/// <summary>A result column's collation, as SqlClient read it from the result's metadata. No public SqlClient API exposes it:
/// GetSchemaTable and GetColumnSchema have no collation, and the SqlString that GetSqlString returns carries the locale and
/// comparison flags but not the UTF-8 flag, and would read a whole value (sequential access then forbids reading it again).
/// So, as <see cref="SequentialXml"/> does, this reads the column's own metadata through internals the offline checks pin
/// (SqlDataReader.MetaData, its indexer, the column metadata's collation, encoding and code page, SqlCollation's LCID,
/// SqlCompareOptions, IsUTF8 and _sortId; 7.1.2 moved the column metadata to TdsColumnMetadata, where encoding and code page
/// are properties): the encoding there is the one SqlClient decodes the column's char and varchar
/// values with, so counting bytes with it gives SQL Server's DATALENGTH. Without the internals, or when the metadata does
/// not match the reader's column, the column has no collation and its varchar bytes count one per character
/// (<see cref="ColumnLength.Chars"/>).</summary>
internal static class SqlClientCollation
{
    public sealed record Column(ResultCollation Info, Encoding? Encoding);

    private const BindingFlags Internal = BindingFlags.Instance | BindingFlags.NonPublic;
    private static readonly PropertyInfo? MetaData = typeof(SqlDataReader).GetProperty("MetaData", Internal);
    private static readonly PropertyInfo? Item = MetaData?.PropertyType.GetProperty("Item", Internal, null, null, [typeof(int)], null);
    // The type the indexer returns: SqlMetaDataPriv's subclass up to 7.1.1, TdsColumnMetadata (a TdsTypeInfo) from 7.1.2.
    private static readonly Type? Meta = Item?.PropertyType;
    private static readonly FieldInfo? CollationField = Meta?.GetField("collation", Internal | BindingFlags.Public);
    private static readonly (Type? Type, Func<object, object?>? Get) EncodingMember = Member(Meta, "encoding", "Encoding");
    private static readonly (Type? Type, Func<object, object?>? Get) CodePageMember = Member(Meta, "codePage", "CodePage");
    private static readonly FieldInfo? NameField = Meta?.GetField("column", Internal | BindingFlags.Public);
    private static readonly Type? Collation = CollationField?.FieldType;
    private static readonly PropertyInfo? Lcid = Collation?.GetProperty("LCID", Internal | BindingFlags.Public);
    private static readonly PropertyInfo? Options = Collation?.GetProperty("SqlCompareOptions", Internal | BindingFlags.Public);
    private static readonly PropertyInfo? Utf8 = Collation?.GetProperty("IsUTF8", Internal | BindingFlags.Public);
    private static readonly FieldInfo? SortId = Collation?.GetField("_sortId", Internal);

    /// <summary>Whether this SqlClient has the internals <see cref="Of"/> reads, with the types it expects.</summary>
    public static bool Available { get; } = Meta is not null && NameField?.FieldType == typeof(string)
        && EncodingMember.Type == typeof(Encoding) && CodePageMember.Type == typeof(int)
        && Lcid?.PropertyType == typeof(int) && Options?.PropertyType == typeof(SqlCompareOptions) && Utf8?.PropertyType == typeof(bool) && SortId?.FieldType == typeof(byte);

    /// <summary>The first of <paramref name="names"/> that <paramref name="type"/> has as an instance field or readable
    /// property, with its type and a getter.</summary>
    internal static (Type? Type, Func<object, object?>? Get) Member(Type? type, params string[] names)
    {
        foreach (var name in names)
        {
            if (type?.GetField(name, Internal | BindingFlags.Public) is { } field) return (field.FieldType, field.GetValue);
            if (type?.GetProperty(name, Internal | BindingFlags.Public) is { CanRead: true } property && property.GetIndexParameters().Length == 0)
                return (property.PropertyType, property.GetValue);
        }
        return (null, null);
    }

    /// <summary>Column <paramref name="ordinal"/>'s collation, or null when it has none (not a character type) or it cannot be
    /// read. Never throws: a failure here only costs exact varchar byte counts.</summary>
    public static Column? Of(SqlDataReader reader, int ordinal)
    {
        if (!Available) return null;
        try
        {
            var set = MetaData!.GetValue(reader);
            if (set is null) return null;
            var meta = Item!.GetValue(set, [ordinal]);
            // Hidden key columns (FOR BROWSE) could shift the indexer from the reader's ordinals: the name must agree.
            if (meta is null || NameField!.GetValue(meta) as string != reader.GetName(ordinal)) return null;
            var collation = CollationField!.GetValue(meta);
            if (collation is null) return null;
            var utf8 = (bool)Utf8!.GetValue(collation)!;
            var encoding = utf8 ? null : EncodingMember.Get!(meta) as Encoding;
            var info = new ResultCollation((int)Lcid!.GetValue(collation)!, (byte)SortId!.GetValue(collation)!, utf8 ? 0 : (int)CodePageMember.Get!(meta)!,
                utf8, (int)(SqlCompareOptions)Options!.GetValue(collation)!);
            return new Column(info, encoding);
        }
        catch (Exception error) when (error is TargetInvocationException or InvalidCastException or ArgumentException or NullReferenceException or MemberAccessException)
        {
            return null;
        }
    }
}
