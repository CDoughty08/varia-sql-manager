using System.Globalization;

namespace Varia.Backend.Search;

/// <summary>What a typed entry (a column, a parameter, a scalar function's return) is beyond its type.</summary>
[Flags]
internal enum TypedFlags : byte
{
    None = 0,
    Nullable = 1,
    Identity = 2,
    Computed = 4,
    /// <summary>A column with a default constraint.</summary>
    Default = 8,
    Output = 16,
    /// <summary>A table-valued parameter (READONLY).</summary>
    ReadOnly = 32,
    /// <summary>The length is a vector's dimensions, which the server reported (not its bytes).</summary>
    Dimensions = 64
}

/// <summary>How a key column takes part in its index or key.</summary>
[Flags]
internal enum KeyColumnFlags : byte
{
    None = 0,
    Descending = 1,
    /// <summary>An index's included (non-key) column.</summary>
    Included = 2
}

/// <summary>A column's, parameter's or scalar function's return type as the catalog states it: the type (by name, its schema for a
/// user-defined one, and its ids), its length in bytes (-1 for max; a vector's dimensions where <see cref="TypedFlags.Dimensions"/> says so), precision and scale, its ordinal (column_id or parameter_id; 0
/// for a function's return) and its flags.</summary>
internal readonly record struct TypedDetail(string TypeName, string? TypeSchema, int UserTypeId, byte SystemTypeId, bool UserDefinedType, bool TableType,
    short MaxLength, byte Precision, byte Scale, short Ordinal, TypedFlags Flags)
{
    /// <summary>The type as a script writes it: a base type with its length, precision or scale (nvarchar(50), varchar(max),
    /// decimal(18,2), datetime2(3)); any other type (sysname, an alias or CLR type) by its name alone.</summary>
    public string TypeText
    {
        get
        {
            static string Number(int value) => value.ToString(CultureInfo.InvariantCulture);
            // vector is a system type whose user_type_id (255) is not its system_type_id (165), as an alias's is not.
            if (!UserDefinedType && TypeName == "vector") return (Flags & TypedFlags.Dimensions) != 0 ? TypeName + "(" + Number(MaxLength) + ")" : TypeName;
            if (UserDefinedType || UserTypeId != SystemTypeId) return TypeName;
            return TypeName switch
            {
                "varchar" or "char" or "varbinary" or "binary" => TypeName + "(" + (MaxLength == -1 ? "max" : Number(MaxLength)) + ")",
                "nvarchar" or "nchar" => TypeName + "(" + (MaxLength == -1 ? "max" : Number(MaxLength / 2)) + ")",
                "decimal" or "numeric" => TypeName + "(" + Number(Precision) + "," + Number(Scale) + ")",
                "datetime2" or "time" or "datetimeoffset" => TypeName + "(" + Number(Scale) + ")",
                _ => TypeName
            };
        }
    }
}

/// <summary>One column of an index or key: its column_id in the key's table, for a foreign key the referenced table's column_id
/// (0 otherwise), and how it takes part.</summary>
internal readonly record struct KeyColumn(short Column, short Referenced, KeyColumnFlags Flags);

/// <summary>
/// The editor metadata beside an <see cref="ObjectTable"/>, held column-wise and read only when a database's children are kept:
/// the database's types, a type per column, parameter and scalar function, and the columns of each index and key (a primary or
/// unique key shares its index's columns; a foreign key pairs each column with the referenced table's). Entries are found by
/// binary search over sorted entry indexes; texts (type names and schemas) are ids into the table's texts, so the table's text
/// swap (<see cref="ObjectTable.WithTexts"/>) and the pool's references cover them.
/// </summary>
internal sealed class ObjectDetails
{
    private readonly int[] typeName, typeSchema, typeId;
    private readonly byte[] typeSystem, typeFlags;
    private readonly int[] typedAt;
    private readonly ushort[] typedType;
    private readonly short[] typedLength, typedOrdinal;
    private readonly byte[] typedPrecision, typedScale, typedFlags;
    private readonly int[] keyAt, keyFrom, keyReferenced;
    private readonly short[] keyCount;
    private readonly short[] keyColumn, keyOther;
    private readonly byte[] keyColumnFlags;

    private const byte UserDefinedFlag = 1, TableTypeFlag = 2;

    private ObjectDetails(int[] typeName, int[] typeSchema, int[] typeId, byte[] typeSystem, byte[] typeFlags, int[] typedAt, ushort[] typedType, short[] typedLength,
        byte[] typedPrecision, byte[] typedScale, short[] typedOrdinal, byte[] typedFlags, int[] keyAt, int[] keyFrom, short[] keyCount, int[] keyReferenced,
        short[] keyColumn, short[] keyOther, byte[] keyColumnFlags)
    {
        (this.typeName, this.typeSchema, this.typeId, this.typeSystem, this.typeFlags) = (typeName, typeSchema, typeId, typeSystem, typeFlags);
        (this.typedAt, this.typedType, this.typedLength, this.typedPrecision, this.typedScale, this.typedOrdinal, this.typedFlags) =
            (typedAt, typedType, typedLength, typedPrecision, typedScale, typedOrdinal, typedFlags);
        (this.keyAt, this.keyFrom, this.keyCount, this.keyReferenced) = (keyAt, keyFrom, keyCount, keyReferenced);
        (this.keyColumn, this.keyOther, this.keyColumnFlags) = (keyColumn, keyOther, keyColumnFlags);
    }

    public int Types => typeName.Length;
    public int TypedCount => typedAt.Length;
    public int KeyCount => keyAt.Length;
    public int KeyColumns => keyColumn.Length;

    /// <summary>What the details cost the budget (<see cref="IndexMemory"/>).</summary>
    public long Bytes => Types * IndexMemory.TypeBytes + TypedCount * IndexMemory.TypedBytes + KeyCount * IndexMemory.KeyBytes + KeyColumns * IndexMemory.KeyColumnBytes;

    /// <summary>The text ids the details name (type names and schemas): names, which a text swap must keep.</summary>
    public IEnumerable<int> TextIds() => typeName.Concat(typeSchema.Where(id => id >= 0));

    public TypedDetail? Typed(int at, IReadOnlyList<object?> texts)
    {
        var item = Array.BinarySearch(typedAt, at);
        if (item < 0) return null;
        var type = typedType[item];
        return new((string)texts[typeName[type]]!, typeSchema[type] < 0 ? null : (string?)texts[typeSchema[type]], typeId[type], typeSystem[type],
            (typeFlags[type] & UserDefinedFlag) != 0, (typeFlags[type] & TableTypeFlag) != 0, typedLength[item], typedPrecision[item], typedScale[item], typedOrdinal[item], (TypedFlags)typedFlags[item]);
    }

    /// <summary>The columns of the index or key at <paramref name="at"/>, keys first in key order then included ones; empty when it has none.</summary>
    public KeyColumn[] Keys(int at)
    {
        var item = Array.BinarySearch(keyAt, at);
        if (item < 0) return [];
        var columns = new KeyColumn[keyCount[item]];
        for (var column = 0; column < columns.Length; column++)
        {
            var from = keyFrom[item] + column;
            columns[column] = new(keyColumn[from], keyOther[from], (KeyColumnFlags)keyColumnFlags[from]);
        }
        return columns;
    }

    /// <summary>The table a foreign key at <paramref name="at"/> references (an entry of the same table), or -1 (not a foreign key,
    /// or a table the index does not hold).</summary>
    public int Referenced(int at) => Array.BinarySearch(keyAt, at) is var item and >= 0 ? keyReferenced[item] : -1;

    /// <summary>How many foreign keys reference a table the index holds.</summary>
    public int ForeignKeyCount => keyReferenced.Count(referenced => referenced >= 0);

    /// <summary>Each foreign key that references a table the index holds, with that table, in entry order.</summary>
    public IEnumerable<(int At, int Referenced)> ForeignKeys()
    {
        for (var item = 0; item < keyAt.Length; item++)
            if (keyReferenced[item] >= 0) yield return (keyAt[item], keyReferenced[item]);
    }

    /// <summary>Collects a read's details as it goes; <see cref="Build"/> sorts them by entry and renumbers them as the table's
    /// builder renumbers its entries.</summary>
    internal sealed class Builder
    {
        private readonly List<(int Name, int Schema, int Id, byte System, byte Flags)> types = [];
        private readonly List<(int At, ushort Type, short Length, byte Precision, byte Scale, short Ordinal, byte Flags)> typed = [];
        private readonly List<(int At, int From, short Count, int Referenced)> keys = [];
        private readonly List<(short Column, short Other, byte Flags)> columns = [];

        public int TypeCount => types.Count;

        /// <summary>Adds a type whose name (and schema) already have text ids; its index for <see cref="SetTyped"/>.</summary>
        public ushort AddType(int name, int schema, int userTypeId, byte systemTypeId, bool userDefined, bool tableType)
        {
            if (types.Count > ushort.MaxValue) throw new InvalidOperationException("Too many types.");
            types.Add((name, schema, userTypeId, systemTypeId, (byte)((userDefined ? UserDefinedFlag : 0) | (tableType ? TableTypeFlag : 0))));
            return (ushort)(types.Count - 1);
        }

        public void SetTyped(int at, ushort type, short maxLength, byte precision, byte scale, short ordinal, TypedFlags flags) =>
            typed.Add((at, type, maxLength, precision, scale, ordinal, (byte)flags));

        /// <summary>Starts the column list of the index or key at <paramref name="at"/> (with the table a foreign key references, or
        /// -1); its columns follow through <see cref="AddKeyColumn"/>. Answers the key's item, which a key sharing its columns names.</summary>
        public int StartKey(int at, int referenced)
        {
            keys.Add((at, columns.Count, 0, referenced));
            return keys.Count - 1;
        }

        public void AddKeyColumn(short column, short other, KeyColumnFlags flags)
        {
            columns.Add((column, other, (byte)flags));
            var last = keys[^1];
            keys[^1] = last with { Count = (short)(last.Count + 1) };
        }

        /// <summary>Gives the key at <paramref name="at"/> the columns of the key item <paramref name="item"/> (a primary or unique key its index's).</summary>
        public void ShareKey(int at, int item) => keys.Add((at, keys[item].From, keys[item].Count, -1));

        /// <summary>The details, their entries renumbered by <paramref name="map"/> (-1 for a removed entry, whose details are left
        /// out; a foreign key's removed table becomes -1), sorted by entry; null when there are none.</summary>
        public ObjectDetails? Build(Func<int, int> map)
        {
            if (types.Count == 0 && typed.Count == 0 && keys.Count == 0) return null;
            var keptTyped = typed.Select(item => item with { At = map(item.At) }).Where(item => item.At >= 0).OrderBy(item => item.At).ToArray();
            var keptKeys = keys.Select(item => item with { At = map(item.At), Referenced = item.Referenced < 0 ? -1 : map(item.Referenced) }).Where(item => item.At >= 0).OrderBy(item => item.At).ToArray();
            return new(
                [.. types.Select(type => type.Name)], [.. types.Select(type => type.Schema)], [.. types.Select(type => type.Id)], [.. types.Select(type => type.System)], [.. types.Select(type => type.Flags)],
                [.. keptTyped.Select(item => item.At)], [.. keptTyped.Select(item => item.Type)], [.. keptTyped.Select(item => item.Length)], [.. keptTyped.Select(item => item.Precision)],
                [.. keptTyped.Select(item => item.Scale)], [.. keptTyped.Select(item => item.Ordinal)], [.. keptTyped.Select(item => item.Flags)],
                [.. keptKeys.Select(item => item.At)], [.. keptKeys.Select(item => item.From)], [.. keptKeys.Select(item => item.Count)], [.. keptKeys.Select(item => item.Referenced)],
                [.. columns.Select(column => column.Column)], [.. columns.Select(column => column.Other)], [.. columns.Select(column => column.Flags)]);
        }
    }
}
