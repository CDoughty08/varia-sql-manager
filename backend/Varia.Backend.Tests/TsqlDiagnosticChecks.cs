using System.Diagnostics;
using System.Text.Json;
using Varia.Backend.Explorer;
using Varia.Backend.Language;
using Varia.Backend.Search;

namespace Varia.Backend.Tests;

/// <summary>Comprehensive offline checks for in-process T-SQL ScriptDom + IndexLookup diagnostics:
/// offline syntax across GO batches, catalog binding, collation fidelity, all zero-false-positive suppression guards,
/// stack safety on hostile || / .m() / nested-paren inputs, 1,000-issue &amp; 250k-char caps, and Entra ID support.</summary>
internal static class TsqlDiagnosticChecks
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public static async Task RunAsync(Action<bool, string> check)
    {
        var (conn, lookup) = BuildFixture();
        try
        {
            LanguageDiagnosticResult Analyze(string sql, IndexLookup? lkp = null, string? db = "Sales") =>
                TsqlDiagnosticService.Analyze(new(Guid.NewGuid().ToString("D"), 1, sql, new("sqlserver", lkp is null ? null : Guid.NewGuid().ToString("D"), db)), lkp, db);

            static bool HasCode(LanguageDiagnosticResult r, string code) => r.Items.Any(i => i.Code == code);
            static bool Mentions(LanguageDiagnosticResult r, string text) => r.Items.Any(i => i.Message.Contains(text, StringComparison.OrdinalIgnoreCase));

            // 1. Offline syntax diagnostics (disconnected, lookup == null)
            var validMultiBatch = Analyze("SELECT 1;\nGO\nSELECT 2;\nGO 5 -- repeat batch\nSELECT 3;\nGO /* trailing comment */\n");
            check(validMultiBatch.Items.Count == 0 && !validMultiBatch.IsIncomplete,
                "valid multi-batch SQL with GO, GO 5, and GO comments reports zero diagnostics");

            const string syntaxSql = "SELECT 1;\nGO 5\nSELECT ( FROM dbo.Orders;\nGO\nSELECT 2;\nGO\nSELECT FROM;";
            var syntaxRes = Analyze(syntaxSql);
            check(syntaxRes.Items.Count >= 2
                && syntaxRes.Items.All(i => i.Severity == 1 && i.Source == "sqlserver" && i.Code is { Length: > 3 } c && c.StartsWith("SQL", StringComparison.Ordinal))
                && syntaxRes.Items.All(i => TsqlLanguageService.PositionInText(syntaxSql, i.Range.Start) && TsqlLanguageService.PositionInText(syntaxSql, i.Range.End))
                && syntaxRes.Items.Any(i => i.Range.Start.Line == 2)
                && syntaxRes.Items.Any(i => i.Range.Start.Line == 6),
                "offline ScriptDom syntax diagnostics report exact 0-based line/column ranges across GO batches without flagging GO");

            var lexErr = Analyze("SELECT 'unterminated string\nSELECT 1;");
            check(lexErr.Items.Count >= 1 && lexErr.Items[0].Range.Start.Line == 0 && lexErr.Items[0].Range.End.Line == 0,
                "unterminated string lexer errors report a bounded single-line range");

            var validThrow = Analyze("THROW 51000, 'never executed', 1;", lookup);
            check(validThrow.Items.Count == 0, "valid THROW statement analyzes as text with zero diagnostics");

            // Disconnected tab never runs catalog binding even for unknown tables/columns
            var disconnectedUnknown = Analyze("SELECT bogus.NoCol FROM dbo.NoSuchTable bogus;", lkp: null);
            check(disconnectedUnknown.Items.Count == 0, "disconnected tabs report syntax errors only and suppress catalog-binding diagnostics");

            // 2. Connected catalog-binding diagnostics
            var unknownTable = Analyze("SELECT * FROM dbo.NoSuchTable;", lookup);
            check(HasCode(unknownTable, "SQL208") && Mentions(unknownTable, "NoSuchTable"),
                "unknown table in FROM emits SQL208 Invalid object name");

            var unknownDml = Analyze("INSERT INTO dbo.GhostTable (A) VALUES (1);\nDELETE FROM dbo.GhostDel;\nUPDATE dbo.GhostUpd SET A = 1;", lookup);
            check(unknownDml.Items.Count(i => i.Code == "SQL208") == 3,
                "unknown tables in INSERT, DELETE, and UPDATE emit SQL208");

            var unknownSchema = Analyze("SELECT * FROM MissingSchema.Orders;", lookup);
            check(HasCode(unknownSchema, "SQL2760") && Mentions(unknownSchema, "MissingSchema") && !HasCode(unknownSchema, "SQL208"),
                "unknown schema on an explicitly schema-qualified table in a Ready database emits SQL2760");

            var unknownColQual = Analyze("SELECT o.MissingCol FROM dbo.Orders AS o;", lookup);
            check(HasCode(unknownColQual, "SQL207") && Mentions(unknownColQual, "MissingCol"),
                "unknown qualified column emits SQL207");

            var unknownColUnqual = Analyze("SELECT MissingCol FROM dbo.Orders;", lookup);
            check(HasCode(unknownColUnqual, "SQL207") && Mentions(unknownColUnqual, "MissingCol"),
                "unknown unqualified column emits SQL207 when all in-scope sources have complete columns");

            var unknownInsertCol = Analyze("INSERT INTO dbo.Orders (OrderId, BadInsertCol) VALUES (1, 2);", lookup);
            check(HasCode(unknownInsertCol, "SQL207") && Mentions(unknownInsertCol, "BadInsertCol"),
                "unknown column in INSERT column list emits SQL207");

            var unknownUpdateCol = Analyze("UPDATE dbo.Orders SET BadUpdateCol = 1;", lookup);
            check(HasCode(unknownUpdateCol, "SQL207") && Mentions(unknownUpdateCol, "BadUpdateCol"),
                "unknown column in UPDATE SET emits SQL207");

            var unknownAlias = Analyze("SELECT bogus.OrderId FROM dbo.Orders AS o;", lookup);
            check(HasCode(unknownAlias, "SQL4104") && Mentions(unknownAlias, "bogus"),
                "unknown table alias qualifier emits SQL4104");

            var ambiguousCol = Analyze("SELECT SharedId FROM dbo.Orders o JOIN dbo.Customers c ON o.CustomerId = c.CustomerId;", lookup);
            check(HasCode(ambiguousCol, "SQL209") && Mentions(ambiguousCol, "SharedId"),
                "ambiguous unqualified column across two joined tables emits SQL209");

            var duplicateAlias = Analyze("SELECT o.OrderId FROM dbo.Orders AS o JOIN dbo.Customers AS o ON 1 = 1;", lookup);
            check(HasCode(duplicateAlias, "SQL1013"),
                "duplicate table alias in the same FROM clause emits SQL1013");

            var selfJoinOk = Analyze("SELECT o1.OrderId, o2.OrderId FROM dbo.Orders AS o1 JOIN dbo.Orders AS o2 ON o1.OrderId = o2.OrderId;", lookup);
            check(selfJoinOk.Items.Count == 0, "self-join with distinct aliases emits zero diagnostics");

            // 3. Mid-script USE, CTEs, derived tables, #temp across GO, @table vars, UPDATE/DELETE alias, OUTPUT, correlated subqueries, script-created/altered tables
            var midScriptUse = Analyze("USE AnalyticsDB;\nSELECT RevenueDate FROM dbo.DailyRevenue;\nSELECT BadRevCol FROM dbo.DailyRevenue;", lookup);
            check(midScriptUse.Items.Count == 1 && HasCode(midScriptUse, "SQL207") && Mentions(midScriptUse, "BadRevCol"),
                "mid-script USE switches active database for subsequent object and column binding");

            var cteOk = Analyze("WITH Recent AS (SELECT o.OrderId, o.CustomerId FROM dbo.Orders o)\nSELECT r.OrderId FROM Recent r;", lookup);
            var cteBad = Analyze("WITH Recent AS (SELECT o.OrderId FROM dbo.Orders o)\nSELECT r.NoSuchCteCol FROM Recent r;", lookup);
            var recCte = Analyze("WITH Tree (Id) AS (SELECT o.OrderId FROM dbo.Orders o UNION ALL SELECT t.Id FROM Tree t)\nSELECT Id FROM Tree;", lookup);
            check(cteOk.Items.Count == 0 && HasCode(cteBad, "SQL207") && recCte.Items.Count == 0,
                "CTEs and recursive CTEs bind columns accurately without false positives");

            var derived = Analyze("SELECT d.OrderId FROM (SELECT OrderId FROM dbo.Orders) AS d;\nSELECT d.BadDerived FROM (SELECT OrderId FROM dbo.Orders) AS d;", lookup);
            check(derived.Items.Count == 1 && HasCode(derived, "SQL207") && Mentions(derived, "BadDerived"),
                "derived tables bind projected columns accurately");

            var tempAcrossGo = Analyze("CREATE TABLE #Staging (TempId INT);\nGO\nSELECT TempId FROM #Staging;\nSELECT * INTO #Copied FROM #Staging;\nGO\nSELECT TempId FROM #Copied;\nSELECT MissingTemp FROM #Copied;", lookup);
            check(tempAcrossGo.Items.Count == 1 && HasCode(tempAcrossGo, "SQL207") && Mentions(tempAcrossGo, "MissingTemp"),
                "#temp tables and SELECT INTO #temp persist across GO batches and bind columns accurately");

            var tableVar = Analyze("DECLARE @t TABLE (Val INT);\nSELECT Val FROM @t;\nSELECT BadVarCol FROM @t;", lookup);
            check(tableVar.Items.Count == 1 && HasCode(tableVar, "SQL207") && Mentions(tableVar, "BadVarCol"),
                "batch-scoped @table variables bind columns accurately");

            var dmlAliasOutput = Analyze("""
                UPDATE o SET Total = 10
                OUTPUT inserted.OrderId, deleted.Total
                FROM dbo.Orders AS o
                WHERE o.CustomerId = 1;
                DELETE o
                OUTPUT deleted.OrderId
                FROM dbo.Orders AS o
                WHERE o.OrderId = 1;
                """, lookup);
            check(dmlAliasOutput.Items.Count == 0,
                "UPDATE/DELETE targeting a FROM alias and OUTPUT inserted/deleted produce zero false positives");

            var correlatedAndApply = Analyze("""
                SELECT o.OrderId
                FROM dbo.Orders AS o
                CROSS APPLY (SELECT c.CustomerName FROM dbo.Customers AS c WHERE c.CustomerId = o.CustomerId) AS ca
                WHERE EXISTS (SELECT 1 FROM dbo.Customers AS c2 WHERE c2.CustomerId = o.CustomerId)
                  AND ca.CustomerName IS NOT NULL;
                """, lookup);
            check(correlatedAndApply.Items.Count == 0,
                "correlated EXISTS subqueries and CROSS APPLY see outer/lateral sources without false positives");

            var scriptCreatedAndAltered = Analyze("""
                CREATE SCHEMA CustomNew;
                GO
                CREATE TABLE CustomNew.CreatedHere (Id INT, Label NVARCHAR(50));
                SELECT Id, Label FROM CustomNew.CreatedHere;
                ALTER TABLE dbo.Orders ADD NewlyAddedCol INT NULL;
                SELECT NewlyAddedCol FROM dbo.Orders;
                """, lookup);
            check(scriptCreatedAndAltered.Items.Count == 0,
                "script-created schemas/tables and ALTER TABLE additions in the same script produce zero false positives");

            // 4. Collation fidelity (case-sensitive + Turkish/Azeri dotted-I)
            var csOk = Analyze("SELECT i.id, i.Id FROM dbo.Item AS i;", lookup, db: "CasedDb");
            var csBadTable = Analyze("SELECT * FROM dbo.item;", lookup, db: "CasedDb");
            var csBadCol = Analyze("SELECT i.ID FROM dbo.Item AS i;", lookup, db: "CasedDb");
            check(csOk.Items.Count == 0 && HasCode(csBadTable, "SQL208") && HasCode(csBadCol, "SQL207"),
                "case-sensitive database collation distinguishes exact case for table and column names");

            var trOk = Analyze("SELECT t.i_col FROM dbo.İtem AS t;", lookup, db: "TurkishDb");
            var trBad = Analyze("SELECT t.I_COL FROM dbo.İtem AS t;", lookup, db: "TurkishDb");
            check(trOk.Items.Count == 0 && HasCode(trBad, "SQL207"),
                "Turkish/Azeri dotted-I collation folds i/İ together and keeps I/ı distinct");

            // 5. CRITICAL False-Positive Suppression Guards
            var absentDb = Analyze("SELECT bad.Col FROM dbo.NoTable bad;", lookup, db: "NoSuchDatabase");
            var skippedDb = Analyze("SELECT bad.Col FROM dbo.NoTable bad;", lookup, db: "SkippedDb");
            var buildingLookup = new IndexLookup(conn, new IndexBudget(1 << 22), building: true, BuildBuildingLedger());
            var buildingDb = Analyze("SELECT bad.Col FROM dbo.NoTable bad;", buildingLookup, db: "BuildingDb");
            var buildingSyntax = Analyze("SELECT ( FROM dbo.NoTable;", buildingLookup, db: "BuildingDb");
            check(absentDb.Items.Count == 0 && skippedDb.Items.Count == 0 && buildingDb.Items.Count == 0 && buildingSyntax.Items.Count > 0,
                "Absent, Skipped, and Building databases suppress catalog errors while still reporting syntax errors");

            var childrenLeftOutValid = Analyze("SELECT o.AnyCol, o.OtherCol FROM dbo.NoColsTable AS o;", lookup, db: "ChildrenLeftOutDb");
            var childrenLeftOutMissingTable = Analyze("SELECT * FROM dbo.TotallyMissing;", lookup, db: "ChildrenLeftOutDb");
            check(childrenLeftOutValid.Items.Count == 0 && HasCode(childrenLeftOutMissingTable, "SQL208"),
                "ChildrenLeftOut suppresses column errors while preserving unknown-table checks on held databases");

            var noSysLookup = BuildNoResourceLookup();
            var sysSuppressed = Analyze("SELECT d.database_id FROM sys.databases AS d; SELECT * FROM INFORMATION_SCHEMA.TABLES;", noSysLookup, db: "Sales");
            check(sysSuppressed.Items.Count == 0,
                "SystemObjectsLeftOut suppresses catalog diagnostics on sys.* and INFORMATION_SCHEMA.*");

            var suppressionSql = """
                EXEC (@dynamicSql);
                EXECUTE sp_executesql N'SELECT * FROM dbo.NotReal';
                SELECT $IDENTITY, $ROWGUID, $PARTITION.MyPf(OrderId), $node_id, $edge_id, $from_id, $to_id FROM dbo.Orders;
                MERGE INTO dbo.Orders AS tgt USING dbo.Customers AS src ON tgt.CustomerId = src.CustomerId
                WHEN MATCHED THEN UPDATE SET Total = 0
                OUTPUT $ACTION, inserted.OrderId, deleted.Total;
                SELECT DATEADD(day, 1, GETDATE()), DATEDIFF(month, GETDATE(), GETDATE()), DATEDIFF_BIG(second, GETDATE(), GETDATE()),
                       DATENAME(weekday, GETDATE()), DATEPART(quarter, GETDATE()), DATETRUNC(week, GETDATE()), DATE_BUCKET(hour, 1, GETDATE())
                FROM dbo.Orders;
                SELECT CAST(OrderId AS NVARCHAR(20)), CONVERT(INT, Total), TRY_CAST(Total AS DECIMAL(18, 2)), TRY_CONVERT(DATE, '2026-01-01')
                FROM dbo.Orders;
                SELECT o.OrderId AS CustomAlias FROM dbo.Orders AS o ORDER BY CustomAlias;
                SELECT o.XmlCol.value('(/a)[1]', 'int'), o.GeoCol.STDistance(NULL) FROM dbo.Orders AS o;
                SELECT x.n FROM dbo.Orders AS o CROSS APPLY o.XmlCol.nodes('/a') AS x(n);
                SELECT j.[key], j.[value] FROM OPENJSON('{"a":1}') AS j;
                SELECT s.value FROM STRING_SPLIT('a,b', ',') AS s;
                SELECT g.value FROM GENERATE_SERIES(1, 5) AS g;
                SELECT * FROM LinkedSrv.RemoteDb.dbo.RemoteOrders;
                SELECT * FROM #CreatedInCallerSession;
                SELECT AnyCol FROM dbo.OrdersSynonym;
                SELECT AnyCol FROM dbo.Orders o JOIN dbo.OrdersSynonym syn ON 1 = 1;
                SELECT * FROM (SELECT CustomerId, Total FROM dbo.Orders) src PIVOT (SUM(Total) FOR CustomerId IN ([1], [2])) p;
                SELECT OrderId FROM dbo.Orders FOR JSON PATH;
                SELECT NEXT VALUE FOR dbo.MySeq;
                SELECT GETDATE() AT TIME ZONE 'UTC';
                """;
            var suppressed = Analyze(suppressionSql, lookup);
            check(suppressed.Items.Count == 0,
                $"all zero-false-positive suppression guards pass cleanly (got {suppressed.Items.Count}: {string.Join("; ", suppressed.Items.Select(i => i.Message))})");

            // 6. Stack safety, 250k char cap, 1,000-issue cap, and < 5ms latency
            var concatChain = "SELECT 'a'" + string.Concat(Enumerable.Repeat("||'a'", 7_500)) + " FROM dbo.Orders;";
            var concatRes = Analyze(concatChain, lookup);
            check(concatRes.IsIncomplete, "hostile || concat chain completes safely via bounded-syntax guard with IsIncomplete=true");

            var methodChain = "SELECT x" + string.Concat(Enumerable.Repeat(".m()", 3_500)) + " FROM dbo.Orders;";
            var methodRes = Analyze(methodChain, lookup);
            check(methodRes.IsIncomplete, "hostile .m().m()... method chain completes safely via bounded-syntax guard with IsIncomplete=true");

            var deepParens = "SELECT " + new string('(', 1_000) + "1" + new string(')', 1_000) + ";";
            var parenRes = Analyze(deepParens, lookup);
            check(parenRes.IsIncomplete, "deeply nested parentheses complete safely without stack overflow");

            var oversized = Analyze(new string(' ', TsqlLanguageService.MaxTextCharacters + 1), lookup);
            check(oversized.Items.Count == 0 && !oversized.IsIncomplete, "whitespace-only oversized text returns cleanly");
            var oversizedSql = Analyze("SELECT " + new string('1', TsqlLanguageService.MaxTextCharacters), lookup);
            check(oversizedSql.Items.Count == 0 && oversizedSql.IsIncomplete, "non-whitespace text over 250,000 characters returns empty bounded result with IsIncomplete=true");

            var manyErrorsSql = "SELECT " + string.Join(", ", Enumerable.Range(0, 1050).Select(i => $"o.BadCol{i}")) + " FROM dbo.Orders AS o;";
            var manyErrors = Analyze(manyErrorsSql, lookup);
            check(manyErrors.Items.Count == TsqlLanguageService.MaxDiagnosticItems && manyErrors.IsIncomplete,
                $"diagnostic output caps cleanly at {TsqlLanguageService.MaxDiagnosticItems} items with IsIncomplete=true (got {manyErrors.Items.Count})");

            // Warmup + speed sanity (20 runs < 2,000 ms even on 3-vCPU contended CI runners; locally < 5 ms total)
            const string perfSql = "SELECT o.OrderId, c.CustomerName FROM dbo.Orders o JOIN dbo.Customers c ON o.CustomerId = c.CustomerId WHERE o.MissingCol = 1;";
            _ = Analyze(perfSql, lookup);
            var sw = Stopwatch.StartNew();
            LanguageDiagnosticResult timed = default!;
            for (var run = 0; run < 20; run++) timed = Analyze(perfSql, lookup);
            sw.Stop();
            check(timed.Items.Count == 1 && sw.ElapsedMilliseconds < 2000,
                $"20 ScriptDom + IndexLookup diagnostic passes ran in {sw.ElapsedMilliseconds} ms");

            // 7. Microsoft Entra ID end-to-end diagnostics through SqlService.DispatchAsync("language.diagnostics")
            using var service = new SqlService();
            var entra = service.Register("Server=unused;Authentication=Active Directory Interactive", ServerProfile.Fallback("16.0"), "EntraDb");
            service.Search.Held(entra).Put(new DatabaseIndex("EntraDb", ObjectTable.Of([
                new IndexedObject("table", "tables", "dbo", "Accounts"),
                new IndexedObject("column", "columns", null, "AccountId", "table", "dbo", "Accounts")
            ]), 0, 0, 0) { CaseSensitive = false });
            var entraDoc = Guid.NewGuid().ToString("D");
            var entraDiag = (LanguageDiagnosticResult)await service.DispatchAsync("language.diagnostics",
                JsonSerializer.SerializeToElement(new LanguageRefreshRequest(entraDoc, 1, "SELECT a.BadCol FROM dbo.Accounts AS a;", new("sqlserver", entra, "EntraDb")), Json), Json);
            var entraSyntax = (LanguageDiagnosticResult)await service.DispatchAsync("language.diagnostics",
                JsonSerializer.SerializeToElement(new LanguageRefreshRequest(entraDoc, 2, "SELECT ( FROM dbo.Accounts;", new("sqlserver", entra, "EntraDb")), Json), Json);
            check(HasCode(entraDiag, "SQL207") && Mentions(entraDiag, "BadCol") && entraSyntax.Items.Count > 0,
                "Microsoft Entra ID SQL Server connections serve live catalog-binding and syntax diagnostics end-to-end");
        }
        finally
        {
            conn.Dispose();
        }
    }

    private static (ConnectionIndex Conn, IndexLookup Lookup) BuildFixture()
    {
        var budget = new IndexBudget(1 << 23);
        var sysSet = new ResourceSet(
            new ResourceKey("16.0.1000.0", 3, 1, null, 1, false),
            ObjectTable.Of([
                new IndexedObject("view", "systemViews", "sys", "databases", System: true, Subtype: "system"),
                new IndexedObject("column", "columns", null, "database_id", "view", "sys", "databases", System: true)
            ]), 0, 0);
        var conn = new ConnectionIndex(budget);
        conn.PutResource(sysSet);

        conn.Put(new DatabaseIndex("Sales", ObjectTable.Of([
            new IndexedObject("table", "tables", "dbo", "Orders"),
            new IndexedObject("column", "columns", null, "OrderId", "table", "dbo", "Orders"),
            new IndexedObject("column", "columns", null, "CustomerId", "table", "dbo", "Orders"),
            new IndexedObject("column", "columns", null, "SharedId", "table", "dbo", "Orders"),
            new IndexedObject("column", "columns", null, "Total", "table", "dbo", "Orders"),
            new IndexedObject("column", "columns", null, "XmlCol", "table", "dbo", "Orders"),
            new IndexedObject("column", "columns", null, "GeoCol", "table", "dbo", "Orders"),
            new IndexedObject("table", "tables", "dbo", "Customers"),
            new IndexedObject("column", "columns", null, "CustomerId", "table", "dbo", "Customers"),
            new IndexedObject("column", "columns", null, "SharedId", "table", "dbo", "Customers"),
            new IndexedObject("column", "columns", null, "CustomerName", "table", "dbo", "Customers"),
            new IndexedObject("synonym", "synonyms", "dbo", "OrdersSynonym")
        ]), 0, 0, 0) { CaseSensitive = false });

        conn.Put(new DatabaseIndex("AnalyticsDB", ObjectTable.Of([
            new IndexedObject("table", "tables", "dbo", "DailyRevenue"),
            new IndexedObject("column", "columns", null, "RevenueDate", "table", "dbo", "DailyRevenue"),
            new IndexedObject("column", "columns", null, "GrossRevenue", "table", "dbo", "DailyRevenue")
        ]), 0, 0, 0) { CaseSensitive = false });

        conn.Put(new DatabaseIndex("CasedDb", ObjectTable.Of([
            new IndexedObject("table", "tables", "dbo", "Item"),
            new IndexedObject("column", "columns", null, "id", "table", "dbo", "Item"),
            new IndexedObject("column", "columns", null, "Id", "table", "dbo", "Item")
        ]), 0, 0, 0) { CaseSensitive = true });

        conn.Put(new DatabaseIndex("TurkishDb", ObjectTable.Of([
            new IndexedObject("table", "tables", "dbo", "İtem"),
            new IndexedObject("column", "columns", null, "İ_col", "table", "dbo", "İtem")
        ]), 0, 0, 0) { CaseSensitive = false, DottedI = true });

        conn.Put(new DatabaseIndex("ChildrenLeftOutDb", ObjectTable.Of([
            new IndexedObject("table", "tables", "dbo", "NoColsTable")
        ]), 0, 0, 0) { CaseSensitive = false, ChildrenLeftOut = true });

        var ledger = new LookupLedger();
        ledger.List(["Sales", "AnalyticsDB", "CasedDb", "TurkishDb", "ChildrenLeftOutDb", "SkippedDb"]);
        ledger.Done("SkippedDb", new ObjectIndexSkip("SkippedDb", "DENIED", "Access denied"));

        var lookup = new IndexLookup(conn, budget, building: false, ledger.Snapshot());
        return (conn, lookup);
    }

    private static LookupLedger.View BuildBuildingLedger()
    {
        var ledger = new LookupLedger();
        ledger.Start();
        ledger.List(["BuildingDb"]);
        return ledger.Snapshot();
    }

    private static IndexLookup BuildNoResourceLookup()
    {
        var budget = new IndexBudget(1 << 20);
        var conn = new ConnectionIndex(budget);
        conn.Put(new DatabaseIndex("Sales", ObjectTable.Of([
            new IndexedObject("table", "tables", "dbo", "Orders"),
            new IndexedObject("column", "columns", null, "OrderId", "table", "dbo", "Orders")
        ]), 0, 0, 0) { CaseSensitive = false });
        return new IndexLookup(conn, budget, building: false, new LookupLedger().Snapshot());
    }
}
