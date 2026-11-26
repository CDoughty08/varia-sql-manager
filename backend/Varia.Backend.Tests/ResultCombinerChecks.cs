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
        await HardeningChecksAsync(combiner, check);
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

        // 2) BigQuery NUMERIC(38,9) + SQL Server decimal(38,12) (scale > 9) -> promotes to WideDecimal, keeping exact scale 12 without 26 spurious trailing zeros
        var bqNum = OpenAndFill(store, budget, 3, "bq1", "bq1",
            [new("Group", "STRING", "text") { SortKind = ColumnTypes.Text }, new("Val", "NUMERIC", "text", Precision: 38, Scale: 9) { SortKind = ColumnTypes.Decimal, BigQueryDecimal = BigQueryDecimalKind.Numeric }],
            [b => { b.AppendText("A"); b.AppendText("1.123456789"); }]);
        var sqlScale12 = OpenAndFill(store, budget, 4, "sql3", "sql3",
            [new("Group", "nvarchar(10)", "text"), new("Val", "decimal(38,12)", "text", Precision: 38, Scale: 12)],
            [b => { b.AppendText("A"); b.AppendText("2.000000000001"); }]);
        var scale12Combined = (await combiner.CombineAsync(store, budget, [bqNum, sqlScale12], 5, 1, 1, null, false, CancellationToken.None)).Buffer!;
        var scale12Col = scale12Combined.Columns[2];
        var scale12Sum = PivotSum(store, scale12Combined, 1, 2);
        check(scale12Col.SortKind == ColumnTypes.Decimal && scale12Col.Scale == 12 && scale12Col.BigQueryDecimal == BigQueryDecimalKind.WideDecimal
            && scale12Sum == "3.123456789001",
            $"NUMERIC + decimal(38,12) promotes to WideDecimal (scale 12) and pivots cleanly to exact scale ({scale12Col.BigQueryDecimal}, sum={scale12Sum})");

        // 3) BigQuery NUMERIC(38,9) + SQL Server decimal(38,2) (integer precision 36 > 29) -> promotes to WideDecimal, preventing TryWideDecimal/NUMERIC 29-digit overflow
        var sqlWideInt = OpenAndFill(store, budget, 6, "sql4", "sql4",
            [new("Group", "nvarchar(10)", "text"), new("Val", "decimal(38,2)", "text", Precision: 38, Scale: 2)],
            [b => { b.AppendText("A"); b.AppendText("1000000000000000000000000000000000.25"); }]);
        var wideIntCombined = (await combiner.CombineAsync(store, budget, [bqNum, sqlWideInt], 7, 1, 1, null, false, CancellationToken.None)).Buffer!;
        var wideIntCol = wideIntCombined.Columns[2];
        var wideIntSum = PivotSum(store, wideIntCombined, 1, 2);
        check(wideIntCol.BigQueryDecimal == BigQueryDecimalKind.WideDecimal
            && wideIntSum == "1000000000000000000000000000000001.373456789",
            $"NUMERIC + decimal(38,2) (int precision 36 > 29) promotes to WideDecimal and pivots 34+ whole digits cleanly ({wideIntCol.BigQueryDecimal}, sum={wideIntSum})");

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
        string? manualThreeCode = null;
        try { await combiner.CombineAsync(store, budget, [s1, remoteSet, s2], 6, 1, 1, null, true, CancellationToken.None); }
        catch (RequestException error) { manualThreeCode = error.Code; }
        check(twoAuto.Buffer is null && twoAuto.Warnings.Count == 1 && manualCode == "REMOTE_RESULT" && manualThreeCode == "REMOTE_RESULT",
            $"fewer than 2 in-memory sources returns null+warning when auto-combining and manual combine throws REMOTE_RESULT for any remote source ({manualCode}/{manualThreeCode})");
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

    private static async Task HardeningChecksAsync(ResultCombiner combiner, Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        var budget = store.BeginQuery("combine-hardening");

        // (a) SQL Server int + decimal(38,38) promotes BigQueryDecimal = WideDecimal so ResultPivoter SUM never overflows Int128
        var intSet = OpenAndFill(store, budget, 0, "s1", "s1",
            [new("G", "nvarchar(10)", "text"), new("V", "int", "text")],
            [b => { b.AppendText("A"); b.AppendText("1"); }]);
        var dec38Set = OpenAndFill(store, budget, 1, "s2", "s2",
            [new("G", "nvarchar(10)", "text"), new("V", "decimal(38,38)", "text", Precision: 38, Scale: 38)],
            [b => { b.AppendText("A"); b.AppendText("0.5"); }]);
        var decCombined = (await combiner.CombineAsync(store, budget, [intSet, dec38Set], 2, 1, 1, null, false, CancellationToken.None)).Buffer!;
        var decCol = decCombined.Columns[2];
        check(decCol.BigQueryDecimal == BigQueryDecimalKind.WideDecimal && decCol.Scale == 38 && decCol.DataType.StartsWith("decimal(", StringComparison.Ordinal),
            $"int + decimal(38,38) promotes to WideDecimal internally with SQL decimal dataType ({decCol.DataType}, {decCol.BigQueryDecimal})");
        var sumCell = PivotSum(store, decCombined, 1, 2);
        check(sumCell is not null && (sumCell == "1.5" || sumCell.StartsWith("1.500", StringComparison.Ordinal)),
            $"ResultPivoter SUM over combined int + decimal(38,38) yields 1.5 without Int128 overflow ({sumCell})");

        // (b) Binary-wire UDT (hierarchyid) + varbinary and hierarchyid + geometry keep binary wire, SortKind, and varbinary(max)
        var udtSet = OpenAndFill(store, budget, 4, "u1", "u1",
            [new("H", "hierarchyid", "binary", Role: "udt") { SortKind = ColumnTypes.Other }],
            [b => b.AppendBinary([0x58])]);
        var binSet = OpenAndFill(store, budget, 5, "u2", "u2",
            [new("H", "varbinary(10)", "binary") { SortKind = ColumnTypes.Binary }],
            [b => b.AppendBinary([0xAB])]);
        var udtBin = (await combiner.CombineAsync(store, budget, [udtSet, binSet], 6, 1, 1, null, false, CancellationToken.None)).Buffer!;
        check(udtBin.Columns[1].Wire == "binary" && udtBin.Columns[1].SortKind == ColumnTypes.Binary && udtBin.Columns[1].DataType == "varbinary(max)",
            $"hierarchyid + varbinary widens to binary/Binary/varbinary(max) ({udtBin.Columns[1].Wire}/{udtBin.Columns[1].SortKind}/{udtBin.Columns[1].DataType})");

        var geomSet = OpenAndFill(store, budget, 7, "u3", "u3",
            [new("H", "geometry", "binary", Role: "udt") { SortKind = ColumnTypes.Other }],
            [b => b.AppendBinary([0x01])]);
        var udtUdtOut = await combiner.CombineAsync(store, budget, [udtSet, geomSet], 8, 1, 1, null, false, CancellationToken.None);
        var udtUdt = udtUdtOut.Buffer!;
        check(udtUdt.Columns[1].Wire == "binary" && udtUdt.Columns[1].SortKind == ColumnTypes.Binary && udtUdt.Columns[1].Role is null
            && udtUdt.Columns[1].DataType == "varbinary(max)" && udtUdtOut.Warnings.Count > 0,
            $"hierarchyid + geometry widens cleanly to binary/Binary/varbinary(max) with Role=null and schema-drift warning ({udtUdt.Columns[1].Wire}/{udtUdt.Columns[1].SortKind}/{udtUdt.Columns[1].Role}/{udtUdt.Columns[1].DataType})");

        // Heterogeneous text Other (sql_variant + GEOGRAPHY) and mixed xml + json widen to text with warnings
        var varSet = OpenAndFill(store, budget, 22, "v1", "v1",
            [new("O", "sql_variant", "text") { SortKind = ColumnTypes.Other }, new("Doc", "xml", "text", Role: "xml") { SortKind = ColumnTypes.Json }],
            [b => { b.AppendText("abc"); b.AppendText("<a/>"); }]);
        var geoSet = OpenAndFill(store, budget, 23, "v2", "v2",
            [new("O", "GEOGRAPHY", "text") { SortKind = ColumnTypes.Other }, new("Doc", "JSON", "text", Role: "json") { SortKind = ColumnTypes.Json }],
            [b => { b.AppendText("POINT(0 0)"); b.AppendText("{\"a\":1}"); }]);
        var hetOut = await combiner.CombineAsync(store, budget, [varSet, geoSet], 24, 1, 1, null, false, CancellationToken.None);
        var hetBuf = hetOut.Buffer!;
        check(hetBuf.Columns[1].SortKind == ColumnTypes.Text && hetBuf.Columns[1].DataType == "nvarchar(max)"
            && hetBuf.Columns[2].SortKind == ColumnTypes.Text && hetBuf.Columns[2].Role is null && hetOut.Warnings.Count > 0,
            "sql_variant + GEOGRAPHY and xml + JSON widen to text/nvarchar(max) with Role=null and schema-drift warning");

        // (c) real + real preserves null Precision (as ColumnPlan.From emits); decimal(38,2) + decimal(18,4) keeps non-38 decimal pivot formatting
        var r1 = OpenAndFill(store, budget, 9, "r1", "r1",
            [new("F", "real", "text"), new("T", "varchar(10)", "text", MaxLength: 10), new("D", "decimal(38,2)", "text", Precision: 38, Scale: 2)],
            [b => { b.AppendText("1.5"); b.AppendText("a"); b.AppendText("10.25"); }]);
        var r2 = OpenAndFill(store, budget, 10, "r2", "r2",
            [new("F", "real", "text"), new("T", "varchar(50)", "text", MaxLength: 50), new("D", "decimal(18,4)", "text", Precision: 18, Scale: 4)],
            [b => { b.AppendText("2.5"); b.AppendText("a"); b.AppendText("2.0900"); }]);
        var rComb = (await combiner.CombineAsync(store, budget, [r1, r2], 11, 1, 1, null, false, CancellationToken.None)).Buffer!;
        var wideSqlSum = PivotSum(store, rComb, 2, 3);
        check(rComb.Columns[1].Precision is null && rComb.Columns[1].DataType == "real"
            && rComb.Columns[2].DataType == "nvarchar(max)" && rComb.Columns[2].MaxLength is null
            && rComb.Columns[3].DataType == "decimal(40,4)" && rComb.Columns[3].Precision == 40 && wideSqlSum == "12.3400",
            $"real+real preserves null Precision, differing varchar drops MaxLength, and decimal(38,2)+decimal(18,4) emits decimal(40,4) pivoting to 12.3400 ({rComb.Columns[3].DataType}, sum={wideSqlSum})");

        // (d) ColumnProfiler: NaN ExactValue excluded from bins, positive/negative NaN collapse, extreme FLOAT64 range (-1e308..1e308), and unparseable float text distinct from NaN
        var nanSet = store.Open(budget, 12, 1, 1, "rows", [new("X", "float", "text")], [WireKind.Text], targetKey: "n1", targetLabel: "n1")!;
        var posNan = BitConverter.Int64BitsToDouble(0x7FF8_0000_0000_0000L);
        var b1 = nanSet.BeginRow()!; b1.AppendFloat(1.0); nanSet.TryCommitRow(0);
        var b2 = nanSet.BeginRow()!; b2.AppendFloat(double.NaN); nanSet.TryCommitRow(0);
        var b3 = nanSet.BeginRow()!; b3.AppendFloat(posNan); nanSet.TryCommitRow(0);
        nanSet.Complete();
        var nanProfile = ColumnProfiler.Profile(nanSet, nanSet.SealedSnapshot(), null, [0], true, CancellationToken.None).Columns[0];
        check(nanProfile.Distinct == 2 && nanProfile.Histogram is { Counts: var counts } && counts.Sum() == 1,
            $"ColumnProfiler excludes NaN ExactValue from histogram bins and collapses positive/negative NaN (distinct={nanProfile.Distinct}, binSum={nanProfile.Histogram?.Counts.Sum()})");

        var extremeSet = OpenAndFill(store, budget, 25, "ex", "ex",
            [new("F", "float", "text")],
            [b => b.AppendText("-1e308"), b => b.AppendText("0"), b => b.AppendText("1e308"), b => b.AppendText("NaN"), b => b.AppendText("foo"), b => b.AppendText("bar")]);
        var exProfile = ColumnProfiler.Profile(extremeSet, extremeSet.SealedSnapshot(), null, [0], true, CancellationToken.None).Columns[0];
        check(exProfile.Distinct == 6 && exProfile.Histogram is { Counts: var exCounts } && exCounts.Sum() == 3 && exCounts[0] == 1 && exCounts[10] == 1 && exCounts[19] == 1,
            $"ColumnProfiler handles extreme finite float span without Infinity overflow and keeps unparseable text distinct from NaN (distinct={exProfile.Distinct}, bins={string.Join(",", exProfile.Histogram?.Counts ?? [])})");

        // (e) ViewSorter.NumberKey boolean textTies + InstantKey with mixed unparseable date cell
        var boolMix = OpenAndFill(store, budget, 13, "bm", "bm",
            [new("B", "bit", "text") { SortKind = ColumnTypes.Boolean }],
            [
                b => b.AppendText("true"),
                b => b.AppendText("invalid"),
                b => b.AppendText("1"),
                b => b.AppendText("false"),
                b => b.AppendText("0")
            ]);
        var boolOrder = ViewSorter.Sort(boolMix, boolMix.SealedSnapshot(), [new ViewKey(0, false, SortMode.Value)], CancellationToken.None).Order;
        check(boolOrder[0] == 1 && ((boolOrder[1] == 3 && boolOrder[2] == 4) || (boolOrder[1] == 4 && boolOrder[2] == 3))
            && ((boolOrder[3] == 0 && boolOrder[4] == 2) || (boolOrder[3] == 2 && boolOrder[4] == 0)),
            $"ViewSorter NumberKey textTies preserves true==1 and false==0 ordering ({string.Join(",", boolOrder)})");

        var mixedInst = OpenAndFill(store, budget, 26, "mi", "mi",
            [new("At", "datetime2", "text")],
            [b => b.AppendText("2024-03-01 10:00:00.0000000"), b => b.AppendText("2024-03-01T09:00:00"), b => b.AppendText("not a date"), b => b.AppendText("2024-03-01T10:00:00")]);
        var mixedInstOrder = ViewSorter.Sort(mixedInst, mixedInst.SealedSnapshot(), [new ViewKey(0, false, SortMode.Value)], CancellationToken.None).Order;
        check(mixedInstOrder[0] == 1 && mixedInstOrder[3] == 2,
            $"InstantKey keeps valid cross-dialect instants ordered chronologically even when an unparseable cell is present ({string.Join(",", mixedInstOrder)})");

        // CellHasher Kind.Float rejects leading/control whitespace and marks trailing spaces as text difference under exact: true
        var fltLeft = OpenAndFill(store, budget, 27, "fl", "fl", [new("F", "float", "text")], [b => b.AppendText("1"), b => b.AppendText("2")]);
        var fltRight = OpenAndFill(store, budget, 28, "fr", "fr", [new("F", "nvarchar(20)", "text")], [b => b.AppendText("\t 1 \r\n"), b => b.AppendText("2  ")]);
        var fltDiff = ResultDiffer.Compare(fltLeft, fltLeft.SealedSnapshot(), fltRight, fltRight.SealedSnapshot(), exact: true, CancellationToken.None);
        check(fltDiff.Entries.All(e => e.Kind != DiffKind.Same),
            $"CellHasher Kind.Float does not match leading/trailing whitespace under exact: true ({string.Join(",", fltDiff.Entries.Select(e => e.Kind))})");

        // (f) Incomplete source propagation & cancellation pin/buffer cleanup
        var incA = OpenAndFill(store, budget, 14, "ia", "ia", [new("Id", "int", "text")], [b => b.AppendText("1")]);
        incA.Incomplete = true;
        var incB = OpenAndFill(store, budget, 15, "ib", "ib", [new("Id", "int", "text")], [b => b.AppendText("2")]);
        var incOut = await combiner.CombineAsync(store, budget, [incA, incB], 16, 1, 1, null, false, CancellationToken.None);
        check(incOut.Buffer is { Incomplete: true } && incOut.Warnings.Any(w => w.Contains("partial rows", StringComparison.OrdinalIgnoreCase)),
            "ResultCombiner propagates Incomplete flag and warns when a source ended with an error");

        var cancelEx = "";
        try
        {
            using var cts = new CancellationTokenSource();
            cts.Cancel();
            await combiner.CombineAsync(store, budget, [incA, incB], 18, 1, 1, null, false, cts.Token);
        }
        catch (OperationCanceledException) { cancelEx = "CANCELLED"; }
        check(cancelEx == "CANCELLED" && incA.Pins == 0 && incB.Pins == 0,
            "ResultCombiner honors cancellation token and releases all source pins cleanly");

        // (g) Binary-to-hex widening preserves exact CellLength when truncated at BinaryCap
        var bigBin = new byte[40_000];
        var binSrc = store.Open(budget, 19, 1, 1, "rows", [new("Data", "varbinary(max)", "binary")], [WireKind.Binary], lengths: [ColumnLength.Binary], targetKey: "b1", targetLabel: "b1")!;
        var br = binSrc.BeginRow()!;
        br.AppendBinary(bigBin.AsSpan(0, ColumnPlan.BinaryCap), truncated: true);
        br.Measure(bigBin.Length, bigBin.Length, keep: true, exact: true);
        binSrc.TryCommitRow(1);
        binSrc.Complete();
        var txtSrc = OpenAndFill(store, budget, 20, "b2", "b2", [new("Data", "nvarchar(max)", "text")], [b => b.AppendText("hi")]);
        var hexComb = (await combiner.CombineAsync(store, budget, [binSrc, txtSrc], 21, 1, 1, null, false, CancellationToken.None)).Buffer!;
        var hexPage = hexComb.SealedSnapshot()[0];
        check(hexPage.Lengths.TryCell(0, 1, out var hexEntry) && hexEntry.Exact && hexEntry.Chars == 2L + 2L * bigBin.Length,
            $"Binary-to-hex widening preserves exact CellLength on truncated binary source (exact={hexEntry.Exact}, chars={hexEntry.Chars})");

        // (h) End-to-end SqlService.DispatchAsync("results.combine", ...) checks
        using var svc = new SqlService(new ResultStore(1L << 26, 1L << 25));
        var svcBudget = svc.Results.BeginQuery("svc-combine");
        var sA = OpenAndFill(svc.Results, svcBudget, 0, "sa", "Server A", [new("Id", "int", "text")], [b => b.AppendText("10")]);
        var sB = OpenAndFill(svc.Results, svcBudget, 1, "sb", "Server B", [new("Id", "int", "text")], [b => b.AppendText("20")]);
        var wire = new System.Text.Json.JsonSerializerOptions(System.Text.Json.JsonSerializerDefaults.Web);
        async Task<(string Code, ResultsCombineResult? Res)> CallCombineAsync(object payload)
        {
            using var doc = System.Text.Json.JsonDocument.Parse(System.Text.Json.JsonSerializer.Serialize(payload, wire));
            try { return ("ok", (ResultsCombineResult?)await svc.DispatchAsync("results.combine", doc.RootElement.Clone(), wire, null)); }
            catch (RequestException ex) { return (ex.Code, null); }
        }
        var (okCode, okRes) = await CallCombineAsync(new { resultIds = new[] { sA.ResultId, sB.ResultId }, statementName = "Orders" });
        check(okCode == "ok" && okRes is { Descriptor: { Kind: "combined", RowsStored: 2, Name: "Orders" } },
            $"SqlService results.combine returns a combined descriptor with 2 rows and statementName ({okCode})");
        svcBudget.Executing = true;
        var (busyCode, _) = await CallCombineAsync(new { resultIds = new[] { sA.ResultId, sB.ResultId } });
        svcBudget.Executing = false;
        check(busyCode == "BUSY", $"SqlService results.combine refuses while Executing ({busyCode})");
        var (badNameCode, _) = await CallCombineAsync(new { resultIds = new[] { sA.ResultId, sB.ResultId }, statementName = " leading" });
        check(badNameCode == "INVALID_PARAMS", $"SqlService results.combine rejects untrimmed statementName ({badNameCode})");

        // (i) Round 3 hardening checks:
        // - TIMESTAMP vs unzoned datetime2 diffs as Changed in both directions regardless of local timezone
        var tsLeft = OpenAndFill(store, budget, 26, "ts1", "ts1",
            [new("Id", "INT64", "text") { SortKind = ColumnTypes.Integer }, new("When", "TIMESTAMP", "text") { SortKind = ColumnTypes.Timestamp }],
            [b => { b.AppendText("1"); b.AppendText("2024-03-01 10:00:00.000000 UTC"); }]);
        var dtRight = OpenAndFill(store, budget, 27, "dt1", "dt1",
            [new("Id", "int", "text"), new("When", "datetime2", "text")],
            [b => { b.AppendText("1"); b.AppendText("2024-03-01 10:00:00.0000000"); }]);
        var diffLR = ResultDiffer.Compare(tsLeft, tsLeft.SealedSnapshot(), dtRight, dtRight.SealedSnapshot(), exact: false, CancellationToken.None, match: new DiffMatch(DiffMatchMode.Columns, [0]));
        var diffRL = ResultDiffer.Compare(dtRight, dtRight.SealedSnapshot(), tsLeft, tsLeft.SealedSnapshot(), exact: false, CancellationToken.None, match: new DiffMatch(DiffMatchMode.Columns, [0]));
        var lrChanged = diffLR.Entries.Count(e => e.Kind == DiffKind.Changed);
        var rlChanged = diffRL.Entries.Count(e => e.Kind == DiffKind.Changed);
        check(lrChanged == 1 && rlChanged == 1,
            $"TIMESTAMP vs unzoned datetime2 diffs symmetrically as Changed ({lrChanged}/{rlChanged})");

        // - TIMESTAMP vs unzoned ISO date ("2024-03-01") diffs symmetrically as Changed even against UTC and local midnight
        var localMidnightUtc = new DateTimeOffset(2024, 3, 1, 0, 0, 0, TimeZoneInfo.Local.GetUtcOffset(new DateTime(2024, 3, 1)))
            .ToUniversalTime().ToString("yyyy-MM-dd HH:mm:ss.ffffff", CultureInfo.InvariantCulture) + " UTC";
        var tsDate = OpenAndFill(store, budget, 39, "tsd1", "tsd1",
            [new("Id", "INT64", "text") { SortKind = ColumnTypes.Integer }, new("When", "TIMESTAMP", "text") { SortKind = ColumnTypes.Timestamp }],
            [b => { b.AppendText("1"); b.AppendText("2024-03-01 00:00:00.000000 UTC"); },
             b => { b.AppendText("2"); b.AppendText(localMidnightUtc); }]);
        var isoDate = OpenAndFill(store, budget, 40, "d1", "d1",
            [new("Id", "int", "text"), new("When", "date", "text")],
            [b => { b.AppendText("1"); b.AppendText("2024-03-01"); },
             b => { b.AppendText("2"); b.AppendText("2024-03-01"); }]);
        var diffTsDate = ResultDiffer.Compare(tsDate, tsDate.SealedSnapshot(), isoDate, isoDate.SealedSnapshot(), exact: false, CancellationToken.None, match: new DiffMatch(DiffMatchMode.Columns, [0]));
        var diffDateTs = ResultDiffer.Compare(isoDate, isoDate.SealedSnapshot(), tsDate, tsDate.SealedSnapshot(), exact: false, CancellationToken.None, match: new DiffMatch(DiffMatchMode.Columns, [0]));
        check(diffTsDate.Entries.Count(e => e.Kind == DiffKind.Changed) == 2
            && diffDateTs.Entries.Count(e => e.Kind == DiffKind.Changed) == 2
            && !ViewSorter.HasExplicitZone("2024-03-01") && !ViewSorter.HasExplicitZone("01-Mar-2024")
            && !ViewSorter.HasExplicitZone("10:00:00 2024-03-01") && !ViewSorter.HasExplicitZone("10:00:00+02:00")
            && !ViewSorter.HasExplicitZone("08:00:00Z") && ViewSorter.HasExplicitZone("2024-03-01 10:00:00+02:00"),
            "TIMESTAMP vs unzoned ISO date diffs symmetrically as Changed and HasExplicitZone rejects unzoned date & time-only offset patterns");

        // - ViewSorter.DistinctValues on Float column distinguishes NaN from unparseable text (matching ColumnProfiler)
        var exDistinct = ViewSorter.DistinctValues(extremeSet, extremeSet.SealedSnapshot(), null, 0, extremeSet.IsComplete, CancellationToken.None);
        check(exDistinct.Distinct == 6,
            $"ViewSorter NumberKey distinguishes NaN from unparseable text on Float columns (distinct={exDistinct.Distinct})");

        // - Native parameterized BIGNUMERIC(50, 10) keeps scale-38 255-bit overflow check and BIGNUMERIC pivot output
        var paramBn = OpenAndFill(store, budget, 28, "bn1", "bn1",
            [new("G", "STRING", "text") { SortKind = ColumnTypes.Text },
             new("V", "BIGNUMERIC(50, 10)", "text", Precision: 50, Scale: 10) { SortKind = ColumnTypes.Decimal, BigQueryDecimal = BigQueryDecimalKind.BigNumeric }],
            [b => { b.AppendText("A"); b.AppendText("400000000000000000000000000000000000000"); },
             b => { b.AppendText("A"); b.AppendText("400000000000000000000000000000000000000"); }]);
        var bnSum = PivotSum(store, paramBn, 0, 1);
        check(bnSum is null, $"Parameterized BIGNUMERIC(50, 10) overflows 255-bit scale-38 sum as ERR (sum={bnSum})");

        // - Identical NUMERIC(10, 2) preserves DataType/Precision/Scale on combine
        var n10a = OpenAndFill(store, budget, 29, "n10a", "n10a",
            [new("V", "NUMERIC(10, 2)", "text", Precision: 10, Scale: 2) { SortKind = ColumnTypes.Decimal, BigQueryDecimal = BigQueryDecimalKind.Numeric }],
            [b => b.AppendText("1.25")]);
        var n10b = OpenAndFill(store, budget, 30, "n10b", "n10b",
            [new("V", "NUMERIC(10, 2)", "text", Precision: 10, Scale: 2) { SortKind = ColumnTypes.Decimal, BigQueryDecimal = BigQueryDecimalKind.Numeric }],
            [b => b.AppendText("2.50")]);
        var n10Comb = (await combiner.CombineAsync(store, budget, [n10a, n10b], 31, 1, 1, null, false, CancellationToken.None)).Buffer!;
        check(n10Comb.Columns[1].DataType == "NUMERIC(10, 2)" && n10Comb.Columns[1].Precision == 10 && n10Comb.Columns[1].Scale == 2,
            $"Identical NUMERIC(10, 2) preserved on combine ({n10Comb.Columns[1].DataType})");

        // - Widened BigQuery NUMERIC(10, 2) + SQL Server int clamps precision to 29 + scale (31, not 38)
        var intSmall = OpenAndFill(store, budget, 41, "ns1", "ns1", [new("V", "int", "text")], [b => b.AppendText("5")]);
        var numWidened = (await combiner.CombineAsync(store, budget, [n10a, intSmall], 42, 1, 1, null, false, CancellationToken.None)).Buffer!;
        check(numWidened.Columns[1].DataType == "NUMERIC" && numWidened.Columns[1].Precision == 31 && numWidened.Columns[1].Scale == 2,
            $"Widened NUMERIC(10,2)+int caps Precision at 29+scale=31 (got {numWidened.Columns[1].Precision},{numWidened.Columns[1].Scale})");

        // - Widened BigQuery BOOL + int measures normalized "1" as 1 char, not 4 chars
        var boolSrc = store.Open(budget, 32, 1, 1, "rows",
            [new("Flag", "BOOL", "text") { SortKind = ColumnTypes.Boolean }], [WireKind.Text], lengths: [ColumnLength.Fixed(1)], targetKey: "bf1", targetLabel: "bf1")!;
        var bfRow = boolSrc.BeginRow()!; bfRow.AppendText("true"); boolSrc.TryCommitRow(0); boolSrc.Complete();
        var intFlagSrc = OpenAndFill(store, budget, 33, "bf2", "bf2", [new("Flag", "int", "text")], [b => b.AppendText("1")]);
        var bfComb = (await combiner.CombineAsync(store, budget, [boolSrc, intFlagSrc], 34, 1, 1, null, false, CancellationToken.None)).Buffer!;
        var bfPage = bfComb.SealedSnapshot()[0];
        var flagLen = bfPage.Lengths.TryCell(0, 1, out var fl) ? fl.Chars : 1L;
        check(flagLen == 1, $"Widened BOOL 'true' normalized to '1' has CellLength Chars == 1 (got {flagLen})");

        // - Zoned + unzoned temporal column emits 1 schema-drift warning (not 2)
        var tzOut = await combiner.CombineAsync(store, budget, [tsLeft, dtRight], 35, 1, 1, null, false, CancellationToken.None);
        check(tzOut.Warnings.Count == 1 && tzOut.Warnings[0].Contains("zoned and unzoned", StringComparison.Ordinal),
            $"Zoned + unzoned temporal column emits single warning (count={tzOut.Warnings.Count})");

        // - IsError cell copied into combined set preserves estimated-row flag
        var errSrc = store.Open(budget, 36, 1, 1, "rows", [new("Val", "nvarchar(10)", "text")], [WireKind.Text], targetKey: "er1", targetLabel: "er1")!;
        var erRow = errSrc.BeginRow()!; erRow.AppendNull(error: true); erRow.Measure(0, 0, exact: false); errSrc.TryCommitRow(0); errSrc.Complete();
        var okErrSrc = OpenAndFill(store, budget, 37, "er2", "er2", [new("Val", "nvarchar(10)", "text")], [b => b.AppendText("ok")]);
        var errComb = (await combiner.CombineAsync(store, budget, [errSrc, okErrSrc], 38, 1, 1, null, false, CancellationToken.None)).Buffer!;
        var errPage = errComb.SealedSnapshot()[0];
        var estRows = new List<int>();
        errPage.Lengths.EstimatedRows(0, errPage.Rows, estRows.Add);
        check(estRows.Contains(0),
            "IsError cell copied into combined result marks row as estimated");

        // - SqlService results.combine returns INVALID_PARAMS before BUSY on invalid/single-server IDs, and distinct message when Loading
        var singleServer = svc.Results.Open(svcBudget, 2, 1, 1, "rows", [new("Id", "int", "text")], [WireKind.Text])!;
        singleServer.Complete();
        svcBudget.Executing = true;
        var (invBeforeBusy, _) = await CallCombineAsync(new { resultIds = new[] { sA.ResultId, singleServer.ResultId } });
        svcBudget.Executing = false;
        svcBudget.TryBeginLoad();
        string loadingMsg = "";
        try
        {
            using var doc = System.Text.Json.JsonDocument.Parse(System.Text.Json.JsonSerializer.Serialize(new { resultIds = new[] { sA.ResultId, sB.ResultId } }, wire));
            await svc.DispatchAsync("results.combine", doc.RootElement.Clone(), wire, null);
        }
        catch (RequestException ex) { loadingMsg = ex.Code + ":" + ex.Message; }
        svcBudget.EndLoad();
        check(invBeforeBusy == "INVALID_PARAMS" && loadingMsg.StartsWith("BUSY:", StringComparison.Ordinal) && loadingMsg.Contains("loading into memory", StringComparison.OrdinalIgnoreCase),
            $"SqlService results.combine validates params before BUSY ({invBeforeBusy}) and reports distinct Loading message ({loadingMsg})");
    }
}
