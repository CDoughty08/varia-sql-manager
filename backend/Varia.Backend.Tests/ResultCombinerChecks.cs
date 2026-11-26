using System.Globalization;
using System.Text;
using Varia.Backend.MultiQuery;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>ResultCombiner and cross-dialect ResultDiff / CellHasher / ViewSorter / ColumnProfiler checks:
/// schema drift, duplicate column alignment, 4,096-column cap, Scale and BigNumeric promotion, unzoned-to-text widening,
/// Float exact sidecars + DoubleToInt64Bits (NaN/-0.0) + non-numeric fallback, Boolean+numeric normalization,
/// binary+text 0x hex cap, QueryBudget whole-buffer refusal, remote windowed skipping, cross-dialect diff,
/// InstantKey sort (' ' vs 'T'), and ColumnProfiles normalization.</summary>
internal static class ResultCombinerChecks
{
    public static async Task RunAsync(Action<bool, string> check)
    {
        var combiner = new ResultCombiner();
        await SchemaDriftAndDuplicatesAsync(combiner, check);
        await ColumnCapAsync(combiner, check);
        await DecimalScaleAndBigNumericPromotionAsync(combiner, check);
        await TemporalWideningAsync(combiner, check);
        await FloatExactAndSpecialValuesAsync(combiner, check);
        await BooleanNumericNormalizationAsync(combiner, check);
        await BinaryTextHexCapAsync(combiner, check);
        await BudgetRefusalKeepsSourcesIntactAsync(combiner, check);
        await RemoteWindowedSourceSkippingAsync(combiner, check);
        await PackedPagesRequirePinsAsync(combiner, check);
        CrossDialectDiffChecks(check);
        await InstantKeyAndColumnProfilesChecksAsync(combiner, check);
    }

    private static ResultSetBuffer OpenAndFill(
        ResultStore store,
        QueryBudget budget,
        int index,
        string targetKey,
        string? targetLabel,
        ResultColumn[] columns,
        Action<PageBuilder>[] rows,
        int? statementSlot = 0,
        bool rolledBackPreview = false)
    {
        var wires = columns.Select(col => col.Wire == "binary" ? WireKind.Binary : WireKind.Text).ToArray();
        var set = store.Open(
            budget,
            index,
            1,
            1,
            "rows",
            columns,
            wires,
            targetKey: targetKey,
            targetLabel: targetLabel,
            statementSlot: statementSlot) ?? throw new InvalidOperationException("The source result set was not kept.");
        foreach (var write in rows)
        {
            set.CountRow();
            var builder = set.BeginRow() ?? throw new InvalidOperationException("Source row was refused.");
            write(builder);
            if (!set.TryCommitRow()) throw new InvalidOperationException("Source row commit was refused.");
        }
        if (rolledBackPreview) set.RolledBackPreview = true;
        set.Complete();
        return set;
    }

    private static List<string?[]> ReadAllRows(ResultSetBuffer set)
    {
        using var pin = set.Pin();
        var pages = set.SealedSnapshot();
        var rows = new List<string?[]>();
        foreach (var page in pages)
        {
            var decoded = PageReader.Read(page.Body(), set.Wires);
            foreach (var row in decoded.Rows)
            {
                var values = new string?[row.Length];
                for (var c = 0; c < row.Length; c++)
                {
                    values[c] = (row[c].Flags & PageReader.Null) != 0 ? null : row[c].Text;
                }
                rows.Add(values);
            }
        }
        return rows;
    }

    private static async Task SchemaDriftAndDuplicatesAsync(ResultCombiner combiner, Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        var budget = store.BeginQuery("combine-drift");
        var s1 = OpenAndFill(store, budget, 0, "srv-1", "prod-east-01",
            [new("Id", "int", "text", Nullable: false), new("Note", "nvarchar(50)", "text"), new("Note", "nvarchar(50)", "text")],
            [
                b => { b.AppendText("1"); b.AppendText("first-a"); b.AppendText("second-a"); },
                b => { b.AppendText("2"); b.AppendText("first-b"); b.AppendNull(); }
            ], statementSlot: 2, rolledBackPreview: true);
        var s2 = OpenAndFill(store, budget, 1, "srv-2", null,
            [new("NOTE", "nvarchar(50)", "text"), new("id", "int", "text", Nullable: false), new("Extra", "varchar(20)", "text")],
            [
                b => { b.AppendText("only-note"); b.AppendText("3"); b.AppendText("extra-val"); }
            ], statementSlot: 2);

        var output = await combiner.CombineAsync(store, budget, [s1, s2], 10, 1, 1, "Orders", false, CancellationToken.None);
        var combined = output.Buffer;
        check(combined is not null && combined.Kind == "combined" && combined.Derived && combined.IsComplete
            && combined.ResultName == "Orders" && combined.StatementSlot == 2 && combined.RolledBackPreview,
            "ResultCombiner opens a derived combined set with statement name, slot, and rolledBackPreview metadata");
        check(combined!.Columns.Select(c => c.Name).SequenceEqual(["_server", "Id", "Note", "Note", "Extra"]),
            "duplicate column names align by (OrdinalNames.KeyOf, occurrence) queues after prepending _server: "
            + string.Join(",", combined.Columns.Select(c => c.Name)));
        check(!combined.Columns[0].Nullable && !combined.Columns[1].Nullable && combined.Columns[3].Nullable && combined.Columns[4].Nullable,
            "columns missing on any server become nullable while universally non-null columns stay non-null");
        var rows = ReadAllRows(combined);
        check(rows.Count == 3
            && rows[0].SequenceEqual(["prod-east-01", "1", "first-a", "second-a", null])
            && rows[1].SequenceEqual(["prod-east-01", "2", "first-b", null, null])
            && rows[2].SequenceEqual(["srv-2", "3", "only-note", null, "extra-val"]),
            "_server uses trusted TargetLabel (falling back to TargetKey) and missing columns fill with NULL");
        check(output.Warnings.Any(w => w.Contains("Schema drift", StringComparison.OrdinalIgnoreCase)),
            "schema drift emits a clean warning: " + string.Join(" | ", output.Warnings));
    }

    private static async Task ColumnCapAsync(ResultCombiner combiner, Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        var budget = store.BeginQuery("combine-cap");
        var leftCols = Enumerable.Range(0, 2500).Select(i => new ResultColumn("L" + i.ToString(CultureInfo.InvariantCulture), "int", "text")).ToArray();
        var rightCols = Enumerable.Range(0, 2500).Select(i => new ResultColumn("R" + i.ToString(CultureInfo.InvariantCulture), "int", "text")).ToArray();
        var s1 = OpenAndFill(store, budget, 0, "k1", "s1", leftCols, [b => { for (var i = 0; i < leftCols.Length; i++) b.AppendText("1"); }]);
        var s2 = OpenAndFill(store, budget, 1, "k2", "s2", rightCols, [b => { for (var i = 0; i < rightCols.Length; i++) b.AppendText("2"); }]);

        var output = await combiner.CombineAsync(store, budget, [s1, s2], 2, 1, 1, null, false, CancellationToken.None);
        check(output.Buffer is not null && output.Buffer.Columns.Count == PageBuilder.MaxColumns && output.Buffer.Columns[0].Name == "_server"
            && output.Warnings.Any(w => w.Contains("4,096", StringComparison.Ordinal)),
            "combined result caps total columns at PageBuilder.MaxColumns (4,096) with a warning: " + output.Buffer?.Columns.Count);
    }

    private static async Task DecimalScaleAndBigNumericPromotionAsync(ResultCombiner combiner, Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        var budget = store.BeginQuery("combine-decimal");

        // 1) int + money (implicit scale 4) -> decimal(19,4), Scale == 4
        var intSet = OpenAndFill(store, budget, 0, "sql1", "sql1",
            [new("Group", "nvarchar(10)", "text"), new("Amt", "int", "text")],
            [b => { b.AppendText("A"); b.AppendText("10"); }]);
        var moneySet = OpenAndFill(store, budget, 1, "sql2", "sql2",
            [new("Group", "nvarchar(10)", "text"), new("Amt", "money", "text")],
            [b => { b.AppendText("A"); b.AppendText("2.3456"); }]);
        var moneyCombined = (await combiner.CombineAsync(store, budget, [intSet, moneySet], 2, 1, 1, null, false, CancellationToken.None)).Buffer!;
        var amtCol = moneyCombined.Columns[2];
        var moneyPivot = PivotSum(store, moneyCombined, 1, 2);
        check(amtCol.SortKind == ColumnTypes.Decimal && amtCol.Scale == 4 && amtCol.BigQueryDecimal == BigQueryDecimalKind.None
            && moneyPivot == "12.3456",
            $"int + money widens to decimal with implicit scale 4 and pivots cleanly ({amtCol.DataType}, scale={amtCol.Scale}, sum={moneyPivot})");

        // 2) BigQuery NUMERIC(38,9) + SQL Server decimal(38,12) (scale > 9) -> promotes to BigNumeric, preventing ResultPivot.cs:745 BigInteger.Pow(10, 9 - shown) crash
        var bqNum = OpenAndFill(store, budget, 3, "bq1", "bq1",
            [new("Group", "STRING", "text") { SortKind = ColumnTypes.Text }, new("Val", "NUMERIC", "text", Precision: 38, Scale: 9) { SortKind = ColumnTypes.Decimal, BigQueryDecimal = BigQueryDecimalKind.Numeric }],
            [b => { b.AppendText("A"); b.AppendText("1.123456789"); }]);
        var sqlScale12 = OpenAndFill(store, budget, 4, "sql3", "sql3",
            [new("Group", "nvarchar(10)", "text"), new("Val", "decimal(38,12)", "text", Precision: 38, Scale: 12)],
            [b => { b.AppendText("A"); b.AppendText("2.000000000001"); }]);
        var scale12Combined = (await combiner.CombineAsync(store, budget, [bqNum, sqlScale12], 5, 1, 1, null, false, CancellationToken.None)).Buffer!;
        var scale12Col = scale12Combined.Columns[2];
        var scale12Sum = PivotSum(store, scale12Combined, 1, 2);
        check(scale12Col.SortKind == ColumnTypes.Decimal && scale12Col.Scale == 12 && scale12Col.BigQueryDecimal == BigQueryDecimalKind.BigNumeric
            && scale12Sum is not null && scale12Sum.StartsWith("3.123456789001", StringComparison.Ordinal),
            $"NUMERIC + decimal(38,12) promotes to BigNumeric (scale 12) and pivots without crashing ({scale12Col.BigQueryDecimal}, sum={scale12Sum})");

        // 3) BigQuery NUMERIC(38,9) + SQL Server decimal(38,2) (integer precision 36 > 29) -> promotes to BigNumeric, preventing TryWideDecimal/NUMERIC 29-digit overflow
        var sqlWideInt = OpenAndFill(store, budget, 6, "sql4", "sql4",
            [new("Group", "nvarchar(10)", "text"), new("Val", "decimal(38,2)", "text", Precision: 38, Scale: 2)],
            [b => { b.AppendText("A"); b.AppendText("1000000000000000000000000000000000.25"); }]);
        var wideIntCombined = (await combiner.CombineAsync(store, budget, [bqNum, sqlWideInt], 7, 1, 1, null, false, CancellationToken.None)).Buffer!;
        var wideIntCol = wideIntCombined.Columns[2];
        var wideIntSum = PivotSum(store, wideIntCombined, 1, 2);
        check(wideIntCol.BigQueryDecimal == BigQueryDecimalKind.BigNumeric
            && wideIntSum is not null && wideIntSum.StartsWith("1000000000000000000000000000000001.373456789", StringComparison.Ordinal),
            $"NUMERIC + decimal(38,2) (int precision 36 > 29) promotes to BigNumeric and pivots 34+ whole digits cleanly ({wideIntCol.BigQueryDecimal}, sum={wideIntSum})");

        // 4) BigQuery NUMERIC + BigQuery BIGNUMERIC -> BigNumeric
        var bqBigNum = OpenAndFill(store, budget, 8, "bq2", "bq2",
            [new("Group", "STRING", "text") { SortKind = ColumnTypes.Text }, new("Val", "BIGNUMERIC", "text", Precision: 77, Scale: 38) { SortKind = ColumnTypes.Decimal, BigQueryDecimal = BigQueryDecimalKind.BigNumeric }],
            [b => { b.AppendText("A"); b.AppendText("5.5"); }]);
        var bqMerged = (await combiner.CombineAsync(store, budget, [bqNum, bqBigNum], 9, 1, 1, null, false, CancellationToken.None)).Buffer!;
        check(bqMerged.Columns[2].BigQueryDecimal == BigQueryDecimalKind.BigNumeric && bqMerged.Columns[2].Scale == 38,
            "NUMERIC + BIGNUMERIC promotes to BigNumeric with scale 38");

        // 5) BigQuery NUMERIC(38,9) + SQL Server decimal(18,2) (scale <= 9, int precision 16 <= 29) -> stays Numeric with scale 9
        var sqlSmall = OpenAndFill(store, budget, 10, "sql5", "sql5",
            [new("Group", "nvarchar(10)", "text"), new("Val", "decimal(18,2)", "text", Precision: 18, Scale: 2)],
            [b => { b.AppendText("A"); b.AppendText("4.25"); }]);
        var staysNum = (await combiner.CombineAsync(store, budget, [bqNum, sqlSmall], 11, 1, 1, null, false, CancellationToken.None)).Buffer!;
        check(staysNum.Columns[2].BigQueryDecimal == BigQueryDecimalKind.Numeric && staysNum.Columns[2].Scale == 9,
            "NUMERIC + decimal(18,2) stays BigQueryDecimalKind.Numeric with widened scale 9");
    }

    private static string? PivotSum(ResultStore store, ResultSetBuffer source, int groupCol, int valueCol)
    {
        var pages = source.SealedSnapshot();
        var spec = new PivotSpec([groupCol], -1, [new PivotValue(PivotAggregate.Sum, valueCol)]);
        var model = ResultPivoter.Build(source, pages, null, spec, CancellationToken.None, _ => true);
        var (cols, wires, lengths) = PivotOutput.Shape(source, pages, spec, model);
        var pivot = store.Open(source.Budget, source.Index + 100, 1, 1, "pivot", cols, wires, lengths: lengths, derived: true)
            ?? throw new InvalidOperationException("Pivot set was not kept.");
        PivotOutput.Write(pivot, source, pages, spec, model, CancellationToken.None);
        var rows = ReadAllRows(pivot);
        return rows.Count > 0 ? rows[0][1] : null;
    }

    private static async Task TemporalWideningAsync(ResultCombiner combiner, Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        var budget = store.BeginQuery("combine-temporal");
        var s1 = OpenAndFill(store, budget, 0, "sql", "sql",
            [new("D", "date", "text"), new("Unzoned", "datetime2", "text"), new("D2", "date", "text"), new("T", "time", "text")],
            [b => { b.AppendText("2024-03-01"); b.AppendText("2024-03-01 10:00:00.0000000"); b.AppendText("2024-03-01"); b.AppendText("10:00:00"); }]);
        var s2 = OpenAndFill(store, budget, 1, "bq", "bq",
            [
                new("D", "DATETIME", "text") { SortKind = ColumnTypes.DateTime },
                new("Unzoned", "TIMESTAMP", "text") { SortKind = ColumnTypes.Timestamp },
                new("D2", "TIMESTAMP", "text") { SortKind = ColumnTypes.Timestamp },
                new("T", "TIMESTAMP", "text") { SortKind = ColumnTypes.Timestamp }
            ],
            [b => { b.AppendText("2024-03-01T12:00:00"); b.AppendText("2024-03-01 10:00:00 UTC"); b.AppendText("2024-03-01 00:00:00 UTC"); b.AppendText("2024-03-01 10:00:00 UTC"); }]);

        var output = await combiner.CombineAsync(store, budget, [s1, s2], 2, 1, 1, null, false, CancellationToken.None);
        var cols = output.Buffer!.Columns;
        check(cols[1].SortKind == ColumnTypes.DateTime
            && cols[2].SortKind == ColumnTypes.Text
            && cols[3].SortKind == ColumnTypes.Text
            && cols[4].SortKind == ColumnTypes.Text
            && output.Warnings.Any(w => w.Contains("zoned and unzoned", StringComparison.OrdinalIgnoreCase)),
            $"date+datetime widens to datetime, while unzoned date/datetime/time + zoned timestamp always widen to text: "
            + string.Join(",", cols.Skip(1).Select(c => c.SortKind)));
    }

    private static async Task FloatExactAndSpecialValuesAsync(ResultCombiner combiner, Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        var budget = store.BeginQuery("combine-float");
        const double low = 1d, high = 1.0000000000000002d;
        var intSide = OpenAndFill(store, budget, 0, "s1", "s1",
            [new("V", "int", "text")],
            [b => b.AppendText("1")]);
        var floatSide = OpenAndFill(store, budget, 1, "s2", "s2",
            [new("V", "float", "text")],
            [b => b.AppendFloat(high), b => b.AppendFloat(low)]);

        var combined = (await combiner.CombineAsync(store, budget, [intSide, floatSide], 2, 1, 1, null, false, CancellationToken.None)).Buffer!;
        var exactCount = combined.SealedSnapshot().Sum(p => p.Lengths.Exacts.Count);
        var distinct = ViewSorter.DistinctValues(combined, combined.SealedSnapshot(), null, 1, true, CancellationToken.None);
        var listed = string.Join(",", distinct.Read(DistinctOrder.Value, 0, 10, null, CancellationToken.None).Values.Select(v => v.Text + "×" + v.Count));
        check(combined.Columns[1].SortKind == ColumnTypes.Float && exactCount == 1 && distinct.Distinct == 2 && listed == "1×2,1.0000000000000002×1",
            $"numeric + float widens to float and propagates ExactValue sidecars (exacts={exactCount}, distinct={listed})");

        // CellHasher.Kind.Float: -0.0 == +0.0, NaN == NaN, non-numeric text != NaN, Literal == true for non-numeric
        var f1 = OpenAndFill(store, budget, 3, "f1", "f1", [new("V", "float", "text")],
            [b => b.AppendText("-0"), b => b.AppendText("NaN"), b => b.AppendText("NaN"), b => b.AppendFloat(0.1 + 0.2)]);
        var f2 = OpenAndFill(store, budget, 4, "f2", "f2", [new("V", "nvarchar(30)", "text")],
            [b => b.AppendText("0"), b => b.AppendText("NaN"), b => b.AppendText("invalid"), b => b.AppendText("0.30000000000000004")]);
        var diff = ResultDiffer.Compare(f1, f1.SealedSnapshot(), f2, f2.SealedSnapshot(), false, CancellationToken.None, match: new DiffMatch(DiffMatchMode.Position, []));
        var kinds = string.Join(",", diff.Entries.Select(e => e.Kind));
        var hasher = new CellHasher(f1.Columns, f1.Wires);
        check(hasher.KindOf(0) == CellHasher.Kind.Float && hasher.Literal(0, "invalid"u8) && !hasher.Literal(0, "NaN"u8) && !hasher.Literal(0, "-0"u8)
            && kinds == "Same,Same,Changed,Same",
            $"Kind.Float hashes/compares -0.0==+0.0, NaN==NaN, exact sidecar==full text, and keeps unparseable text apart from NaN ({kinds})");
    }

    private static async Task BooleanNumericNormalizationAsync(ResultCombiner combiner, Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        var budget = store.BeginQuery("combine-bool");
        var bq = OpenAndFill(store, budget, 0, "bq", "bq-prod",
            [
                new("FlagInt", "BOOL", "text") { SortKind = ColumnTypes.Boolean },
                new("FlagDec", "BOOL", "text") { SortKind = ColumnTypes.Boolean },
                new("FlagFlt", "BOOL", "text") { SortKind = ColumnTypes.Boolean }
            ],
            [
                b => { b.AppendText("true"); b.AppendText("false"); b.AppendText("true"); },
                b => { b.AppendText("false"); b.AppendText("true"); b.AppendText("false"); }
            ]);
        var sql = OpenAndFill(store, budget, 1, "sql", "sql-prod",
            [
                new("FlagInt", "int", "text"),
                new("FlagDec", "decimal(10,2)", "text", Precision: 10, Scale: 2),
                new("FlagFlt", "float", "text")
            ],
            [b => { b.AppendText("42"); b.AppendText("3.50"); b.AppendText("1.25"); }]);

        var combined = (await combiner.CombineAsync(store, budget, [bq, sql], 2, 1, 1, null, false, CancellationToken.None)).Buffer!;
        var rows = ReadAllRows(combined);
        check(combined.Columns[1].SortKind == ColumnTypes.Integer
            && combined.Columns[2].SortKind == ColumnTypes.Decimal
            && combined.Columns[3].SortKind == ColumnTypes.Float
            && rows[0].SequenceEqual(["bq-prod", "1", "0", "1"])
            && rows[1].SequenceEqual(["bq-prod", "0", "1", "0"])
            && rows[2].SequenceEqual(["sql-prod", "42", "3.50", "1.25"]),
            "boolean + numeric widens to numeric and normalizes BigQuery true/false to 1/0 via ColumnTypes.BooleanNumber");
    }

    private static async Task BinaryTextHexCapAsync(ResultCombiner combiner, Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        var budget = store.BeginQuery("combine-bin");
        var oversized = new byte[40_000];
        Array.Fill(oversized, (byte)0xAB);
        var binSet = OpenAndFill(store, budget, 0, "s1", "s1",
            [new("Payload", "varbinary(max)", "binary")],
            [
                b => b.AppendBinary([0xDE, 0xAD, 0xBE, 0xEF]),
                b => b.AppendBinary([]),
                b => b.AppendBinary(oversized)
            ]);
        var textSet = OpenAndFill(store, budget, 1, "s2", "s2",
            [new("Payload", "nvarchar(100)", "text")],
            [b => b.AppendText("hello")]);

        var combined = (await combiner.CombineAsync(store, budget, [binSet, textSet], 2, 1, 1, null, false, CancellationToken.None)).Buffer!;
        using var pin = combined.Pin();
        var pages = combined.SealedSnapshot();
        var decoded = pages.SelectMany(p => PageReader.Read(p.Body(), combined.Wires).Rows).ToList();
        var cappedText = decoded[2][1].Text!;
        var cappedTruncated = (decoded[2][1].Flags & PageReader.Truncated) != 0;
        check(combined.Columns[1].SortKind == ColumnTypes.Text && combined.Wires[1] == WireKind.Text
            && decoded[0][1].Text == "0xDEADBEEF" && (decoded[0][1].Flags & PageReader.Truncated) == 0
            && decoded[1][1].Text == "0x"
            && cappedText.StartsWith("0xABAB", StringComparison.Ordinal) && cappedText.Length <= ColumnPlan.TextCap && cappedText.Length == 2 + 2 * ((ColumnPlan.TextCap - 2) / 2)
            && cappedTruncated
            && decoded[3][1].Text == "hello",
            $"binary + text widens to text with 0x+hex capped at ColumnPlan.TextCap ({cappedText.Length} <= {ColumnPlan.TextCap}, truncated={cappedTruncated})");
    }

    private static async Task BudgetRefusalKeepsSourcesIntactAsync(ResultCombiner combiner, Action<bool, string> check)
    {
        // Tight budget: enough for the two source sets (~350 KiB each), NOT enough for their combined copy (~700 KiB).
        var payload = new string('X', 2000);
        var store = new ResultStore(1_600_000, 900_000);
        var budget = store.BeginQuery("combine-budget");
        Action<PageBuilder>[] rows = [.. Enumerable.Range(0, 150).Select<int, Action<PageBuilder>>(i => b => b.AppendText(payload + i.ToString(CultureInfo.InvariantCulture)))];
        var s1 = OpenAndFill(store, budget, 0, "s1", "s1", [new("Body", "nvarchar(max)", "text")], rows);
        var s2 = OpenAndFill(store, budget, 1, "s2", "s2", [new("Body", "nvarchar(max)", "text")], rows);
        var beforeUsed = budget.UsedBytes;
        var beforeCount = store.Count;

        // 1) Auto-combine (throwOnBudgetRefusal: false): returns Buffer == null + warning, releases combined whole, sources intact
        var auto = await combiner.CombineAsync(store, budget, [s1, s2], 2, 1, 1, null, false, CancellationToken.None);
        check(auto.Buffer is null && auto.Warnings.Count > 0 && store.Count == beforeCount
            && budget.Stopped == TruncationReason.None && budget.UsedBytes == beforeUsed
            && !s1.IsReleased && !s2.IsReleased && ReadAllRows(s1).Count == 150 && ReadAllRows(s2).Count == 150,
            $"budget refusal with throwOnBudgetRefusal=false returns null+warning, releases combined whole, and keeps sources intact (used={budget.UsedBytes}/{beforeUsed}, sets={store.Count})");

        // 2) Manual combine (throwOnBudgetRefusal: true): throws TOO_LARGE, releases combined whole, sources intact
        var beforeManualUsed = budget.UsedBytes;
        string? code = null;
        try { await combiner.CombineAsync(store, budget, [s1, s2], 3, 1, 1, null, true, CancellationToken.None); }
        catch (RequestException error) { code = error.Code; }
        check(code == "TOO_LARGE" && store.Count == beforeCount && budget.Stopped == TruncationReason.None && budget.UsedBytes == beforeManualUsed
            && !s1.IsReleased && !s2.IsReleased,
            $"budget refusal with throwOnBudgetRefusal=true throws TOO_LARGE and releases combined whole without harming sources (code={code}, sets={store.Count}, used={budget.UsedBytes}/{beforeManualUsed})");
    }

    private static async Task RemoteWindowedSourceSkippingAsync(ResultCombiner combiner, Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        var budget = store.BeginQuery("combine-remote");
        var s1 = OpenAndFill(store, budget, 0, "s1", "sql-1", [new("Id", "int", "text")], [b => b.AppendText("1")]);
        var s2 = OpenAndFill(store, budget, 1, "s2", "sql-2", [new("Id", "int", "text")], [b => b.AppendText("2")]);
        var remoteSet = OpenAndFill(store, budget, 2, "bq-win", "bq-windowed", [new("Id", "INT64", "text") { SortKind = ColumnTypes.Integer }], [b => b.AppendText("3")]);
        using var lane = new SemaphoreSlim(1);
        var remote = RemoteResult.Create(store, remoteSet.ResultId, remoteSet.Wires, 1000, false, 16, 1L << 20, lane, (_, _, _, _) => Task.CompletedTask);
        store.Demote(remoteSet, remote, 1000);

        // 3 sources (2 in-memory + 1 remote): skips remote with warning and combines the 2 in-memory sources
        var three = await combiner.CombineAsync(store, budget, [s1, remoteSet, s2], 3, 1, 1, null, false, CancellationToken.None);
        var rows = ReadAllRows(three.Buffer!);
        check(three.Buffer is not null && rows.Count == 2 && rows[0][0] == "sql-1" && rows[1][0] == "sql-2"
            && three.Warnings.Any(w => w.Contains("bq-windowed", StringComparison.Ordinal) && w.Contains("windowed", StringComparison.OrdinalIgnoreCase)),
            "remote windowed source is skipped with a calm warning while >= 2 remaining in-memory sources still combine");

        // 2 sources (1 in-memory + 1 remote): < 2 remain
        var twoAuto = await combiner.CombineAsync(store, budget, [s1, remoteSet], 4, 1, 1, null, false, CancellationToken.None);
        string? manualCode = null;
        try { await combiner.CombineAsync(store, budget, [s1, remoteSet], 5, 1, 1, null, true, CancellationToken.None); }
        catch (RequestException error) { manualCode = error.Code; }
        check(twoAuto.Buffer is null && twoAuto.Warnings.Count == 1 && manualCode == "REMOTE_RESULT",
            $"fewer than 2 in-memory sources returns null+warning when auto-combining and throws REMOTE_RESULT when manual ({manualCode})");
    }

    private static async Task PackedPagesRequirePinsAsync(ResultCombiner combiner, Action<bool, string> check)
    {
        var previousRequirePins = ResultSetBuffer.RequirePins;
        ResultSetBuffer.RequirePins = true;
        try
        {
            var store = new ResultStore(1L << 30, 1L << 29) { Packing = PagePacking.EveryComplete };
            var budget = store.BeginQuery("combine-packed");
            Action<PageBuilder>[] rows = [.. Enumerable.Range(0, 200).Select<int, Action<PageBuilder>>(i => b =>
            {
                b.AppendText(i.ToString(CultureInfo.InvariantCulture));
                b.AppendText("repeated-compressible-payload-segment-" + (i % 5).ToString(CultureInfo.InvariantCulture));
            })];
            var s1 = OpenAndFill(store, budget, 0, "p1", "packed-1", [new("Id", "int", "text"), new("Txt", "nvarchar(100)", "text")], rows);
            var s2 = OpenAndFill(store, budget, 1, "p2", "packed-2", [new("Id", "int", "text"), new("Txt", "nvarchar(100)", "text")], rows);
            var combined = (await combiner.CombineAsync(store, budget, [s1, s2], 2, 1, 1, null, false, CancellationToken.None)).Buffer!;
            check(s1.HasPacked && s2.HasPacked && combined.RowsAvailable == 400 && ReadAllRows(combined).Count == 400,
                "ResultCombiner reads packed pages via PageRooms/RoomReader under ResultSetBuffer.RequirePins=true");
        }
        finally
        {
            ResultSetBuffer.RequirePins = previousRequirePins;
        }
    }

    private static void CrossDialectDiffChecks(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        var budget = store.BeginQuery("cross-diff");

        ResultColumn[] sqlCols =
        [
            new("Id", "int", "text"),
            new("Active", "bit", "text"),
            new("At", "datetime2", "text"),
            new("Clock", "time", "text"),
            new("Score", "float", "text")
        ];
        ResultColumn[] bqCols =
        [
            new("Id", "INT64", "text") { SortKind = ColumnTypes.Integer },
            new("Active", "BOOL", "text") { SortKind = ColumnTypes.Boolean },
            new("At", "DATETIME", "text") { SortKind = ColumnTypes.DateTime },
            new("Clock", "TIME", "text") { SortKind = ColumnTypes.Time },
            new("Score", "FLOAT64", "text") { SortKind = ColumnTypes.Float }
        ];

        var sqlSet = OpenAndFill(store, budget, 0, "sql", "sql", sqlCols,
        [
            b => { b.AppendText("1"); b.AppendText("1"); b.AppendText("2024-03-10 02:30:00.0000000"); b.AppendText("10:20:30.5000000"); b.AppendFloat(0.1 + 0.2); },
            b => { b.AppendText("2"); b.AppendText("0"); b.AppendText("2024-06-15 00:00:00.000"); b.AppendText("00:00:00"); b.AppendFloat(100_000d); }
        ]);
        var bqSet = OpenAndFill(store, budget, 1, "bq", "bq", bqCols,
        [
            b => { b.AppendText("1"); b.AppendText("true"); b.AppendText("2024-03-10T02:30:00"); b.AppendText("10:20:30.5"); b.AppendText("0.30000000000000004"); },
            b => { b.AppendText("2"); b.AppendText("false"); b.AppendText("2024-06-15"); b.AppendText("00:00:00.000000"); b.AppendText("1E+05"); }
        ]);

        foreach (var exact in new[] { false, true })
        {
            var forward = ResultDiffer.Compare(sqlSet, sqlSet.SealedSnapshot(), bqSet, bqSet.SealedSnapshot(), exact, CancellationToken.None);
            var reverse = ResultDiffer.Compare(bqSet, bqSet.SealedSnapshot(), sqlSet, sqlSet.SealedSnapshot(), exact, CancellationToken.None);
            var fSummary = string.Join(",", forward.Entries.Select(e => e.Kind + "/" + e.CellCount));
            var rSummary = string.Join(",", reverse.Entries.Select(e => e.Kind + "/" + e.CellCount));
            check(fSummary == "Same/0,Same/0" && rSummary == "Same/0,Same/0",
                $"cross-dialect Boolean, unzoned DateTime (including DST gap), Time, and Float diff identically in both directions (exact={exact}: {fSummary} / {rSummary})");
        }
    }

    private static async Task InstantKeyAndColumnProfilesChecksAsync(ResultCombiner combiner, Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        var budget = store.BeginQuery("combine-instant-profile");
        var sqlSet = OpenAndFill(store, budget, 0, "sql", "sql",
            [new("At", "datetime2", "text"), new("Clock", "time", "text")],
            [
                b => { b.AppendText("2024-03-01 10:00:00.0000000"); b.AppendText("10:20:30.0000000"); },
                b => { b.AppendText("2024-03-01 08:00:00.0000000"); b.AppendText("09:00:00.5000000"); }
            ]);
        var bqSet = OpenAndFill(store, budget, 1, "bq", "bq",
            [
                new("At", "DATETIME", "text") { SortKind = ColumnTypes.DateTime },
                new("Clock", "TIME", "text") { SortKind = ColumnTypes.Time }
            ],
            [
                b => { b.AppendText("2024-03-01T10:00:00"); b.AppendText("10:20:30"); },
                b => { b.AppendText("2024-03-01T09:30:00.5"); b.AppendText("09:00:00.5"); }
            ]);

        var combined = (await combiner.CombineAsync(store, budget, [sqlSet, bqSet], 2, 1, 1, null, false, CancellationToken.None)).Buffer!;
        var pages = combined.SealedSnapshot();

        // InstantKey sort over ' ' vs 'T' and mixed fractional widths
        var atOrder = ViewSorter.Sort(combined, pages, [new ViewKey(1, false, SortMode.Value)], CancellationToken.None).Order;
        var clockOrder = ViewSorter.Sort(combined, pages, [new ViewKey(2, false, SortMode.Value)], CancellationToken.None).Order;
        check(atOrder.SequenceEqual([1, 3, 0, 2]) && clockOrder.SequenceEqual([1, 3, 0, 2]),
            $"InstantKey orders combined SQL Server/BigQuery DateTime and Time chronologically across ' '/'T' and widths (at={string.Join(",", atOrder)}, clock={string.Join(",", clockOrder)})");

        // ColumnProfiler normalization agrees with Sort/Filter/Pivot/Diff on Distinct/Min/Max
        var profile = ColumnProfiler.Profile(combined, pages, null, [1, 2], true, CancellationToken.None);
        var atProfile = profile.Columns[0];
        var clockProfile = profile.Columns[1];
        check(atProfile.Distinct == 3 && atProfile.Min == "2024-03-01 08:00:00.0000000" && atProfile.Max == "2024-03-01 10:00:00.0000000"
            && clockProfile.Distinct == 2 && clockProfile.Min == "09:00:00.5000000" && clockProfile.Max == "10:20:30.0000000",
            $"ColumnProfiles normalizes unzoned DateTime/Time via TryInstant ticks (At distinct={atProfile.Distinct}, min={atProfile.Min}, max={atProfile.Max}; Clock distinct={clockProfile.Distinct})");
    }
}
