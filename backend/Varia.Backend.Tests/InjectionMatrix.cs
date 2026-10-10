using System.Data;
using System.Diagnostics;
using System.Globalization;
using System.Text.RegularExpressions;
using Microsoft.Data.SqlClient;
using Varia.Backend.Scripting;

namespace Varia.Backend.Tests;

/// <summary>Script As never hands over a script that runs SQL its user did not write. Objects named to break out of
/// everything SMO writes a name into (comments, its header and banner shapes, brackets, string literals, lines, batches)
/// are scripted with every DDL verb Script As offers them, with headers on and off, Generate script for dependent objects
/// on and off, Script triggers on, and Check for object existence; a procedure over missing objects with such names, in
/// its own database, in master and in a database that does not exist, takes SMO's unresolved-reference path. Every script
/// that comes back runs as the query window splits it, batch by batch, in the matrix's scratch database inside a
/// transaction that is always rolled back: it must run without an error, change exactly the objects its verb implies for
/// this fixture (an inventory of the database and the server's principals before and after), and leave the canary every
/// name aims at in place. A refusal must be a documented one, and the unresolved-reference path must script.</summary>
internal static partial class InjectionMatrix
{
    [GeneratedRegex(@"Script Date: [^\r\n]*? \*{6}/")]
    private static partial Regex ScriptDate();

    /// <summary>Name parts: a comment's end, SMO's header start and banner end, and a comment's start; a lone CR; LF and GO
    /// lines; CRLF and GO lines; U+2028; a closing bracket and an apostrophe. Each carries a payload the canary shows. They
    /// stay short: SMO 181's dependency walk keeps [schema].[name] in a sysname, so a longer pair loses its dependents.</summary>
    internal static readonly string[] Fragments =
    [
        "x*/ DELETE dbo.Canary /****** Object: ******/ /*",
        "c\rDROP TABLE dbo.Canary --",
        "l\nGO\nCREATE TABLE dbo.Pwned (id int)\nGO\n--",
        "w\r\nGO\r\nDROP TABLE dbo.Canary\r\nGO\r\n--",
        "u\u2028DROP TABLE dbo.Canary --",
        "q]'); DROP TABLE dbo.Canary; --"
    ];

    /// <summary>The fixture's objects by label letter, as each fragment repeats them: a table with a trigger, a view over
    /// the table, a function over the view, a procedure over the function, a procedure over missing objects, a synonym for
    /// the table, an alias type, an empty schema and a user. Kind, subtype (for the catalogue's verbs) and URN type.</summary>
    private static readonly (string Label, string Kind, string Subtype, string Urn)[] Parts =
    [
        ("t", "table", "", "Table"), ("r", "trigger", "", "Trigger"), ("v", "view", "", "View"), ("f", "function", "scalar", "UserDefinedFunction"),
        ("p", "procedure", "sql", "StoredProcedure"), ("u", "procedure", "sql", "StoredProcedure"), ("y", "synonym", "", "Synonym"),
        ("d", "type", "alias", "UserDefinedDataType"), ("e", "schema", "", "Schema"), ("U", "user", "", "User")
    ];

    /// <summary>What SMO 181's dependency walk finds in this fixture: what each object refers to (a CREATE's, and DROP And
    /// CREATE's second pass's, parents) and what refers to it (a CREATE OR ALTER's, and a DROP's, children).</summary>
    private static readonly Dictionary<string, string[]> ParentsOf = new() { ["v"] = ["t"], ["f"] = ["v", "t"], ["p"] = ["f", "v", "t"], ["r"] = ["t"], ["y"] = ["t"] };
    private static readonly Dictionary<string, string[]> ChildrenOf = new() { ["t"] = ["r", "v", "f", "p", "y"], ["v"] = ["f", "p"], ["f"] = ["p"] };
    /// <summary>What goes and comes with an object: a table's trigger (written with it under Script triggers) and a user's
    /// CONNECT permission (label g).</summary>
    private static readonly Dictionary<string, string[]> Sub = new() { ["t"] = ["r"], ["U"] = ["g"] };
    /// <summary>The order the matrix drops objects in itself before a script creates them again.</summary>
    private static readonly string[] DropOrder = ["u", "p", "f", "v", "y", "r", "t", "d", "e", "U"];
    private const string Mark = "varia.mark";

    internal sealed record Case(string Label, ObjectRefDto Target, string Verb, bool Headers, bool Dependencies, bool Existence)
    {
        public override string ToString() => Label + " " + Verb + (Headers ? " headers" : "") + (Dependencies ? " dependents" : "") + (Existence ? " existence" : "");
    }

    /// <param name="Refusals">Refused cases by the documented reason.</param>
    internal sealed record Report(int Cases, int Scripted, int Retried, int Executed, int Batches, long ScriptMs, long ExecuteMs, Dictionary<string, int> Refusals, List<string> Failures);

    private static string Bracket(string name) => "[" + name.Replace("]", "]]", StringComparison.Ordinal) + "]";
    private static string Schema(int i) => "s" + Fragments[i];
    private static string Name(string letter, int i) => letter + Fragments[i];
    private static string Label(string letter, int i) => letter + i.ToString(CultureInfo.InvariantCulture);
    private static List<string> Sorted(IEnumerable<string> labels) => [.. labels.Order(StringComparer.Ordinal)];

    /// <summary>The fixture, one statement per command (nothing splits it at GO), in a database that holds nothing else
    /// but the canary: dbo.Canary with one row, which the payloads drop or empty (one creates dbo.Pwned instead).</summary>
    internal static IEnumerable<string> Fixture()
    {
        yield return "CREATE TABLE dbo.Canary (id int NOT NULL);";
        yield return "INSERT dbo.Canary (id) VALUES (1);";
        for (var i = 0; i < Fragments.Length; i++)
        {
            var s = Bracket(Schema(i));
            string Q(string letter) => s + "." + Bracket(Name(letter, i));
            yield return "CREATE SCHEMA " + s + ";";
            yield return "CREATE SCHEMA " + Bracket(Name("e", i)) + ";";
            yield return "CREATE TABLE " + Q("t") + " (id int NULL);";
            yield return "CREATE TRIGGER " + Q("r") + " ON " + Q("t") + " AFTER INSERT AS SET NOCOUNT ON;";
            yield return "CREATE VIEW " + Q("v") + " AS SELECT id FROM " + Q("t") + ";";
            yield return "CREATE FUNCTION " + Q("f") + " () RETURNS int AS BEGIN RETURN (SELECT COUNT(*) FROM " + Q("v") + "); END;";
            yield return "CREATE PROCEDURE " + Q("p") + " AS SELECT " + Q("f") + "() AS c;";
            // Missing objects with such names in this database, in master, and in a database that does not exist.
            var missing = Bracket(Name("m", i));
            yield return "CREATE PROCEDURE " + Q("u") + " AS SELECT * FROM " + s + "." + missing + "; SELECT * FROM [master]." + s + "." + missing + "; SELECT * FROM "
                + Bracket(Name("n", i)) + "." + s + "." + missing + ";";
            yield return "CREATE SYNONYM " + Q("y") + " FOR " + Q("t") + ";";
            yield return "CREATE TYPE " + Q("d") + " FROM int NULL;";
            yield return "CREATE USER " + Bracket(Name("U", i)) + " WITHOUT LOGIN;";
        }
    }

    private static ObjectRefDto Target(string database, string letter, int i) => letter switch
    {
        "r" => new ObjectRefDto("trigger", database, Name: Name("r", i), Parent: new ParentRefDto("table", Schema(i), Name("t", i))),
        "e" => new ObjectRefDto("schema", database, Name: Name("e", i)),
        "U" => new ObjectRefDto("user", database, Name: Name("U", i)),
        _ => new ObjectRefDto(Parts.First(part => part.Label == letter).Kind, database, Schema(i), Name(letter, i))
    };

    /// <summary>The option sets: headers on and off, Generate script for dependent objects on and off, and Check for object
    /// existence with headers on (Script triggers always on).</summary>
    private static readonly (bool Headers, bool Dependencies, bool Existence)[] Combinations =
        [(true, false, false), (false, false, false), (true, true, false), (false, true, false), (true, false, true)];

    /// <summary>The cases: every fragment's every object with every DDL verb the catalogue offers it, once, with one option
    /// set, rotated so that each object and verb meets every option set across the fragments, and each fragment's object
    /// both header settings across its verbs (the whole product, over 1,300 scripts, takes minutes on a shared runner).
    /// Generate script for dependent objects goes only to kinds SMO's dependency discovery takes, and the procedure over
    /// missing objects always takes the walk for CREATE and DROP And CREATE, so every name reaches the unresolved path.</summary>
    internal static List<Case> Cases(string database)
    {
        var ddl = new HashSet<string>(["create", "alter", "createOrAlter", "drop", "dropAndCreate"]);
        var cases = new List<Case>();
        var pair = 0;
        foreach (var (letter, kind, subtype, urn) in Parts)
        {
            var row = ScriptingCatalog.Current.Row(kind, subtype) ?? throw new InvalidOperationException("No catalogue row for " + kind);
            var choices = SmoOptionsMapper.Dependencies(urn, letter == "r" ? "Table" : null, false) ? Combinations : [.. Combinations.Where(item => !item.Dependencies)];
            foreach (var verb in row.Enabled.Where(ddl.Contains))
            {
                for (var i = 0; i < Fragments.Length; i++)
                {
                    var (headers, deps, existence) = choices[(i + pair) % choices.Length];
                    if (letter == "u" && verb is "create" or "dropAndCreate") (headers, deps, existence) = (i % 2 == 0, true, false);
                    cases.Add(new(Label(letter, i), Target(database, letter, i), verb, headers, deps, existence));
                }
                pair++;
            }
        }
        return cases;
    }

    private static string Letter(string label) => label[..1];
    private static int Index(string label) => int.Parse(label[1..], CultureInfo.InvariantCulture);

    private static IEnumerable<string> Close(IEnumerable<string> letters) => letters.SelectMany(letter => Sub.GetValueOrDefault(letter, []).Prepend(letter)).Distinct();

    /// <summary>What the case's script must do to the fixture: the objects the matrix drops first so that the script can
    /// create them, the ones it must add and remove (an object dropped and created again keeps its key, and loses the
    /// matrix's mark), and the related ones it may alter.</summary>
    private static (string[] Prepare, string[] Added, string[] Removed, string[] Related) Expect(Case item)
    {
        var x = Letter(item.Label);
        var parents = item.Dependencies ? ParentsOf.GetValueOrDefault(x, []) : [];
        var children = item.Dependencies ? ChildrenOf.GetValueOrDefault(x, []) : [];
        var related = Close(new[] { x }.Concat(ParentsOf.GetValueOrDefault(x, [])).Concat(ChildrenOf.GetValueOrDefault(x, []))).ToArray();
        string[] Order(IEnumerable<string> letters) => [.. letters.Distinct().Where(letter => letter != "g").OrderBy(letter => Array.IndexOf(DropOrder, letter))];
        return item.Verb switch
        {
            "create" => (Order(Close(parents.Prepend(x))), [.. Close(parents.Prepend(x))], [], related),
            "drop" => ([], [], [.. Close(children.Prepend(x))], related),
            "dropAndCreate" => (Order(Close(parents)), [.. Close(parents)], [.. Close(children).Except(Close([x]))], related),
            _ => ([], [], [], related)
        };
    }

    private static string DropStatement(string letter, int i)
    {
        var q = Bracket(Schema(i)) + "." + Bracket(Name(letter, i));
        return letter switch
        {
            "t" => "DROP TABLE " + q, "r" => "DROP TRIGGER " + q, "v" => "DROP VIEW " + q, "f" => "DROP FUNCTION " + q, "p" or "u" => "DROP PROCEDURE " + q,
            "y" => "DROP SYNONYM " + q, "d" => "DROP TYPE " + q, "e" => "DROP SCHEMA " + Bracket(Name("e", i)), "U" => "DROP USER " + Bracket(Name("U", i)),
            _ => throw new InvalidOperationException("No fixture object " + letter)
        } + ";";
    }

    /// <summary>The matrix's mark on the target (an extended property), which a DROP takes with the object and an ALTER
    /// keeps; the names go as parameters.</summary>
    private static SqlCommand Marking(string letter, int i, SqlConnection connection, SqlTransaction transaction)
    {
        (string Type, string Name)[] levels = letter switch
        {
            "e" => [("SCHEMA", Name("e", i))],
            "U" => [("USER", Name("U", i))],
            "r" => [("SCHEMA", Schema(i)), ("TABLE", Name("t", i)), ("TRIGGER", Name("r", i))],
            _ => [("SCHEMA", Schema(i)), (letter switch { "t" => "TABLE", "v" => "VIEW", "f" => "FUNCTION", "y" => "SYNONYM", "d" => "TYPE", _ => "PROCEDURE" }, Name(letter, i))]
        };
        var command = new SqlCommand("EXEC sys.sp_addextendedproperty @name = N'" + Mark + "', @value = 1, @level0type = @t0, @level0name = @n0, @level1type = @t1, @level1name = @n1, "
            + "@level2type = @t2, @level2name = @n2;", connection, transaction) { CommandTimeout = 30 };
        for (var level = 0; level < 3; level++)
        {
            command.Parameters.Add(new SqlParameter("@t" + level, SqlDbType.VarChar, 128) { Value = level < levels.Length ? levels[level].Type : DBNull.Value });
            command.Parameters.Add(new SqlParameter("@n" + level, SqlDbType.NVarChar, 128) { Value = level < levels.Length ? levels[level].Name : DBNull.Value });
        }
        return command;
    }

    /// <summary>Everything in the database a statement could create, drop or alter, and the server's principals: key → id
    /// and modification time. Then the canary's row count (−1 when it is gone) and the marks left.</summary>
    private const string Inventory = "SELECT N'o', SCHEMA_NAME(o.schema_id), o.name, RTRIM(o.type), CONVERT(bigint, o.object_id), o.modify_date FROM sys.objects AS o WHERE o.is_ms_shipped = 0 "
        + "UNION ALL SELECT N's', NULL, s.name, NULL, s.schema_id, NULL FROM sys.schemas AS s "
        + "UNION ALL SELECT N'p', NULL, p.name, RTRIM(p.type), p.principal_id, p.modify_date FROM sys.database_principals AS p "
        + "UNION ALL SELECT N't', SCHEMA_NAME(t.schema_id), t.name, NULL, t.user_type_id, NULL FROM sys.types AS t WHERE t.is_user_defined = 1 "
        + "UNION ALL SELECT N'd', NULL, tr.name, NULL, tr.object_id, tr.modify_date FROM sys.triggers AS tr WHERE tr.parent_class = 0 "
        + "UNION ALL SELECT N'g', CONVERT(sysname, dp.class_desc) + N' ' + CONVERT(sysname, dp.major_id), USER_NAME(dp.grantee_principal_id), dp.state + N' ' + dp.permission_name, 0, NULL "
        + "FROM sys.database_permissions AS dp "
        + "UNION ALL SELECT N'm', USER_NAME(rm.role_principal_id), USER_NAME(rm.member_principal_id), NULL, 0, NULL FROM sys.database_role_members AS rm "
        + "UNION ALL SELECT N'e', CONVERT(sysname, ep.class) + N' ' + CONVERT(sysname, ep.major_id) + N' ' + CONVERT(sysname, ep.minor_id), ep.name, NULL, 0, NULL "
        + "FROM sys.extended_properties AS ep WHERE ep.name <> N'" + Mark + "' "
        + "UNION ALL SELECT N'x', NULL, sp.name COLLATE DATABASE_DEFAULT, RTRIM(sp.type) COLLATE DATABASE_DEFAULT, sp.principal_id, sp.modify_date FROM sys.server_principals AS sp;\n"
        + "IF OBJECT_ID(N'dbo.Canary', N'U') IS NULL SELECT -1 ELSE EXEC (N'SELECT COUNT(*) FROM dbo.Canary');\n"
        + "SELECT COUNT(*) FROM sys.extended_properties WHERE name = N'" + Mark + "';";

    private static (Dictionary<string, string> Items, int Canary, int Marks) Read(SqlConnection connection, SqlTransaction transaction)
    {
        using var command = new SqlCommand(Inventory, connection, transaction) { CommandTimeout = 30 };
        using var reader = command.ExecuteReader();
        var items = new Dictionary<string, string>(StringComparer.Ordinal);
        while (reader.Read())
        {
            string Text(int ordinal) => reader.IsDBNull(ordinal) ? "" : Convert.ToString(reader.GetValue(ordinal), CultureInfo.InvariantCulture)!;
            var modified = reader.IsDBNull(5) ? "" : reader.GetDateTime(5).ToString("O", CultureInfo.InvariantCulture);
            items[Text(0) + "\u0001" + Text(1) + "\u0001" + Text(2) + "\u0001" + Text(3)] = Text(4) + "\u0001" + modified;
        }
        reader.NextResult();
        reader.Read();
        var canary = reader.GetInt32(0);
        reader.NextResult();
        reader.Read();
        return (items, canary, reader.GetInt32(0));
    }

    /// <summary>The fixture labels of inventory keys; anything else is shown by kind and visible name.</summary>
    private static Dictionary<string, string> Labels()
    {
        var labels = new Dictionary<string, string>(StringComparer.Ordinal);
        static string Key(string kind, string? schema, string name, string? type) => kind + "\u0001" + schema + "\u0001" + name + "\u0001" + type;
        for (var i = 0; i < Fragments.Length; i++)
        {
            foreach (var (letter, type) in new[] { ("t", "U"), ("r", "TR"), ("v", "V"), ("f", "FN"), ("p", "P"), ("u", "P"), ("y", "SN") })
                labels[Key("o", Schema(i), Name(letter, i), type)] = Label(letter, i);
            labels[Key("t", Schema(i), Name("d", i), null)] = Label("d", i);
            labels[Key("s", null, Name("e", i), null)] = Label("e", i);
            labels[Key("s", null, Schema(i), null)] = Label("s", i);
            labels[Key("p", null, Name("U", i), "S")] = Label("U", i);
            labels[Key("g", "DATABASE 0", Name("U", i), "G CONNECT")] = Label("g", i);
        }
        return labels;
    }

    private static string Show(string key, Dictionary<string, string> labels) =>
        labels.TryGetValue(key, out var label) ? label : ScriptingErrors.Display(string.Join(".", key.Split('\u0001').Where(part => part.Length > 0)));

    /// <summary>Why a refusal is documented, or null: a comment of SMO's that a name breaks (Varia's refusal), or SMO 181's
    /// own failure to walk a table trigger's dependencies with Script triggers on, whatever the trigger is named. Both are
    /// SMO_ERROR values that show the name as messages show names.</summary>
    private static string? Documented(Case item, ScriptError error)
    {
        var shown = item.Target.Schema is { } schema ? schema + "." + item.Target.Name : item.Target.Name!;
        if (error.Code != "SMO_ERROR" || !error.Message.StartsWith("Could not script " + ScriptingErrors.Display(shown) + ": ", StringComparison.Ordinal)
            || error.Message.Any(c => char.IsControl(c) || c is '\u2028' or '\u2029')) return null;
        if (error.Message.EndsWith(": " + SmoScriptRunner.BrokenComment, StringComparison.Ordinal)) return "broken SMO comment";
        return Letter(item.Label) == "r" && item.Dependencies && item.Verb is "create" or "dropAndCreate"
            && error.Message.Contains("There is no collection of Table objects that is a child of Table.", StringComparison.Ordinal) ? "SMO 181 trigger walk" : null;
    }

    /// <summary>Scripts every case, <paramref name="parallel"/> at a time (the worker index picks a connection), then runs
    /// each distinct script that came back in <paramref name="connectionString"/>'s database, which holds the fixture.</summary>
    public static async Task<Report> RunAsync(string database, string connectionString, int parallel, Func<int, ObjectRefDto, string, ScriptingOptionsDto, Task<ScriptResult>> script,
        ScriptingOptionsDto defaults)
    {
        var failures = new List<string>();
        var cases = Cases(database);
        var results = new ScriptResult?[cases.Count];
        var watch = Stopwatch.StartNew();
        async Task<ScriptResult> Script(int worker, Case item)
        {
            var options = defaults with { IncludeHeaders = item.Headers, GenerateDependentObjects = item.Dependencies, ScriptTriggers = true, CheckExistence = item.Existence };
            try { return await script(worker, item.Target, item.Verb, options); }
            catch (RequestException error) { return new ScriptResult(null, "", [], 0, 0, new ScriptError("THROWN " + error.Code, error.Message, false)); }
        }
        var next = -1;
        await Task.WhenAll(Enumerable.Range(0, parallel).Select(worker => Task.Run(async () =>
        {
            for (var index = Interlocked.Increment(ref next); index < cases.Count; index = Interlocked.Increment(ref next)) results[index] = await Script(worker, cases[index]);
        })));
        // SMO 181's dependency discovery now and then fails with a NullReferenceException when jobs run side by side; a
        // refusal that is not a documented one is scripted once more, alone.
        var retried = 0;
        for (var index = 0; index < cases.Count; index++)
            if (results[index]!.Error is { } first && Documented(cases[index], first) is null)
            {
                retried++;
                results[index] = await Script(0, cases[index]);
            }
        var scriptMs = watch.ElapsedMilliseconds;

        var runs = new Dictionary<string, (Case Case, string Text)>(StringComparer.Ordinal);
        var refusals = new Dictionary<string, int>(StringComparer.Ordinal);
        var scripted = 0;
        for (var index = 0; index < cases.Count; index++)
        {
            var item = cases[index];
            var result = results[index]!;
            if (result.Error is null) scripted++;
            // SMO walks references for a CREATE (and DROP And CREATE's second pass) only: there the procedure over missing
            // objects takes the unresolved-reference path, whose comments are left out and named in a warning.
            var unresolved = Letter(item.Label) == "u" && item.Dependencies && item.Verb is "create" or "dropAndCreate";
            if (result.Error is { } error)
            {
                if (!unresolved && Documented(item, error) is { } reason) refusals[reason] = refusals.GetValueOrDefault(reason) + 1;
                else failures.Add(item + ": refused with " + error.Code + " " + error.Message);
                continue;
            }
            var text = result.Text ?? "";
            var notices = result.Warnings.Where(warning => !(item.Headers && warning == HeaderGuard.Warning)).ToList();
            if (unresolved && (notices.Count != 1 || !notices[0].StartsWith("The script does not create objects that a definition in it refers to", StringComparison.Ordinal)))
                failures.Add(item + ": expected the unresolved-reference warning, got " + notices.Count + " warnings");
            else if (!unresolved && notices.Count > 0) failures.Add(item + ": unexpected warning " + notices[0]);
            if (text.Contains("Cannot script Unresolved Entities", StringComparison.Ordinal)) failures.Add(item + ": SMO's unresolved-reference comment is in the script");
            try { if (SqlScript.Parse(text).Count == 0) { failures.Add(item + ": no batches"); continue; } }
            catch (RequestException parse) { failures.Add(item + ": the query window cannot split it: " + parse.Message); continue; }
            runs.TryAdd(item.Label + "\u0001" + item.Verb + "\u0001" + item.Dependencies + "\u0001" + ScriptDate().Replace(text, ""), (item, text));
        }

        watch.Restart();
        var labels = Labels();
        var executed = 0;
        var batchCount = 0;
        await using var connection = new SqlConnection(connectionString);
        await connection.OpenAsync();
        foreach (var (item, text) in runs.Values)
        {
            var x = Letter(item.Label);
            var i = Index(item.Label);
            var (prepare, added, removed, related) = Expect(item);
            var errors = new List<string>();
            (Dictionary<string, string> Items, int Canary, int Marks) before, after;
            using var transaction = connection.BeginTransaction();
            try
            {
                using (var setup = new SqlCommand("SET XACT_ABORT OFF; SET ANSI_NULLS ON; SET QUOTED_IDENTIFIER ON; SET ANSI_PADDING ON; SET ANSI_WARNINGS ON; "
                    + "SET CONCAT_NULL_YIELDS_NULL ON; SET ARITHABORT ON;\n" + string.Concat(prepare.Select(letter => DropStatement(letter, i) + "\n")), connection, transaction)
                    { CommandTimeout = 30 })
                    setup.ExecuteNonQuery();
                if (item.Verb != "create")
                    using (var mark = Marking(x, i, connection, transaction)) mark.ExecuteNonQuery();
                before = Read(connection, transaction);
                var number = 0;
                foreach (var batch in SqlScript.Parse(text))
                {
                    number++;
                    for (var repeat = 0; repeat < batch.RepeatCount; repeat++)
                    {
                        try
                        {
                            using var command = new SqlCommand(batch.Sql, connection, transaction) { CommandTimeout = 30 };
                            command.ExecuteNonQuery();
                            batchCount++;
                        }
                        catch (SqlException run) { errors.Add("batch " + number + ": Msg " + run.Number); }
                    }
                }
                after = Read(connection, transaction);
            }
            catch (Exception ended) when (ended is InvalidOperationException or SqlException)
            {
                failures.Add(item + ": the transaction ended (" + (ended is SqlException sql ? "Msg " + sql.Number : ended.GetType().Name) + ")"
                    + (errors.Count > 0 ? " after " + string.Join(", ", errors) : ""));
                continue;
            }
            finally
            {
                try { transaction.Rollback(); }
                catch (InvalidOperationException) { /* The server already ended it; the failure is recorded. */ }
            }
            executed++;
            var gotAdded = Sorted(after.Items.Keys.Except(before.Items.Keys).Select(key => Show(key, labels)));
            var gotRemoved = Sorted(before.Items.Keys.Except(after.Items.Keys).Select(key => Show(key, labels)));
            var changed = before.Items.Keys.Intersect(after.Items.Keys).Where(key => before.Items[key] != after.Items[key]).Select(key => Show(key, labels)).ToList();
            var expectedAdded = Sorted(added.Select(letter => Label(letter, i)));
            var expectedRemoved = Sorted(removed.Select(letter => Label(letter, i)));
            var mayChange = Close(related).Select(letter => Label(letter, i)).ToHashSet(StringComparer.Ordinal);
            var target = Label(x, i);
            var problems = new List<string>();
            if (errors.Count > 0) problems.Add("errors " + string.Join(", ", errors));
            if (after.Canary != 1) problems.Add("dbo.Canary has " + after.Canary + " rows");
            if (!gotAdded.SequenceEqual(expectedAdded)) problems.Add("added [" + string.Join(" ", gotAdded) + "] not [" + string.Join(" ", expectedAdded) + "]");
            if (!gotRemoved.SequenceEqual(expectedRemoved)) problems.Add("removed [" + string.Join(" ", gotRemoved) + "] not [" + string.Join(" ", expectedRemoved) + "]");
            if (changed.Where(label => !mayChange.Contains(label)).ToList() is { Count: > 0 } stray) problems.Add("altered [" + string.Join(" ", stray) + "]");
            // A DROP takes the target and its mark; DROP And CREATE creates it again unmarked; an ALTER keeps both.
            switch (item.Verb)
            {
                case "alter" or "createOrAlter" when !changed.Contains(target) || after.Marks != 1:
                    problems.Add("did not alter " + target + " in place (" + after.Marks + " marks)");
                    break;
                case "drop" when after.Marks != 0:
                    problems.Add("left the mark of " + target);
                    break;
                case "dropAndCreate" when after.Marks != 0 || !after.Items.Keys.Any(key => Show(key, labels) == target):
                    problems.Add("did not drop and create " + target + " (" + after.Marks + " marks)");
                    break;
            }
            if (problems.Count > 0) failures.Add(item + ": " + string.Join("; ", problems));
        }
        return new(cases.Count, scripted, retried, executed, batchCount, scriptMs, watch.ElapsedMilliseconds, refusals, failures);
    }
}
