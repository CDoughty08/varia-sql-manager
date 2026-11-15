using System.Data.Common;
using System.Globalization;
using System.Text;
using Microsoft.SqlServer.TransactSql.ScriptDom;
using Varia.Backend.Results;

namespace Varia.Backend;

/// <summary>A #Name marker comment SqlScript found: the comment's offsets (relative to its batch's text once batched), the
/// script line of the marker, and the name, or null for a malformed marker, which names nothing.</summary>
internal sealed record ResultMarker(int Offset, int End, int Line, string? Name);

/// <summary>How many result sets a top-level statement returns, as far as its text says (docs/named-result-sets-scope.md,
/// Binding rule).</summary>
internal enum StatementClass { None, One, Unknown }

/// <summary>A name the plan puts on the set at <paramref name="Position"/> (counted over the batch execution's sets with
/// columns, plans left out). Exact: the set is the first of a statement that returns exactly one; otherwise the statement
/// returns an unknown number and <paramref name="First"/> is the position of its first set.</summary>
internal sealed record ResultNameSlot(int Position, string Name, int Line, bool Exact, int First);

/// <summary>
/// Named result sets: a query names a result set with a marker comment, <c>/* #Name="Open orders" */</c> or
/// <c>-- #Name="Open orders"</c>, before its statement (docs/named-result-sets-scope.md). The user's SQL is never changed: the
/// markers are comments to the server either way. A batch with a marker is parsed once by ScriptDom, before it runs however
/// often GO n repeats it, and each top-level statement is classed by how many sets it returns; a name is put on a set only
/// where its place among the batch's sets is known, and Messages says why when it is not. Names and SQL are never logged.
/// </summary>
internal static class ResultNames
{
    /// <summary>The longest name, a query tab name's length (tabNameChars); the descriptor's zod schema holds the same.</summary>
    public const int MaxChars = 128;
    /// <summary>A longer batch is not parsed and its names are reported as not applied. A 262,144-character batch of 1,289
    /// statements parsed in 170 to 250 ms when this was set (PR 1's measurement).</summary>
    public const int MaxParseChars = 262_144;
    /// <summary>ScriptDom's parse time grows faster than linearly with nested parentheses (4,000 levels 110 ms, 30,000 levels
    /// 2.7 s, 130,000 levels two minutes) and its recursion overflows the stack, which ends the process. SQL Server itself
    /// refuses far shallower nesting, so a deeper batch is not parsed.</summary>
    public const int MaxParenDepth = 128;
    /// <summary>Notes about names per run; the rest are counted in one line.</summary>
    public const int MaxNotes = 20;
    /// <summary>The parse runs on a thread of its own with this much stack reserved (committed only as used): a long chain of
    /// AND, + or ELSE IF within MaxParseChars recurses deeper than a thread pool thread's stack allows.</summary>
    private const int ParseStackBytes = 256 * 1024 * 1024;

    /// <summary>C0 and C1 controls, line and paragraph separators, bidirectional marks, embeddings, overrides and isolates,
    /// and the BOM: a marker whose name holds one is malformed (the zod schema's refusedResultNameChars).</summary>
    public static bool IsRefused(char value) => value is <= (char)0x1f or (>= (char)0x7f and <= (char)0x9f) or (char)0x061c or (char)0x200e or (char)0x200f
        or (char)0x2028 or (char)0x2029 or (>= (char)0x202a and <= (char)0x202e) or (>= (char)0x2066 and <= (char)0x2069) or (char)0xfeff;

    /// <summary>Whether a comment's text (without its delimiters) is a marker: <c>#Name</c> in any case, white space, <c>=</c>,
    /// white space, a double-quoted name with doubled quotes inside, and nothing else but white space. False: an ordinary
    /// comment. True with a null name: a malformed marker (no closing quote, text after it, empty, too long, a refused
    /// character other than a tab). The name is trimmed and its runs of white space, tabs included, become one space.</summary>
    public static bool TryMarker(ReadOnlySpan<char> comment, out string? name)
    {
        name = null;
        var text = comment.Trim();
        // "#Names" or "#name_list" is a temporary table's name in commented-out SQL, not a marker.
        if (text.Length < 5 || text[0] != '#' || !text[1..5].Equals("name", StringComparison.OrdinalIgnoreCase) || text.Length > 5 && IsNamePart(text[5])) return false;
        var at = Skip(text, 5);
        if (at >= text.Length || text[at] != '=') return true;
        at = Skip(text, at + 1);
        if (at >= text.Length || text[at] != '"') return true;
        // Collapsed as it is read (leading white space dropped, each run one space), so the bound is the name's own length
        // however much white space the quotes hold, and reading stops once the name is too long.
        var collapsed = new StringBuilder(MaxChars + 2);
        for (at++; ; at++)
        {
            if (at >= text.Length) return true;
            var c = text[at];
            if (c == '"')
            {
                if (at + 1 >= text.Length || text[at + 1] != '"') break;
                at++;
            }
            // A tab is white space like any other; every other refused character makes the marker malformed.
            else if (c != (char)0x09 && IsRefused(c)) return true;
            if (!char.IsWhiteSpace(c)) collapsed.Append(c);
            else if (collapsed.Length > 0 && collapsed[^1] != ' ') collapsed.Append(' ');
            // One more than the bound may be a trailing space, trimmed below.
            if (collapsed.Length > MaxChars + 1) return true;
        }
        // The text was trimmed, so the closing quote must end it.
        if (at != text.Length - 1) return true;
        if (collapsed.Length > 0 && collapsed[^1] == ' ') collapsed.Length--;
        if (collapsed.Length is 0 or > MaxChars) return true;
        name = collapsed.ToString();
        return true;

        static int Skip(ReadOnlySpan<char> text, int at)
        {
            while (at < text.Length && char.IsWhiteSpace(text[at])) at++;
            return at;
        }
    }

    /// <summary>The option a SET statement turns on or off that makes SQL Server skip statements without an error, or null.</summary>
    internal static string? SkipsStatements(PredicateSetStatement statement) =>
        (statement.Options & SetOptions.NoExec) != 0 ? "NOEXEC" : (statement.Options & SetOptions.ParseOnly) != 0 ? "PARSEONLY" : (statement.Options & SetOptions.FmtOnly) != 0 ? "FMTONLY" : null;

    private static bool IsNamePart(char value) => char.IsLetterOrDigit(value) || value is '_' or '@' or '#' or '$';

    /// <summary>A statement's class, the column count of a One statement's set when its text says it (null with a * or a FOR
    /// clause), and the words Messages names it by.</summary>
    internal static (StatementClass Class, int? Columns, string Kind) Classify(TSqlStatement statement)
    {
        switch (statement)
        {
            case SelectStatement select:
                if (select.Into is not null || select.ComputeClauses?.Count > 0) return (select.Into is not null ? StatementClass.None : StatementClass.Unknown, null, "SELECT");
                var first = First(select.QueryExpression);
                if (first?.SelectElements.Any(element => element is SelectSetVariable) == true) return (StatementClass.None, null, "SELECT");
                int? columns = first is null || select.QueryExpression.ForClause is not null || first.SelectElements.Any(element => element is SelectStarExpression)
                    ? null : first.SelectElements.Count;
                return (StatementClass.One, columns, "SELECT");
            case InsertStatement insert: return Dml(insert.InsertSpecification, "INSERT");
            case UpdateStatement update: return Dml(update.UpdateSpecification, "UPDATE");
            case DeleteStatement delete: return Dml(delete.DeleteSpecification, "DELETE");
            case MergeStatement merge: return Dml(merge.MergeSpecification, "MERGE");
            case ExecuteStatement: return (StatementClass.Unknown, null, "EXEC");
            case IfStatement: return (StatementClass.Unknown, null, "IF");
            case WhileStatement: return (StatementClass.Unknown, null, "WHILE");
            case BeginEndBlockStatement: return (StatementClass.Unknown, null, "BEGIN … END");
            case TryCatchStatement: return (StatementClass.Unknown, null, "TRY … CATCH");
            // While NOEXEC, PARSEONLY or FMTONLY is on, SQL Server skips statements (or runs them differently) without an error,
            // and an OFF in a batch may end an ON from an earlier batch or run: no set's place in such a batch is known.
            case PredicateSetStatement predicate when SkipsStatements(predicate) is { } option: return (StatementClass.Unknown, null, "SET " + option);
            // Statements that never return a set: an error one raises stops binding at run time, as any error does.
            case SetOnOffStatement or DeclareVariableStatement or DeclareTableVariableStatement or DeclareCursorStatement or UseStatement or PrintStatement
                or BeginTransactionStatement or CommitTransactionStatement or RollbackTransactionStatement or SaveTransactionStatement
                or TruncateTableStatement or RaiseErrorStatement or ThrowStatement or ReturnStatement
                or OpenCursorStatement or CloseCursorStatement or DeallocateCursorStatement or GrantStatement or DenyStatement or RevokeStatement
                or ExecuteAsStatement or RevertStatement:
                return (StatementClass.None, null, "statement");
            case FetchCursorStatement fetch: return (fetch.IntoVariables.Count > 0 ? StatementClass.None : StatementClass.Unknown, null, "FETCH");
            case WaitForStatement wait: return (wait.Statement is null ? StatementClass.None : StatementClass.Unknown, null, "WAITFOR");
        }
        // SET in all its forms (SET NOCOUNT, SET @v = …, SET STATISTICS XML ON) and DDL (CREATE, ALTER, DROP).
        var type = statement.GetType().Name;
        if (type.StartsWith("Set", StringComparison.Ordinal) || type.StartsWith("Create", StringComparison.Ordinal) || type.StartsWith("Alter", StringComparison.Ordinal)
            || type.StartsWith("Drop", StringComparison.Ordinal)) return (StatementClass.None, null, "statement");
        return (StatementClass.Unknown, null, "statement");

        static (StatementClass, int?, string) Dml(DataModificationSpecification specification, string kind) => specification.OutputClause is { } output
            ? (StatementClass.One, output.SelectColumns.Any(column => column is SelectStarExpression) ? null : output.SelectColumns.Count, kind)
            : (StatementClass.None, null, kind);

        static QuerySpecification? First(QueryExpression? expression) => expression switch
        {
            QuerySpecification specification => specification,
            BinaryQueryExpression binary => First(binary.FirstQueryExpression),
            QueryParenthesisExpression parenthesis => First(parenthesis.QueryExpression),
            _ => null
        };
    }

    /// <summary>Runs a parse and the walks over its tree on a thread with a large stack; the caller may stop waiting (the work
    /// then finishes by itself).</summary>
    internal static Task<T> OnParseThreadAsync<T>(Func<T> work)
    {
        var done = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
        var thread = new Thread(() =>
        {
            try { done.SetResult(work()); }
            catch (Exception error) { done.SetException(error); }
        }, ParseStackBytes) { IsBackground = true, Name = "Varia result names" };
        thread.Start();
        return done.Task;
    }

    private static string Quote(string name) => "\"" + name + "\"";
    private static string Number(int value) => value.ToString("N0", CultureInfo.InvariantCulture);
    internal static string Note(ResultMarker marker, string what) => $"Result name {Quote(marker.Name!)} (line {Number(marker.Line)}) {what}";
    internal static string Note(ResultNameSlot slot, string what, int repetition = 0) =>
        $"Result name {Quote(slot.Name)} (line {Number(slot.Line)}{(repetition > 0 ? ", repetition " + Number(repetition) : "")}) {what}";
    /// <summary>The note for a marker in a run of comments that is no batch.</summary>
    internal static string Unbatched(ResultMarker marker) => Note(marker, "is unused: no statement follows it in its batch.");
}

/// <summary>Where a batch's names go, worked out once before the batch first runs: the named positions, the column count each
/// known position's set must have, and the notes for names that cannot be applied, which Messages shows.</summary>
internal sealed class ResultNamePlan
{
    private ResultNamePlan(IReadOnlyList<ResultNameSlot> slots, IReadOnlyDictionary<int, int> columns, IReadOnlyList<string> notes, IReadOnlySet<int>? unsized = null)
    {
        Unsized = unsized ?? new HashSet<int>();
        Slots = slots;
        SlotAt = Enumerable.Range(0, slots.Count).ToDictionary(index => slots[index].Position);
        Columns = columns;
        Notes = notes;
    }

    public IReadOnlyList<ResultNameSlot> Slots { get; }
    /// <summary>The index in <see cref="Slots"/> of the slot at each named place (no two slots share one).</summary>
    public IReadOnlyDictionary<int, int> SlotAt { get; }
    public IReadOnlyDictionary<int, int> Columns { get; }
    /// <summary>The places of One statements whose column count the text does not say (a *, a FOR clause): a set from a table
    /// with SQL Server's plan column can arrive there and be shown as a plan, though the parse counts it.</summary>
    public IReadOnlySet<int> Unsized { get; }
    public IReadOnlyList<string> Notes { get; }

    /// <summary>The plan for a batch; null when it holds no well-formed marker, in which case it is not parsed.</summary>
    /// <param name="sourceStartLine">The submitted text's first line (a selection's), as SqlScript.Parse was given it.</param>
    public static async Task<ResultNamePlan?> BuildAsync(SqlBatch batch, int sourceStartLine, CancellationToken token)
    {
        var markers = batch.Markers?.Where(marker => marker.Name is not null).ToList();
        if (markers is not { Count: > 0 }) return null;
        if (batch.Sql.Length > ResultNames.MaxParseChars)
            return Refused(markers, $"was not applied: its batch is longer than {ResultNames.MaxParseChars.ToString("N0", CultureInfo.InvariantCulture)} characters.");
        if (batch.ParenDepth > ResultNames.MaxParenDepth)
            return Refused(markers, "was not applied: its batch nests parentheses too deeply to place it.");
        // A set in that column is shown as a plan and left out of the count, though the parse counts its SELECT: every later
        // set would take the name before it. The text is searched, so a dynamic SQL string that selects one counts too.
        if (batch.Sql.Contains(ColumnPlan.ShowplanColumn, StringComparison.OrdinalIgnoreCase))
            return Refused(markers, $"was not applied: its batch names a column \"{ColumnPlan.ShowplanColumn}\", whose sets are shown as plans and not counted.");
        // Before the parse as well as while waiting: a parse can finish before WaitAsync looks at the token.
        token.ThrowIfCancellationRequested();
        var firstLine = sourceStartLine + batch.StartLine - 1;
        // The parse and the walk over its tree (which recurses as deeply) both run on the parse thread's large stack. A
        // failure inside ScriptDom costs the batch its names, never the run.
        ResultNamePlan? plan;
        try
        {
            plan = await ResultNames.OnParseThreadAsync(() =>
            {
                using var reader = new StringReader(batch.Sql);
                var fragment = new TSql180Parser(initialQuotedIdentifiers: true).Parse(reader, out var errors);
                return errors.Count > 0 || fragment is not TSqlScript script ? null : Build(script.Batches.SelectMany(parsed => parsed.Statements).ToList(), markers, firstLine);
            }).WaitAsync(token).ConfigureAwait(false);
        }
        catch (Exception error) when (error is not OperationCanceledException) { plan = null; }
        return plan ?? new([], new Dictionary<int, int>(), [$"Result names in the batch starting on line {firstLine.ToString("N0", CultureInfo.InvariantCulture)} were not applied: the batch does not parse."]);
    }

    /// <summary>The binding rule over a parsed batch's top-level statements (docs/named-result-sets-scope.md, Binding rule).</summary>
    internal static ResultNamePlan Build(IReadOnlyList<TSqlStatement> statements, IReadOnlyList<ResultMarker> markers, int firstLine)
    {
        var notes = new List<string>();
        var slots = new List<ResultNameSlot>();
        var columns = new Dictionary<int, int>();
        var unsized = new HashSet<int>();
        var classes = statements.Select(ResultNames.Classify).ToList();
        int Line(TSqlStatement statement) => firstLine + statement.StartLine - 1;
        string At(int index) => (classes[index].Kind == "statement" ? "a statement" : (classes[index].Kind is "IF" or "INSERT" or "UPDATE" or "EXEC" ? "an " : "a ") + classes[index].Kind + " statement")
            + " on line " + Line(statements[index]).ToString("N0", CultureInfo.InvariantCulture);
        // A batch that turns NOEXEC, PARSEONLY or FMTONLY on or off anywhere, in an IF or BEGIN … END too: the option outlives
        // the batch, so a GO n repetition or a later batch or run may start with statements skipped without an error, until
        // an OFF lets a later statement's set arrive in an earlier one's place. No name in such a batch is applied.
        var skips = new SkippingSetFinder();
        foreach (var statement in statements)
        {
            statement.Accept(skips);
            if (skips.Found is not null) break;
        }
        if (skips.Found is { } found)
            return Refused(markers, $"was not applied: a SET {ResultNames.SkipsStatements(found)} statement on line {(firstLine + found.StartLine - 1).ToString("N0", CultureInfo.InvariantCulture)} in its batch can make SQL Server skip statements without an error. Put the SET statement in a batch of its own.");
        // The markers before each statement, in order; a marker inside a statement or after the last names nothing.
        var named = new List<ResultMarker>?[statements.Count];
        // Where a statement's own text ends: ScriptDom gives a statement the semicolons after it, ";WITH"'s included, so a marker
        // before ";WITH" would be inside the statement before.
        static int End(TSqlStatement statement)
        {
            var tokens = statement.ScriptTokenStream;
            var last = statement.LastTokenIndex;
            while (tokens is not null && last > statement.FirstTokenIndex && tokens[last].TokenType is TSqlTokenType.Semicolon or TSqlTokenType.WhiteSpace
                or TSqlTokenType.SingleLineComment or TSqlTokenType.MultilineComment) last--;
            return tokens is null || last < 0 ? statement.StartOffset + statement.FragmentLength : tokens[last].Offset + tokens[last].Text.Length;
        }
        // Markers and statements are both in text order, so one pass places them all.
        var next = 0;
        foreach (var marker in markers)
        {
            while (next < statements.Count && End(statements[next]) <= marker.Offset) next++;
            if (next == statements.Count) notes.Add(ResultNames.Note(marker, "is unused: no statement follows it in its batch."));
            else if (statements[next].StartOffset < marker.End)
                notes.Add(ResultNames.Note(marker, classes[next].Kind is "IF" or "WHILE" or "BEGIN … END" or "TRY … CATCH"
                    ? $"was not applied: it is inside {At(next)}, where how often a statement runs is not known."
                    : $"was not applied: it is inside {At(next)}, not before one."));
            else (named[next] ??= []).Add(marker);
        }
        var position = 0;
        int? blocker = null;
        for (var index = 0; index < statements.Count; index++)
        {
            var (kind, count, _) = classes[index];
            var own = named[index] ?? [];
            if (blocker is { } before)
            {
                foreach (var marker in own)
                    notes.Add(ResultNames.Note(marker, $"was not applied: {At(before)} before it returns an unknown number of result sets. Put GO between them."));
                continue;
            }
            if (kind == StatementClass.None)
            {
                foreach (var marker in own) notes.Add(ResultNames.Note(marker, "is unused: its statement returns no result set."));
                continue;
            }
            if (kind == StatementClass.One)
            {
                if (count is { } known) columns[position] = known;
                else unsized.Add(position);
                if (own.Count > 0) slots.Add(new(position, own[0].Name!, own[0].Line, true, position));
                foreach (var marker in own.Skip(1)) notes.Add(ResultNames.Note(marker, "is unused: its statement returns one result set, which an earlier name takes."));
                position++;
                continue;
            }
            // Unknown: its first set is at a known place, but which later sets are its own is known only when no statement
            // after it in the batch can return one.
            blocker = index;
            if (own.Count == 0) continue;
            var later = Enumerable.Range(index + 1, statements.Count - index - 1).FirstOrDefault(next => classes[next].Class != StatementClass.None, -1);
            if (later >= 0)
            {
                foreach (var marker in own)
                    notes.Add(ResultNames.Note(marker, $"was not applied: {At(later)} after it may also return result sets, so which are its own cannot be known. Put GO after its statement."));
                continue;
            }
            for (var k = 0; k < own.Count; k++) slots.Add(new(position + k, own[k].Name!, own[k].Line, false, position));
        }
        return new(slots, columns, notes, unsized);
    }

    private static ResultNamePlan Refused(IEnumerable<ResultMarker> markers, string what) => new([], new Dictionary<int, int>(), [.. markers.Select(marker => ResultNames.Note(marker, what))]);
}

/// <summary>The first SET NOEXEC, PARSEONLY or FMTONLY statement in a statement, however deeply nested.</summary>
internal sealed class SkippingSetFinder : TSqlFragmentVisitor
{
    public PredicateSetStatement? Found { get; private set; }

    public override void Visit(PredicateSetStatement node)
    {
        if (Found is null && ResultNames.SkipsStatements(node) is not null) Found = node;
    }
}

/// <summary>One batch execution's binding: counts its sets with columns (plans left out) and names those the plan placed,
/// until something makes the count untrustworthy: an error (a statement that fails returns no set, so every count after it
/// may be one off), a set with another column count than its statement selects, or SHOWPLAN or STATISTICS PROFILE text.</summary>
internal sealed class ResultNameBinder(ResultNamePlan plan)
{
    private readonly bool[] applied = new bool[plan.Slots.Count];
    private int position;
    private int lastApplied = -1;
    private string? stopped;

    /// <summary>The name for the set the reader is on, or null; call once for every set with columns.</summary>
    /// <param name="errored">An error was raised in this batch execution before the set arrived.</param>
    public string? Take(DbDataReader reader, bool isPlan, bool errored) => Take(reader.FieldCount, !isPlan && IsShowplanText(reader), isPlan, errored);

    /// <summary><see cref="Take(DbDataReader, bool, bool)"/> from what it reads of the set.</summary>
    internal string? Take(int fieldCount, bool showplanText, bool isPlan, bool errored)
    {
        lastApplied = -1;
        // A plan is left out of the count, but one at a place where a SELECT * may have returned a set in the plan column
        // may be that SELECT's own set: the places after it are then unknown.
        if (isPlan)
        {
            if (stopped is null && plan.Unsized.Contains(position))
                stopped = "a result set shown as an execution plan arrived where a statement with * may have returned it, so the place of its result set is unknown";
            return null;
        }
        if (stopped is null && errored) stopped = "an error earlier in its batch made the place of its result set unknown";
        if (stopped is null && showplanText) stopped = "SHOWPLAN or STATISTICS PROFILE output in its batch made the place of its result set unknown";
        var at = position++;
        if (stopped is not null) return null;
        if (plan.Columns.TryGetValue(at, out var columns) && columns != fieldCount)
        {
            stopped = "a result set arrived that its batch's statements do not select (a trigger's, or STATISTICS PROFILE output), so the place of its result set is unknown";
            return null;
        }
        if (!plan.SlotAt.TryGetValue(at, out var slot)) return null;
        applied[slot] = true;
        lastApplied = slot;
        return plan.Slots[slot].Name;
    }

    /// <summary>No later set of the batch execution is named (they are not kept).</summary>
    public void Stop(string reason) => stopped ??= reason;

    /// <summary>The result budget refused the set just taken: its name was not applied, and no later set is kept.</summary>
    public void Refused()
    {
        if (lastApplied >= 0) applied[lastApplied] = false;
        lastApplied = -1;
        Stop("result memory kept no more result sets");
    }

    /// <summary>The notes for this execution's names that no set took.</summary>
    /// <param name="ended">Why the batch execution ended early (a cancel, or an error that ends the script), if it did.</param>
    /// <param name="repetition">The GO n repetition (0 when the batch runs once), which its notes name: another may have applied the name.</param>
    public IEnumerable<string> Unapplied(bool errored, string? ended = null, int repetition = 0)
    {
        var reason = stopped ?? ended ?? (errored ? "an error earlier in its batch made the place of its result set unknown" : null);
        // The statements (by their first set's place) that some name was applied to: one pass, however many names.
        var reached = new HashSet<int>();
        for (var i = 0; i < applied.Length; i++)
            if (applied[i]) reached.Add(plan.Slots[i].First);
        for (var i = 0; i < applied.Length; i++)
        {
            if (applied[i]) continue;
            var slot = plan.Slots[i];
            var some = reached.Contains(slot.First);
            yield return ResultNames.Note(slot, reason is not null ? "was not applied: " + reason + "."
                : some ? "is unused: its statement returned fewer result sets than there are names." : "is unused: its statement returned no result set.", repetition);
        }
    }

    /// <summary>The notes for a batch's names in repetitions the run ended before (first to last, 1-based; 1 to 1 when it
    /// runs once and never ran).</summary>
    internal static IEnumerable<string> Unrun(ResultNamePlan plan, int first, int last, bool repeated) =>
        plan.Slots.Select(slot => ResultNames.Note(slot, "was not applied: the run ended before "
            + (!repeated ? "its batch ran." : first == last ? $"repetition {first.ToString("N0", CultureInfo.InvariantCulture)} ran." : $"repetitions {first.ToString("N0", CultureInfo.InvariantCulture)} to {last.ToString("N0", CultureInfo.InvariantCulture)} ran.")));

    /// <summary>SHOWPLAN_TEXT and SHOWPLAN_ALL sets start with StmtText, STATISTICS PROFILE's with Rows, Executes, StmtText: each
    /// statement then adds sets the parse cannot count.</summary>
    internal static bool IsShowplanText(DbDataReader reader) =>
        reader.FieldCount >= 1 && reader.GetName(0).Equals("StmtText", StringComparison.OrdinalIgnoreCase)
        || reader.FieldCount >= 3 && reader.GetName(0).Equals("Rows", StringComparison.OrdinalIgnoreCase) && reader.GetName(1).Equals("Executes", StringComparison.OrdinalIgnoreCase)
            && reader.GetName(2).Equals("StmtText", StringComparison.OrdinalIgnoreCase);
}

/// <summary>A run's notes about names: informational lines in Messages, never errors, each once, at most MaxNotes with a
/// count of the rest.</summary>
internal sealed class ResultNameNotes(Action<string> add)
{
    private readonly HashSet<string> seen = new(StringComparer.Ordinal);
    private int suppressed;
    private const int MaxCounted = 4096;

    /// <summary>The notes kept to tell repeats, at most <see cref="ResultNames.MaxNotes"/> + 4,096.</summary>
    internal int Kept => seen.Count;

    public void Add(string note)
    {
        // Past the cap a note is counted; only the first few thousand are kept to tell repeats, since a GO n run can make
        // millions of distinct ones (past that, a repeat may be counted twice).
        if (seen.Count < ResultNames.MaxNotes) { if (seen.Add(note)) add(note); return; }
        if (seen.Contains(note)) return;
        if (seen.Count < ResultNames.MaxNotes + MaxCounted) seen.Add(note);
        suppressed++;
    }

    public void Finish()
    {
        if (suppressed > 0) add($"… and {suppressed.ToString("N0", CultureInfo.InvariantCulture)} more notes about result names.");
        suppressed = 0;
    }
}
