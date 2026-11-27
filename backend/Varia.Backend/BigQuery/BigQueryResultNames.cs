using System.Globalization;

namespace Varia.Backend.BigQuery;

/// <summary>A planned name for one top-level GoogleSQL query statement: its 0-based index among top-level queries (for
/// positional matching when BigQuery omits script stack frames), its 1-based start line and column in the submitted SQL
/// text (matching <c>statistics.scriptStatistics.stackFrames</c>), its editor line, the marker's name and editor line, and
/// any control-flow or dynamic statement before it that blocks positional matching without stack frames.</summary>
internal sealed record BigQueryResultNameSlot(int QueryIndex, int StartLine, int StartColumn, int EditorLine, string Name, int MarkerLine, string? BlockerBefore);

/// <summary>
/// Where a BigQuery query or script's <c>#Name="…"</c> markers go (docs/named-result-sets-scope.md, BigQuery). The user's
/// SQL is never altered: markers stay ordinary comments (<c>--</c>, <c>/* */</c>, <c># #Name="…"</c> or <c>#Name="…"</c>).
/// A script without <c>#name</c> pays only one case-insensitive substring check; one longer than
/// <see cref="ResultNames.MaxParseChars"/> is not split and each valid marker is noted as not applied. Names and SQL are
/// never logged.
/// </summary>
internal sealed class BigQueryResultNamePlan
{
    private BigQueryResultNamePlan(IReadOnlyList<BigQueryResultNameSlot> slots, IReadOnlyList<string> notes, int statementCount,
        IReadOnlyDictionary<(int Line, int Column), int> slotByPosition, IReadOnlyDictionary<int, int> uniqueSlotByLine,
        IReadOnlyDictionary<int, int> slotByQueryIndex)
    {
        Slots = slots;
        Notes = notes;
        StatementCount = statementCount;
        SlotByPosition = slotByPosition;
        UniqueSlotByLine = uniqueSlotByLine;
        SlotByQueryIndex = slotByQueryIndex;
    }

    public IReadOnlyList<BigQueryResultNameSlot> Slots { get; }
    public IReadOnlyList<string> Notes { get; }
    public int StatementCount { get; }
    /// <summary>Whether the submitted text is one top-level query statement with a planned name.</summary>
    public bool SingleQuery => StatementCount == 1 && Slots.Count == 1;
    public IReadOnlyDictionary<(int Line, int Column), int> SlotByPosition { get; }
    /// <summary>Maps a 1-based submitted script line to its slot index only when exactly one top-level query statement
    /// (named or unnamed) starts on that line.</summary>
    public IReadOnlyDictionary<int, int> UniqueSlotByLine { get; }
    /// <summary>Maps a 0-based top-level query index to its slot index only for statements with no control-flow or dynamic
    /// statement before them.</summary>
    public IReadOnlyDictionary<int, int> SlotByQueryIndex { get; }

    /// <summary>Builds a plan for <paramref name="sql"/>, or null when it holds no well-formed <c>#Name</c> marker.</summary>
    public static BigQueryResultNamePlan? Build(string? sql, int sourceStartLine = 1)
    {
        if (string.IsNullOrEmpty(sql) || !sql.Contains("#name", StringComparison.OrdinalIgnoreCase)) return null;
        if (sql.Length > ResultNames.MaxParseChars)
        {
            var oversizedMarkers = GoogleSqlScanner.ScanMarkers(sql, sourceStartLine).Where(marker => marker.Name is not null).ToList();
            if (oversizedMarkers.Count == 0) return null;
            var limit = ResultNames.MaxParseChars.ToString("N0", CultureInfo.InvariantCulture);
            return Refused(oversizedMarkers, $"was not applied: its script is longer than {limit} characters.");
        }
        var scan = GoogleSqlScanner.ScanScript(sql, sourceStartLine);
        var markers = scan.Markers.Where(marker => marker.Name is not null).ToList();
        if (markers.Count == 0) return null;
        if (scan.Unbalanced)
            return Refused(markers, "was not applied: its script could not be parsed cleanly to place it.");

        var statements = scan.Statements;
        var notes = new List<(int Offset, string Text)>();
        var named = new List<ResultMarker>?[statements.Count];
        var next = 0;
        foreach (var marker in markers)
        {
            while (next < statements.Count && statements[next].EndOffset <= marker.Offset) next++;
            if (next == statements.Count)
                notes.Add((marker.Offset, ResultNames.Note(marker, "is unused: no statement follows it in its script.")));
            else if (statements[next].StartOffset < marker.End)
                notes.Add((marker.Offset, ResultNames.Note(marker, IsControlFlowBlock(statements[next].Kind)
                    ? $"was not applied: it is inside {Describe(statements[next])}, where how often a statement runs is not known."
                    : $"was not applied: it is inside {Describe(statements[next])}, not before one.")));
            else (named[next] ??= []).Add(marker);
        }

        // Count every top-level query statement (named or unnamed) per start line so line-only fallback never matches a
        // line shared by two queries (e.g. "SELECT 1; SELECT 2;").
        var queriesOnLine = new Dictionary<int, int>();
        foreach (var statement in statements)
            if (statement.Class == StatementClass.One)
                queriesOnLine[statement.StartLine] = queriesOnLine.GetValueOrDefault(statement.StartLine) + 1;

        var slots = new List<BigQueryResultNameSlot>();
        var byPosition = new Dictionary<(int Line, int Column), int>();
        var uniqueByLine = new Dictionary<int, int>();
        var byQueryIndex = new Dictionary<int, int>();
        var queryIndex = 0;
        string? blocker = null;

        for (var i = 0; i < statements.Count; i++)
        {
            var statement = statements[i];
            var own = named[i];
            if (statement.Class == StatementClass.None)
            {
                if (own is not null)
                    foreach (var marker in own)
                        notes.Add((marker.Offset, ResultNames.Note(marker, "is unused: its statement returns no result set.")));
                continue;
            }
            if (statement.Class == StatementClass.Unknown)
            {
                blocker ??= Describe(statement);
                if (own is not null)
                    foreach (var marker in own)
                        notes.Add((marker.Offset, ResultNames.Note(marker, $"was not applied: {Describe(statement)} may return zero or multiple result sets, so its result set cannot be named unambiguously.")));
                continue;
            }
            if (own is { Count: > 0 })
            {
                // When multiple markers precede the same GoogleSQL query statement, the last marker wins and earlier ones
                // are reported in Messages.
                for (var k = 0; k < own.Count - 1; k++)
                    notes.Add((own[k].Offset, ResultNames.Note(own[k], "is unused: a later name takes its statement's result set.")));
                var winner = own[^1];
                var slotIndex = slots.Count;
                slots.Add(new(queryIndex, statement.StartLine, statement.StartColumn, statement.EditorLine, winner.Name!, winner.Line, blocker));
                byPosition.TryAdd((statement.StartLine, statement.StartColumn), slotIndex);
                if (queriesOnLine.GetValueOrDefault(statement.StartLine) == 1) uniqueByLine[statement.StartLine] = slotIndex;
                if (blocker is null) byQueryIndex[queryIndex] = slotIndex;
            }
            queryIndex++;
        }

        notes.Sort(static (a, b) => a.Offset.CompareTo(b.Offset));
        return new(slots, [.. notes.Select(item => item.Text)], statements.Count, byPosition, uniqueByLine, byQueryIndex);
    }

    private static BigQueryResultNamePlan Refused(IEnumerable<ResultMarker> markers, string what) =>
        new([], [.. markers.Select(marker => ResultNames.Note(marker, what))], 0,
            new Dictionary<(int, int), int>(), new Dictionary<int, int>(), new Dictionary<int, int>());

    private static bool IsControlFlowBlock(string kind) =>
        kind is "IF" or "LOOP" or "WHILE" or "REPEAT" or "FOR" or "BEGIN … END" or "CASE";

    private static string Describe(GoogleSqlStatement statement)
    {
        var article = statement.Kind is "IF" or "INSERT" or "UPDATE" or "EXECUTE IMMEDIATE" ? "an " : "a ";
        var noun = statement.Kind == "statement" ? "a statement" : article + statement.Kind + " statement";
        return noun + " on line " + statement.EditorLine.ToString("N0", CultureInfo.InvariantCulture);
    }
}

/// <summary>
/// One BigQuery execution's runtime binding for <see cref="BigQueryResultNamePlan"/>. For single queries it binds the sole
/// planned name; for scripts it matches child jobs via <c>statistics.scriptStatistics.stackFrames</c>
/// (<c>startLine</c>/<c>startColumn</c>) when present, or safely by top-level query position when stack frames are absent
/// and no control-flow or dynamic statement precedes the query. Any unmatched or ambiguous name stays unnamed and is
/// reported in Messages (bounded by <see cref="ResultNameNotes"/>).
/// </summary>
internal sealed class BigQueryResultNameBinder(BigQueryResultNamePlan plan)
{
    private readonly bool[] applied = new bool[plan.Slots.Count];
    private readonly string?[] refusalReasons = new string?[plan.Slots.Count];
    private readonly List<string> extraNotes = [];
    private bool sawStackFrames;
    private bool stoppedPositional;
    private string? positionalStopReason;
    private int selectChildIndex;
    private int lastSlot = -1;

    /// <summary>Takes the name for a single-result execution (non-script, or a script whose child jobs were not listed).</summary>
    public string? TakeSingle(bool isScript, bool listingFailed = false, bool noChildren = false)
    {
        lastSlot = -1;
        if (plan.SingleQuery && !isScript)
        {
            applied[0] = true;
            lastSlot = 0;
            return plan.Slots[0].Name;
        }
        var reason = listingFailed ? "Varia could not list the script's statements to match result sets"
            : noChildren || isScript || plan.StatementCount > 1 ? "BigQuery returned no child jobs for the script, so its statements could not be matched"
            : "its result set could not be matched unambiguously";
        for (var i = 0; i < refusalReasons.Length; i++)
            if (!applied[i]) refusalReasons[i] ??= reason;
        return null;
    }

    /// <summary>Marks a single query's planned name as consumed when results were intentionally discarded.</summary>
    public void DiscardSingle(bool isScript)
    {
        if (plan.SingleQuery && !isScript) applied[0] = true;
    }

    /// <summary>Matches one finished SELECT child job of a BigQuery script and returns its name, or null when unnamed or
    /// ambiguous. With <paramref name="discarded"/> true, consumes the slot without returning a name.</summary>
    public string? TakeChild(BigQueryChild child, bool incompleteListing, bool discarded = false)
    {
        lastSlot = -1;
        if (child.ScriptFrameCount > 0)
        {
            sawStackFrames = true;
            // Nested frames (stored procedures, EXECUTE IMMEDIATE) and expression evaluations are not direct top-level queries.
            if (child.ScriptFrameCount > 1 || child.InProcedure || string.Equals(child.ScriptEvaluationKind, "EXPRESSION", StringComparison.OrdinalIgnoreCase))
                return null;
            if (child.ScriptStartLine is not { } line) return null;
            int slotIndex;
            if (child.ScriptStartColumn is { } col && plan.SlotByPosition.TryGetValue((line, col), out slotIndex)) { }
            else if (plan.UniqueSlotByLine.TryGetValue(line, out slotIndex)) { }
            else return null;
            if (applied[slotIndex])
            {
                extraNotes.Add(Note(plan.Slots[slotIndex], "was not applied to a repeated execution of its statement."));
                return null;
            }
            applied[slotIndex] = true;
            lastSlot = slotIndex;
            return discarded ? null : plan.Slots[slotIndex].Name;
        }

        // No stackFrames on this child (e.g. emulator or minimal fake): fall back to positional matching only when no
        // stack-framed child was seen, the listing is complete, and no control-flow blocker preceded the statement.
        var ordinal = selectChildIndex++;
        if (sawStackFrames) return null;
        if (incompleteListing)
        {
            StopPositional("Varia could not list all of the script's statements");
            return null;
        }
        if (stoppedPositional) return null;
        if (!plan.SlotByQueryIndex.TryGetValue(ordinal, out var positionalSlot)) return null;
        if (applied[positionalSlot]) return null;
        applied[positionalSlot] = true;
        lastSlot = positionalSlot;
        return discarded ? null : plan.Slots[positionalSlot].Name;
    }

    /// <summary>Marks a SELECT child whose set was refused (MaxResultSets) so positional counts stay aligned and its planned
    /// name receives a note.</summary>
    public void RefusedChild(BigQueryChild child, bool incompleteListing, string reason)
    {
        TakeChild(child, incompleteListing, discarded: false);
        RefusedLast(reason);
    }

    /// <summary>Undoes the name just taken (store budget or result-set cap refused the set) so Messages explains why.</summary>
    public void RefusedLast(string reason)
    {
        if (lastSlot < 0) return;
        applied[lastSlot] = false;
        refusalReasons[lastSlot] = reason;
        lastSlot = -1;
    }

    /// <summary>Records a child failure, stopping positional matching for any later children.</summary>
    public void NoteChildError() => StopPositional("an error earlier in its script made the place of its result set unknown");

    public void StopPositional(string reason)
    {
        stoppedPositional = true;
        positionalStopReason ??= reason;
    }

    /// <summary>Notes for planned names that no result set took, plus any runtime warnings (such as repeated execution).</summary>
    public IEnumerable<string> Unapplied(string? runEndedReason = null, bool script = false, bool listedAll = true, bool listingFailed = false, bool hasChildren = false)
    {
        foreach (var note in extraNotes) yield return note;
        for (var i = 0; i < plan.Slots.Count; i++)
        {
            if (applied[i]) continue;
            var slot = plan.Slots[i];
            var reason = refusalReasons[i]
                ?? runEndedReason
                ?? (script && listingFailed ? "Varia could not list the script's statements to match result sets" : null)
                ?? (script && !hasChildren ? "BigQuery returned no child jobs for the script, so its statements could not be matched" : null)
                ?? (script && !listedAll ? "Varia could not list all of the script's statements" : null)
                ?? (script && !sawStackFrames && slot.BlockerBefore is { } blocker ? $"{blocker} before it returns an unknown number of result sets, and BigQuery did not report script stack frames" : null)
                ?? positionalStopReason;
            yield return reason is not null
                ? Note(slot, "was not applied: " + reason + ".")
                : Note(slot, "is unused: its statement returned no result set.");
        }
    }

    private static string Note(BigQueryResultNameSlot slot, string what) =>
        $"Result name \"{slot.Name}\" (line {slot.MarkerLine.ToString("N0", CultureInfo.InvariantCulture)}) {what}";
}
