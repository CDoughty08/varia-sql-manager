using System.Globalization;
using Varia.Backend.MultiQuery;

namespace Varia.Backend.Results;

/// <summary>Combines two or more in-memory multi-server result sets into one derived <c>combined</c> result set
/// with a prepended trusted <c>_server</c> column, duplicate-name alignment matching <see cref="ResultDiffer.Pairs"/>,
/// safe cross-dialect type widening, and whole-buffer budget rollback so individual server results remain intact.</summary>
internal sealed class ResultCombiner : IResultCombiner
{
    public const string ServerColumnName = "_server";
    public const string TooLarge = "There is not enough result memory to combine these results. Close other results and try again.";
    private const string BudgetWarning = "Skipped Combined view: not enough result memory remained for the combined rows. Individual server results were kept intact.";
    private const int CancelEvery = 1024;
    private const int MaxBinaryHexBytes = (ColumnPlan.TextCap - 2) / 2;

    private static ReadOnlySpan<byte> HexDigits => "0123456789ABCDEF"u8;

    public Task<CombineOutput> CombineAsync(
        ResultStore store,
        QueryBudget budget,
        IReadOnlyList<ResultSetBuffer> sources,
        int index,
        int batchNumber,
        int iteration,
        string? statementName,
        bool throwOnBudgetRefusal,
        CancellationToken token) =>
        Task.FromResult(Combine(store, budget, sources, index, batchNumber, iteration, statementName, throwOnBudgetRefusal, token));

    private static CombineOutput Combine(
        ResultStore store,
        QueryBudget budget,
        IReadOnlyList<ResultSetBuffer> sources,
        int index,
        int batchNumber,
        int iteration,
        string? statementName,
        bool throwOnBudgetRefusal,
        CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        var warnings = new List<string>();
        var pins = new List<PagePin>(sources.Count);
        var inMemory = new List<(ResultSetBuffer Set, StoredPage[] Pages, string Label)>(sources.Count);
        var skippedRemote = 0;

        try
        {
            foreach (var src in sources)
            {
                token.ThrowIfCancellationRequested();
                pins.Add(src.Pin());
                var label = SourceLabel(src);
                if (src.IsReleased)
                {
                    if (throwOnBudgetRefusal) throw new RequestException("RESULT_RELEASED", "One of the source results was closed.");
                    warnings.Add($"Skipped {label}: source result was closed.");
                    continue;
                }
                if (src.IsRemote)
                {
                    skippedRemote++;
                    warnings.Add($"Skipped {label}: result is windowed in BigQuery. Load it into memory to include it in Combined.");
                    continue;
                }
                StoredPage[] pages;
                try
                {
                    pages = src.SealedSnapshot();
                }
                catch (RequestException error) when (error.Code == "REMOTE_RESULT")
                {
                    skippedRemote++;
                    warnings.Add($"Skipped {label}: result is windowed in BigQuery. Load it into memory to include it in Combined.");
                    continue;
                }
                inMemory.Add((src, pages, label));
            }

            if (inMemory.Count < 2)
            {
                if (throwOnBudgetRefusal)
                {
                    if (skippedRemote > 0) throw SqlService.RemoteRefused();
                    throw new RequestException("INVALID_PARAMS", "At least two in-memory results are required to combine.");
                }
                return new CombineOutput(null, warnings);
            }

            var plan = AlignColumns(inMemory, warnings);
            int? statementSlot = inMemory[0].Set.StatementSlot;
            for (var s = 1; s < inMemory.Count; s++)
            {
                if (inMemory[s].Set.StatementSlot != statementSlot) { statementSlot = null; break; }
            }

            var combined = store.Open(
                budget,
                index,
                batchNumber,
                iteration,
                "combined",
                plan.Columns,
                plan.Wires,
                lengths: plan.Lengths,
                derived: true,
                name: statementName,
                statementSlot: statementSlot);

            if (combined is null)
            {
                if (throwOnBudgetRefusal) throw new RequestException("TOO_LARGE", TooLarge);
                warnings.Add(BudgetWarning);
                return new CombineOutput(null, warnings);
            }

            var anyRolledBack = false;
            foreach (var item in inMemory)
            {
                if (item.Set.RolledBackPreview) { anyRolledBack = true; break; }
            }
            if (anyRolledBack) combined.RolledBackPreview = true;

            var refused = false;
            try
            {
                byte[]? hexBuffer = plan.HasBinaryToText ? new byte[2 + 2 * MaxBinaryHexBytes] : null;
                var rowCounter = 0;

                for (var s = 0; s < inMemory.Count && !refused; s++)
                {
                    var (src, pages, label) = inMemory[s];
                    using var rooms = PageRooms.Over(pages, src.Wires.Count, () => new RequestException("TOO_LARGE", TooLarge));
                    using var reader = new RoomReader(rooms, src.Wires.Count);

                    foreach (var page in pages)
                    {
                        token.ThrowIfCancellationRequested();
                        var view = reader.Read(page);
                        var lengths = page.Lengths;
                        for (var r = 0; r < page.Rows; r++)
                        {
                            if ((++rowCounter & (CancelEvery - 1)) == 0) token.ThrowIfCancellationRequested();
                            combined.CountRow();
                            var builder = combined.BeginRow();
                            if (builder is null) { refused = true; break; }

                            var truncated = 0;
                            builder.AppendText(label);
                            builder.Measure(label.Length, 2L * label.Length);
                            if (builder.LastTruncated) truncated++;

                            for (var k = 0; k < plan.Slots.Count; k++)
                            {
                                var srcCol = plan.Slots[k].SourceColumns[s];
                                if (srcCol < 0)
                                {
                                    builder.AppendNull();
                                    continue;
                                }
                                if (view.IsNull(srcCol, r))
                                {
                                    builder.AppendNull(view.IsError(srcCol, r));
                                    continue;
                                }

                                var outIndex = k + 1;
                                var outMeta = plan.Columns[outIndex];
                                var outWire = plan.Wires[outIndex];
                                var outLength = plan.Lengths[outIndex];
                                var srcMeta = src.Columns[srcCol];
                                var srcWire = src.Wires[srcCol];
                                var span = view.Span(srcCol, r);
                                var cut = view.IsTruncated(srcCol, r);

                                if (srcWire == WireKind.Binary && outWire == WireKind.Binary)
                                {
                                    builder.AppendBinary(span, cut);
                                    MeasureCopied(builder, src.Lengths[srcCol], outLength, lengths, r, srcCol, span, srcWire, cut);
                                }
                                else if (srcWire == WireKind.Binary)
                                {
                                    var hexCut = cut || span.Length > MaxBinaryHexBytes;
                                    var take = Math.Min(span.Length, MaxBinaryHexBytes);
                                    var written = FormatHex(span[..take], hexBuffer!);
                                    builder.AppendUtf8(hexBuffer.AsSpan(0, written), hexCut);
                                    var fullBytes = lengths.TryCell(r, srcCol, out var kept) ? kept.Bytes : span.Length;
                                    var hexChars = 2L + 2L * fullBytes;
                                    builder.Measure(hexChars, 2L * hexChars, keep: hexCut || outLength.Rule != LengthRule.Utf16, exact: !cut);
                                }
                                else if (srcMeta.SortKind == ColumnTypes.Boolean && ColumnTypes.IsNumeric(outMeta.SortKind))
                                {
                                    var normalized = ColumnTypes.BooleanNumber(span);
                                    builder.AppendUtf8(normalized, cut);
                                    var derivedSize = outLength.Derive(normalized, WireKind.Text);
                                    builder.Measure(derivedSize.Chars, derivedSize.Bytes, keep: cut, exact: !cut && derivedSize.Exact);
                                }
                                else
                                {
                                    builder.AppendUtf8(span, cut);
                                    if (ColumnTypes.HoldsExact(outMeta) && ColumnTypes.HoldsExact(srcMeta) && view.TryExact(srcCol, r, out var exact))
                                        builder.KeepExact(exact);
                                    MeasureCopied(builder, src.Lengths[srcCol], outLength, lengths, r, srcCol, span, srcWire, cut);
                                }

                                if (builder.LastTruncated) truncated++;
                            }

                            if (!combined.TryCommitRow(truncated))
                            {
                                refused = true;
                                break;
                            }
                        }
                        if (refused) break;
                    }
                }
            }
            catch (RequestException error) when (error.Code == "TOO_LARGE")
            {
                store.Release([combined.ResultId]);
                if (throwOnBudgetRefusal) throw;
                warnings.Add(BudgetWarning);
                return new CombineOutput(null, warnings);
            }
            catch
            {
                store.Release([combined.ResultId]);
                throw;
            }

            if (refused || combined.Refusal != TruncationReason.None || combined.Truncated != TruncationReason.None)
            {
                store.Release([combined.ResultId]);
                if (throwOnBudgetRefusal) throw new RequestException("TOO_LARGE", TooLarge);
                warnings.Add(BudgetWarning);
                return new CombineOutput(null, warnings);
            }

            combined.Complete();
            return new CombineOutput(combined, warnings);
        }
        finally
        {
            foreach (var pin in pins) pin.Dispose();
        }
    }

    private static string SourceLabel(ResultSetBuffer src) =>
        !string.IsNullOrWhiteSpace(src.TargetLabel) ? src.TargetLabel
        : !string.IsNullOrWhiteSpace(src.TargetKey) ? src.TargetKey
        : "server";

    private static void MeasureCopied(
        PageBuilder builder,
        ColumnLength sourceRule,
        ColumnLength outputRule,
        PageLengths lengths,
        int row,
        int column,
        ReadOnlySpan<byte> span,
        WireKind wire,
        bool cut)
    {
        CellSize size;
        if (lengths.TryCell(row, column, out var kept)) size = new CellSize(kept.Chars, kept.Bytes, kept.Exact && !sourceRule.Estimated);
        else
        {
            size = sourceRule.Derive(span, wire);
            if (cut) size = size with { Exact = false };
        }
        builder.Measure(size.Chars, size.Bytes, keep: sourceRule.Rule == LengthRule.Recorded || !ReferenceEquals(sourceRule, outputRule), exact: size.Exact);
    }

    private static int FormatHex(ReadOnlySpan<byte> bytes, byte[] destination)
    {
        destination[0] = (byte)'0';
        destination[1] = (byte)'x';
        var hex = HexDigits;
        var at = 2;
        foreach (var b in bytes)
        {
            destination[at++] = hex[b >> 4];
            destination[at++] = hex[b & 0x0f];
        }
        return at;
    }

    private sealed class AlignedSlot(string name, int sourceCount)
    {
        public string Name { get; } = name;
        public int[] SourceColumns { get; } = Filled(sourceCount);
        public List<(ResultColumn Column, WireKind Wire, ColumnLength Length)> Members { get; } = [];

        private static int[] Filled(int count)
        {
            var values = new int[count];
            Array.Fill(values, -1);
            return values;
        }
    }

    private sealed record CombinePlan(
        List<AlignedSlot> Slots,
        List<ResultColumn> Columns,
        List<WireKind> Wires,
        List<ColumnLength> Lengths,
        bool HasBinaryToText);

    private static CombinePlan AlignColumns(
        List<(ResultSetBuffer Set, StoredPage[] Pages, string Label)> sources,
        List<string> warnings)
    {
        var slots = new List<AlignedSlot>();
        var slotByKey = new Dictionary<(string Key, int Occurrence), int>();
        var droppedColumns = 0;

        for (var s = 0; s < sources.Count; s++)
        {
            var set = sources[s].Set;
            var occurrences = new Dictionary<string, int>(StringComparer.Ordinal);
            for (var c = 0; c < set.Columns.Count; c++)
            {
                var col = set.Columns[c];
                if (ResultTextWriter.Hidden(col)) continue;
                var nameKey = OrdinalNames.KeyOf(col.Name);
                occurrences.TryGetValue(nameKey, out var occurrence);
                occurrences[nameKey] = occurrence + 1;
                var alignKey = (nameKey, occurrence);
                if (!slotByKey.TryGetValue(alignKey, out var slotIndex))
                {
                    if (slots.Count + 1 >= PageBuilder.MaxColumns)
                    {
                        droppedColumns++;
                        continue;
                    }
                    slotIndex = slots.Count;
                    slots.Add(new AlignedSlot(col.Name, sources.Count));
                    slotByKey[alignKey] = slotIndex;
                }
                slots[slotIndex].SourceColumns[s] = c;
                slots[slotIndex].Members.Add((col, set.Wires[c], set.Lengths[c]));
            }
        }

        var columns = new List<ResultColumn>(slots.Count + 1)
        {
            new(ServerColumnName, "nvarchar(128)", "text", MaxLength: 128, Nullable: false)
        };
        var wires = new List<WireKind>(slots.Count + 1) { WireKind.Text };
        var lengths = new List<ColumnLength>(slots.Count + 1) { ColumnLength.Utf16 };

        var missingColumns = 0;
        var widenedColumns = 0;
        var zonedToTextColumns = 0;
        var hasBinaryToText = false;

        foreach (var slot in slots)
        {
            var missingInSome = slot.Members.Count < sources.Count;
            if (missingInSome) missingColumns++;

            var (column, wire, length, widened, zonedToText, binaryToText) = WidenSlot(slot, missingInSome);
            if (widened) widenedColumns++;
            if (zonedToText) zonedToTextColumns++;
            if (binaryToText) hasBinaryToText = true;

            columns.Add(column);
            wires.Add(wire);
            lengths.Add(length);
        }

        if (missingColumns > 0)
            warnings.Add($"Schema drift: {missingColumns} column(s) were missing on one or more servers and filled with NULL.");
        if (zonedToTextColumns > 0)
            warnings.Add($"Schema drift: {zonedToTextColumns} temporal column(s) mixed zoned and unzoned values and were widened to text.");
        if (widenedColumns > 0)
            warnings.Add($"Schema drift: {widenedColumns} column(s) had differing types across servers and were widened.");
        if (droppedColumns > 0)
            warnings.Add($"Combined result reached the {PageBuilder.MaxColumns.ToString("N0", CultureInfo.InvariantCulture)}-column limit; {droppedColumns} extra column(s) were omitted.");

        return new CombinePlan(slots, columns, wires, lengths, hasBinaryToText);
    }

    private static (ResultColumn Column, WireKind Wire, ColumnLength Length, bool Widened, bool ZonedToText, bool BinaryToText) WidenSlot(
        AlignedSlot slot,
        bool missingInSome)
    {
        var members = slot.Members;
        var first = members[0];
        var anyBinary = false;
        var anyTextWire = false;
        var anyTimestamp = false;
        var anyUnzonedTemporal = false;
        var anyGuid = false;
        var anyNonGuidOther = false;
        var distinctKinds = new HashSet<string>(StringComparer.Ordinal);
        var kind = first.Column.SortKind;

        foreach (var (col, wire, _) in members)
        {
            if (wire == WireKind.Binary) anyBinary = true;
            else anyTextWire = true;
            if (col.SortKind == ColumnTypes.Timestamp) anyTimestamp = true;
            if (ColumnTypes.IsUnzonedTemporal(col.SortKind)) anyUnzonedTemporal = true;
            if (ColumnTypes.IsGuid(col)) anyGuid = true;
            else if (col.SortKind == ColumnTypes.Other) anyNonGuidOther = true;
            distinctKinds.Add(col.SortKind);
            kind = WidenKind(kind, col.SortKind);
        }

        var binaryToText = anyBinary && anyTextWire;
        if (binaryToText) kind = ColumnTypes.Text;
        else if (kind == ColumnTypes.Other && anyGuid && anyNonGuidOther) kind = ColumnTypes.Text;

        var outWire = anyBinary && !anyTextWire ? WireKind.Binary : WireKind.Text;
        var widened = distinctKinds.Count > 1 || binaryToText || (kind == ColumnTypes.Text && anyGuid && anyNonGuidOther);
        var zonedToText = kind == ColumnTypes.Text && anyTimestamp && anyUnzonedTemporal;

        var nullable = missingInSome || members.Any(m => m.Column.Nullable);
        var sameDataType = !widened && members.All(m => string.Equals(m.Column.DataType, first.Column.DataType, StringComparison.OrdinalIgnoreCase));
        var sameRole = !widened && members.All(m => string.Equals(m.Column.Role, first.Column.Role, StringComparison.Ordinal));
        var role = sameRole ? first.Column.Role : null;

        ResultCollation? collation = null;
        if (kind == ColumnTypes.Text && first.Column.Collation is { } firstCollation
            && members.All(m => Equals(m.Column.Collation, firstCollation)))
        {
            collation = firstCollation;
        }

        int? maxLength = null;
        if (!widened && members.All(m => m.Column.MaxLength is > 0))
            maxLength = members.Max(m => m.Column.MaxLength!.Value);

        int? precision = null;
        int? scale = null;
        var bigQueryDecimal = BigQueryDecimalKind.None;
        string dataType;

        if (kind == ColumnTypes.Decimal)
        {
            var maxScale = 0;
            var maxIntPrecision = 0;
            var maxPrecision = 0;
            var anyBigNumeric = false;
            var anyNumeric = false;
            foreach (var (col, _, _) in members)
            {
                var srcScale = ResultPivoter.Scale(col);
                var srcIntPrecision = IntegerPrecision(col, srcScale);
                maxScale = Math.Max(maxScale, srcScale);
                maxIntPrecision = Math.Max(maxIntPrecision, srcIntPrecision);
                if (col.Precision is { } p) maxPrecision = Math.Max(maxPrecision, p);
                if (col.BigQueryDecimal == BigQueryDecimalKind.BigNumeric) anyBigNumeric = true;
                else if (col.BigQueryDecimal == BigQueryDecimalKind.Numeric) anyNumeric = true;
            }

            if (anyBigNumeric || (anyNumeric && (maxScale > 9 || maxIntPrecision > 29)))
                bigQueryDecimal = BigQueryDecimalKind.BigNumeric;
            else if (anyNumeric)
                bigQueryDecimal = BigQueryDecimalKind.Numeric;

            scale = maxScale;
            if (bigQueryDecimal == BigQueryDecimalKind.BigNumeric)
            {
                precision = Math.Clamp(Math.Max(maxIntPrecision + maxScale, Math.Max(maxPrecision, 77)), 1, 77);
                dataType = "BIGNUMERIC";
            }
            else if (bigQueryDecimal == BigQueryDecimalKind.Numeric)
            {
                precision = Math.Clamp(Math.Max(maxIntPrecision + maxScale, Math.Max(maxPrecision, 38)), 1, 38);
                dataType = "NUMERIC";
            }
            else
            {
                precision = Math.Clamp(Math.Max(maxIntPrecision + maxScale, maxPrecision), 1, 38);
                dataType = sameDataType && members.All(m => ResultPivoter.Scale(m.Column) == maxScale && m.Column.Precision == first.Column.Precision)
                    ? first.Column.DataType
                    : $"decimal({precision.Value.ToString(CultureInfo.InvariantCulture)},{maxScale.ToString(CultureInfo.InvariantCulture)})";
            }
        }
        else if (kind == ColumnTypes.Float)
        {
            precision = 53;
            dataType = sameDataType ? first.Column.DataType : "float";
        }
        else if (sameDataType)
        {
            dataType = first.Column.DataType;
            precision = members.All(m => m.Column.Precision == first.Column.Precision) ? first.Column.Precision : null;
            scale = members.All(m => m.Column.Scale == first.Column.Scale) ? first.Column.Scale : null;
        }
        else
        {
            dataType = DefaultDataType(kind);
        }

        ColumnLength outLength;
        if (outWire == WireKind.Binary)
            outLength = ColumnLength.Binary;
        else if (!widened && members.All(m => ReferenceEquals(m.Length, first.Length)))
            outLength = first.Length;
        else
            outLength = ColumnLength.Utf16;

        var column = new ResultColumn(
            slot.Name,
            dataType,
            outWire == WireKind.Binary ? "binary" : "text",
            Role: role,
            MaxLength: maxLength,
            Precision: precision,
            Scale: scale,
            Nullable: nullable,
            Collation: collation)
        {
            SortKind = kind,
            BigQueryDecimal = bigQueryDecimal
        };

        return (column, outWire, outLength, widened, zonedToText, binaryToText);
    }

    internal static string WidenKind(string a, string b)
    {
        if (a == b) return a;
        if (a == ColumnTypes.Boolean && ColumnTypes.IsNumeric(b)) return b;
        if (b == ColumnTypes.Boolean && ColumnTypes.IsNumeric(a)) return a;
        if (ColumnTypes.IsNumeric(a) && ColumnTypes.IsNumeric(b))
        {
            if (a == ColumnTypes.Float || b == ColumnTypes.Float) return ColumnTypes.Float;
            return ColumnTypes.Decimal;
        }
        if ((a == ColumnTypes.Date && b == ColumnTypes.DateTime) || (a == ColumnTypes.DateTime && b == ColumnTypes.Date))
            return ColumnTypes.DateTime;
        // Unzoned date/datetime/time + zoned timestamp MUST widen to text (never timestamp) so no local timezone offset is fabricated.
        return ColumnTypes.Text;
    }

    private static int IntegerPrecision(ResultColumn column, int scale)
    {
        if (column.SortKind == ColumnTypes.Boolean) return 1;
        if (column.SortKind == ColumnTypes.Integer)
        {
            return ColumnTypes.BaseName(column.DataType) switch
            {
                "tinyint" => 3,
                "smallint" => 5,
                "int" => 10,
                _ => 19
            };
        }
        if (column.SortKind == ColumnTypes.Decimal)
        {
            if (column.BigQueryDecimal == BigQueryDecimalKind.BigNumeric)
                return Math.Max(0, (column.Precision ?? 77) - (column.Scale ?? 38));
            if (column.BigQueryDecimal == BigQueryDecimalKind.Numeric)
                return Math.Max(0, (column.Precision ?? 38) - (column.Scale ?? 9));
            if (ColumnTypes.IsMoney(column))
                return ColumnTypes.BaseName(column.DataType) == "smallmoney" ? 6 : 15;
            return Math.Max(0, (column.Precision ?? 38) - scale);
        }
        return 0;
    }

    private static string DefaultDataType(string sortKind) => sortKind switch
    {
        ColumnTypes.Integer => "bigint",
        ColumnTypes.Decimal => "decimal(38,0)",
        ColumnTypes.Float => "float",
        ColumnTypes.Boolean => "bit",
        ColumnTypes.Date => "date",
        ColumnTypes.Time => "time",
        ColumnTypes.DateTime => "datetime2",
        ColumnTypes.Timestamp => "datetimeoffset",
        ColumnTypes.Binary => "varbinary(max)",
        ColumnTypes.Json => "json",
        _ => "nvarchar(max)"
    };
}
