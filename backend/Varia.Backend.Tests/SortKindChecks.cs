using System.Text.Json;
using System.Text.Json.Nodes;
using Varia.Backend;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>ResultColumn.SortKind (ColumnTypes): the SQL Server mapping in tests/fixtures/sort-kinds/sql-server.json, which
/// tests/sort-kind.test.ts checks the TypeScript mirror against, and parity: every consumer that classified columns by
/// type name before sortKind classifies every SQL Server descriptor exactly as its old code (kept below as Legacy) did.</summary>
internal static class SortKindChecks
{
    private static readonly ResultCollation CaseInsensitive = new(1033, 0, 1252, false, 1 | 8 | 16);
    private static readonly ResultCollation Bin2 = new(1033, 0, 1252, false, 16384);

    public static void Run(Action<bool, string> check)
    {
        var path = Path.Combine(GoldenText.Repository(), "tests", "fixtures", "sort-kinds", "sql-server.json");
        var types = JsonNode.Parse(File.ReadAllText(path))!["types"]!.AsArray().Select(item => ((string)item![0]!, (string)item[1]!)).ToArray();
        var wrong = types.Where(type => ColumnTypes.SortKindOf(type.Item1) != type.Item2).Select(type => type.Item1 + " gave " + ColumnTypes.SortKindOf(type.Item1)).ToArray();
        check(types.Length > 40 && wrong.Length == 0, "ColumnTypes.SortKindOf gives each SQL Server type in tests/fixtures/sort-kinds/sql-server.json its kind: " + string.Join(", ", wrong));
        check(types.Select(type => type.Item2).Distinct().Order(StringComparer.Ordinal).SequenceEqual(ColumnTypes.SortKinds.Order(StringComparer.Ordinal)),
            "the SQL Server golden uses every sort kind, and only those");
        check(new ResultColumn("a", "decimal(18,2)", "text").SortKind == "decimal" && (new ResultColumn("a", "INT64", "text") { SortKind = "integer" }).SortKind == "integer",
            "a column's sortKind comes from its type name unless its producer sets it");
        var json = JsonSerializer.Serialize(new ResultColumn("a", "bit", "text"), new JsonSerializerOptions(JsonSerializerDefaults.Web));
        check(json.Contains("\"sortKind\":\"boolean\"", StringComparison.Ordinal), "a descriptor column carries sortKind on the wire: " + json);

        // Every type in every shape a consumer looks at: wire, collation, role, length and scale.
        var columns = new List<ResultColumn>();
        var wires = new List<WireKind>();
        foreach (var (type, _) in types)
            foreach (var wire in new[] { WireKind.Text, WireKind.Binary })
                foreach (var collation in new[] { null, CaseInsensitive, Bin2 })
                    foreach (var role in new[] { null, "xml", "json", "udt" })
                        foreach (var maxLength in new int?[] { null, 0, 50, 2000 })
                            foreach (var scale in new int?[] { null, 3 })
                                foreach (var name in new[] { "Amount", "ItemId" })
                                {
                                    columns.Add(new ResultColumn(name, type, wire == WireKind.Text ? "text" : "binary", role, MaxLength: maxLength, Precision: scale is null ? null : 10, Scale: scale, Collation: collation));
                                    wires.Add(wire);
                                }
        var differences = new List<string>();
        void Same<T>(string consumer, Func<ResultColumn, WireKind, T> now, Func<ResultColumn, WireKind, T> before)
        {
            var count = 0;
            for (var i = 0; i < columns.Count; i++)
            {
                var (a, b) = (now(columns[i], wires[i]), before(columns[i], wires[i]));
                if (!EqualityComparer<T>.Default.Equals(a, b) && count++ < 3) differences.Add(consumer + " " + columns[i] + " " + wires[i] + ": " + a + " not " + b);
            }
        }
        Same("ViewSorter.KindOf", ViewSorter.KindOf, Legacy.KindOf);
        Same("ViewSorter.IsText", (column, _) => ViewSorter.IsText(column), (column, _) => Legacy.IsText(column));
        Same("InstantKey", (column, wire) => ViewSorter.KindOf(column, wire) == ViewSorter.Kind.Ordinal && wire == WireKind.Text && ViewSorter.IsInstant(column) ? (column.SortKind == ColumnTypes.Time ? 2 : 1) : 0,
            (column, wire) => Legacy.KindOf(column, wire) == ViewSorter.Kind.Ordinal && wire == WireKind.Text && Legacy.TypeName(column) is "date" or "datetime" or "datetime2" or "smalldatetime" or "time" ? (Legacy.TypeName(column) == "time" ? 2 : 1) : 0);
        Same("ResultTextWriter.Kind", (column, _) => ResultTextWriter.Kind(column), (column, _) => Legacy.TextKind(column));
        Same("ResultPivoter.IsNumeric", ResultPivoter.IsNumeric, Legacy.IsNumeric);
        Same("ResultPivoter.Scale", (column, _) => ResultPivoter.Scale(column), (column, _) => Legacy.Scale(column));
        Same("ResultPivoter.IsInteger", (column, _) => ResultPivoter.IsInteger(column), (column, _) => Legacy.TypeName(column) is "tinyint" or "smallint" or "int" or "bigint");
        Same("ColumnProfiler.BasisOf", (column, wire) => ColumnProfiler.BasisOf(column, wire, ViewSorter.KindOf(column, wire)), (column, wire) => Legacy.BasisOf(column, wire));
        Same("ColumnProfiler time only", (column, _) => column.SortKind == ColumnTypes.Time, (column, _) => Legacy.TypeName(column) == "time");
        var hasher = new CellHasher(columns, wires);
        var legacyHasher = Legacy.HashKinds(columns, wires);
        var hashes = Enumerable.Range(0, columns.Count).Where(i => hasher.KindOf(i) != legacyHasher[i]).Take(3).Select(i => "CellHasher " + columns[i] + ": " + hasher.KindOf(i) + " not " + legacyHasher[i]);
        differences.AddRange(hashes);
        if (!RowIdentity.Candidates(columns, wires).SequenceEqual(Legacy.Candidates(columns, wires))) differences.Add("RowIdentity.Candidates ranks the columns differently");
        check(columns.Count > 10_000 && differences.Count == 0, "sort, length sorts, instants, Copy and Save, pivot, profiles, row hashes and Auto's key candidates classify every SQL Server descriptor as before sortKind: "
            + string.Join("; ", differences));
    }

    /// <summary>The classifications as they were, by type name, before sortKind.</summary>
    private static class Legacy
    {
        public static string TypeName(ResultColumn column)
        {
            var type = column.DataType;
            var cut = type.IndexOf('(');
            return (cut < 0 ? type : type[..cut]).Trim().ToLowerInvariant();
        }

        public static bool IsText(ResultColumn column) => column.Collation is not null || column.Role is "xml" or "json"
            || TypeName(column) is "char" or "varchar" or "nchar" or "nvarchar" or "text" or "ntext" or "sysname" or "xml" or "json";

        public static ViewSorter.Kind KindOf(ResultColumn column, WireKind wire)
        {
            if (wire == WireKind.Binary) return ViewSorter.Kind.Ordinal;
            return TypeName(column) switch
            {
                "bit" or "tinyint" or "smallint" or "int" or "bigint" or "decimal" or "numeric" or "money" or "smallmoney" => ViewSorter.Kind.Exact,
                "real" or "float" => ViewSorter.Kind.Approximate,
                "datetimeoffset" => ViewSorter.Kind.Ticks,
                "uniqueidentifier" => ViewSorter.Kind.Guid,
                "char" or "varchar" or "nchar" or "nvarchar" or "text" or "ntext" or "sysname" when column.Collation is not null => ViewSorter.Kind.Collated,
                _ => ViewSorter.Kind.Ordinal
            };
        }

        private static readonly HashSet<string> NumberTypes = ["tinyint", "smallint", "int", "bigint", "decimal", "numeric", "money", "smallmoney", "real", "float"];

        public static ResultTextWriter.ValueKind TextKind(ResultColumn column)
        {
            if (column.Wire == "binary") return ResultTextWriter.ValueKind.Binary;
            var type = column.DataType.Split('(')[0].Trim().ToLowerInvariant();
            return type == "bit" ? ResultTextWriter.ValueKind.Bit : NumberTypes.Contains(type) ? ResultTextWriter.ValueKind.Number : ResultTextWriter.ValueKind.Text;
        }

        public static bool IsNumeric(ResultColumn column, WireKind wire) =>
            KindOf(column, wire) is ViewSorter.Kind.Approximate || (KindOf(column, wire) is ViewSorter.Kind.Exact && TypeName(column) != "bit");

        public static int Scale(ResultColumn column) => TypeName(column) switch
        {
            "money" or "smallmoney" => 4,
            "decimal" or "numeric" => column.Scale ?? 0,
            _ => 0
        };

        public static ColumnProfiler.Basis BasisOf(ResultColumn column, WireKind wire)
        {
            var kind = KindOf(column, wire);
            if (wire == WireKind.Binary) return ColumnProfiler.Basis.Bytes;
            if (IsText(column)) return ColumnProfiler.Basis.Chars;
            if (kind is ViewSorter.Kind.Exact or ViewSorter.Kind.Approximate) return ColumnProfiler.Basis.Value;
            return TypeName(column) is "date" or "datetime" or "datetime2" or "smalldatetime" or "time" or "datetimeoffset" ? ColumnProfiler.Basis.Time : ColumnProfiler.Basis.None;
        }

        public static CellHasher.Kind[] HashKinds(IReadOnlyList<ResultColumn> columns, IReadOnlyList<WireKind> wires)
        {
            var kinds = new CellHasher.Kind[columns.Count];
            for (var c = 0; c < columns.Count; c++)
            {
                var column = columns[c];
                if (wires[c] == WireKind.Binary) { kinds[c] = CellHasher.Kind.Bytes; continue; }
                var type = TypeName(column);
                if (column.Collation is not null && type is "char" or "varchar" or "nchar" or "nvarchar" or "text" or "ntext" or "sysname")
                {
                    kinds[c] = ViewSorter.Culture(column.Collation) is null ? CellHasher.Kind.Trimmed : CellHasher.Kind.Collated;
                    continue;
                }
                kinds[c] = type switch
                {
                    "bit" or "tinyint" or "smallint" or "int" or "bigint" or "decimal" or "numeric" or "money" or "smallmoney" => CellHasher.Kind.Exact,
                    "real" or "float" => CellHasher.Kind.Float,
                    "uniqueidentifier" => CellHasher.Kind.Guid,
                    "datetimeoffset" => CellHasher.Kind.Ticks,
                    "date" or "datetime" or "datetime2" or "smalldatetime" => CellHasher.Kind.DateTime,
                    "time" => CellHasher.Kind.Time,
                    _ => CellHasher.Kind.Bytes
                };
            }
            return kinds;
        }

        public static IEnumerable<int> Candidates(IReadOnlyList<ResultColumn> columns, IReadOnlyList<WireKind> wires)
        {
            var ranked = new List<(int Rank, int Column)>();
            for (var c = 0; c < columns.Count; c++)
            {
                var column = columns[c];
                if (wires[c] == WireKind.Binary || ResultTextWriter.Hidden(column) || column.Role is not null) continue;
                var type = TypeName(column);
                var keyType = type is "tinyint" or "smallint" or "int" or "bigint" or "uniqueidentifier" or "decimal" or "numeric";
                var other = type is "char" or "varchar" or "nchar" or "nvarchar" or "sysname" or "date" or "datetime" or "datetime2" or "smalldatetime" or "datetimeoffset" or "time"
                    && (column.MaxLength is null or > 0 and <= 900);
                if (!keyType && !other) continue;
                var name = column.Name.Trim();
                var named = name.Equals("id", StringComparison.OrdinalIgnoreCase) || name.EndsWith("id", StringComparison.OrdinalIgnoreCase)
                    || name.EndsWith("key", StringComparison.OrdinalIgnoreCase) || name.EndsWith("guid", StringComparison.OrdinalIgnoreCase);
                ranked.Add((named ? 0 : keyType ? 1 : 2, c));
            }
            return ranked.OrderBy(item => item.Rank).ThenBy(item => item.Column).Select(item => item.Column);
        }
    }
}
