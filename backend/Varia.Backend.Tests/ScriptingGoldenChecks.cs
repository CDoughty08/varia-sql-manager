using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Varia.Backend.Scripting;

namespace Varia.Backend.Tests;

/// <summary>Spec G4 on the scratch database: every case of tests/fixtures/scripting/cases.json against its golden, module
/// text byte for byte, a round trip through a second database, a low-privilege login, and the command, time and
/// concurrency budgets, recorded in artifacts/scripting-perf.json.</summary>
internal static partial class ScriptingLiveChecks
{
    private sealed record CaseParent(string Kind, string Schema, string Name);
    private sealed record CaseTarget(string Kind, string Name, string? Schema = null, CaseParent? Parent = null);
    private sealed record ScriptCase(string Id, CaseTarget Target, string Verb, JsonObject? Options = null, int? MinMajor = null, int? MaxMajor = null, int? MaxCommands = null,
        int? RoundTrip = null, string? ExpectError = null, string? Requires = null, bool Parses = true);
    private sealed record CaseFile(int Version, List<ScriptCase> Cases);

    /// <summary>The most commands a table's CREATE may take (spec G4): 51 for the kitchen sink, 47 for 300 columns and 20
    /// indexes on SQL Server 2022 with prefetch, against 713 without it.</summary>
    private const int SinkCommandCeiling = 60;

    [GeneratedRegex(@"\n+GO\n+")]
    private static partial Regex BlankLines();

    [GeneratedRegex(@"^(VariaScratch_\d{14}_[0-9a-f]{8})_(ls|cred|role|dev|audit|sas|trg)$")]
    private static partial Regex ServerObjectName();

    /// <summary>Drops a scratch run's server objects (spec G4's fixture), whichever of them exist.</summary>
    private static async Task DropServerObjectsAsync(Func<string, string, Task<SqlRun>> sql, string scratch)
    {
        string N(string suffix) => "N'" + scratch + "_" + suffix + "'";
        string Q(string suffix) => "[" + scratch + "_" + suffix + "]";
        await sql("IF DB_ID(N'" + scratch + "') IS NOT NULL EXEC [" + scratch + "].sys.sp_executesql N'IF EXISTS (SELECT 1 FROM sys.database_audit_specifications WHERE name = N''ScratchAuditSpecification'') "
            + "DROP DATABASE AUDIT SPECIFICATION ScratchAuditSpecification;';\n"
            + "IF EXISTS (SELECT 1 FROM sys.server_triggers WHERE name = " + N("trg") + ") DROP TRIGGER " + Q("trg") + " ON ALL SERVER;\n"
            + "IF EXISTS (SELECT 1 FROM sys.server_audit_specifications WHERE name = " + N("sas") + ") DROP SERVER AUDIT SPECIFICATION " + Q("sas") + ";\n"
            + "IF EXISTS (SELECT 1 FROM sys.server_audits WHERE name = " + N("audit") + ") DROP SERVER AUDIT " + Q("audit") + ";\n"
            + "IF EXISTS (SELECT 1 FROM sys.backup_devices WHERE name = " + N("dev") + ") EXEC master.dbo.sp_dropdevice @logicalname = " + N("dev") + ";\n"
            + "IF EXISTS (SELECT 1 FROM sys.servers WHERE name = " + N("ls") + ") EXEC master.dbo.sp_dropserver @server = " + N("ls") + ", @droplogins = 'droplogins';\n"
            + "IF EXISTS (SELECT 1 FROM sys.credentials WHERE name = " + N("cred") + ") DROP CREDENTIAL " + Q("cred") + ";\n"
            + "IF EXISTS (SELECT 1 FROM sys.server_principals WHERE name = " + N("role") + " AND type = 'R') DROP SERVER ROLE " + Q("role") + ";", "master");
    }

    /// <summary>Server objects a crashed run left behind: their scratch database is gone.</summary>
    private static async Task SweepServerObjectsAsync(Func<string, string, Task<SqlRun>> sql)
    {
        var names = await sql("SELECT name FROM sys.servers UNION ALL SELECT name FROM sys.credentials UNION ALL SELECT name FROM sys.server_principals WHERE type = 'R' "
            + "UNION ALL SELECT name FROM sys.backup_devices UNION ALL SELECT name FROM sys.server_audits UNION ALL SELECT name FROM sys.server_audit_specifications "
            + "UNION ALL SELECT name FROM sys.server_triggers;", "master");
        var databases = (await sql("SELECT name FROM sys.databases WHERE name LIKE N'VariaScratch[_]%';", "master")).Sets[0].Select(row => row[0]!).ToHashSet(StringComparer.Ordinal);
        var stale = names.Sets[0].Select(row => ServerObjectName().Match(row[0] ?? "")).Where(match => match.Success).Select(match => match.Groups[1].Value)
            .Where(scratch => !databases.Contains(scratch)).Distinct().ToList();
        foreach (var scratch in stale)
        {
            Console.WriteLine("Dropping stale scratch server objects of " + scratch);
            await DropServerObjectsAsync(sql, scratch);
        }
    }

    private static ObjectRefDto Resolve(CaseTarget target, string db)
    {
        var name = target.Name.Replace("{{scratch}}", db, StringComparison.Ordinal);
        if (target.Kind == "database") return new("database", Name: name);
        if (ScriptPreflight.ServerScope(target.Kind)) return new(target.Kind, Name: name);
        return new(target.Kind, db, target.Schema, name, target.Parent is { } parent ? new ParentRefDto(parent.Kind, parent.Schema, parent.Name) : null);
    }

    private static ScriptingOptionsDto With(ScriptingOptionsDto options, JsonObject? overrides, JsonSerializerOptions json)
    {
        if (overrides is null) return options;
        var merged = JsonSerializer.SerializeToNode(options, json)!.AsObject();
        foreach (var (key, value) in overrides) merged[key] = value?.DeepClone();
        return merged.Deserialize<ScriptingOptionsDto>(json)!;
    }

    private static double Percentile(IReadOnlyList<long> values, double fraction)
    {
        if (values.Count == 0) return 0;
        var sorted = values.Order().ToList();
        return sorted[Math.Min(sorted.Count - 1, (int)Math.Ceiling(fraction * sorted.Count) - 1)];
    }

    private static async Task GoldenAsync(Action<bool, string> check, SqlService service, Client client, ScratchDatabase scratch, Func<string, string, Task<SqlRun>> sql,
        Func<string, ConnectOptions> live, JsonSerializerOptions json)
    {
        var db = scratch.Name;
        var golden = GoldenText.Load();
        var file = JsonSerializer.Deserialize<CaseFile>(File.ReadAllText(Path.Combine(golden.Folder, "cases.json")), json)!;
        var major = scratch.Major;
        var failures = new List<string>();
        var results = new Dictionary<string, (ScriptCase Case, ObjectRefDto Target, ScriptResult Result)>(StringComparer.Ordinal);
        var timings = new List<(ScriptCase Case, long Ms, int Commands)>();
        var ran = 0;
        foreach (var item in file.Cases)
        {
            if (item.MinMajor > major || item.MaxMajor < major || item.Requires == "sqlLogin" && scratch.Login is null || item.Requires == "snapshot" && !scratch.HasSnapshot) continue;
            var target = Resolve(item.Target, db);
            var options = With(client.Options, item.Options, json);
            var watch = Stopwatch.StartNew();
            var result = await client.Script(target, item.Verb, options);
            timings.Add((item, watch.ElapsedMilliseconds, result.Commands));
            ran++;
            // Hang guards: the first script also pays for loading SMO.
            if (watch.ElapsedMilliseconds > (ran == 1 ? 20_000 : 10_000)) failures.Add(item.Id + ": took " + watch.ElapsedMilliseconds + " ms");
            if (item.ExpectError is { } code)
            {
                if (result.Error?.Code != code) failures.Add(item.Id + ": expected " + code + " but got " + (result.Error?.Code ?? "a script"));
                continue;
            }
            if (!Ok(result)) { failures.Add(item.Id + ": " + result.Error?.Code + " " + result.Error?.Message); continue; }
            results[item.Id] = (item, target, result);
            if (item.MaxCommands is { } most && result.Commands > most) failures.Add(item.Id + ": " + result.Commands + " commands, more than " + most);
            if (golden.Compare(major, item.Id, golden.Normalize(result.Text!)) is { } problem) failures.Add(item.Id + ": " + problem);
            // A placeholder may hold a quote from a column's name; the query window then refuses the unfilled template whole.
            if (!item.Parses) { if (Parses(result.Text!)) failures.Add(item.Id + ": expected the query window to refuse the unfilled template"); }
            else if (options.DelimitStatements && !Framed(result.Text!)) failures.Add(item.Id + ": a batch without its GO, or text the query window cannot split");
        }
        golden.Save();
        foreach (var failure in failures) Console.Error.WriteLine("Script As case: " + failure);
        check(failures.Count == 0 && ran > 150, "every Script As case matches its golden on SQL Server " + major + " (" + ran + " cases): " + string.Join("; ", failures.Take(6)));

        // Each module's stored text appears byte for byte in its CREATE and ALTER scripts, after SMO's own header.
        var mismatched = new List<string>();
        var modules = 0;
        foreach (var (item, target, result) in results.Values.Where(entry => entry.Case.Verb is "create" or "alter"
            && entry.Case.Target.Kind is "view" or "procedure" or "function" or "trigger" or "databaseTrigger" or "serverTrigger"))
        {
            var definition = (await sql(DefinitionQuery(target), target.Kind == "serverTrigger" ? "master" : db)).Scalar;
            modules++;
            if (definition is null || !result.Text!.Contains(Tail(definition, target.Kind), StringComparison.Ordinal)) mismatched.Add(item.Id);
        }
        check(mismatched.Count == 0 && modules > 15, "module definitions survive scripting byte for byte, mixed line endings included (" + modules + " scripts): " + string.Join(", ", mismatched));
        var big = await client.Script(new ObjectRefDto("procedure", db, "dbo", "usp_Big"), "create");
        check(Ok(big) && big.Text!.Length > 1_500_000 && big.Commands < 40, "a 3,000,000-byte procedure scripts in full (" + big.Commands + " commands)");

        await RoundTripAsync(check, client, scratch, sql, file.Cases, golden);
        await CrossDatabaseAsync(check, client, scratch, sql);
        await RecreateAsync(check, client, scratch, sql);
        await LowPrivilegeAsync(check, service, scratch, sql, live, json);
        await PerformanceAsync(check, service, client, db, timings);
    }

    private static bool Parses(string text)
    {
        try { SqlScript.Parse(text); return true; }
        catch (RequestException error) when (error.Code == "INVALID_SCRIPT") { return false; }
    }

    /// <summary>The query reading a module's stored definition.</summary>
    private static string DefinitionQuery(ObjectRefDto target)
    {
        string Text(string value) => "N'" + value.Replace("'", "''") + "'";
        return target.Kind switch
        {
            "databaseTrigger" => "SELECT m.definition FROM sys.sql_modules AS m JOIN sys.triggers AS t ON t.object_id = m.object_id WHERE t.parent_class = 0 AND t.name = " + Text(target.Name!) + ";",
            "serverTrigger" => "SELECT m.definition FROM sys.server_sql_modules AS m JOIN sys.server_triggers AS t ON t.object_id = m.object_id WHERE t.name = " + Text(target.Name!) + ";",
            _ => "SELECT definition FROM sys.sql_modules WHERE object_id = OBJECT_ID(" + Text("[" + (target.Schema ?? target.Parent!.Schema).Replace("]", "]]") + "].[" + target.Name!.Replace("]", "]]") + "]") + ");"
        };
    }

    [GeneratedRegex(@"\bCREATE\s+(?:OR\s+ALTER\s+)?(?:PROC|PROCEDURE|FUNCTION|VIEW|TRIGGER)\s+(?:\[(?:[^\]]|\]\])*\]|""[^""]*""|[\w@#$]+)(?:\s*\.\s*(?:\[(?:[^\]]|\]\])*\]|""[^""]*""|[\w@#$]+))*",
        RegexOptions.IgnoreCase)]
    private static partial Regex ModuleHeader();

    /// <summary>A module's stored text from where SMO stops rewriting it: after the name for procedures and functions
    /// (SMO writes the name schema-qualified, or the new one after sp_rename); after the AS that follows the name for
    /// views and triggers (SMO also qualifies the trigger's table and puts a view's body on a line of its own).</summary>
    private static string Tail(string definition, string kind)
    {
        var header = ModuleHeader().Match(definition);
        if (!header.Success) return definition;
        var rest = definition[(header.Index + header.Length)..];
        if (kind is "procedure" or "function") return rest;
        var keyword = Regex.Match(rest, @"\bAS\b", RegexOptions.IgnoreCase);
        return keyword.Success ? rest[(keyword.Index + keyword.Length)..].TrimStart() : rest;
    }

    /// <summary>Scripts schema objects with USE off, runs them in order into an empty database, scripts the copies, and
    /// compares; the crafted name's DROP TABLE must not run.</summary>
    private static async Task RoundTripAsync(Action<bool, string> check, Client client, ScratchDatabase scratch, Func<string, string, Task<SqlRun>> sql, List<ScriptCase> cases,
        GoldenText golden)
    {
        var copy = await scratch.CreateRoundTripAsync();
        // SMO writes SET ANSI_PADDING OFF after a table and turns it back on only before indexes on padded columns, so
        // a filtered index on another column (Sales.Orders) fails to create; without the SET commands the session's ON holds.
        // Partition schemes are scripted so the partitioned table comes back partitioned.
        var options = client.Options with { ScriptUseDatabase = false, GenerateAnsiPadding = false, ScriptPartitionSchemes = true };
        var participants = cases.Where(item => item.RoundTrip is not null && (item.MinMajor ?? 0) <= scratch.Major).OrderBy(item => item.RoundTrip).ToList();
        var problems = new List<string>();
        var originals = new List<(ScriptCase Case, string Text)>();
        foreach (var item in participants)
        {
            var original = await client.Script(Resolve(item.Target, scratch.Name), item.Verb, options);
            if (!Ok(original)) { problems.Add(item.Id + ": " + original.Error?.Message); continue; }
            var run = await sql(original.Text!, copy);
            if (run.Status != "completed") problems.Add(item.Id + " did not run: " + run.Error);
            originals.Add((item, original.Text!));
        }
        // A module created from a script keeps the blank line after GO as its first line, as it does in SSMS, and SMO
        // ends a view's body with a blank line, so each round trip adds one: blank lines around GO are compared as one.
        string Same(string text) => BlankLines().Replace(golden.Normalize(text), "\nGO\n\n");
        foreach (var (item, text) in originals)
        {
            var again = await client.Script(Resolve(item.Target, copy), item.Verb, options);
            if (!Ok(again)) problems.Add(item.Id + " copy: " + again.Error?.Message);
            else if (Same(again.Text!) != Same(text)) problems.Add(item.Id + " copy differs at " + GoldenText.FirstDifference(Same(text), Same(again.Text!)));
        }
        foreach (var problem in problems) Console.Error.WriteLine("Script As round trip: " + problem);
        var victim = (await sql("SELECT COUNT(*) FROM sys.tables WHERE name IN (N'Victim', N'x*/ DROP TABLE dbo.Victim /*');", copy)).Scalar;
        check(problems.Count == 0 && participants.Count >= 20 && victim == "2",
            "Script As round-trips " + participants.Count + " schema objects through a second database, and a name built to drop a table drops nothing: " + string.Join("; ", problems.Take(4)));
    }

    /// <summary>Generate script for dependent objects follows a three-part name into another database, so the definition
    /// check runs in each database a dependent lives in (spec F): the scratch database's 8,000,000-byte function is
    /// refused before SMO loads it, here from a view in the round-trip database.</summary>
    private static async Task CrossDatabaseAsync(Action<bool, string> check, Client client, ScratchDatabase scratch, Func<string, string, Task<SqlRun>> sql)
    {
        var copy = scratch.RoundTrip;
        var setup = await sql("CREATE VIEW dbo.vCrossLarge AS SELECT One FROM [" + scratch.Name + "].dbo.fn_Large();\nGO\nCREATE SYNONYM dbo.synLarge FOR [" + scratch.Name + "].dbo.fn_Large;\nGO\n"
            + "CREATE VIEW dbo.vSynonymLarge AS SELECT One FROM dbo.synLarge();", copy);
        var dependents = client.Options with { GenerateDependentObjects = true };
        var allocated = GC.GetTotalAllocatedBytes(true);
        var cross = await client.Script(new ObjectRefDto("view", copy, "dbo", "vCrossLarge"), "create", dependents);
        var synonym = await client.Script(new ObjectRefDto("view", copy, "dbo", "vSynonymLarge"), "create", dependents);
        allocated = GC.GetTotalAllocatedBytes(true) - allocated;
        check(setup.Status == "completed" && cross.Error is { Code: "TOO_LARGE" } && cross.Error.Message == "The definition of dbo.fn_Large is larger than 8 MB, which Varia cannot open. "
            + "Turn off Generate script for dependent objects in Tools › Options › Scripting and try again." && (Ok(synonym) || synonym.Error?.Code == "TOO_LARGE") && allocated < 48_000_000,
            "a dependent in another database over 8,000,000 bytes is refused before SMO loads it, through a three-part name or a synonym (" + allocated / 1_000_000 + " MB allocated): "
            + (setup.Error ?? cross.Error?.Message) + " " + synonym.Error?.Message);
    }

    /// <summary>Runs the round-trip database's DROP And CREATE script on master: the database comes back with its marker
    /// (SMO adds it after USE of the database), master gains no extended property, and the script ends in master.</summary>
    private static async Task RecreateAsync(Action<bool, string> check, Client client, ScratchDatabase scratch, Func<string, string, Task<SqlRun>> sql)
    {
        const string marker = "SELECT COUNT(*) FROM sys.extended_properties WHERE class = 0 AND name = N'varia.scratch';";
        var before = (await sql(marker, "master")).Scalar;
        var script = await client.Script(new ObjectRefDto("database", Name: scratch.RoundTrip), "dropAndCreate");
        // Pooled sessions of the round trip may still be in the database, which DROP DATABASE would wait for.
        await sql("ALTER DATABASE [" + scratch.RoundTrip + "] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;", "master");
        var run = Ok(script) ? await sql(script.Text!, "master") : null;
        var master = (await sql(marker, "master")).Scalar;
        var recreated = (await sql(marker, scratch.RoundTrip)).Scalar;
        if (master != before && before == "0") await sql("EXEC sys.sp_dropextendedproperty @name = N'varia.scratch';", "master");
        var uses = Ok(script) ? Regex.Matches(script.Text!, @"^USE \[(.*)\]\r?$", RegexOptions.Multiline) : null;
        check(run?.Status == "completed" && master == before && recreated == "1" && uses is { Count: > 2 } && uses[^1].Groups[1].Value == "master",
            "a database's DROP And CREATE script recreates it with its extended property, adds none to master, and ends in master: " + (script.Error?.Message ?? run?.Error) + " master " + before + "→" + master);
    }

    /// <summary>The low-privilege login of the scratch fixture (spec G4): EXECUTE on one procedure, SELECT on one table.</summary>
    private static async Task LowPrivilegeAsync(Action<bool, string> check, SqlService service, ScratchDatabase scratch, Func<string, string, Task<SqlRun>> sql,
        Func<string, ConnectOptions> live, JsonSerializerOptions json)
    {
        if (scratch.Login is not { } login)
        {
            Console.WriteLine("Low-privilege scripting checks skipped: the server accepts Windows logins only.");
            return;
        }
        var user = "[" + login + "]";
        var granted = await sql("GRANT EXECUTE ON Sales.usp_Orders TO " + user + ";\nGRANT SELECT ON dbo.Compressed TO " + user + ";\nGRANT SELECT ON dbo.KitchenSink TO " + user + ";", scratch.Name);
        var reader = (ConnectionInfo)await service.DispatchAsync("connections.connect", JsonSerializer.SerializeToElement(live("master") with
        {
            Authentication = "sql", Username = login, Password = scratch.Password
        }, json), json);
        try
        {
            var limited = new Client(service, reader.Id, json);
            var procedure = new ObjectRefDto("procedure", scratch.Name, "Sales", "usp_Orders");
            var hidden = await limited.Script(procedure, "create");
            check(granted.Status == "completed" && hidden.Error is { Code: "NO_DEFINITION", Retryable: false }
                && hidden.Error.Message == "You do not have permission to view the definition of Sales.usp_Orders. VIEW DEFINITION on it is required.",
                "without VIEW DEFINITION a procedure's CREATE is NO_DEFINITION");
            var execute = await limited.Script(procedure, "execute");
            check(Ok(execute) && execute.Text!.Contains("EXECUTE @RC = [Sales].[usp_Orders] ", StringComparison.Ordinal), "EXECUTE To needs only the parameters the login can see");
            var table = await limited.Script(new ObjectRefDto("table", scratch.Name, "dbo", "Compressed"), "create");
            check(Ok(table) && table.Text!.Contains("CREATE TABLE [dbo].[Compressed](", StringComparison.Ordinal)
                && table.Warnings.SequenceEqual(["You do not have VIEW DEFINITION permission on dbo.Compressed; parts you cannot see (for example indexes or constraints) may be missing from the script."]),
                "a table the login may only read scripts, with the VIEW DEFINITION warning: " + (table.Error?.Message ?? string.Join(" ", table.Warnings)));
            // Computed columns, defaults and checks are text only VIEW DEFINITION shows.
            var computed = await limited.Script(new ObjectRefDto("table", scratch.Name, "dbo", "KitchenSink"), "create");
            check(computed.Error is { Code: "NO_DEFINITION" }, "a readable table with computed columns and constraints is NO_DEFINITION, not a partial script: " + computed.Error?.Code);
            var select = await limited.Script(new ObjectRefDto("table", scratch.Name, "dbo", "KitchenSink"), "select");
            check(Ok(select) && select.Warnings.Count == 0, "its SELECT template needs only the columns, so it carries no VIEW DEFINITION warning: " + string.Join(" ", select.Warnings));
            await sql("GRANT VIEW DEFINITION ON Sales.usp_Orders TO " + user + ";", scratch.Name);
            check(Ok(await limited.Script(procedure, "create")), "with VIEW DEFINITION the procedure's CREATE scripts");
        }
        finally { await service.DispatchAsync("connections.disconnect", JsonSerializer.SerializeToElement(new ConnectionArgs(reader.Id), json), json); }
    }

    /// <summary>Command ceilings (not O(columns)), warm times, eight concurrent scripts on one connection, and the numbers
    /// for the PR in artifacts/scripting-perf.json.</summary>
    private static async Task PerformanceAsync(Action<bool, string> check, SqlService service, Client client, string db, List<(ScriptCase Case, long Ms, int Commands)> timings)
    {
        var sink = new ObjectRefDto("table", db, "dbo", "KitchenSink");
        var wide = new ObjectRefDto("table", db, "dbo", "Wide");
        var warm = new List<long>();
        var sinkCommands = 0;
        for (var i = 0; i < 7; i++)
        {
            var watch = Stopwatch.StartNew();
            var result = await client.Script(sink, "create");
            warm.Add(watch.ElapsedMilliseconds);
            sinkCommands = result.Commands;
        }
        var wideResult = await client.Script(wide, "create");
        var plain = await client.Script(new ObjectRefDto("table", db, "dbo", "b"), "create");
        check(sinkCommands is > 0 and <= SinkCommandCeiling && wideResult.Commands <= SinkCommandCeiling && wideResult.Commands < plain.Commands + 20,
            "a table's CREATE costs a bounded number of commands, whatever its width (kitchen sink " + sinkCommands + ", 300 columns and 20 indexes " + wideResult.Commands
            + ", two columns " + plain.Commands + ", with 2,500 other tables in the database)");
        var p50 = Percentile(warm, 0.5);
        check(p50 <= 3000, "a warm table CREATE takes at most 3 s at the median (" + p50 + " ms)");
        var templates = timings.Where(item => item.Case.Verb is "select" or "insert" or "update" or "delete" or "execute" && item.Case.ExpectError is null).ToList();
        var slowest = templates.Count == 0 ? 0 : templates.Max(item => item.Ms);
        check(templates.Count > 20 && slowest <= 500 && templates.All(item => item.Commands == 2), "templates take one round trip after the prologue and at most 500 ms (" + slowest + " ms)");

        var peak = 0;
        using var sampling = new CancellationTokenSource();
        var sampler = Task.Run(async () => { while (!sampling.IsCancellationRequested) { peak = Math.Max(peak, service.Scripting.ActiveJobs); await Task.Delay(10); } });
        var concurrent = Stopwatch.StartNew();
        var all = await Task.WhenAll(Enumerable.Range(0, 8).Select(_ => client.Script(sink, "create")));
        concurrent.Stop();
        sampling.Cancel();
        await sampler;
        check(all.All(Ok) && all.Select(result => Normalize(result.Text!)).Distinct().Count() == 1 && peak <= 2, "eight scripts on one connection all complete, two at a time (peak " + peak + ", " + concurrent.ElapsedMilliseconds + " ms)");

        var first = timings.Count == 0 ? 0 : timings[0].Ms;
        var tables = timings.Where(item => item.Case.Target.Kind == "table" && item.Case.Verb == "create" && item.Case.ExpectError is null).Select(item => item.Ms).ToList();
        var report = new JsonObject
        {
            ["firstCaseMs"] = first,
            ["kitchenSinkCreateMs"] = new JsonObject { ["p50"] = p50, ["p95"] = Percentile(warm, 0.95), ["runs"] = warm.Count },
            ["tableCreateCasesMs"] = new JsonObject { ["p50"] = Percentile(tables, 0.5), ["p95"] = Percentile(tables, 0.95), ["count"] = tables.Count },
            ["templateMaxMs"] = slowest,
            ["commands"] = new JsonObject { ["kitchenSinkCreate"] = sinkCommands, ["wideCreate"] = wideResult.Commands, ["plainCreate"] = plain.Commands },
            ["concurrent8Ms"] = concurrent.ElapsedMilliseconds,
            ["cases"] = new JsonArray([.. timings.Select(item => (JsonNode)new JsonObject { ["id"] = item.Case.Id, ["ms"] = item.Ms, ["commands"] = item.Commands })])
        };
        var artifacts = Path.Combine(GoldenText.Repository(), "artifacts");
        Directory.CreateDirectory(artifacts);
        File.WriteAllText(Path.Combine(artifacts, "scripting-perf.json"), report.ToJsonString(new JsonSerializerOptions { WriteIndented = true }) + "\n", new UTF8Encoding(false));
        Console.WriteLine("Script As performance: first case " + first + " ms, kitchen sink CREATE p50 " + p50.ToString(CultureInfo.InvariantCulture) + " ms, "
            + sinkCommands + " commands; artifacts/scripting-perf.json");
    }
}
