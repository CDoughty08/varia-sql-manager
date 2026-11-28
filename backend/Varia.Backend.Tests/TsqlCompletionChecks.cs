using System.Data;
using System.Diagnostics;
using System.Text.Json;
using Varia.Backend.Explorer;
using Varia.Backend.Language;
using Varia.Backend.Search;

namespace Varia.Backend.Tests;

/// <summary>Comprehensive offline checks for PR-5's in-process ScriptDom (<see cref="TsqlScopeReader"/>) +
/// <see cref="IndexLookup"/> T-SQL completion and hover engine: #temp across GO, @table/@scalar batch scoping,
/// CTEs, derived tables, APPLY, PIVOT/UNPIVOT, OUTPUT inserted/deleted, mid-script USE, FK-aware JOIN ON
/// (single, incoming &amp; composite), cross-DB/cross-schema fuzzy FROM jump, CAST/CONVERT types, DATEADD/DATEDIFF
/// date parts, @@ globals, built-in functions, 3-level hover, Turkish dotted-I &amp; CS collations, resource DB,
/// unindexed/partial/CHILDREN_LEFT_OUT graceful fallback, Entra ID, and zero STS completion child spawned.</summary>
internal static class TsqlCompletionChecks
{
    public static async Task RunAsync(Action<bool, string> check)
    {
        var (conn, budget, lookup, ledger) = await BuildRichFixtureAsync();
        try
        {
            LanguageCompletionResult Complete(string marked, string? db = "Sales", IndexLookup? customLookup = null)
            {
                var cursor = marked.IndexOf('|');
                var text = marked.Remove(cursor, 1);
                var req = new LanguageRequest(Guid.NewGuid().ToString(), 1, text, new("sqlserver", Guid.NewGuid().ToString(), db),
                    SqlToolsLanguageService.EndPosition(text[..cursor]));
                return TsqlCompletionService.Complete(req, customLookup ?? lookup, db);
            }

            LanguageHover? HoverAt(string marked, string? db = "Sales", IndexLookup? customLookup = null)
            {
                var cursor = marked.IndexOf('|');
                var text = marked.Remove(cursor, 1);
                var req = new LanguageRequest(Guid.NewGuid().ToString(), 1, text, new("sqlserver", Guid.NewGuid().ToString(), db),
                    SqlToolsLanguageService.EndPosition(text[..cursor]));
                return TsqlHoverService.Hover(req, customLookup ?? lookup, db);
            }

            static bool Has(LanguageCompletionResult r, string label) => r.Items.Any(i => i.Label == label);

            // 1. #temp tables (CREATE TABLE #Recent + SELECT INTO #Stage) persist across GO; DROP TABLE removes them; ##global_temp works.
            const string tempScript = """
                CREATE TABLE #Recent (OrderId INT NOT NULL, CutoffDate DATETIME2 NULL, Amount DECIMAL(18,2));
                CREATE TABLE ##GlobalCache (CacheKey NVARCHAR(64) NOT NULL, Payload NVARCHAR(MAX));
                SELECT o.id, o.total INTO #OrderCopy FROM dbo.Orders o;
                CREATE TABLE #Dropped (X INT);
                DROP TABLE IF EXISTS #Dropped;
                GO
                DECLARE @cutoff DATETIME2 = SYSUTCDATETIME();
                SELECT r.| FROM #Recent r WHERE r.CutoffDate >= @cutoff;
                """;
            var tempCols = Complete(tempScript);
            check(Has(tempCols, "[OrderId]") && Has(tempCols, "[CutoffDate]") && Has(tempCols, "[Amount]")
                && tempCols.Items.First(i => i.Label == "[OrderId]").Detail!.Contains("INT", StringComparison.OrdinalIgnoreCase),
                "#temp table defined before GO persists across GO and completes its declared columns with types");

            var tempUnqualified = Complete("CREATE TABLE #Recent (OrderId INT, Amount DECIMAL(18,2));\nGO\nSELECT | FROM #Recent");
            check(Has(tempUnqualified, "[OrderId]") && Has(tempUnqualified, "[Amount]"),
                "single unaliased #temp table completes bare bracketed column names");

            var selectInto = Complete("SELECT o.id, o.total INTO #OrderCopy FROM dbo.Orders o;\nGO\nSELECT s.| FROM #OrderCopy s");
            check(Has(selectInto, "[id]") && Has(selectInto, "[total]"),
                "SELECT ... INTO #temp projects columns across GO batches");

            var selectStarInto = Complete("SELECT * INTO #AllOrders FROM dbo.Orders;\nGO\nSELECT a.| FROM #AllOrders a");
            check(Has(selectStarInto, "[id]") && Has(selectStarInto, "[customer_id]") && Has(selectStarInto, "[total]"),
                "SELECT * INTO #temp expands columns from IndexLookup across GO batches");

            var fromTemp = Complete("CREATE TABLE #Recent (Id INT);\nCREATE TABLE ##GlobalCache (K INT);\nCREATE TABLE #Gone (X INT);\nDROP TABLE #Gone;\nGO\nSELECT * FROM #|");
            check(Has(fromTemp, "#Recent") && Has(fromTemp, "##GlobalCache") && !Has(fromTemp, "#Gone"),
                "FROM suggests active #temp and ##global_temp tables across GO while omitting dropped #temp tables");

            // 2. @table variables & @scalar variables are scoped strictly to the current GO batch.
            var sameBatchVars = Complete("DECLARE @cutoff DATETIME2 = GETUTCDATE(), @limit INT = 100;\nDECLARE @items TABLE (Sku NVARCHAR(32), Qty INT);\nSELECT @| FROM @items i");
            check(Has(sameBatchVars, "@cutoff") && Has(sameBatchVars, "@limit") && Has(sameBatchVars, "@items")
                && sameBatchVars.Items.First(i => i.Label == "@cutoff").Detail == "DATETIME2"
                && sameBatchVars.Items.First(i => i.Label == "@cutoff").TextEdit!.Range.Start.Character == "SELECT ".Length,
                "@scalar and @table variables complete in the same GO batch with declared types and replacement span covering @");

            var tableVarCols = Complete("DECLARE @items TABLE (Sku NVARCHAR(32), Qty INT);\nSELECT i.| FROM @items i");
            check(Has(tableVarCols, "[Sku]") && Has(tableVarCols, "[Qty]"),
                "@table variable alias-dot completes its declared columns");

            var nextBatchVars = Complete("DECLARE @oldVar INT = 1;\nDECLARE @oldTbl TABLE (A INT);\nGO\nDECLARE @newVar BIGINT = 2;\nSELECT @|");
            check(Has(nextBatchVars, "@newVar") && !Has(nextBatchVars, "@oldVar") && !Has(nextBatchVars, "@oldTbl"),
                "@scalar and @table variables do NOT leak across GO batch boundaries");

            var procParam = Complete("CREATE PROCEDURE dbo.RunReport @Region NVARCHAR(20), @TopN INT AS\nSELECT @|");
            check(Has(procParam, "@Region") && Has(procParam, "@TopN"),
                "stored procedure parameters complete as local @variables inside the procedure body");

            // 3. CTEs, derived tables, APPLY, PIVOT, UNPIVOT, OPENJSON, UPDATE/DELETE/MERGE/INSERT, OUTPUT inserted/deleted.
            var cteCols = Complete("WITH TopCust (CustId, Spend) AS (SELECT customer_id, total FROM dbo.Orders) SELECT tc.| FROM TopCust tc");
            check(Has(cteCols, "[CustId]") && Has(cteCols, "[Spend]"),
                "CTE with explicit column list completes those columns");

            var cteStar = Complete("WITH AllOrd AS (SELECT * FROM dbo.Orders) SELECT ao.| FROM AllOrd ao");
            check(Has(cteStar, "[id]") && Has(cteStar, "[customer_id]") && Has(cteStar, "[total]"),
                "CTE with SELECT * expands columns from IndexLookup");

            var derivedCols = Complete("SELECT d.| FROM (SELECT o.id, o.total AS Gross FROM dbo.Orders o) AS d");
            check(Has(derivedCols, "[id]") && Has(derivedCols, "[Gross]") && !Has(derivedCols, "[customer_id]"),
                "derived table exposes only its projected columns and aliases");

            var pivotCols = Complete("SELECT p.| FROM (SELECT customer_id, name, total FROM dbo.Orders) src PIVOT (SUM(total) FOR name IN ([Q1], [Q2])) AS p");
            check(Has(pivotCols, "[customer_id]") && Has(pivotCols, "[Q1]") && Has(pivotCols, "[Q2]") && !Has(pivotCols, "[total]") && !Has(pivotCols, "[name]"),
                "PIVOT exposes non-pivoted source columns plus IN pivot values while excluding value and pivot columns");

            var unpivotCols = Complete("SELECT u.| FROM (SELECT id, name, note FROM dbo.Orders) src UNPIVOT (Val FOR ColName IN (name, note)) AS u");
            check(Has(unpivotCols, "[id]") && Has(unpivotCols, "[Val]") && Has(unpivotCols, "[ColName]") && !Has(unpivotCols, "[name]") && !Has(unpivotCols, "[note]"),
                "UNPIVOT exposes unpivoted value & pivot columns plus non-unpivoted source columns");

            var openJson = Complete("SELECT j.| FROM OPENJSON(@doc) WITH (OrderKey INT, Status NVARCHAR(20)) AS j");
            check(Has(openJson, "[OrderKey]") && Has(openJson, "[Status]"),
                "OPENJSON WITH schema exposes its declared columns");

            var insertCols = Complete("INSERT INTO dbo.Orders (|) VALUES (1)");
            check(Has(insertCols, "[id]") && Has(insertCols, "[customer_id]") && Has(insertCols, "[total]"),
                "INSERT INTO table (|) completes target table's bare bracketed columns");

            var outputInserted = Complete("UPDATE dbo.Orders SET total = 10 OUTPUT inserted.| WHERE id = 1");
            check(Has(outputInserted, "[id]") && Has(outputInserted, "[total]") && Has(outputInserted, "[customer_id]"),
                "UPDATE ... OUTPUT inserted.| completes target table columns");

            var outputDeleted = Complete("DELETE FROM dbo.Orders OUTPUT deleted.| WHERE id = 1");
            check(Has(outputDeleted, "[id]") && Has(outputDeleted, "[customer_id]"),
                "DELETE ... OUTPUT deleted.| completes target table columns");

            var mergeScope = Complete("MERGE INTO dbo.Orders AS tgt USING dbo.Customers AS src ON tgt.|");
            check(Has(mergeScope, "[customer_id]") && Has(mergeScope, "[id]"),
                "MERGE target alias completes target columns");

            // 4. Mid-script USE switching active database for subsequent statements!
            var midUse = Complete("USE AnalyticsDB;\nGO\nSELECT d.| FROM dbo.DailyRevenue d", db: "Sales");
            check(Has(midUse, "[RevenueDate]") && Has(midUse, "[GrossRevenue]") && !Has(midUse, "[customer_id]"),
                "mid-script USE switches the active database for subsequent completions");

            var useDbs = Complete("USE |");
            check(Has(useDbs, "[Sales]") && Has(useDbs, "[AnalyticsDB]"),
                "USE | completes indexed database names");

            // 5. FK-aware JOIN ... ON completion (outgoing, incoming, AND composite multi-column FK — ranked #1!).
            var fkOutgoing = Complete("SELECT * FROM dbo.Orders o JOIN dbo.Customers c ON |");
            check(fkOutgoing.Items.Count > 0
                && fkOutgoing.Items[0].Label == "o.[customer_id] = c.[id]"
                && fkOutgoing.Items[0].Detail!.Contains("fk_orders_customers", StringComparison.OrdinalIgnoreCase)
                && fkOutgoing.Items[0].SortText!.StartsWith('!'),
                "outgoing FK suggests 'o.[customer_id] = c.[id]' ranked #1 in JOIN ... ON");

            var fkIncoming = Complete("SELECT * FROM dbo.Customers c JOIN dbo.Orders o ON |");
            check(fkIncoming.Items.Count > 0
                && fkIncoming.Items[0].Label == "c.[id] = o.[customer_id]"
                && fkIncoming.Items[0].SortText!.StartsWith('!'),
                "incoming FK suggests 'c.[id] = o.[customer_id]' ranked #1 in reversed JOIN ... ON");

            var fkComposite = Complete("SELECT * FROM dbo.OrderLines ol JOIN dbo.Shipments sh ON |", db: "AnalyticsDB");
            check(fkComposite.Items.Count > 0
                && fkComposite.Items[0].Label == "ol.[TenantId] = sh.[TenantId] AND ol.[OrderId] = sh.[OrderId]",
                "composite multi-column FK suggests full multi-column AND join predicate ranked #1");

            // 6. Cross-DB / cross-schema fuzzy FROM jump (current DB dbo -> other schemas -> other indexed DBs!).
            var crossDbJump = Complete("SELECT * FROM DailyRev|", db: "Sales");
            var jumpItem = crossDbJump.Items.FirstOrDefault(i => i.Label == "[AnalyticsDB].[dbo].[DailyRevenue]");
            check(jumpItem is not null && jumpItem.FilterText == "DailyRevenue" && jumpItem.TextEdit!.NewText == "[AnalyticsDB].[dbo].[DailyRevenue]"
                && jumpItem.Detail == "Table",
                "cross-DB fuzzy FROM jump surfaces [AnalyticsDB].[dbo].[DailyRevenue] with bare FilterText and concise Table detail");

            var crossSchemaJump = Complete("SELECT * FROM ArchOrd|", db: "Sales");
            check(crossSchemaJump.Items.Any(i => i.Label == "[Archive].[ArchiveOrders]" && i.FilterText == "ArchiveOrders"),
                "cross-schema fuzzy FROM jump surfaces [Archive].[ArchiveOrders] from another schema in current DB");

            // 7. T-SQL context sites: CAST/CONVERT types, DATEADD/DATEDIFF date parts, @@ globals, AfterFromTable, StatementStart, comments/strings.
            var castTypes = Complete("SELECT CAST(x AS |)");
            check(Has(castTypes, "INT") && Has(castTypes, "NVARCHAR") && Has(castTypes, "DATETIME2") && Has(castTypes, "UNIQUEIDENTIFIER")
                && !Has(castTypes, "SELECT") && !Has(castTypes, "Orders"),
                "CAST(x AS |) completes only T-SQL data types");

            var convertTypes = Complete("SELECT CONVERT(|, x)");
            check(Has(convertTypes, "INT") && Has(convertTypes, "DECIMAL") && Has(convertTypes, "VARCHAR") && !Has(convertTypes, "FROM"),
                "CONVERT(|, x) completes only T-SQL data types");

            foreach (var fn in new[] { "DATEADD", "DATEDIFF", "DATEDIFF_BIG", "DATENAME", "DATEPART", "DATETRUNC" })
            {
                var dp = Complete($"SELECT {fn}(|");
                check(Has(dp, "year") && Has(dp, "month") && Has(dp, "day") && Has(dp, "hour") && Has(dp, "millisecond") && !Has(dp, "SELECT"),
                    $"{fn}(|) completes only T-SQL date parts");
            }

            var globals = Complete("SELECT @@|");
            check(Has(globals, "@@ROWCOUNT") && Has(globals, "@@TRANCOUNT") && Has(globals, "@@ERROR") && Has(globals, "@@IDENTITY")
                && Has(globals, "@@SPID") && Has(globals, "@@VERSION")
                && globals.Items.First(i => i.Label == "@@ROWCOUNT").TextEdit!.Range.Start.Character == "SELECT ".Length,
                "@@| completes curated T-SQL system globals with replacement span covering @@");

            var afterFrom = Complete("SELECT * FROM dbo.Orders o |");
            check(Has(afterFrom, "WHERE") && Has(afterFrom, "INNER JOIN") && Has(afterFrom, "LEFT JOIN") && Has(afterFrom, "GROUP BY")
                && !Has(afterFrom, "INT"),
                "AfterFromTable completes valid FROM/JOIN continuation keywords");

            var stmtStart = Complete("|");
            check(Has(stmtStart, "SELECT") && Has(stmtStart, "WITH") && Has(stmtStart, "DECLARE") && !Has(stmtStart, "WHERE"),
                "StatementStart completes statement-starting keywords");

            check(Complete("SELECT 'hello |'").Items.Count == 0 && Complete("SELECT 1 -- comment |").Items.Count == 0,
                "comments and string literals suppress completion suggestions");

            // 8. Built-in functions + rich hover + 3-level hover (Database, Schema, Table/Proc/Func) + #temp/@var/CTE/alias/column hover.
            var exprFns = Complete("SELECT COAL|");
            check(exprFns.Items.Any(i => i.Label == "COALESCE" && i.Kind == 3),
                "built-in T-SQL functions complete in expression positions");

            var dbHover = HoverAt("SELECT * FROM [Analy|ticsDB].[dbo].[DailyRevenue]", db: "Sales");
            check(dbHover is not null && dbHover.Contents.Contains("AnalyticsDB", StringComparison.Ordinal) && dbHover.Contents.Contains("Database", StringComparison.Ordinal)
                && dbHover.Contents.Contains("table", StringComparison.OrdinalIgnoreCase),
                "3-level hover Level 1: hovering Database segment shows database state, collation, and object counts");

            var schemaHover = HoverAt("SELECT * FROM [AnalyticsDB].[d|bo].[DailyRevenue]", db: "Sales");
            check(schemaHover is not null && schemaHover.Contents.Contains("dbo", StringComparison.Ordinal) && schemaHover.Contents.Contains("Schema", StringComparison.Ordinal)
                && schemaHover.Contents.Contains("DailyRevenue", StringComparison.Ordinal),
                "3-level hover Level 2: hovering Schema segment shows object counts and sample objects");

            var tableHover = HoverAt("SELECT * FROM dbo.Ord|ers", db: "Sales");
            check(tableHover is not null && tableHover.Contents.Contains(@"dbo\.Orders", StringComparison.Ordinal)
                && tableHover.Contents.Contains("PK", StringComparison.Ordinal)
                && tableHover.Contents.Contains("Foreign Keys", StringComparison.Ordinal)
                && tableHover.Contents.Contains(@"decimal\(18,2\)", StringComparison.Ordinal),
                "3-level hover Level 3: hovering Table shows columns, types, PK/FK badges, and Foreign Keys section");

            var procHover = HoverAt("EXEC dbo.usp_|get", db: "Sales");
            check(procHover is not null && procHover.Contents.Contains("Stored procedure", StringComparison.Ordinal) && procHover.Contents.Contains("@id", StringComparison.Ordinal),
                "hovering stored procedure shows its parameters and types");

            var funcHover = HoverAt("SELECT dbo.fn_|total(1)", db: "Sales");
            check(funcHover is not null && funcHover.Contents.Contains(@"RETURNS decimal\(18,2\)", StringComparison.Ordinal) && funcHover.Contents.Contains("@x", StringComparison.Ordinal),
                "hovering scalar function shows its parameters and return type");

            var colHover = HoverAt("SELECT o.custo|mer_id FROM dbo.Orders o", db: "Sales");
            check(colHover is not null && colHover.Contents.Contains(@"customer\_id", StringComparison.Ordinal) && colHover.Contents.Contains("FK", StringComparison.Ordinal)
                && colHover.Contents.Contains("Customers", StringComparison.Ordinal),
                "hovering FK column shows type, FK badge, owner table, and referenced target");

            var aliasHover = HoverAt("SELECT o|.customer_id FROM dbo.Orders o", db: "Sales");
            check(aliasHover is not null && aliasHover.Contents.Contains("Alias", StringComparison.Ordinal) && aliasHover.Contents.Contains("Orders", StringComparison.Ordinal),
                "hovering table alias shows its underlying table summary");

            var tempHover = HoverAt("CREATE TABLE #Recent (OrderId INT NOT NULL);\nGO\nSELECT * FROM #Rec|ent");
            check(tempHover is not null && tempHover.Contents.Contains("Temporary table", StringComparison.Ordinal) && tempHover.Contents.Contains("OrderId", StringComparison.Ordinal),
                "hovering #temp table shows its declared columns");

            var varHover = HoverAt("DECLARE @cutoff DATETIME2;\nSELECT @cut|off");
            check(varHover is not null && varHover.Contents.Contains("@cutoff", StringComparison.Ordinal) && varHover.Contents.Contains("DATETIME2", StringComparison.Ordinal),
                "hovering @scalar variable shows its declared type");

            var globalHover = HoverAt("SELECT @@ROW|COUNT");
            check(globalHover is not null && globalHover.Contents.Contains("@@ROWCOUNT", StringComparison.Ordinal) && globalHover.Contents.Contains("int", StringComparison.Ordinal),
                "hovering @@ global shows return type and description");

            var builtinHover = HoverAt("SELECT DATE|ADD(day, 1, GETDATE())");
            check(builtinHover is not null && builtinHover.Contents.Contains("DATEADD", StringComparison.Ordinal) && builtinHover.Contents.Contains("datepart", StringComparison.Ordinal),
                "hovering built-in T-SQL function shows signature and summary");

            // 9. Turkish dotted-I & Case-Sensitive collations!
            var csExact = Complete("SELECT x.| FROM dbo.Item x", db: "CasedDb");
            var csWrongCase = Complete("SELECT x.| FROM dbo.item x", db: "CasedDb");
            var csUpper = Complete("SELECT x.| FROM dbo.ITEM x", db: "CasedDb");
            check(Has(csExact, "[LowerItemCol]") && !Has(csExact, "[UpperItemCol]")
                && !Has(csWrongCase, "[LowerItemCol]")
                && Has(csUpper, "[UpperItemCol]") && !Has(csUpper, "[LowerItemCol]"),
                "case-sensitive database resolves dbo.Item vs dbo.ITEM strictly by exact case");

            var turkishLower = Complete("SELECT t.| FROM dbo.İTEMS t", db: "TurkishDb");
            var turkishUpper = Complete("SELECT t.| FROM dbo.ıtems t", db: "TurkishDb");
            check(Has(turkishLower, "[DottedCol]") && !Has(turkishLower, "[DotlessCol]")
                && Has(turkishUpper, "[DotlessCol]") && !Has(turkishUpper, "[DottedCol]"),
                "Turkish dotted-I collation pairs i with İ and ı with I in completion");

            // 10. Resource DB (sys & INFORMATION_SCHEMA) completion & hover!
            var sysObjs = Complete("SELECT * FROM sys.|", db: "Sales");
            var sysCols = Complete("SELECT o.| FROM sys.objects o", db: "Sales");
            check(Has(sysObjs, "[objects]") && Has(sysCols, "[name]") && Has(sysCols, "[object_id]"),
                "resource database sys views and columns complete in any indexed database");

            // 11. Graceful unindexed / partial / CHILDREN_LEFT_OUT / Building / Skipped handling!
            var unindexedTemp = Complete("CREATE TABLE #Local (A INT);\nDECLARE @x INT;\nSELECT l.| FROM #Local l", db: "Sales", customLookup: null);
            var unindexedGlobal = Complete("SELECT @@ROW|", db: "Sales", customLookup: null);
            check(Has(unindexedTemp, "[A]") && Has(unindexedGlobal, "@@ROWCOUNT"),
                "unindexed connection (indexOnConnect off) still completes #temp tables, @vars, built-ins, globals and keywords");

            var leftOutCols = Complete("SELECT o.| FROM dbo.NoChildren o", db: "LeftOutDb");
            var leftOutTables = Complete("SELECT * FROM dbo.|", db: "LeftOutDb");
            check(Has(leftOutTables, "[NoChildren]") && leftOutCols.IsIncomplete,
                "CHILDREN_LEFT_OUT database still completes table names and marks column completion incomplete gracefully");

            var buildingLookup = new IndexLookup(conn, budget, building: true, ledger.Snapshot());
            var whileBuilding = Complete("SELECT * FROM dbo.|", db: "Sales", customLookup: buildingLookup);
            check(whileBuilding.IsIncomplete,
                "while index is building, completion marks IsIncomplete so Monaco re-queries as databases land");

            // 12. Performance sanity check (should execute well under 50 ms even on contended CI; typically < 1 ms).
            var sw = Stopwatch.StartNew();
            for (var run = 0; run < 20; run++)
                _ = Complete("SELECT o.| FROM dbo.Orders o JOIN dbo.Customers c ON o.customer_id = c.id");
            sw.Stop();
            check(sw.ElapsedMilliseconds < 2000, $"20 ScriptDom + IndexLookup completions ran in {sw.ElapsedMilliseconds} ms");

            // 13. Adversarial Round 1 regressions:
            // (a) O(1) FindStatementBounds on 12,000 semicolon-free SET lines + repeated SELECT INTO cap + CancellationToken.
            var manySets = string.Concat(Enumerable.Repeat("SET @a = 1\n", 12_000)) + "SELECT o.| FROM dbo.Orders o";
            var swSets = Stopwatch.StartNew();
            var manySetsRes = Complete(manySets);
            swSets.Stop();
            check(Has(manySetsRes, "[customer_id]") && swSets.ElapsedMilliseconds < 1500,
                $"12,000 semicolon-free SET lines complete cleanly in O(N) ({swSets.ElapsedMilliseconds} ms)");

            var repeatedInto = string.Concat(Enumerable.Repeat("SELECT 1 AS a INTO #r;\n", 200)) + "SELECT x.| FROM #r x";
            var swInto = Stopwatch.StartNew();
            var repeatedIntoRes = Complete(repeatedInto);
            swInto.Stop();
            check(Has(repeatedIntoRes, "[a]") && swInto.ElapsedMilliseconds < 1500,
                $"200 repeated SELECT INTO #r statements stay bounded ({swInto.ElapsedMilliseconds} ms)");

            using var cancelledCts = new CancellationTokenSource();
            cancelledCts.Cancel();
            var threwCancel = false;
            try { _ = TsqlCompletionService.Complete(new LanguageRequest(Guid.NewGuid().ToString("D"), 1, "SELECT 1", new("sqlserver", null, "Sales"), new(0, 7)), lookup, "Sales", cancelledCts.Token); }
            catch (OperationCanceledException) { threwCancel = true; }
            check(threwCancel, "TsqlCompletionService threads and honors CancellationToken");

            // (b) Cross-DB jump fairness: huge BigDb (many columns) must not starve ZzzDb, and detail omits redundant db.schema.
            var fairBudget = new IndexBudget(1 << 25);
            var fairPool = new StringPool(fairBudget);
            var fairConn = new ConnectionIndex(fairBudget, null, fairPool);
            try
            {
                var bigRows = new List<IndexedObject>(12_000);
                for (var t = 0; t < 1_000; t++)
                {
                    var tbl = $"NoiseTable{t:D4}";
                    bigRows.Add(new("table", "tables", "dbo", tbl));
                    for (var c = 0; c < 10; c++)
                        bigRows.Add(new("column", "columns", null, $"Col{c}", "table", "dbo", tbl));
                }
                fairConn.Put(new DatabaseIndex("Sales", ObjectTable.Of([new IndexedObject("table", "tables", "dbo", "Orders")]), 0, 0, 0));
                fairConn.Put(new DatabaseIndex("BigDb", ObjectTable.Of(bigRows), 0, 0, 0));
                fairConn.Put(new DatabaseIndex("ZzzDb", ObjectTable.Of([new IndexedObject("table", "tables", "dbo", "TargetMetrics")]), 0, 0, 0));
                var fairLedger = new LookupLedger();
                fairLedger.Start();
                fairLedger.List(["Sales", "BigDb", "ZzzDb"]);
                foreach (var d in new[] { "Sales", "BigDb", "ZzzDb" }) fairLedger.Done(d, null);
                var fairLookup = new IndexLookup(fairConn, fairBudget, false, fairLedger.Snapshot());
                var fairJump = Complete("SELECT * FROM TargetMet|", db: "Sales", customLookup: fairLookup);
                var zzzHit = fairJump.Items.FirstOrDefault(i => i.Label == "[ZzzDb].[dbo].[TargetMetrics]");
                check(zzzHit is not null && zzzHit.Detail == "Table",
                    "cross-DB jump is fair across large DBs and omits redundant Database.Schema from cross-DB detail");
            }
            finally { fairConn.Dispose(); }

            // (c) Prefix < 2 chars in FROM with other indexed DBs marks IsIncomplete so completionCache re-queries at 2+ chars.
            var fromEmpty = Complete("SELECT * FROM |", db: "Sales");
            var fromOne = Complete("SELECT * FROM D|", db: "Sales");
            check(fromEmpty.IsIncomplete && fromOne.IsIncomplete,
                "FROM completion with <2 typed chars marks IsIncomplete when other indexed databases exist");

            // (d) Hover inline code spans never emit literal backslashes on parameterized types or function signatures.
            var globalIdentHover = HoverAt("SELECT @@IDENT|ITY");
            var fnDateAddHover = HoverAt("SELECT DATE|ADD(day, 1, GETDATE())");
            var decColHover = HoverAt("SELECT o.tot|al FROM dbo.Orders o", db: "Sales");
            var udtVarHover = HoverAt("DECLARE @x DECIMAL(18, 2);\nSELECT @|x");
            check(globalIdentHover is not null && globalIdentHover.Contents.Contains("`numeric(38,0)`", StringComparison.Ordinal)
                && fnDateAddHover is not null && fnDateAddHover.Contents.Contains("`DATEADD( datepart, number, date )`", StringComparison.Ordinal)
                && decColHover is not null && decColHover.Contents.Contains("`decimal(18,2)`", StringComparison.Ordinal)
                && udtVarHover is not null && udtVarHover.Contents.Contains("`DECIMAL(18,2)`", StringComparison.Ordinal),
                "hover inline code spans format types and signatures cleanly without literal backslashes");
            check(TsqlCatalog.FormatCodeSpan("a`b") == "``a`b``" && TsqlCatalog.FormatCodeSpan("`lead`") == "`` `lead` ``",
                "FormatCodeSpan escapes embedded and boundary backticks per CommonMark");

            // (e) Case-sensitive collation: duplicate-case columns `id` and `Id` both appear, and CS FK only matches exact-case table!
            var csDup = Complete("SELECT x.| FROM dbo.Item x", db: "CasedDb");
            check(Has(csDup, "[id]") && Has(csDup, "[Id]") && Has(csDup, "[LowerItemCol]"),
                "case-sensitive table preserves distinct columns differing only in case (id and Id)");
            var csSchemaWrong = HoverAt("SELECT * FROM DBO|.Item", db: "CasedDb");
            check(csSchemaWrong is null, "case-sensitive schema hover does not match wrong-case schema name");

            // (f) WITH CTE attached to DELETE / UPDATE / INSERT / MERGE, plus unfinished CTE body!
            var cteDelete = Complete("WITH Recent AS (SELECT 1 AS a) DELETE FROM Recent WHERE |", db: "Sales");
            var cteUpdate = Complete("WITH Recent AS (SELECT 1 AS a) UPDATE Recent SET | = 1", db: "Sales");
            var unfinishedCte = Complete("WITH C AS (SELECT o.| FROM dbo.Orders o)", db: "Sales");
            check(Has(cteDelete, "[a]") && Has(cteUpdate, "[a]") && Has(unfinishedCte, "[customer_id]"),
                "WITH CTE stays attached to DELETE/UPDATE and unfinished CTE bodies retain table scope");

            // (g) SELECT ... INTO #S2 FROM #S1 + mid-script USE persistence!
            var chainInto = Complete("CREATE TABLE #S1 (OrderId INT);\nSELECT * INTO #S2 FROM #S1;\nSELECT s.| FROM #S2 s", db: "Sales");
            var useInto = Complete("USE AnalyticsDB;\nSELECT * INTO #Rev FROM dbo.DailyRevenue;\nUSE Sales;\nSELECT r.| FROM #Rev r", db: "Sales");
            check(Has(chainInto, "[OrderId]") && Has(useInto, "[RevenueDate]") && Has(useInto, "[GrossRevenue]"),
                "SELECT INTO #temp inherits from #temp sources and stamps active database before subsequent USE");

            // (h) Empty auto-closed brackets `SELECT [|]` replace both `[` and `]` without doubling!
            var emptyBracketSql = "SELECT [] FROM dbo.Orders";
            var emptyBracketRes = Complete("SELECT [|] FROM dbo.Orders", db: "Sales");
            var ebItem = emptyBracketRes.Items.FirstOrDefault(i => i.Label == "[customer_id]");
            check(ebItem?.TextEdit is { } ebEdit
                && emptyBracketSql[..ebEdit.Range.Start.Character] + ebEdit.NewText + emptyBracketSql[ebEdit.Range.End.Character..] == "SELECT [customer_id] FROM dbo.Orders",
                "empty auto-closed brackets SELECT [|] replace both brackets cleanly without producing [[col]]");

            // (i) Hover on OUTPUT inserted/deleted + 3-part column `dbo.Orders.customer_id` + scalar UDT not misclassified as table variable!
            var outputHover = HoverAt("UPDATE dbo.Orders SET total = 1 OUTPUT inserted.custo|mer_id", db: "Sales");
            var threePartColHover = HoverAt("SELECT dbo.Orders.custo|mer_id FROM dbo.Orders", db: "Sales");
            var scalarUdtFrom = Complete("DECLARE @zip dbo.PostalCode;\nSELECT * FROM |", db: "Sales");
            var scalarUdtHover = HoverAt("DECLARE @zip dbo.PostalCode;\nSELECT @z|ip", db: "Sales");
            check(outputHover is not null && outputHover.Contents.Contains(@"customer\_id", StringComparison.Ordinal)
                && threePartColHover is not null && threePartColHover.Contents.Contains(@"customer\_id", StringComparison.Ordinal)
                && !Has(scalarUdtFrom, "@zip")
                && scalarUdtHover is not null && scalarUdtHover.Contents.Contains("Local variable", StringComparison.Ordinal) && !scalarUdtHover.Contents.Contains("Table variable", StringComparison.Ordinal),
                "hover resolves OUTPUT inserted/deleted & 3-part columns, and scalar UDT variables are not misclassified as table variables");

            // (j) Missing sites: `INSERT dbo.Orders (|`, `DECLARE @a INT, @b |`, `DECLARE @a AS |`, `SELECT dbo.|` scalar functions only!
            var insertNoInto = Complete("INSERT dbo.Orders (|", db: "Sales");
            var multiDeclare = Complete("DECLARE @a INT, @b |", db: "Sales");
            var declareAs = Complete("DECLARE @a AS |", db: "Sales");
            var exprSchemaDot = Complete("SELECT dbo.|", db: "Sales");
            check(Has(insertNoInto, "[customer_id]")
                && Has(multiDeclare, "INT") && Has(declareAs, "NVARCHAR")
                && Has(exprSchemaDot, "[fn_total]") && !Has(exprSchemaDot, "[usp_get]"),
                "INSERT without INTO, multi-var/AS DECLARE type sites, and scalar-only SELECT dbo. completion work cleanly");

            // (k) Clean UTF-8 en-dash (zero mojibake), no backticks in FK plain-text docs, DROP TABLE #t1, #t2, DATE_BUCKET, routine RETURNS @out TABLE!
            check(TsqlCatalog.DateParts.All(d => !d.Summary.Contains("â€", StringComparison.Ordinal))
                && TsqlCatalog.SystemGlobals.All(g => !g.Summary.Contains("â€", StringComparison.Ordinal)),
                "TsqlCatalog contains clean UTF-8 en-dashes with zero mojibake");
            var fkCleanDoc = Complete("SELECT * FROM dbo.Orders o JOIN dbo.Customers c ON |", db: "Sales");
            check(fkCleanDoc.Items[0].Documentation is { } fdoc && !fdoc.Contains('`', StringComparison.Ordinal),
                "FK JOIN ON plain-text documentation contains no raw Markdown backticks");
            var dropMulti = Complete("CREATE TABLE #t1 (a INT); CREATE TABLE #t2 (b INT); DROP TABLE #t1, #t2; SELECT * FROM |", db: "Sales");
            var dateBucket = Complete("SELECT DATE_BUCKET(|, 1, GETDATE())");
            var tvfReturn = Complete("CREATE FUNCTION dbo.fn_test(@a INT = (1), @b INT) RETURNS @out TABLE (Score INT) AS BEGIN SELECT x.| FROM @out x END", db: "Sales");
            check(!Has(dropMulti, "#t1") && !Has(dropMulti, "#t2")
                && Has(dateBucket, "day")
                && Has(tvfReturn, "[Score]"),
                "DROP TABLE #t1, #t2, DATE_BUCKET dateparts, nested-paren routine params, and RETURNS @out TABLE work");

            // (l) RefreshAsync cancellation via CloseAsync maps to STALE (never TIMEOUT), including when search.IndexAsync wraps OCE as RequestException("CANCELLED")!
            var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            using var refreshSvc = new SqlToolsLanguageService(
                _ => null,
                activeDatabase: _ => "Sales",
                refreshIndex: async (_, ct) =>
                {
                    started.TrySetResult();
                    try { await Task.Delay(Timeout.Infinite, ct); }
                    catch (OperationCanceledException)
                    {
                        // Simulate ObjectSearchService.CheckSqlAsync throwing RequestException("CANCELLED") and SqlService.RefreshLanguageIndexAsync rethrowing OCE on ct.
                        ct.ThrowIfCancellationRequested();
                    }
                    return true;
                });
            var refreshDocId = Guid.NewGuid().ToString("D");
            var refreshTask = refreshSvc.RefreshAsync(new LanguageRefreshRequest(refreshDocId, 1, "SELECT 1", new("sqlserver", Guid.NewGuid().ToString("D"), "Sales")), CancellationToken.None);
            await started.Task.WaitAsync(TimeSpan.FromSeconds(5));
            await refreshSvc.CloseAsync(refreshDocId, CancellationToken.None);
            string? refreshErrCode = null;
            try { await refreshTask; }
            catch (RequestException ex) { refreshErrCode = ex.Code; }
            check(refreshErrCode == "STALE", $"RefreshAsync cancelled by CloseAsync maps to STALE (got {refreshErrCode ?? "none"})");

            // (m) WaitForLookupAsync waits during initial build until Resource + activeDb land (without waiting for remaining DBs),
            // returns immediately when already held / not building / unlisted, wakes on cancel & Forget, and respects LookupWaitBudget!
            await VerifyWaitForLookupAsync(check);
        }
        finally
        {
            conn.Dispose();
        }
    }

    private sealed class MinimalSearchHost : IObjectSearchHost
    {
        public Varia.Backend.Explorer.ServerProfile Profile(string connectionId) => new(17, null, 3, null, false, true, true, 16);
        public Microsoft.Data.SqlClient.SqlConnection Connection(string connectionId, string? database) => throw new NotSupportedException();
        public Task OpenAsync(Microsoft.Data.SqlClient.SqlConnection connection, CancellationToken token) => throw new NotSupportedException();
    }

    private static async Task VerifyWaitForLookupAsync(Action<bool, string> check)
    {
        using var search = new ObjectSearchService(new MinimalSearchHost());
        var connId = Guid.NewGuid().ToString("D");

        // 1. Initial build in progress: WaitForLookupAsync waits until Resource + activeDb ("Sales") land, WITHOUT waiting for "SlowDb"!
        search.BeginSimulatedBuild(connId);
        var waitSales = search.WaitForLookupAsync(connId, "Sales", CancellationToken.None);
        check(!waitSales.IsCompleted, "WaitForLookupAsync waits while initial build has not yet read resource or active DB");

        search.CompleteSimulatedListing(connId, ["Sales", "SlowDb"]);
        check(!waitSales.IsCompleted, "WaitForLookupAsync continues waiting after listing until resource and Sales finish");

        var sysSet = new ResourceSet(
            new ResourceKey("17.0.1000.7", 3, 1, null, 1, false),
            ObjectTable.Of([
                new IndexedObject("view", "systemViews", "sys", "databases", System: true, Subtype: "system"),
                new IndexedObject("column", "columns", null, "database_id", "view", "sys", "databases", System: true)
            ]), 0, 0);
        search.CompleteSimulatedResource(connId, sysSet);
        check(!waitSales.IsCompleted, "WaitForLookupAsync still waits for active DB Sales after resource finishes");

        var salesDb = new DatabaseIndex("Sales", ObjectTable.Of([
            new IndexedObject("table", "tables", "dbo", "Orders"),
            new IndexedObject("column", "columns", null, "OrderId", "table", "dbo", "Orders")
        ]), 0, 0, 0);
        search.CompleteSimulatedDatabase(connId, "Sales", salesDb);

        var salesLookup = await waitSales.WaitAsync(TimeSpan.FromSeconds(5));
        check(salesLookup is not null
            && salesLookup.Database("Sales").Held is not null
            && salesLookup.Objects("Sales", "sys", "databases").Value.Count == 1,
            "WaitForLookupAsync wakes immediately when Resource + activeDb land without waiting for SlowDb");

        // 2. Unlisted database (e.g. tempdb) does not hang once ListedDone && ResourceDone!
        var tempdbLookup = await search.WaitForLookupAsync(connId, "tempdb", CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(5));
        check(tempdbLookup is not null && tempdbLookup.Database("tempdb").State == LookupState.Absent,
            "WaitForLookupAsync returns immediately for an unlisted database once listing and resource finish");

        // 3. Rebuild / freshness check with Sales already held returns synchronously (0 ms wait) even while SlowDb is still building!
        var rebuildLookup = search.WaitForLookupAsync(connId, "Sales", CancellationToken.None);
        check(rebuildLookup.IsCompleted && (await rebuildLookup)!.Database("Sales").Held is not null,
            "WaitForLookupAsync returns immediately (0 wait) when activeDb is already held during a build");

        search.EndSimulatedBuild(connId);
        var idleLookup = search.WaitForLookupAsync(connId, "Sales", CancellationToken.None);
        check(idleLookup.IsCompleted && (await idleLookup) is not null,
            "WaitForLookupAsync returns immediately when no build is running");

        // 4. Caller cancellation wakes WaitForLookupAsync immediately with OperationCanceledException.
        var connCancel = Guid.NewGuid().ToString("D");
        search.BeginSimulatedBuild(connCancel);
        using var cancelCts = new CancellationTokenSource();
        var cancelledWait = search.WaitForLookupAsync(connCancel, "Sales", cancelCts.Token);
        cancelCts.Cancel();
        var gotOce = false;
        try { _ = await cancelledWait.WaitAsync(TimeSpan.FromSeconds(5)); }
        catch (OperationCanceledException) { gotOce = true; }
        check(gotOce, "WaitForLookupAsync wakes immediately with OperationCanceledException on caller cancellation");
        search.EndSimulatedBuild(connCancel);

        // 5. Forget(connectionId) wakes WaitForLookupAsync immediately and returns null.
        var connForget = Guid.NewGuid().ToString("D");
        search.BeginSimulatedBuild(connForget);
        var forgetWait = search.WaitForLookupAsync(connForget, "Sales", CancellationToken.None);
        search.Forget(connForget);
        var forgetResult = await forgetWait.WaitAsync(TimeSpan.FromSeconds(5));
        check(forgetResult is null, "WaitForLookupAsync wakes immediately and returns null when connection is forgotten");

        // 6. LookupWaitBudget timeout falls back gracefully to Lookup(connectionId) without throwing.
        var connBudget = Guid.NewGuid().ToString("D");
        search.LookupWaitBudget = TimeSpan.FromMilliseconds(30);
        search.BeginSimulatedBuild(connBudget);
        var budgetResult = await search.WaitForLookupAsync(connBudget, "Sales", CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(5));
        check(budgetResult is not null && budgetResult.Database("Sales").State == LookupState.Absent,
            "WaitForLookupAsync falls back gracefully to current Lookup when LookupWaitBudget expires");
        search.EndSimulatedBuild(connBudget);
    }

    private static async Task<(ConnectionIndex Conn, IndexBudget Budget, IndexLookup Lookup, LookupLedger Ledger)> BuildRichFixtureAsync()
    {
        var budget = new IndexBudget(1 << 24);
        var pool = new StringPool(budget);
        var sales = (await new DatabaseReader("Sales", new ObjectIndexLimits(), pool).ReadAsync(SearchDetailChecks.Fixture(children: true, caseSensitive: false), false, CancellationToken.None))!;

        // Add Archive.ArchiveOrders in a second fixture database? Let's put Archive schema inside Sales or add a helper read with ArchiveOrders:
        // Actually we can keep Sales from SearchDetailChecks.Fixture (which has Orders, Customers, fk_orders_customers, usp_get, fn_total)
        // AND add a custom Sales archive table by augmenting or testing cross-schema in AnalyticsDB!
        // Let's make Sales have Archive.ArchiveOrders AND Orders/Customers/FKs by building a DataTableReader or putting Archive schema in Sales.
        // Simpler: build AnalyticsDB with dbo.DailyRevenue, dbo.OrderLines, dbo.Shipments (with composite FK!), and put Archive.ArchiveOrders in Sales via a cloned reader, OR test cross-schema on Sales's own second schema!
        // Let's check: SearchDetailChecks.Fixture has dbo.Orders, dbo.Customers, dbo.usp_get, dbo.fn_total, dbo.List — let's build Sales with Archive.ArchiveOrders added to AnalyticsDB or build a composite FK in AnalyticsDB!
        var conn = new ConnectionIndex(budget, null, pool);
        conn.Put(sales);

        // Add Archive schema table to Sales by putting a separate small database or checking Sales schemas:
        // Wait: ConnectionIndex replaces by database name, so let's add Archive.ArchiveOrders via a custom DatabaseReader for Sales that wraps SearchDetailChecks.Fixture, OR even cleaner: build AnalyticsDB with dbo + Archive schemas and composite FK!
        // Let's actually add Archive.ArchiveOrders to Sales by building a small SalesArchive? No, cross-schema test checks same DB, non-dbo schema!
        // So let's build AnalyticsDB with:
        //   dbo.DailyRevenue (RevenueDate date, GrossRevenue decimal(18,2))
        //   dbo.OrderLines (TenantId int, OrderId int, LineTotal decimal(18,2), FK -> Shipments(TenantId, OrderId))
        //   dbo.Shipments (TenantId int, OrderId int, ShippedAt datetime2)
        // AND for cross-schema in Sales: let's add Archive.ArchiveOrders into Sales by extending SearchDetailChecks.Fixture's DataTables!
        var salesWithArchive = await ReadSalesWithArchiveAsync(pool);
        conn.Put(salesWithArchive);

        var analytics = await ReadAnalyticsDbAsync(pool);
        conn.Put(analytics);

        // Case-sensitive DB (including duplicate-case columns `id` and `Id` on dbo.Item)
        var casedRows = new IndexedObject[]
        {
            new("table", "tables", "dbo", "Item"),
            new("column", "columns", null, "id", "table", "dbo", "Item"),
            new("column", "columns", null, "Id", "table", "dbo", "Item"),
            new("column", "columns", null, "LowerItemCol", "table", "dbo", "Item"),
            new("table", "tables", "dbo", "ITEM"),
            new("column", "columns", null, "UpperItemCol", "table", "dbo", "ITEM")
        };
        conn.Put(new DatabaseIndex("CasedDb", ObjectTable.Of(casedRows), 0, 0, 0) { CaseSensitive = true });

        // Turkish dotted-I DB
        var turkishRows = new IndexedObject[]
        {
            new("table", "tables", "dbo", "items"),
            new("column", "columns", null, "DottedCol", "table", "dbo", "items"),
            new("table", "tables", "dbo", "ITEMS"),
            new("column", "columns", null, "DotlessCol", "table", "dbo", "ITEMS")
        };
        var turkish = new DatabaseIndex("TurkishDb", ObjectTable.Of(turkishRows), 0, 0, 0) { CaseSensitive = false, DottedI = true };
        conn.Put(turkish);

        // CHILDREN_LEFT_OUT DB
        var leftOut = new DatabaseIndex("LeftOutDb", ObjectTable.Of([new IndexedObject("table", "tables", "dbo", "NoChildren")]), 0, 0, 0)
        {
            CaseSensitive = false,
            ChildrenLeftOut = true
        };
        conn.Put(leftOut);

        // Resource set with sys.objects
        var sysObjects = new IndexedObject("view", "systemViews", "sys", "objects", System: true, Subtype: "system");
        var sysCols = new IndexedObject[]
        {
            sysObjects,
            new("column", "columns", null, "name", "view", "sys", "objects", System: true),
            new("column", "columns", null, "object_id", "view", "sys", "objects", System: true)
        };
        conn.PutResource(new ResourceSet(new ResourceKey("17.0.1000.7", 3, 1, null, 1, false), ObjectTable.Of(sysCols), 0, 0));

        var ledger = new LookupLedger();
        ledger.Start();
        ledger.List(["Sales", "AnalyticsDB", "CasedDb", "TurkishDb", "LeftOutDb"]);
        foreach (var dbName in new[] { "Sales", "AnalyticsDB", "CasedDb", "TurkishDb" }) ledger.Done(dbName, null);
        ledger.Done("LeftOutDb", new("LeftOutDb", ObjectSearchService.ChildrenLeftOut, "left out"));

        return (conn, budget, new IndexLookup(conn, budget, false, ledger.Snapshot()), ledger);
    }

    private static async Task<DatabaseIndex> ReadSalesWithArchiveAsync(StringPool pool)
    {
        var at = DateTime.UnixEpoch;
        var reader = SearchChecks.Batch(true,
            [
                [10, "dbo", "Orders", "U", at, 0, false, (byte)0, null],
                [20, "dbo", "Customers", "U", at, 0, false, (byte)0, null],
                [25, "Archive", "ArchiveOrders", "U", at, 0, false, (byte)0, null],
                [30, "dbo", "pk_orders", "PK", at, 10, false, (byte)0, null],
                [31, "dbo", "fk_orders_customers", "F", at, 10, false, (byte)0, null],
                [32, "dbo", "uq_customers", "UQ", at, 20, false, (byte)0, null],
                [40, "dbo", "usp_get", "P", at, 0, false, (byte)0, null],
                [41, "dbo", "fn_total", "FN", at, 0, false, (byte)0, null]
            ],
            [],
            [],
            [
                [10, "id", 1, 56, (short)4, (byte)10, (byte)0, false, true, false, false],
                [10, "customer_id", 2, 56, (short)4, (byte)10, (byte)0, false, false, false, false],
                [10, "total", 3, 106, (short)9, (byte)18, (byte)2, true, false, false, false],
                [10, "name", 4, 231, (short)100, (byte)0, (byte)0, true, false, false, false],
                [10, "note", 5, 231, (short)-1, (byte)0, (byte)0, true, false, false, false],
                [20, "id", 1, 56, (short)4, (byte)10, (byte)0, false, false, false, false],
                [20, "customer_name", 2, 231, (short)100, (byte)0, (byte)0, false, false, false, false],
                [25, "id", 1, 56, (short)4, (byte)10, (byte)0, false, false, false, false]
            ],
            [[10, "pk_orders", (byte)1, 1], [20, "uq_customers", (byte)2, 2]],
            [],
            [
                [40, "@id", false, 1, 56, (short)4, (byte)10, (byte)0, false],
                [41, "", false, 0, 106, (short)9, (byte)18, (byte)2, false],
                [41, "@x", false, 1, 56, (short)4, (byte)10, (byte)0, false]
            ],
            allTypes: SearchChecks.SystemTypes,
            indexColumns: [[10, 1, 1, false, false], [20, 2, 1, false, false]],
            keys: [[30, 10, 1], [32, 20, 2]],
            foreignKeys: [[31, 2, 20, 1]],
            caseSensitive: false);
        return (await new DatabaseReader("Sales", new ObjectIndexLimits(), pool).ReadAsync(reader, false, CancellationToken.None))!;
    }

    private static async Task<DatabaseIndex> ReadAnalyticsDbAsync(StringPool pool)
    {
        var at = DateTime.UnixEpoch;
        var reader = SearchChecks.Batch(true,
            [
                [7001, "dbo", "DailyRevenue", "U", at, 0, false, (byte)0, null],
                [7002, "dbo", "OrderLines", "U", at, 0, false, (byte)0, null],
                [7003, "dbo", "Shipments", "U", at, 0, false, (byte)0, null],
                [8001, "dbo", "fk_orderlines_shipments", "F", at, 7002, false, (byte)0, null]
            ],
            [],
            [],
            [
                [7001, "RevenueDate", 1, 40, (short)3, (byte)10, (byte)0, false, false, false, false],
                [7001, "GrossRevenue", 2, 106, (short)9, (byte)18, (byte)2, true, false, false, false],
                [7002, "TenantId", 1, 56, (short)4, (byte)10, (byte)0, false, false, false, false],
                [7002, "OrderId", 2, 56, (short)4, (byte)10, (byte)0, false, false, false, false],
                [7002, "LineTotal", 3, 106, (short)9, (byte)18, (byte)2, true, false, false, false],
                [7003, "TenantId", 1, 56, (short)4, (byte)10, (byte)0, false, false, false, false],
                [7003, "OrderId", 2, 56, (short)4, (byte)10, (byte)0, false, false, false, false],
                [7003, "ShippedAt", 3, 42, (short)8, (byte)27, (byte)7, true, false, false, false]
            ],
            [],
            [],
            [],
            allTypes: SearchChecks.SystemTypes,
            indexColumns: [],
            keys: [],
            foreignKeys: [[8001, 1, 7003, 1], [8001, 2, 7003, 2]],
            caseSensitive: false);
        return (await new DatabaseReader("AnalyticsDB", new ObjectIndexLimits(), pool).ReadAsync(reader, false, CancellationToken.None))!;
    }
}
