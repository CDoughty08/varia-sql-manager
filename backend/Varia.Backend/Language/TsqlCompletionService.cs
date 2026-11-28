using Varia.Backend.Search;

namespace Varia.Backend.Language;

/// <summary>In-process T-SQL completion provider backed by <see cref="TsqlScopeReader"/> (ScriptDom) and
/// <see cref="IndexLookup"/> (Search Objects RAM index). Zero IPC hops, zero SQL queries, full collation fidelity,
/// FK-aware JOIN ON suggestions, cross-DB/cross-schema fuzzy FROM jump, and graceful unindexed fallback.</summary>
internal static class TsqlCompletionService
{
    private const int MaxJumpHits = 50;
    private const int MaxJumpTopLevelScan = 50_000;
    private const int MaxStarDepth = 8;
    private const int MaxAggregateChars = 1_000_000;

    internal sealed class TurkishCaseComparer : IEqualityComparer<string>
    {
        public static readonly TurkishCaseComparer Instance = new();
        public bool Equals(string? x, string? y) => x is null ? y is null : y is not null && TurkishCase.Same(x, y);
        public int GetHashCode(string obj)
        {
            var hash = new HashCode();
            foreach (var ch in obj)
                hash.Add(ch switch { 'i' => 'İ', 'ı' => 'I', _ => char.ToUpperInvariant(ch) });
            return hash.ToHashCode();
        }
    }

    internal static IEqualityComparer<string> CollationComparer(LookupDatabase? db) =>
        db?.CaseSensitive == true ? StringComparer.Ordinal
        : db?.Held?.DottedI == true ? TurkishCaseComparer.Instance
        : StringComparer.OrdinalIgnoreCase;

    internal static bool IsConfirmedTableVariable(LocalTable tv, IndexLookup? lookup, string? activeDb)
    {
        if (tv.TableTypeRef is null) return true;
        if (lookup is null) return false;
        return ResolveCatalogObject(lookup, tv.TableTypeRef.Database ?? activeDb, tv.TableTypeRef.Schema, tv.TableTypeRef.Name, TableTypeKinds, out _) is not null;
    }

    internal sealed record ResolvedColumn(
        string Name,
        string? TypeText,
        bool? Nullable,
        string? Markers = null,
        string? ForeignKeyTarget = null);

    internal static LanguageCompletionResult Complete(LanguageRequest request, IndexLookup? lookup, string? defaultDatabase, CancellationToken cancellationToken = default)
    {
        var ctx = TsqlScopeReader.ReadCompletion(request.Text, request.Position, defaultDatabase, cancellationToken);
        if (ctx.Site == TsqlSiteKind.None) return new([], false);

        var candidates = new List<Candidate>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var incomplete = false;

        void Add(string label, int kind, string? detail, string? doc, string insertText, string? filterText, string sortKey, int priority = 50, int? insertFormat = 1)
        {
            var dedupKey = kind.ToString() + ":" + label;
            if (!seen.Add(dedupKey)) return;
            var item = new LanguageCompletionItem(
                label,
                kind,
                Bounded(detail, 4096),
                Bounded(doc, 16_384),
                insertText,
                insertFormat,
                new LanguageTextEdit(ctx.ReplacementRange, insertText),
                sortKey,
                Bounded(filterText, 1024));
            candidates.Add(new Candidate(item, priority, filterText ?? label));
        }

        switch (ctx.Site)
        {
            case TsqlSiteKind.StatementStart:
                EmitKeywords(TsqlCatalog.StatementStarterKeywords, Add);
                break;

            case TsqlSiteKind.UseDatabase:
                EmitDatabases(lookup, Add, ref incomplete);
                break;

            case TsqlSiteKind.CastType:
                EmitDataTypes(lookup, ctx.ActiveDatabase, Add, ref incomplete);
                break;

            case TsqlSiteKind.DatePart:
                EmitDateParts(Add);
                break;

            case TsqlSiteKind.SystemGlobal:
                EmitSystemGlobals(Add);
                break;

            case TsqlSiteKind.LocalVariable:
                EmitLocalVariables(ctx, lookup, Add);
                EmitSystemGlobals(Add, basePriority: 70);
                break;

            case TsqlSiteKind.AfterFromTable:
                EmitKeywords(TsqlCatalog.AfterFromTableKeywords, Add);
                break;

            case TsqlSiteKind.InsertColumnList:
                if (ctx.InsertTarget is not null)
                    EmitSourceColumns(ctx.InsertTarget, lookup, ctx.ActiveDatabase, qualify: false, Add, ref incomplete);
                break;

            case TsqlSiteKind.Member:
                EmitMemberCompletions(ctx, lookup, Add, ref incomplete);
                break;

            case TsqlSiteKind.Object:
                EmitObjectCompletions(ctx, lookup, Add, ref incomplete, cancellationToken);
                break;

            case TsqlSiteKind.JoinCondition:
                EmitJoinForeignKeyConditions(ctx, lookup, Add, ref incomplete);
                EmitExpressionCompletions(ctx, lookup, Add, ref incomplete);
                break;

            case TsqlSiteKind.Expression:
                EmitExpressionCompletions(ctx, lookup, Add, ref incomplete);
                break;
        }

        return FinalizeResult(candidates, ctx.Typed, incomplete);
    }

    private sealed record Candidate(LanguageCompletionItem Item, int GroupPriority, string MatchTarget);

    private static LanguageCompletionResult FinalizeResult(List<Candidate> candidates, string typed, bool incomplete)
    {
        var prefix = TsqlCatalog.Unquote(typed);
        var hasPrefix = prefix.Length > 0;

        var ordered = candidates
            .Select((c, idx) => (c, idx, matchRank: hasPrefix ? MatchRank(c.MatchTarget, c.Item.Label, prefix) : 0, isFk: c.Item.SortText?.StartsWith('!') == true))
            .OrderBy(x => x.isFk && (!hasPrefix || x.matchRank <= 3) ? 0 : 1)
            .ThenBy(x => hasPrefix ? x.matchRank : 0)
            .ThenBy(x => x.c.GroupPriority)
            .ThenBy(x => x.c.Item.SortText ?? x.c.Item.Label, StringComparer.OrdinalIgnoreCase)
            .ThenBy(x => x.idx);

        var items = new List<LanguageCompletionItem>(Math.Min(candidates.Count, SqlToolsLanguageService.MaxCompletionItems));
        var totalChars = 0;

        foreach (var entry in ordered)
        {
            if (items.Count >= SqlToolsLanguageService.MaxCompletionItems)
            {
                incomplete = true;
                break;
            }
            var item = entry.c.Item;
            var size = item.Label.Length + (item.Detail?.Length ?? 0) + (item.Documentation?.Length ?? 0)
                + (item.InsertText?.Length ?? 0) + (item.TextEdit?.NewText.Length ?? 0)
                + (item.SortText?.Length ?? 0) + (item.FilterText?.Length ?? 0);
            if (totalChars + size > MaxAggregateChars)
            {
                incomplete = true;
                break;
            }
            totalChars += size;
            items.Add(item);
        }

        return new LanguageCompletionResult(items, incomplete);
    }

    private static int MatchRank(string target, string label, string prefix)
    {
        static int Score(string raw, string p)
        {
            if (string.IsNullOrEmpty(raw)) return 4;
            if (raw.Equals(p, StringComparison.OrdinalIgnoreCase)) return 0;
            if (raw.StartsWith(p, StringComparison.OrdinalIgnoreCase)) return 1;
            if (raw.Contains(p, StringComparison.OrdinalIgnoreCase)) return 2;
            return IsSubsequence(raw, p) ? 3 : 4;
        }

        var best = Score(target, prefix);
        if (best == 0) return 0;
        var unquotedLabel = TsqlCatalog.Unquote(label);
        if (!string.Equals(unquotedLabel, target, StringComparison.Ordinal))
        {
            var labelScore = Score(unquotedLabel, prefix);
            if (labelScore < best) best = labelScore;
        }
        return best;
    }

    internal static bool IsSubsequence(string candidate, string query)
    {
        if (query.Length > candidate.Length) return false;
        var matched = 0;
        for (var i = 0; i < candidate.Length && matched < query.Length; i++)
        {
            if (char.ToUpperInvariant(candidate[i]) == char.ToUpperInvariant(query[matched]))
                matched++;
        }
        return matched == query.Length;
    }

    private delegate void AddItem(string label, int kind, string? detail, string? doc, string insertText, string? filterText, string sortKey, int priority = 50, int? insertFormat = 1);

    private static void EmitKeywords(IReadOnlyList<string> keywords, AddItem add)
    {
        for (var i = 0; i < keywords.Count; i++)
        {
            var kw = keywords[i];
            add(kw, 14, "Keyword", null, kw, kw, $"8{i:D3}:{kw}", priority: 80);
        }
    }

    private static void EmitDatabases(IndexLookup? lookup, AddItem add, ref bool incomplete)
    {
        if (lookup is null) return;
        if (lookup.IndexState == "building") incomplete = true;
        foreach (var dbName in lookup.Databases())
        {
            var db = lookup.Database(dbName);
            var bracketed = TsqlCatalog.Bracket(dbName);
            var detail = db.State switch
            {
                LookupState.Partial => "Database · partial",
                LookupState.Building => "Database · indexing…",
                LookupState.Skipped => "Database · skipped",
                _ => "Database"
            };
            add(bracketed, 9, detail, null, bracketed, dbName, $"10:{dbName}", priority: 10);
        }
    }

    private static void EmitDataTypes(IndexLookup? lookup, string? activeDb, AddItem add, ref bool incomplete)
    {
        for (var i = 0; i < TsqlCatalog.DataTypes.Count; i++)
        {
            var type = TsqlCatalog.DataTypes[i];
            add(type.Name, 14, "Data type", type.Summary, type.Name, type.Name, $"1{i:D3}:{type.Name}", priority: 10);
        }
        if (lookup is null || string.IsNullOrEmpty(activeDb)) return;
        var db = lookup.Database(activeDb);
        if (db.State == LookupState.Building) incomplete = true;
        if (db.Held is null) return;
        var table = db.Held.Table;
        for (var at = 0; at < table.Count; at++)
        {
            if (table.Parent(at) >= 0) continue;
            var kind = table.Kind(at);
            if (kind is not ("type" or "tableType")) continue;
            var schema = table.Schema(at);
            var name = table.Name(at);
            var formatted = TsqlCatalog.FormatObjectPath(null, schema, name);
            add(formatted, 22, kind == "tableType" ? "User-defined table type" : "User-defined type", null, formatted, name, $"20:{name}", priority: 20);
        }
    }

    private static void EmitDateParts(AddItem add)
    {
        for (var i = 0; i < TsqlCatalog.DateParts.Count; i++)
        {
            var dp = TsqlCatalog.DateParts[i];
            add(dp.Name, 14, $"Date part ({dp.Abbreviations})", dp.Summary, dp.Name, dp.Name, $"1{i:D3}:{dp.Name}", priority: 10);
        }
    }

    private static void EmitSystemGlobals(AddItem add, int basePriority = 10)
    {
        for (var i = 0; i < TsqlCatalog.SystemGlobals.Count; i++)
        {
            var g = TsqlCatalog.SystemGlobals[i];
            add(g.Name, 6, g.ReturnType, g.Summary, g.Name, g.Name, $"{(basePriority == 10 ? "1" : "6")}{i:D3}:{g.Name}", priority: basePriority);
        }
    }

    private static void EmitLocalVariables(TsqlCompletionContext ctx, IndexLookup? lookup, AddItem add)
    {
        var confirmedTableVars = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var t in ctx.TableVariables.Values)
        {
            if (!IsConfirmedTableVariable(t, lookup, ctx.ActiveDatabase)) continue;
            confirmedTableVars.Add(t.Name);
            add(t.Name, 6, t.TableTypeRef is { } udt ? $"Table variable ({udt.Schema}.{udt.Name})" : "Table variable", null, t.Name, t.Name, $"15:{t.Name}", priority: 15);
        }
        foreach (var v in ctx.ScalarVariables.Values)
        {
            if (confirmedTableVars.Contains(v.Name)) continue;
            add(v.Name, 6, v.TypeText ?? "Local variable", null, v.Name, v.Name, $"10:{v.Name}", priority: 10);
        }
    }

    private static void EmitMemberCompletions(TsqlCompletionContext ctx, IndexLookup? lookup, AddItem add, ref bool incomplete)
    {
        var qualifier = ctx.QualifierParts;
        if (qualifier.Count == 0) return;

        // 1. Expression dot: check in-scope sources & outer sources first (`o.`, `[bob].`, `inserted.`, `#Recent.`, `@t.`).
        if (!ctx.MemberIsObjectPosition)
        {
            var matchedSource = FindSourceByQualifier(ctx, qualifier, lookup);
            if (matchedSource is not null)
            {
                EmitSourceColumns(matchedSource, lookup, ctx.ActiveDatabase, qualify: false, add, ref incomplete);
                return;
            }
            // Also check scalar/aggregate functions on schema dot in expressions (`SELECT dbo.|`).
            if (lookup is not null && !string.IsNullOrEmpty(ctx.ActiveDatabase) && qualifier.Count == 1)
            {
                var db = lookup.Database(ctx.ActiveDatabase);
                if (db.State == LookupState.Building) incomplete = true;
                foreach (var obj in lookup.ObjectsInSchema(ctx.ActiveDatabase, qualifier[0]))
                {
                    if (obj.Kind != "function" || obj.Subtype is "inline" or "tableValued" or "clrTableValued") continue;
                    EmitCatalogObject(obj, qualifySchema: false, qualifyDatabase: false, detailSuffix: null, add, priority: 30, sortPrefix: "30");
                }
            }
            return;
        }

        // 2. Object dot: `dbo.|`, `AnalyticsDB.|`, `AnalyticsDB.dbo.|`, `AnalyticsDB..|`, `sys.|`, `INFORMATION_SCHEMA.|`
        if (lookup is null) return;
        if (lookup.IndexState == "building") incomplete = true;

        if (qualifier.Count == 1)
        {
            var seg = qualifier[0];
            // Schema in current DB -> objects in that schema
            if (!string.IsNullOrEmpty(ctx.ActiveDatabase))
            {
                var db = lookup.Database(ctx.ActiveDatabase);
                if (db.State == LookupState.Building) incomplete = true;
                foreach (var obj in lookup.ObjectsInSchema(ctx.ActiveDatabase, seg))
                {
                    if (!MatchesObjectHint(obj, ctx.ObjectHint)) continue;
                    EmitCatalogObject(obj, qualifySchema: false, qualifyDatabase: false, detailSuffix: null, add, priority: 15, sortPrefix: "20");
                }
            }
            // Database name -> schemas in that database
            var candidateDb = lookup.Database(seg);
            if (candidateDb.State != LookupState.Absent)
            {
                if (candidateDb.State == LookupState.Building) incomplete = true;
                foreach (var schema in lookup.Schemas(candidateDb.Database))
                {
                    var bracketed = TsqlCatalog.Bracket(schema);
                    add(bracketed, 9, $"Schema · {candidateDb.Database}", null, bracketed, schema, $"25:{schema}", priority: 25);
                }
            }
        }
        else if (qualifier.Count >= 2)
        {
            var targetDb = qualifier[0];
            var targetSchema = string.IsNullOrEmpty(qualifier[1]) ? "dbo" : qualifier[1];
            var db = lookup.Database(targetDb);
            if (db.State == LookupState.Building) incomplete = true;
            if (db.State == LookupState.Absent) return;
            foreach (var obj in lookup.ObjectsInSchema(db.Database, targetSchema))
            {
                if (!MatchesObjectHint(obj, ctx.ObjectHint)) continue;
                EmitCatalogObject(obj, qualifySchema: false, qualifyDatabase: false, detailSuffix: null, add, priority: 15, sortPrefix: "20");
            }
        }
    }

    private static void EmitObjectCompletions(TsqlCompletionContext ctx, IndexLookup? lookup, AddItem add, ref bool incomplete, CancellationToken cancellationToken)
    {
        // 1. CTEs
        foreach (var cte in ctx.Ctes)
            add(cte.Name, 7, "CTE", null, cte.Name, cte.Name, $"10:{cte.Name}", priority: 10);

        // 2. Script-local #temp / ##global_temp tables
        foreach (var temp in ctx.TempTables.Values)
            add(temp.Name, 7, temp.Name.StartsWith("##", StringComparison.Ordinal) ? "Global temporary table" : "Temporary table", null, temp.Name, temp.Name, $"12:{temp.Name}", priority: 12);

        // 3. Batch-local @table variables (excluding scalar UDTs that do not resolve to a tableType)
        foreach (var tv in ctx.TableVariables.Values)
        {
            if (!IsConfirmedTableVariable(tv, lookup, ctx.ActiveDatabase)) continue;
            add(tv.Name, 6, "Table variable", null, tv.Name, tv.Name, $"14:{tv.Name}", priority: 14);
        }

        if (lookup is null) return;
        if (lookup.IndexState == "building") incomplete = true;

        var activeDb = ctx.ActiveDatabase;
        var hasActiveDb = !string.IsNullOrEmpty(activeDb);
        var activeResolved = hasActiveDb ? lookup.Database(activeDb!) : null;
        if (activeResolved?.State == LookupState.Building) incomplete = true;

        // 4. Current DB schemas + objects in a single O(N) pass (avoiding O(schemas * N) scans).
        if (activeResolved is { State: not LookupState.Absent })
        {
            var schemas = lookup.Schemas(activeResolved.Database);
            foreach (var schema in schemas)
            {
                var isSystem = schema.Equals("sys", StringComparison.OrdinalIgnoreCase) || schema.Equals("INFORMATION_SCHEMA", StringComparison.OrdinalIgnoreCase);
                var bracketed = TsqlCatalog.Bracket(schema);
                add(bracketed, 9, isSystem ? "System schema" : "Schema", null, bracketed, schema, $"{(isSystem ? "55" : "40")}:{schema}", priority: isSystem ? 55 : 40);
            }

            if (activeResolved.Held is { } read)
            {
                var table = read.Table;
                for (var at = 0; at < table.Count; at++)
                {
                    if ((at & 1023) == 0) cancellationToken.ThrowIfCancellationRequested();
                    if (table.Parent(at) >= 0) continue;
                    var obj = new LookupObject(activeResolved.Database, table, at, read);
                    if (!MatchesObjectHint(obj, ctx.ObjectHint)) continue;
                    var schema = obj.Schema ?? "dbo";
                    if (schema.Equals("sys", StringComparison.OrdinalIgnoreCase)
                        || schema.Equals("INFORMATION_SCHEMA", StringComparison.OrdinalIgnoreCase)) continue;
                    var isDbo = schema.Equals("dbo", StringComparison.OrdinalIgnoreCase);
                    EmitCatalogObject(obj, qualifySchema: true, qualifyDatabase: false, detailSuffix: $"{activeResolved.Database}.{schema}",
                        add, priority: isDbo ? 20 : 25, sortPrefix: isDbo ? "20" : "25");
                }
            }
        }

        // 5. Indexed databases (for `[OtherDB].dbo.Table` navigation)
        var allDatabases = lookup.Databases();
        var hasOtherDatabases = false;
        foreach (var dbName in allDatabases)
        {
            if (activeResolved is null || !string.Equals(dbName, activeResolved.Database, StringComparison.OrdinalIgnoreCase))
                hasOtherDatabases = true;
            var bracketed = TsqlCatalog.Bracket(dbName);
            add(bracketed, 9, "Database", null, bracketed, dbName, $"45:{dbName}", priority: 45);
        }

        // 6. Cross-DB fuzzy FROM jump when 2+ characters typed!
        // When < 2 characters are typed and other databases exist, mark incomplete so interactive typing re-queries once 2+ chars exist.
        var prefix = TsqlCatalog.Unquote(ctx.Typed);
        if (prefix.Length >= 2)
            EmitCrossDatabaseJump(lookup, allDatabases, activeResolved?.Database, prefix, ctx.ObjectHint, add, ref incomplete, cancellationToken);
        else if (hasOtherDatabases)
            incomplete = true;
    }

    private static void EmitCrossDatabaseJump(
        IndexLookup lookup,
        IReadOnlyList<string> allDatabases,
        string? activeDb,
        string prefix,
        TsqlObjectHint hint,
        AddItem add,
        ref bool incomplete,
        CancellationToken cancellationToken)
    {
        var otherDbs = new List<LookupDatabase>();
        foreach (var dbName in allDatabases)
        {
            if (activeDb is not null && string.Equals(dbName, activeDb, StringComparison.OrdinalIgnoreCase)) continue;
            var db = lookup.Database(dbName);
            if (db.Held is not null) otherDbs.Add(db);
        }
        if (otherDbs.Count == 0) return;

        // Per-DB top-level object budget prevents one huge database from starving smaller databases.
        var perDbTopBudget = Math.Max(500, MaxJumpTopLevelScan / otherDbs.Count);
        var totalTopScanned = 0;
        var topK = new List<(LookupObject Obj, int Rank)>(MaxJumpHits + 1);

        static int CompareHit((LookupObject Obj, int Rank) a, (LookupObject Obj, int Rank) b)
        {
            var cmp = a.Rank.CompareTo(b.Rank);
            if (cmp != 0) return cmp;
            cmp = StringComparer.OrdinalIgnoreCase.Compare(a.Obj.Name, b.Obj.Name);
            if (cmp != 0) return cmp;
            return StringComparer.OrdinalIgnoreCase.Compare(a.Obj.Database, b.Obj.Database);
        }

        foreach (var db in otherDbs)
        {
            var table = db.Held!.Table;
            var dbTopScanned = 0;
            for (var at = 0; at < table.Count; at++)
            {
                if ((at & 1023) == 0) cancellationToken.ThrowIfCancellationRequested();
                if (table.Parent(at) >= 0) continue;
                if (++dbTopScanned > perDbTopBudget) { incomplete = true; break; }
                if (++totalTopScanned > MaxJumpTopLevelScan) { incomplete = true; goto DoneScan; }
                var kind = table.Kind(at);
                if (!MatchesObjectKind(kind, table.Subtype(at), hint)) continue;
                var schema = table.Schema(at) ?? "dbo";
                if (schema.Equals("sys", StringComparison.OrdinalIgnoreCase) || schema.Equals("INFORMATION_SCHEMA", StringComparison.OrdinalIgnoreCase)) continue;
                var name = table.Name(at);
                var rank = MatchRank(name, name, prefix);
                if (rank > 3) continue;

                var candidate = (new LookupObject(db.Database, table, at, db.Held), rank);
                if (topK.Count < MaxJumpHits)
                {
                    topK.Add(candidate);
                    if (topK.Count == MaxJumpHits) topK.Sort(CompareHit);
                }
                else if (CompareHit(candidate, topK[^1]) < 0)
                {
                    topK[^1] = candidate;
                    for (var j = topK.Count - 1; j > 0 && CompareHit(topK[j], topK[j - 1]) < 0; j--)
                        (topK[j], topK[j - 1]) = (topK[j - 1], topK[j]);
                }
            }
        }

    DoneScan:
        if (topK.Count > 1 && topK.Count < MaxJumpHits) topK.Sort(CompareHit);
        foreach (var hit in topK)
        {
            EmitCatalogObject(
                hit.Obj,
                qualifySchema: true,
                qualifyDatabase: true,
                detailSuffix: null,
                add,
                priority: 30,
                sortPrefix: "30");
        }
    }

    private static void EmitJoinForeignKeyConditions(TsqlCompletionContext ctx, IndexLookup? lookup, AddItem add, ref bool incomplete)
    {
        if (lookup is null || ctx.JoinRightSource is null || ctx.JoinLeftSources.Count == 0) return;
        var rightObj = ResolveCatalogObjectForSource(ctx.JoinRightSource, lookup, ctx.ActiveDatabase, out var rightBuilding);
        if (rightBuilding) incomplete = true;
        if (rightObj is not { } rhs) return;

        var rightQual = ctx.JoinRightSource.RawQualifier;
        var emittedPredicates = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var fkIndex = 0;

        foreach (var leftSource in ctx.JoinLeftSources)
        {
            var leftObj = ResolveCatalogObjectForSource(leftSource, lookup, ctx.ActiveDatabase, out var leftBuilding);
            if (leftBuilding) incomplete = true;
            if (leftObj is not { } lhs) continue;

            var leftQual = leftSource.RawQualifier;

            // Outgoing FKs from LHS -> RHS (e.g., Orders.CustomerId -> Customers.Id)
            foreach (var fk in lookup.ForeignKeys(lhs))
            {
                if (fk.Referenced is not { } target || !SameCatalogObject(target, rhs)) continue;
                EmitFkPredicate(fk, leftQual, rightQual, leftIsFkOwner: true, emittedPredicates, ref fkIndex, add);
            }

            // Outgoing FKs from RHS -> LHS (e.g., Customers JOIN Orders ON c.Id = o.CustomerId -> emit lhs = rhs)
            foreach (var fk in lookup.ForeignKeys(rhs))
            {
                if (fk.Referenced is not { } target || !SameCatalogObject(target, lhs)) continue;
                EmitFkPredicate(fk, leftQual, rightQual, leftIsFkOwner: false, emittedPredicates, ref fkIndex, add);
            }
        }
    }

    private static void EmitFkPredicate(
        LookupForeignKey fk,
        string leftQual,
        string rightQual,
        bool leftIsFkOwner,
        HashSet<string> emittedPredicates,
        ref int fkIndex,
        AddItem add)
    {
        var clauses = new List<string>(fk.Pairs.Count);
        foreach (var (col, refCol) in fk.Pairs)
        {
            if (string.IsNullOrEmpty(col) || string.IsNullOrEmpty(refCol)) return;
            var leftCol = leftIsFkOwner ? col : refCol;
            var rightCol = leftIsFkOwner ? refCol : col;
            clauses.Add($"{leftQual}.{TsqlCatalog.Bracket(leftCol)} = {rightQual}.{TsqlCatalog.Bracket(rightCol)}");
        }
        if (clauses.Count == 0) return;
        var predicate = string.Join(" AND ", clauses);
        if (!emittedPredicates.Add(predicate)) return;
        var idx = fkIndex++;
        add(
            predicate,
            10, // Property (and !-prefixed sortText puts it unconditionally #1 ahead of columns!)
            $"FK · {fk.Entry.Name}",
            $"Foreign key join condition from {fk.Entry.Name}.",
            predicate,
            predicate,
            $"!0{idx:D2}:{predicate}",
            priority: 0);
    }

    private static void EmitExpressionCompletions(TsqlCompletionContext ctx, IndexLookup? lookup, AddItem add, ref bool incomplete)
    {
        var allSources = ctx.Sources.Concat(ctx.OuterSources).ToList();
        var qualifyMulti = allSources.Count > 1;

        // 1. In-scope columns (inner sources first, then outer correlated sources).
        foreach (var source in allSources)
        {
            var qualify = source.HasExplicitAlias || qualifyMulti;
            EmitSourceColumns(source, lookup, ctx.ActiveDatabase, qualify, add, ref incomplete);
        }

        // 2. ORDER BY output aliases (bare bracketed names, matching SqlCompletionLiveChecks).
        foreach (var alias in ctx.OutputAliases)
        {
            var bracketed = TsqlCatalog.Bracket(alias);
            add(bracketed, 5, "Column alias", null, bracketed, alias, $"05:{alias}", priority: 5);
        }

        // 3. Table aliases / source names.
        foreach (var source in allSources)
        {
            if (string.IsNullOrEmpty(source.RawQualifier)) continue;
            var detail = source.Kind switch
            {
                "cte" => "CTE alias",
                "temp" => "Temp table",
                "tableVar" => "Table variable",
                "output" => "OUTPUT virtual table",
                _ => source.ObjectRef is { } obj ? $"Alias · {(obj.Schema is not null ? obj.Schema + "." : "")}{obj.Name}" : "Alias"
            };
            add(source.RawQualifier, 10, detail, null, source.RawQualifier, source.ExposureName, $"30:{source.ExposureName}", priority: 30);
        }

        // 4. Batch-local @scalar variables.
        foreach (var v in ctx.ScalarVariables.Values)
            add(v.Name, 6, v.TypeText ?? "Local variable", null, v.Name, v.Name, $"35:{v.Name}", priority: 35);

        // 5. Built-in T-SQL functions.
        for (var i = 0; i < TsqlCatalog.BuiltInFunctions.Count; i++)
        {
            var fn = TsqlCatalog.BuiltInFunctions[i];
            var doc = fn.Summary + (fn.Signatures.Length > 0 ? "\n\n" + string.Join("\n", fn.Signatures) : "");
            add(fn.Name, 3, $"Function · {fn.ReturnType}", doc, fn.Name, fn.Name, $"6{i:D3}:{fn.Name}", priority: 60);
        }

        // 6. Expression keywords.
        EmitKeywords(TsqlCatalog.ExpressionKeywords, add);
    }

    private static void EmitSourceColumns(
        TsqlSourceRef source,
        IndexLookup? lookup,
        string? activeDb,
        bool qualify,
        AddItem add,
        ref bool incomplete)
    {
        var (columns, colIncomplete, catalogObj) = ResolveSourceColumns(source, lookup, activeDb, depth: 0);
        if (colIncomplete) incomplete = true;

        var ownerDetail = catalogObj is { } obj
            ? $"{(obj.Schema is { Length: > 0 } s ? s + "." : "")}{obj.Name}"
            : source.ExposureName;

        for (var i = 0; i < columns.Count; i++)
        {
            var col = columns[i];
            var bracketedCol = TsqlCatalog.Bracket(col.Name);
            var label = qualify && !string.IsNullOrEmpty(source.RawQualifier)
                ? $"{source.RawQualifier}.{bracketedCol}"
                : bracketedCol;
            var detailParts = new List<string>(3);
            if (!string.IsNullOrEmpty(col.TypeText)) detailParts.Add(col.TypeText);
            if (!string.IsNullOrEmpty(col.Markers)) detailParts.Add(col.Markers);
            if (!string.IsNullOrEmpty(ownerDetail)) detailParts.Add(ownerDetail);
            var detail = detailParts.Count > 0 ? string.Join(" · ", detailParts) : null;
            var priority = source.IsOuter ? 12 : 10;
            add(label, 5, detail, col.ForeignKeyTarget is { } fk ? $"Foreign key → {fk}" : null, label, col.Name, $"0{(source.IsOuter ? "2" : "1")}{i:D4}:{col.Name}", priority: priority);
        }
    }

    internal static (List<ResolvedColumn> Columns, bool Incomplete, LookupObject? CatalogObject) ResolveSourceColumns(
        TsqlSourceRef source,
        IndexLookup? lookup,
        string? activeDb,
        int depth)
    {
        var result = new List<ResolvedColumn>();
        var dbForCollation = lookup is not null && !string.IsNullOrEmpty(source.ObjectRef?.Database ?? activeDb)
            ? lookup.Database((source.ObjectRef?.Database ?? activeDb)!)
            : null;
        var colComparer = CollationComparer(dbForCollation);
        var seen = new HashSet<string>(colComparer);
        var incomplete = false;
        LookupObject? catalogObj = null;

        if (source.ObjectRef is not null && lookup is not null)
        {
            var obj = ResolveCatalogObjectForSource(source, lookup, activeDb, out var building);
            if (building) incomplete = true;
            if (obj is { } found)
            {
                catalogObj = found;
                var db = lookup.Database(found.Database);
                var objComparer = CollationComparer(db);
                if (!ReferenceEquals(objComparer, colComparer))
                {
                    colComparer = objComparer;
                    seen = new HashSet<string>(colComparer);
                }
                if (db.Gaps.HasFlag(LookupGaps.ChildrenLeftOut)) incomplete = true;
                var cols = lookup.Columns(found);
                var indexes = lookup.Indexes(found);
                var fks = lookup.ForeignKeys(found);
                var pkIds = new HashSet<short>();
                var ukIds = new HashSet<short>();
                foreach (var ix in indexes)
                {
                    if (ix.Kind == "key" && ix.Subtype == "primary")
                        foreach (var pkc in ix.Columns) if (!pkc.Included && pkc.ColumnId > 0) pkIds.Add(pkc.ColumnId);
                    else if (ix.Kind == "key" && ix.Subtype == "unique")
                        foreach (var ukc in ix.Columns) if (!ukc.Included && ukc.ColumnId > 0) ukIds.Add(ukc.ColumnId);
                }
                var fkMap = new Dictionary<string, string>(objComparer);
                foreach (var fk in fks)
                {
                    var target = fk.Referenced is { } r ? $"{(r.Schema is { Length: > 0 } s ? s + "." : "")}{r.Name}" : null;
                    foreach (var (colName, refCol) in fk.Pairs)
                    {
                        if (!string.IsNullOrEmpty(colName) && !fkMap.ContainsKey(colName))
                            fkMap[colName] = target is not null ? (refCol is not null ? $"{target}({refCol})" : target) : fk.Entry.Name;
                    }
                }
                foreach (var c in cols)
                {
                    var markers = new List<string>(3);
                    if (c.Ordinal > 0 && pkIds.Contains(c.Ordinal)) markers.Add("PK");
                    if (c.Ordinal > 0 && ukIds.Contains(c.Ordinal)) markers.Add("UK");
                    if (fkMap.TryGetValue(c.Name, out var fkTarget)) markers.Add("FK");
                    var flags = c.Type?.Flags ?? TypedFlags.None;
                    if ((flags & TypedFlags.Identity) != 0) markers.Add("IDENTITY");
                    if (seen.Add(c.Name))
                    {
                        result.Add(new ResolvedColumn(
                            c.Name,
                            c.Type?.TypeText,
                            c.Type is { } t ? (t.Flags & TypedFlags.Nullable) != 0 : null,
                            markers.Count > 0 ? string.Join(" · ", markers) : null,
                            fkTarget));
                    }
                }
            }
        }

        if (source.InlineColumns is { Count: > 0 })
        {
            foreach (var c in source.InlineColumns)
                if (seen.Add(c.Name)) result.Add(new ResolvedColumn(c.Name, c.TypeText, c.Nullable));
        }

        if (source.HasStar && source.StarSources is { Count: > 0 } && depth < MaxStarDepth)
        {
            var excluded = source.ExcludedColumns is { Count: > 0 }
                ? new HashSet<string>(source.ExcludedColumns, colComparer)
                : null;
            foreach (var starSrc in source.StarSources)
            {
                var (subCols, subInc, _) = ResolveSourceColumns(starSrc, lookup, activeDb, depth + 1);
                if (subInc) incomplete = true;
                foreach (var sc in subCols)
                {
                    if (excluded is not null && excluded.Contains(sc.Name)) continue;
                    if (seen.Add(sc.Name)) result.Add(sc);
                }
            }
        }

        return (result, incomplete, catalogObj);
    }

    internal static LookupObject? ResolveCatalogObjectForSource(
        TsqlSourceRef source,
        IndexLookup lookup,
        string? activeDb,
        out bool building)
    {
        building = false;
        if (source.ObjectRef is not { } objRef) return null;
        return ResolveCatalogObject(lookup, objRef.Database ?? activeDb, objRef.Schema, objRef.Name,
            source.Kind == "tableVar" ? TableTypeKinds : QueryableKinds, out building);
    }

    internal static readonly IReadOnlySet<string> QueryableKinds = new HashSet<string>(StringComparer.Ordinal)
    {
        "table", "view", "function", "synonym", "tableType"
    };

    internal static readonly IReadOnlySet<string> TableTypeKinds = new HashSet<string>(StringComparer.Ordinal)
    {
        "tableType"
    };

    internal static LookupObject? ResolveCatalogObject(
        IndexLookup lookup,
        string? database,
        string? schema,
        string name,
        IReadOnlySet<string>? kinds,
        out bool building)
    {
        building = false;
        if (string.IsNullOrEmpty(database)) return null;
        var answer = lookup.Objects(database, schema, name, kinds);
        if (answer.Database.State == LookupState.Building) building = true;
        if (answer.Value.Count == 0) return null;
        if (answer.Value.Count == 1) return answer.Value[0];
        return answer.Value
            .OrderBy(o => schema is null && string.Equals(o.Schema, "dbo", StringComparison.OrdinalIgnoreCase) ? 0
                : schema is null && string.Equals(o.Schema, "sys", StringComparison.OrdinalIgnoreCase) ? 2 : 1)
            .ThenBy(o => o.Kind switch { "table" => 0, "view" => 1, "function" => 2, "procedure" => 3, "synonym" => 4, _ => 5 })
            .First();
    }

    private static TsqlSourceRef? FindSourceByQualifier(TsqlCompletionContext ctx, IReadOnlyList<string> qualifier, IndexLookup? lookup)
    {
        var all = ctx.Sources.Concat(ctx.OuterSources).ToList();
        if (all.Count == 0) return null;

        var db = lookup is not null && !string.IsNullOrEmpty(ctx.ActiveDatabase) ? lookup.Database(ctx.ActiveDatabase) : null;
        var caseSensitive = db?.CaseSensitive == true;
        var dottedI = !caseSensitive && db?.Held?.DottedI == true;

        bool MatchName(string a, string b) => caseSensitive
            ? string.Equals(a, b, StringComparison.Ordinal)
            : dottedI ? TurkishCase.Same(a, b) : string.Equals(a, b, StringComparison.OrdinalIgnoreCase);

        if (qualifier.Count == 1)
        {
            var q = qualifier[0];
            // Exact case match always wins first (supports case-distinct `t` vs `T` aliases even before DB metadata confirms CS).
            var exact = all.FirstOrDefault(s => string.Equals(s.ExposureName, q, StringComparison.Ordinal));
            if (exact is not null) return exact;
            if (!caseSensitive)
                return all.FirstOrDefault(s => MatchName(s.ExposureName, q));
            return null;
        }
        if (qualifier.Count == 2)
        {
            // e.g. `dbo.Orders.` when Orders was unaliased
            return all.FirstOrDefault(s => !s.HasExplicitAlias && s.ObjectRef is { } obj
                && MatchName(obj.Name, qualifier[1])
                && (obj.Schema is null || MatchName(obj.Schema, qualifier[0])));
        }
        return null;
    }

    private static bool SameCatalogObject(LookupObject a, LookupObject b) =>
        ReferenceEquals(a.Table, b.Table) && a.At == b.At;

    private static bool MatchesObjectHint(LookupObject obj, TsqlObjectHint hint) =>
        MatchesObjectKind(obj.Kind, obj.Subtype, hint);

    private static bool MatchesObjectKind(string kind, string? subtype, TsqlObjectHint hint) => hint switch
    {
        TsqlObjectHint.Procedure => kind == "procedure",
        TsqlObjectHint.TableValuedFunction => kind == "function" && subtype is "inline" or "tableValued" or "clrTableValued",
        TsqlObjectHint.TableOrView => kind is "table" or "view" or "synonym" || (kind == "function" && subtype is "inline" or "tableValued" or "clrTableValued"),
        _ => kind is "table" or "view" or "procedure" or "function" or "synonym" or "sequence" or "tableType"
    };

    private static void EmitCatalogObject(
        LookupObject obj,
        bool qualifySchema,
        bool qualifyDatabase,
        string? detailSuffix,
        AddItem add,
        int priority,
        string sortPrefix)
    {
        var label = qualifyDatabase
            ? TsqlCatalog.FormatObjectPath(obj.Database, obj.Schema ?? "dbo", obj.Name)
            : qualifySchema
                ? TsqlCatalog.FormatObjectPath(null, obj.Schema, obj.Name)
                : TsqlCatalog.Bracket(obj.Name);
        var lspKind = obj.Kind switch
        {
            "table" => 7,
            "view" => 8,
            "procedure" => 2,
            "function" => 3,
            "sequence" => 12,
            "synonym" => 18,
            "tableType" => 22,
            _ => 7
        };
        var kindLabel = obj.Kind switch
        {
            "table" => "Table",
            "view" => "View",
            "procedure" => "Procedure",
            "function" => "Function",
            "synonym" => "Synonym",
            "sequence" => "Sequence",
            "tableType" => "Table type",
            _ => obj.Kind
        };
        var detail = detailSuffix is not null ? $"{kindLabel} · {detailSuffix}" : kindLabel;
        add(label, lspKind, detail, null, label, obj.Name, $"{sortPrefix}:{obj.Name}", priority: priority);
    }

    private static string? Bounded(string? text, int limit) =>
        text is { Length: > 0 } ? (text.Length <= limit ? text : text[..limit]) : null;
}
