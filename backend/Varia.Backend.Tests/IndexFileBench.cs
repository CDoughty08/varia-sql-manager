using System.Data;
using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json;
using Varia.Backend.Search;

namespace Varia.Backend.Tests;

/// <summary>The index file benchmark (tests/bench/search.bench.ts runs it with <see cref="Argument"/>): one database of about
/// 300,000 objects, read by the real reader from a synthetic batch (tables with typed columns, indexes and their columns,
/// constraints, procedures and views with distinct definitions), saved to a file and loaded back into an empty pool, encrypted
/// and in clear text. Prints one JSON line per metric; measures only.</summary>
internal static class IndexFileBench
{
    public const string Argument = "--index-file-bench";

    private static DataTable Rows((string Name, Type Type)[] columns, IEnumerable<object?[]> rows)
    {
        var table = new DataTable();
        foreach (var (name, type) in columns) table.Columns.Add(name, type);
        table.BeginLoadData();
        foreach (var row in rows) table.Rows.Add([.. row.Select(value => value ?? DBNull.Value)]);
        table.EndLoadData();
        return table;
    }

    private static SearchCostChecks.Batch Batch()
    {
        const int Tables = 24_000, Procedures = 20_000, Views = 10_000, Checks = 6_000;
        var at = new DateTime(2026, 11, 1, 0, 0, 0, DateTimeKind.Unspecified);
        string[] columnNames = ["Id", "Name", "CreatedAt", "ModifiedAt", "Amount", "Status", "OwnerId", "Notes", "RowVersion"];
        int[] columnTypes = [56, 231, 42, 42, 106, 231, 56, 231, 189];
        static string D5(int value) => value.ToString("D5", CultureInfo.InvariantCulture);
        IEnumerable<object?[]> Objects()
        {
            for (var table = 0; table < Tables; table++) yield return [1_000_000 + table, table % 3 == 0 ? "sales" : "dbo", "Customer_Orders_" + D5(table), "U", at.AddSeconds(table), 0, false, (byte)0, null];
            for (var procedure = 0; procedure < Procedures; procedure++) yield return [2_000_000 + procedure, "dbo", "usp_Ledger_" + D5(procedure), "P", at.AddSeconds(procedure), 0, false, (byte)0, null];
            for (var view = 0; view < Views; view++) yield return [3_000_000 + view, "reporting", "vw_Orders_" + D5(view), "V", at, 0, false, (byte)0, null];
            for (var constraint = 0; constraint < Checks; constraint++) yield return [4_000_000 + constraint, "dbo", "ck_Orders_" + D5(constraint), "C", at, 1_000_000 + constraint, false, (byte)0, null];
        }
        IEnumerable<object?[]> Columns()
        {
            for (var table = 0; table < Tables; table++)
                for (var column = 0; column < columnNames.Length; column++)
                    yield return [1_000_000 + table, column == 4 ? "Amount_" + table % 50 : columnNames[column], column + 1, columnTypes[column], (short)(column == 1 ? 200 : 8), (byte)18, (byte)2, column > 0, column == 0, false, false, null, null];
        }
        IEnumerable<object?[]> Definitions()
        {
            for (var procedure = 0; procedure < Procedures; procedure++)
            {
                var text = new StringBuilder("CREATE PROCEDURE dbo.usp_Ledger_" + D5(procedure) + " @from date, @to date\r\nAS\r\nBEGIN\r\n");
                for (var line = 0; line < 24; line++)
                    text.Append("\tUPDATE dbo.Ledger_").Append(procedure % 97).Append(" SET Amount = Amount + ").Append(line * 7 + procedure).Append(" WHERE PostedAt BETWEEN @from AND @to AND RuleId = ").Append(line).Append(";\r\n");
                yield return [2_000_000 + procedure, text.Append("END\r\n").ToString()];
            }
            for (var view = 0; view < Views; view++)
                yield return [3_000_000 + view, "CREATE VIEW reporting.vw_Orders_" + D5(view) + " AS\r\nSELECT o.Id, o.Name, o.CreatedAt, o.ModifiedAt, o.Amount_" + view % 50 + ", o.Status, o.OwnerId\r\nFROM sales.Customer_Orders_" + D5(view)
                    + " AS o\r\nWHERE o.Status = N'open' AND o.CreatedAt >= DATEADD(day, -" + view % 365 + ", SYSUTCDATETIME());\r\n" + new string('-', 300 + view % 300)];
            for (var constraint = 0; constraint < Checks; constraint++) yield return [4_000_000 + constraint, "([Amount_" + constraint % 50 + "]>(0))"];
        }
        return new SearchCostChecks.Batch([
            Rows([("id", typeof(int)), ("schema", typeof(string)), ("name", typeof(string)), ("type", typeof(string)), ("modified", typeof(DateTime)), ("parent", typeof(int)),
                ("system", typeof(bool)), ("variant", typeof(byte)), ("current", typeof(int))], Objects()),
            Rows([("id", typeof(int)), ("schema", typeof(string)), ("name", typeof(string)), ("table", typeof(bool)), ("assembly", typeof(bool)), ("object", typeof(int))], []),
            Rows([("code", typeof(string)), ("schema", typeof(string)), ("name", typeof(string)), ("modified", typeof(DateTime)), ("system", typeof(bool))],
                [["SC", null, "sales", null, false], ["SC", null, "reporting", null, false]]),
            Rows([("id", typeof(int)), ("name", typeof(string)), ("modified", typeof(DateTime)), ("system", typeof(bool))], []),
            Rows([("name", typeof(string)), ("modified", typeof(DateTime)), ("text", typeof(string))], []),
            Rows([("id", typeof(int)), ("schema", typeof(string)), ("name", typeof(string)), ("system", typeof(byte)), ("user", typeof(bool)), ("table", typeof(bool))],
                [.. SearchChecks.SystemTypes, [42, "sys", "datetime2", (byte)42, false, false], [189, "sys", "timestamp", (byte)189, false, false]]),
            Rows([("id", typeof(int)), ("name", typeof(string)), ("column", typeof(int)), ("type", typeof(int)), ("length", typeof(short)), ("precision", typeof(byte)), ("scale", typeof(byte)),
                ("nullable", typeof(bool)), ("identity", typeof(bool)), ("computed", typeof(bool)), ("default", typeof(bool)), ("dimensions", typeof(int)), ("expression", typeof(string))], Columns()),
            Rows([("id", typeof(int)), ("name", typeof(string)), ("type", typeof(byte)), ("index", typeof(int))],
                Enumerable.Range(0, Tables).Select(table => new object?[] { 1_000_000 + table, "IX_Customer_Orders_" + D5(table) + "_Owner", (byte)2, 2 })),
            Rows([("id", typeof(int)), ("name", typeof(string))], []),
            Rows([("id", typeof(int)), ("name", typeof(string)), ("output", typeof(bool)), ("parameter", typeof(int)), ("type", typeof(int)), ("length", typeof(short)), ("precision", typeof(byte)),
                ("scale", typeof(byte)), ("readonly", typeof(bool)), ("dimensions", typeof(int))], []),
            Rows([("id", typeof(int)), ("index", typeof(int)), ("column", typeof(int)), ("descending", typeof(bool)), ("included", typeof(bool))],
                Enumerable.Range(0, Tables).SelectMany(table => new[] { new object?[] { 1_000_000 + table, 2, 7, false, false }, [1_000_000 + table, 2, 3, true, false] })),
            Rows([("id", typeof(int)), ("parent", typeof(int)), ("index", typeof(int))], []),
            Rows([("id", typeof(int)), ("column", typeof(int)), ("referenced", typeof(int)), ("other", typeof(int))], []),
            Rows([("id", typeof(int)), ("text", typeof(string))], Definitions()),
            Rows([("cased", typeof(bool)), ("dotted", typeof(bool))], [[false, false]])
        ]);
    }

    public static void Run()
    {
        var limits = new ObjectIndexLimits { MemoryBytes = 4L << 30, NamesReserveBytes = 1L << 30 };
        var budget = new IndexBudget(limits.MemoryBytes);
        var pool = new StringPool(budget);
        var unit = new DatabaseReader("Sales", limits, pool).ReadAsync(Batch(), true, CancellationToken.None).GetAwaiter().GetResult() ?? throw new InvalidOperationException("The bench's database did not fit.");
        var table = unit.Table;
        var memory = budget.Used;
        var definitionChars = Enumerable.Range(0, table.Count).Sum(at => table.StoredDefinition(at) is { } stored ? (long)DefinitionText.Length(stored) : 0);
        var identity = "bench/Sales"u8.ToArray();
        var key = new byte[32];
        Random.Shared.NextBytes(key);
        var folder = Directory.CreateTempSubdirectory("varia-index-bench-");
        try
        {
            var path = Path.Combine(folder.FullName, "unit.vidx");
            (double SaveMs, double LoadMs, long Bytes, double HeaderMs) Measure(IndexFileProtection protection)
            {
                var (saves, loads) = (new List<double>(), new List<double>());
                for (var run = 0; run < 7; run++)
                {
                    var watch = Stopwatch.StartNew();
                    var saved = IndexFile.SaveFile(path, unit, IndexUnitKind.Database, new IndexSaveOptions(protection, identity));
                    watch.Stop();
                    if (saved != IndexFileProblem.None) throw new InvalidOperationException("The bench's unit was not saved: " + saved);
                    var own = new StringPool(new IndexBudget(limits.MemoryBytes));
                    var loading = Stopwatch.StartNew();
                    var loaded = IndexFile.LoadFile(path, new IndexLoadOptions(protection, IndexUnitKind.Database, identity), limits, own);
                    loading.Stop();
                    if (loaded.Value is not { } value || value.Table.Count != table.Count || value.Bytes != unit.Bytes || own.Budget.Used != memory) throw new InvalidOperationException("The bench's unit did not load as it was: " + loaded.Problem);
                    if (run < 2) continue;
                    saves.Add(watch.Elapsed.TotalMilliseconds);
                    loads.Add(loading.Elapsed.TotalMilliseconds);
                }
                saves.Sort();
                loads.Sort();
                var header = Stopwatch.StartNew();
                for (var read = 0; read < 200; read++)
                    if (IndexFile.ReadHeaderFile(path, protection).Value is null) throw new InvalidOperationException("The bench's header did not read.");
                return (saves[saves.Count / 2], loads[loads.Count / 2], new FileInfo(path).Length, header.Elapsed.TotalMilliseconds / 200);
            }
            var sealedFile = Measure(IndexFileProtection.Encrypted(key));
            var clear = Measure(IndexFileProtection.ClearText);
            static string Mb(long bytes) => (bytes / 1e6).ToString("0.0", CultureInfo.InvariantCulture) + " MB";
            static string Ms(double ms) => ms.ToString("0", CultureInfo.InvariantCulture) + " ms";
            var detail = table.Count.ToString("N0", CultureInfo.InvariantCulture) + " objects, " + table.Texts.Count.ToString("N0", CultureInfo.InvariantCulture) + " texts, "
                + (definitionChars / 1e6).ToString("0.0", CultureInfo.InvariantCulture) + " M definition characters; " + Mb(memory) + " of the index's budget; encrypted " + Mb(sealedFile.Bytes) + ", clear text " + Mb(clear.Bytes);
            Print("node.indexFile.saveMs", sealedFile.SaveMs, "ms", detail + "; flushed to disk; clear text " + Ms(clear.SaveMs) + "; median of 5");
            Print("node.indexFile.loadMs", sealedFile.LoadMs, "ms", detail + "; into an empty pool; clear text " + Ms(clear.LoadMs) + "; median of 5");
            Print("node.indexFile.diskPerMemory", (double)sealedFile.Bytes / memory, "×", detail);
            Print("node.indexFile.headerMs", sealedFile.HeaderMs, "ms", "the header alone of that " + Mb(sealedFile.Bytes) + " file, opened and read; clear text "
                + clear.HeaderMs.ToString("0.000", CultureInfo.InvariantCulture) + " ms; mean of 200");
        }
        finally { folder.Delete(true); }
    }

    private static void Print(string id, double value, string unit, string detail) =>
        Console.WriteLine(JsonSerializer.Serialize(new { id, value, unit, detail }));
}
