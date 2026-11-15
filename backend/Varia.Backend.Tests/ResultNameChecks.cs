using System.Data;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.SqlServer.TransactSql.ScriptDom;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>Named result sets with no server (docs/named-result-sets-scope.md): the marker scan, the statement classes and
/// the binding rule over the shared cases in tests/fixtures/result-names, the bounds, the notes' cap and the descriptor's
/// name. ResultNameLiveChecks runs the rules that need a server.</summary>
internal static class ResultNameChecks
{
    public static async Task RunAsync(Action<bool, string> check)
    {
        var folder = Path.Combine(GoldenText.Repository(), "tests", "fixtures", "result-names");
        Markers(check, Cases(folder, "markers.json"));
        Classes(check, Cases(folder, "classes.json"));
        await BindingAsync(check, Cases(folder, "binding.json"));
        await BoundsAsync(check);
        Notes(check);
        Readers(check);
        Descriptor(check);
    }

    private static JsonArray Cases(string folder, string file) => JsonNode.Parse(File.ReadAllText(Path.Combine(folder, file)))!["cases"]!.AsArray();

    private static string Show(ResultMarker marker) => marker.Line + ":" + (marker.Name is null ? "malformed" : "\"" + marker.Name + "\"");

    private static void Markers(Action<bool, string> check, JsonArray cases)
    {
        var differences = new List<string>();
        foreach (var item in cases)
        {
            var unbatched = new List<ResultMarker>();
            var batches = SqlScript.Parse((string)item!["sql"]!, (int?)item["startLine"] ?? 1, unbatched);
            var found = string.Join(" ", batches.SelectMany(batch => batch.Markers ?? []).Concat(unbatched).OrderBy(marker => marker.Line).Select(Show));
            var expected = string.Join(" ", item["markers"]!.AsArray().Select(marker => Show(new(0, 0, (int)marker!["line"]!, (string?)marker["name"]))));
            if (found != expected) differences.Add((string)item["name"]! + " gave [" + found + "], not [" + expected + "]");
        }
        check(cases.Count >= 30 && differences.Count == 0, "the marker scan finds each case's markers in tests/fixtures/result-names/markers.json: " + string.Join("; ", differences));
        // The refused characters, held to the ranges the descriptor schema's test reads too (tests/result-name-descriptor.test.ts).
        var refusedPath = Path.Combine(GoldenText.Repository(), "tests", "fixtures", "result-names", "refused.json");
        var ranges = JsonNode.Parse(File.ReadAllText(refusedPath))!["ranges"]!.AsArray().Select(range => ((int)range![0]!, (int)range[1]!)).ToList();
        var differ = Enumerable.Range(0, 0x10000).Where(code => ResultNames.IsRefused((char)code) != ranges.Any(range => code >= range.Item1 && code <= range.Item2)).ToList();
        check(ranges.Count > 0 && differ.Count == 0, "ResultNames.IsRefused refuses exactly the code units in tests/fixtures/result-names/refused.json: " + string.Join(", ", differ.Take(8).Select(code => code.ToString("x4"))));
        // A batch's marker offsets are its own text's, so the comment they point at is in the batch as the server gets it.
        var script = "SELECT 1 AS a;\nGO\n/* #Name=\"Second\" */\nSELECT 2 AS b;";
        var second = SqlScript.Parse(script)[1];
        check(second.Markers is [var marker] && second.Sql[marker.Offset..marker.End] == "/* #Name=\"Second\" */" && second.Sql == "/* #Name=\"Second\" */\nSELECT 2 AS b;",
            "a marker's offsets are relative to its batch, whose text is the user's, unchanged");
        check(SqlScript.Parse("SELECT 1 AS a; -- a comment\n/* another */").Single().Markers is { Count: 0 }, "a batch without a marker has no markers");
    }

    private static void Classes(Action<bool, string> check, JsonArray cases)
    {
        var differences = new List<string>();
        foreach (var item in cases)
        {
            var sql = (string)item!["sql"]!;
            var parsed = (TSqlScript)new TSql180Parser(initialQuotedIdentifiers: true).Parse(new StringReader(sql), out var errors);
            if (errors.Count > 0 || parsed.Batches.Count == 0 || parsed.Batches[0].Statements.Count == 0) { differences.Add(sql + " does not parse"); continue; }
            var (found, columns, _) = ResultNames.Classify(parsed.Batches[0].Statements[0]);
            var expected = Enum.Parse<StatementClass>((string)item["class"]!);
            var expectedColumns = (int?)item["columns"];
            if (found != expected || columns != expectedColumns) differences.Add(sql + " is " + found + "/" + (columns?.ToString() ?? "null") + ", not " + expected + "/" + (expectedColumns?.ToString() ?? "null"));
        }
        check(cases.Count >= 50 && differences.Count == 0, "each statement in tests/fixtures/result-names/classes.json has its class and column count: " + string.Join("; ", differences));
    }

    private static async Task BindingAsync(Action<bool, string> check, JsonArray cases)
    {
        var differences = new List<string>();
        foreach (var item in cases)
        {
            var name = (string)item!["name"]!;
            var startLine = (int?)item["startLine"] ?? 1;
            var unbatched = new List<ResultMarker>();
            var batches = SqlScript.Parse((string)item["sql"]!, startLine, unbatched);
            var notes = unbatched.Where(marker => marker.Name is not null).Select(ResultNames.Unbatched).ToList();
            var plans = new List<ResultNamePlan?>();
            foreach (var batch in batches)
            {
                var plan = await ResultNamePlan.BuildAsync(batch, startLine, CancellationToken.None);
                plans.Add(plan);
                if (plan is not null) notes.AddRange(plan.Notes);
            }
            var slots = string.Join(" | ", plans.Select(plan => string.Join(" ", plan?.Slots.Select(slot => slot.Position + "=" + slot.Name) ?? [])));
            var expectedSlots = string.Join(" | ", item["slots"]!.AsArray().Select(batch => string.Join(" ", batch!.AsArray().Select(slot => (int)slot![0]! + "=" + (string)slot[1]!))));
            if (slots != expectedSlots) differences.Add(name + ": slots [" + slots + "], not [" + expectedSlots + "]");
            if (!Fragments(notes, item["notes"]!.AsArray())) differences.Add(name + ": notes [" + string.Join(" / ", notes) + "]");
            if (item["run"] is not { } run) continue;
            var replayed = plans[(int)run["batch"]!];
            if (replayed is null) { differences.Add(name + ": no plan to replay"); continue; }
            var binder = new ResultNameBinder(replayed);
            var names = new List<string?>();
            var errored = false;
            foreach (var set in run["sets"]!.AsArray())
            {
                if ((bool?)set!["error"] == true) { errored = true; continue; }
                names.Add(binder.Take((int)set["columns"]!, (bool?)set["showplan"] == true, (bool?)set["plan"] == true, errored));
            }
            var expectedNames = run["names"]!.AsArray().Select(value => (string?)value).ToList();
            if (!names.SequenceEqual(expectedNames)) differences.Add(name + ": names [" + string.Join(", ", names.Select(value => value ?? "null")) + "]");
            var unapplied = binder.Unapplied(errored).ToList();
            if (!Fragments(unapplied, run["unapplied"]!.AsArray())) differences.Add(name + ": unapplied [" + string.Join(" / ", unapplied) + "]");
        }
        check(cases.Count >= 30 && differences.Count == 0, "each binding case in tests/fixtures/result-names/binding.json names its sets and notes what it cannot: " + string.Join("; ", differences));

        static bool Fragments(List<string> notes, JsonArray expected) =>
            notes.Count == expected.Count && notes.Zip(expected).All(pair => pair.First.Contains((string)pair.Second!, StringComparison.Ordinal) && pair.First.EndsWith('.'));
    }

    private static async Task BoundsAsync(Action<bool, string> check)
    {
        check(ResultNames.MaxChars == 128 && ResultNames.MaxParseChars == 262_144 && ResultNames.MaxNotes == 20,
            "a name is at most 128 characters (the zod schema's resultNameChars), a batch over 262,144 characters is not parsed, and a run says at most 20 notes");
        // Over the size bound: not parsed, every name noted.
        var filler = string.Concat(Enumerable.Repeat("SELECT 1 AS a;\n", ResultNames.MaxParseChars / 15 + 1));
        var large = SqlScript.Parse("-- #Name=\"Big\"\n" + filler + "-- #Name=\"Bigger\"\nSELECT 2 AS b;").Single();
        var plan = await ResultNamePlan.BuildAsync(large, 1, CancellationToken.None);
        check(large.Sql.Length > ResultNames.MaxParseChars && plan is { Slots.Count: 0, Notes: [var big, var bigger] } && big.Contains("\"Big\" (line 1) was not applied: its batch is longer than 262,144 characters.", StringComparison.Ordinal)
            && bigger.Contains("\"Bigger\"", StringComparison.Ordinal), "a batch over the size bound is not parsed and each of its names is noted: " + string.Join(" / ", plan?.Notes ?? []));
        // Nested parentheses: ScriptDom's time grows faster than linearly with them and its recursion can end the process.
        static string Nested(int depth) => "-- #Name=\"Deep\"\nSELECT " + new string('(', depth) + "1" + new string(')', depth) + " AS a;";
        var shallow = SqlScript.Parse(Nested(ResultNames.MaxParenDepth)).Single();
        var deep = SqlScript.Parse(Nested(ResultNames.MaxParenDepth + 1)).Single();
        var shallowPlan = await ResultNamePlan.BuildAsync(shallow, 1, CancellationToken.None);
        var deepPlan = await ResultNamePlan.BuildAsync(deep, 1, CancellationToken.None);
        check(shallow.ParenDepth == ResultNames.MaxParenDepth && shallowPlan is { Slots: [{ Name: "Deep" }], Notes.Count: 0 }
            && deep.ParenDepth == ResultNames.MaxParenDepth + 1 && deepPlan is { Slots.Count: 0, Notes: [var nested] } && nested.Contains("nests parentheses too deeply", StringComparison.Ordinal),
            "a batch nested within the parenthesis bound is placed and a deeper one is noted, not parsed");
        check(SqlScript.Parse("SELECT '((((' AS a, [((] AS b; -- ((((\n/* (((( */ SELECT (1) AS c;").Single().ParenDepth == 1,
            "parentheses in strings, quoted names and comments do not count toward the nesting");
        // A long chain within the size bound recurses deeper than a thread pool thread's 1.5 MB stack; the parse thread's holds it.
        var chain = new System.Text.StringBuilder("-- #Name=\"Chain\"\nSELECT 1 AS a WHERE 1 = 1");
        while (chain.Length < ResultNames.MaxParseChars - 16) chain.Append(" AND 1 = 1");
        var chained = await ResultNamePlan.BuildAsync(SqlScript.Parse(chain.ToString()).Single(), 1, CancellationToken.None);
        check(chained is { Slots: [{ Name: "Chain", Position: 0 }] }, "a batch of one long AND chain within the size bound parses on the parse thread's stack and is named");
        // No marker, no parse: the plan is null without ScriptDom seeing the text.
        check(await ResultNamePlan.BuildAsync(SqlScript.Parse("SELECT FROM WHERE;").Single(), 1, CancellationToken.None) is null
            && await ResultNamePlan.BuildAsync(SqlScript.Parse("-- #Name=\"unclosed\nSELECT 1 AS a;").Single(), 1, CancellationToken.None) is null,
            "a batch without a well-formed marker is not parsed, even one that would not parse");
        using var cancelled = new CancellationTokenSource();
        await cancelled.CancelAsync();
        var stopped = false;
        try { await ResultNamePlan.BuildAsync(shallow, 1, cancelled.Token); }
        catch (OperationCanceledException) { stopped = true; }
        check(stopped, "a cancelled run stops waiting for its plan");
    }

    private static void Notes(Action<bool, string> check)
    {
        var shown = new List<string>();
        var notes = new ResultNameNotes(shown.Add);
        for (var i = 0; i < 25; i++) notes.Add("note " + i);
        for (var i = 0; i < 25; i++) notes.Add("note " + i);
        notes.Finish();
        check(shown.Count == 21 && shown[19] == "note 19" && shown[20] == "… and 5 more notes about result names.",
            "a run says each note once, at most 20 of them, then counts the rest: " + string.Join(" / ", shown.Skip(18)));
    }

    private static void Readers(Action<bool, string> check)
    {
        static DataTableReader Reader(params string[] columns)
        {
            var table = new DataTable();
            foreach (var column in columns) table.Columns.Add(column, typeof(string));
            return table.CreateDataReader();
        }
        check(ResultNameBinder.IsShowplanText(Reader("StmtText")) && ResultNameBinder.IsShowplanText(Reader("StmtText", "StmtId", "NodeId"))
            && ResultNameBinder.IsShowplanText(Reader("Rows", "Executes", "StmtText", "StmtId")) && !ResultNameBinder.IsShowplanText(Reader("Rows", "Executes"))
            && !ResultNameBinder.IsShowplanText(Reader("name", "StmtText")), "SHOWPLAN_TEXT, SHOWPLAN_ALL and STATISTICS PROFILE sets are told by their first columns");
        var plan = SqlScript.Parse("-- #Name=\"Rows\"\nSELECT 1 AS a, 2 AS b;").Single();
        var placed = ResultNamePlan.BuildAsync(plan, 1, CancellationToken.None).GetAwaiter().GetResult()!;
        var binder = new ResultNameBinder(placed);
        check(binder.Take(Reader("a", "b"), isPlan: false, errored: false) == "Rows" && binder.Take(Reader("c"), isPlan: false, errored: false) is null && !binder.Unapplied(false).Any(),
            "a reader's set is named by its place and column count");
    }

    private static void Descriptor(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        var budget = store.BeginQuery("names" + Guid.NewGuid());
        ResultColumn[] columns = [new("a", "int", "text", Nullable: true)];
        var named = store.Open(budget, 0, 1, 1, "rows", columns, [WireKind.Text], name: "Open orders")!;
        var unnamed = store.Open(budget, 1, 1, 1, "rows", columns, [WireKind.Text])!;
        var options = ActionDesign.Strict;
        var namedJson = JsonSerializer.Serialize(named.Describe(), options);
        var unnamedJson = JsonSerializer.Serialize(unnamed.Describe(), options);
        // The columns have names of their own, so the descriptor's own members are looked at.
        check(named.Describe().Name == "Open orders" && (string?)JsonNode.Parse(namedJson)!["name"] == "Open orders" && unnamed.Describe().Name is null
            && !JsonNode.Parse(unnamedJson)!.AsObject().ContainsKey("name"), "a set's descriptor carries its name, and one without a name leaves the field out");
    }
}
