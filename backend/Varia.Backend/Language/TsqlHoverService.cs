using System.Text;
using Varia.Backend.Search;

namespace Varia.Backend.Language;

/// <summary>In-process T-SQL hover provider backed by <see cref="TsqlScopeReader"/> (ScriptDom) and
/// <see cref="IndexLookup"/> (Search Objects RAM index). Provides 3-level hover (Database, Schema, Table/View/Proc/Func/Synonym),
/// plus column, alias, #temp table, @table / @scalar variable, CTE, @@ global, built-in function, and data type hover.</summary>
internal static class TsqlHoverService
{
    private const int MaxHoverChars = 16_384;
    private const int MaxColumnsShown = 40;
    private const int MaxRelationsShown = 6;
    private const int MaxSamplesShown = 8;

    internal static LanguageHover? Hover(LanguageRequest request, IndexLookup? lookup, string? defaultDatabase)
    {
        var ctx = TsqlScopeReader.ReadHover(request.Text, request.Position, defaultDatabase);
        if (ctx is null || ctx.Parts.Count == 0) return null;

        var markdown = BuildMarkdown(ctx, lookup);
        if (string.IsNullOrWhiteSpace(markdown)) return null;
        if (markdown.Length > MaxHoverChars) markdown = markdown[..MaxHoverChars];
        return new LanguageHover(markdown, ctx.Range);
    }

    private static string? BuildMarkdown(TsqlHoverContext ctx, IndexLookup? lookup)
    {
        var parts = ctx.Parts;
        var at = ctx.HoveredSegmentIndex;
        var hovered = parts[at];
        if (string.IsNullOrEmpty(hovered)) return null;

        // 1. @@ System globals
        if (parts.Count == 1 && hovered.StartsWith("@@", StringComparison.Ordinal))
        {
            if (TsqlCatalog.SystemGlobalMap.TryGetValue(hovered, out var global))
                return $"**{TsqlCatalog.EscapeMarkdown(global.Name)}** · `{TsqlCatalog.EscapeMarkdown(global.ReturnType)}`\n\n{TsqlCatalog.EscapeMarkdown(global.Summary)}";
            return null;
        }

        // 2. @ Local variables (@table or @scalar)
        if (parts.Count == 1 && hovered.StartsWith('@'))
        {
            if (ctx.TableVariables.TryGetValue(hovered, out var tv))
                return FormatLocalTableMarkdown(tv, lookup, ctx.ActiveDatabase);
            if (ctx.ScalarVariables.TryGetValue(hovered, out var sv))
            {
                var type = !string.IsNullOrEmpty(sv.TypeText) ? $" · `{TsqlCatalog.EscapeMarkdown(sv.TypeText)}`" : "";
                return $"**{TsqlCatalog.EscapeMarkdown(sv.Name)}** · Local variable{type}";
            }
            return null;
        }

        // 3. #temp / ##global_temp tables
        if (parts.Count == 1 && hovered.StartsWith('#'))
        {
            if (ctx.TempTables.TryGetValue(hovered, out var temp))
                return FormatLocalTableMarkdown(temp, lookup, ctx.ActiveDatabase);
            return null;
        }

        // 4. USE <database> hover
        if (ctx.IsUseDatabase && lookup is not null)
            return FormatDatabaseHover(lookup, hovered);

        // 5. 3-level catalog hover when in object position OR multi-part object chain (db.schema.obj, schema.obj, obj)
        if (ctx.IsObjectPosition)
        {
            if (parts.Count == 1)
            {
                // CTE?
                var cte = ctx.Ctes.FirstOrDefault(c => string.Equals(c.Name, hovered, StringComparison.OrdinalIgnoreCase));
                if (cte is not null) return FormatCteMarkdown(cte, lookup, ctx.ActiveDatabase);
            }
            if (lookup is not null)
            {
                if (parts.Count == 3 && at == 0)
                    return FormatDatabaseHover(lookup, parts[0]);
                if (parts.Count == 3 && at == 1)
                    return FormatSchemaHover(lookup, parts[0], string.IsNullOrEmpty(parts[1]) ? "dbo" : parts[1]);
                if (parts.Count == 2 && at == 0)
                {
                    // Could be `schema.object` in activeDb OR `database.schema`.
                    if (!string.IsNullOrEmpty(ctx.ActiveDatabase) && FormatSchemaHover(lookup, ctx.ActiveDatabase, parts[0]) is { } schemaHover)
                        return schemaHover;
                    if (FormatDatabaseHover(lookup, parts[0]) is { } dbHover)
                        return dbHover;
                }
                if (at == parts.Count - 1)
                {
                    var dbName = parts.Count == 3 ? parts[0] : ctx.ActiveDatabase;
                    var schemaName = parts.Count == 3 ? (string.IsNullOrEmpty(parts[1]) ? null : parts[1])
                        : parts.Count == 2 ? parts[0] : null;
                    if (!string.IsNullOrEmpty(dbName) && lookup.ObjectSummary(dbName, schemaName, parts[^1]) is { } summary)
                        return FormatObjectSummaryMarkdown(summary);
                }
            }
            return null;
        }

        // 6. Data type hover when in type position (`CAST(x AS NVARCHAR)`, `DECLARE @x DATETIME2`)
        if (ctx.IsTypePosition && parts.Count == 1 && TsqlCatalog.DataTypeMap.TryGetValue(hovered, out var typeInfo))
            return $"**{TsqlCatalog.EscapeMarkdown(typeInfo.Name)}** · Data type\n\n{TsqlCatalog.EscapeMarkdown(typeInfo.Summary)}";

        // 7. Expression / dotted chain hover: alias, alias.column, bare column, CTE, catalog object, or built-in function.
        var allSources = ctx.Sources.Concat(ctx.OuterSources).ToList();
        var dbInfo = lookup is not null && !string.IsNullOrEmpty(ctx.ActiveDatabase) ? lookup.Database(ctx.ActiveDatabase) : null;
        var caseSensitive = dbInfo?.CaseSensitive == true;
        var dottedI = !caseSensitive && dbInfo?.Held?.DottedI == true;
        bool Same(string a, string b) => caseSensitive
            ? string.Equals(a, b, StringComparison.Ordinal)
            : dottedI ? TurkishCase.Same(a, b) : string.Equals(a, b, StringComparison.OrdinalIgnoreCase);

        if (parts.Count >= 2 && at == 0)
        {
            // Hovering qualifier in `o.CustomerId` or `dbo.fn_total(...)`
            var src = FindSource(allSources, parts[0], caseSensitive, Same);
            if (src is not null) return FormatSourceHover(src, lookup, ctx.ActiveDatabase);
            if (lookup is not null && !string.IsNullOrEmpty(ctx.ActiveDatabase))
            {
                if (parts.Count == 3 && FormatDatabaseHover(lookup, parts[0]) is { } dbH) return dbH;
                if (FormatSchemaHover(lookup, ctx.ActiveDatabase, parts[0]) is { } schH) return schH;
            }
        }
        else if (parts.Count == 3 && at == 1)
        {
            if (lookup is not null && FormatSchemaHover(lookup, parts[0], string.IsNullOrEmpty(parts[1]) ? "dbo" : parts[1]) is { } schH)
                return schH;
        }
        else if (parts.Count >= 2 && at == parts.Count - 1)
        {
            // Hovering leaf in `o.CustomerId` or `dbo.fn_total(...)`
            if (parts.Count == 2)
            {
                var src = FindSource(allSources, parts[0], caseSensitive, Same);
                if (src is not null)
                {
                    if (FormatColumnHover(src, parts[1], lookup, ctx.ActiveDatabase, Same) is { } colMd)
                        return colMd;
                }
            }
            if (lookup is not null)
            {
                var dbName = parts.Count == 3 ? parts[0] : ctx.ActiveDatabase;
                var schemaName = parts.Count == 3 ? (string.IsNullOrEmpty(parts[1]) ? null : parts[1]) : parts[0];
                if (!string.IsNullOrEmpty(dbName) && lookup.ObjectSummary(dbName, schemaName, parts[^1]) is { } summary)
                    return FormatObjectSummaryMarkdown(summary);
            }
        }
        else if (parts.Count == 1)
        {
            // Built-in function call (`DATEADD(...)`, `COUNT(...)`)
            if (ctx.IsCall && TsqlCatalog.FunctionMap.TryGetValue(hovered, out var fnCall))
                return FormatFunctionMarkdown(fnCall);

            // Alias itself (e.g., hovering `o` in `FROM dbo.Orders o`)
            var aliasedSrc = FindSource(allSources, hovered, caseSensitive, Same);
            if (aliasedSrc is not null && aliasedSrc.HasExplicitAlias)
                return FormatSourceHover(aliasedSrc, lookup, ctx.ActiveDatabase);

            // Bare column in scope
            foreach (var src in allSources)
            {
                if (FormatColumnHover(src, hovered, lookup, ctx.ActiveDatabase, Same) is { } colMd)
                    return colMd;
            }

            // Unaliased source name or CTE
            if (aliasedSrc is not null)
                return FormatSourceHover(aliasedSrc, lookup, ctx.ActiveDatabase);
            var cte = ctx.Ctes.FirstOrDefault(c => string.Equals(c.Name, hovered, StringComparison.OrdinalIgnoreCase));
            if (cte is not null) return FormatCteMarkdown(cte, lookup, ctx.ActiveDatabase);

            // Built-in function (even without parens, e.g. hovering `CURRENT_TIMESTAMP` or `COALESCE`)
            if (TsqlCatalog.FunctionMap.TryGetValue(hovered, out var fn))
                return FormatFunctionMarkdown(fn);

            // Fallback: catalog object in current DB
            if (lookup is not null && !string.IsNullOrEmpty(ctx.ActiveDatabase)
                && lookup.ObjectSummary(ctx.ActiveDatabase, null, hovered) is { } objSummary)
                return FormatObjectSummaryMarkdown(objSummary);
        }

        return null;
    }

    private static TsqlSourceRef? FindSource(IReadOnlyList<TsqlSourceRef> sources, string name, bool caseSensitive, Func<string, string, bool> same)
    {
        var exact = sources.FirstOrDefault(s => string.Equals(s.ExposureName, name, StringComparison.Ordinal));
        if (exact is not null) return exact;
        return caseSensitive ? null : sources.FirstOrDefault(s => same(s.ExposureName, name));
    }

    private static string? FormatDatabaseHover(IndexLookup lookup, string dbName)
    {
        var db = lookup.Database(dbName);
        if (db.State == LookupState.Absent) return null;
        var sb = new StringBuilder(256);
        sb.Append("**").Append(TsqlCatalog.EscapeMarkdown(db.Database)).Append("** · Database");

        var facts = new List<string>();
        facts.Add(db.State switch
        {
            LookupState.Ready => "Indexed",
            LookupState.Partial when db.Gaps.HasFlag(LookupGaps.ChildrenLeftOut) => "Partial (columns left out)",
            LookupState.Partial => "Partial",
            LookupState.Building => "Indexing…",
            LookupState.Skipped => $"Skipped ({db.Skip?.Code ?? "error"})",
            _ => db.State.ToString()
        });
        if (db.CaseSensitive == true) facts.Add("Case-sensitive collation");
        else if (db.Held?.DottedI == true) facts.Add("Case-insensitive (Turkish/Azeri)");
        else if (db.CaseSensitive == false) facts.Add("Case-insensitive collation");

        var schemas = lookup.Schemas(db.Database);
        if (schemas.Count > 0) facts.Add($"{schemas.Count:N0} {(schemas.Count == 1 ? "schema" : "schemas")}");

        if (db.Held is { } held)
        {
            int tables = 0, views = 0, procs = 0, funcs = 0;
            var t = held.Table;
            for (var at = 0; at < t.Count; at++)
            {
                if (t.Parent(at) >= 0) continue;
                switch (t.Kind(at))
                {
                    case "table": tables++; break;
                    case "view": views++; break;
                    case "procedure": procs++; break;
                    case "function": funcs++; break;
                }
            }
            if (tables > 0) facts.Add($"{tables:N0} {(tables == 1 ? "table" : "tables")}");
            if (views > 0) facts.Add($"{views:N0} {(views == 1 ? "view" : "views")}");
            if (procs > 0) facts.Add($"{procs:N0} {(procs == 1 ? "procedure" : "procedures")}");
            if (funcs > 0) facts.Add($"{funcs:N0} {(funcs == 1 ? "function" : "functions")}");
        }

        sb.Append("\n\n").Append(string.Join(" · ", facts.Select(TsqlCatalog.EscapeMarkdown)));
        if (schemas.Count > 0)
        {
            var sample = string.Join(", ", schemas.Take(MaxSamplesShown).Select(TsqlCatalog.EscapeMarkdown));
            var more = schemas.Count > MaxSamplesShown ? ", …" : "";
            sb.Append("\n\nSchemas: ").Append(sample).Append(more);
        }
        return sb.ToString();
    }

    private static string? FormatSchemaHover(IndexLookup lookup, string dbName, string schemaName)
    {
        var db = lookup.Database(dbName);
        if (db.State == LookupState.Absent) return null;
        var objects = lookup.ObjectsInSchema(db.Database, schemaName).ToList();
        var knownSchema = lookup.Schemas(db.Database).FirstOrDefault(s => string.Equals(s, schemaName, StringComparison.OrdinalIgnoreCase));
        if (objects.Count == 0 && knownSchema is null) return null;

        var resolvedSchema = knownSchema ?? schemaName;
        var sb = new StringBuilder(256);
        sb.Append("**").Append(TsqlCatalog.EscapeMarkdown(resolvedSchema)).Append("** · Schema\n\n");
        sb.Append(TsqlCatalog.EscapeMarkdown($"{TsqlCatalog.Bracket(db.Database)}.{TsqlCatalog.Bracket(resolvedSchema)}"));

        int tables = 0, views = 0, procs = 0, funcs = 0;
        foreach (var o in objects)
        {
            switch (o.Kind)
            {
                case "table": tables++; break;
                case "view": views++; break;
                case "procedure": procs++; break;
                case "function": funcs++; break;
            }
        }
        var counts = new List<string>();
        if (tables > 0) counts.Add($"{tables:N0} {(tables == 1 ? "table" : "tables")}");
        if (views > 0) counts.Add($"{views:N0} {(views == 1 ? "view" : "views")}");
        if (procs > 0) counts.Add($"{procs:N0} {(procs == 1 ? "procedure" : "procedures")}");
        if (funcs > 0) counts.Add($"{funcs:N0} {(funcs == 1 ? "function" : "functions")}");
        if (counts.Count > 0)
            sb.Append("\n\n").Append(string.Join(" · ", counts.Select(TsqlCatalog.EscapeMarkdown)));
        else
            sb.Append("\n\nNo indexed objects in this schema yet.");

        if (objects.Count > 0)
        {
            var sample = string.Join(", ", objects.Take(MaxSamplesShown).Select(o => TsqlCatalog.EscapeMarkdown(o.Name)));
            var more = objects.Count > MaxSamplesShown ? ", …" : "";
            sb.Append("\n\nObjects: ").Append(sample).Append(more);
        }
        return sb.ToString();
    }

    private static string FormatObjectSummaryMarkdown(LookupObjectSummary summary)
    {
        var obj = summary.Object;
        var kindLabel = obj.Kind switch
        {
            "table" => "Table",
            "view" => "View",
            "procedure" => "Stored procedure",
            "function" => "Function",
            "synonym" => "Synonym",
            "sequence" => "Sequence",
            "tableType" => "Table type",
            _ => obj.Kind
        };
        var title = obj.Schema is { Length: > 0 } s ? $"{s}.{obj.Name}" : obj.Name;
        var sb = new StringBuilder(512);
        sb.Append("**").Append(TsqlCatalog.EscapeMarkdown(title)).Append("** · ").Append(TsqlCatalog.EscapeMarkdown(kindLabel)).Append("\n\n");
        sb.Append(TsqlCatalog.EscapeMarkdown(TsqlCatalog.FormatObjectPath(summary.Database.Database, obj.Schema, obj.Name)));

        var pkIds = new HashSet<short>();
        var ukIds = new HashSet<short>();
        var fkCols = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var pks = new List<LookupIndex>();
        var uks = new List<LookupIndex>();
        var indexes = new List<LookupIndex>();
        foreach (var ix in summary.Indexes)
        {
            if (ix.Kind == "key" && ix.Subtype == "primary")
            {
                pks.Add(ix);
                foreach (var kc in ix.Columns) if (!kc.Included && kc.ColumnId > 0) pkIds.Add(kc.ColumnId);
            }
            else if (ix.Kind == "key" && ix.Subtype == "unique")
            {
                uks.Add(ix);
                foreach (var kc in ix.Columns) if (!kc.Included && kc.ColumnId > 0) ukIds.Add(kc.ColumnId);
            }
            else if (ix.Kind == "index") indexes.Add(ix);
        }
        foreach (var fk in summary.ForeignKeys)
            foreach (var (col, _) in fk.Pairs) if (!string.IsNullOrEmpty(col)) fkCols.Add(col);

        var facts = new List<string>();
        if (pks.Count > 0)
        {
            var pkCols = string.Join(", ", pks[0].Columns.Where(c => !c.Included && c.Name is not null).Select(c => c.Name!));
            facts.Add(pkCols.Length > 0 ? $"PK ({pkCols})" : "Primary key");
        }
        if (uks.Count > 0) facts.Add($"{uks.Count} unique {(uks.Count == 1 ? "key" : "keys")}");
        if (indexes.Count > 0) facts.Add($"{indexes.Count} {(indexes.Count == 1 ? "index" : "indexes")}");
        if (summary.ForeignKeys.Count > 0) facts.Add($"{summary.ForeignKeys.Count} {(summary.ForeignKeys.Count == 1 ? "FK" : "FKs")} out");
        if (summary.ReferencedBy.Count > 0) facts.Add($"{summary.ReferencedBy.Count} referenced by");
        if (obj.Kind is "procedure" or "function" && obj.Type?.TypeText is { Length: > 0 } ret)
            facts.Add($"RETURNS {ret}");
        if (facts.Count > 0) sb.Append("\n\n").Append(string.Join(" · ", facts.Select(TsqlCatalog.EscapeMarkdown)));

        if (summary.Columns.Count > 0)
        {
            sb.Append("\n\n| Column | Type |\n| --- | --- |");
            foreach (var col in summary.Columns.Take(MaxColumnsShown))
            {
                var parts = new List<string>(4);
                if (col.Type?.TypeText is { Length: > 0 } t) parts.Add(TsqlCatalog.EscapeMarkdown(t));
                var flags = col.Type?.Flags ?? TypedFlags.None;
                if (col.Type is not null && (flags & TypedFlags.Nullable) == 0) parts.Add("NOT NULL");
                if (col.Ordinal > 0 && pkIds.Contains(col.Ordinal)) parts.Add("PK");
                if (col.Ordinal > 0 && ukIds.Contains(col.Ordinal)) parts.Add("UK");
                if (fkCols.Contains(col.Name)) parts.Add("FK");
                if ((flags & TypedFlags.Identity) != 0) parts.Add("IDENTITY");
                if ((flags & TypedFlags.Computed) != 0) parts.Add("COMPUTED");
                sb.Append("\n| ").Append(TsqlCatalog.EscapeMarkdown(col.Name)).Append(" | ").Append(string.Join(" · ", parts)).Append(" |");
            }
            if (summary.Columns.Count > MaxColumnsShown)
                sb.Append($"\n\nand {summary.Columns.Count - MaxColumnsShown:N0} more columns");
        }
        else if (summary.Parameters.Count > 0)
        {
            sb.Append("\n\n| Parameter | Type |\n| --- | --- |");
            foreach (var p in summary.Parameters.Take(MaxColumnsShown))
            {
                var parts = new List<string>(3);
                if (p.Type?.TypeText is { Length: > 0 } t) parts.Add(TsqlCatalog.EscapeMarkdown(t));
                var flags = p.Type?.Flags ?? TypedFlags.None;
                if ((flags & TypedFlags.Output) != 0) parts.Add("OUTPUT");
                if ((flags & TypedFlags.ReadOnly) != 0) parts.Add("READONLY");
                sb.Append("\n| ").Append(TsqlCatalog.EscapeMarkdown(p.Name)).Append(" | ").Append(string.Join(" · ", parts)).Append(" |");
            }
        }
        else if (summary.Database.Gaps.HasFlag(LookupGaps.ChildrenLeftOut))
        {
            sb.Append("\n\nColumns were left out by the Search Objects memory budget.");
        }

        if (summary.ForeignKeys.Count > 0 || summary.ReferencedBy.Count > 0)
        {
            sb.Append("\n\n**Foreign Keys**");
            var shown = 0;
            foreach (var fk in summary.ForeignKeys)
            {
                if (shown++ >= MaxRelationsShown) break;
                var cols = string.Join(", ", fk.Pairs.Select(p => p.Column).Where(n => n is not null));
                var refs = string.Join(", ", fk.Pairs.Select(p => p.ReferencedColumn).Where(n => n is not null));
                var target = fk.Referenced is { } r ? $"{(r.Schema is { Length: > 0 } rs ? rs + "." : "")}{r.Name}" : "?";
                sb.Append("\n- → ").Append(TsqlCatalog.EscapeMarkdown($"({cols}) → {target}({refs})"));
            }
            foreach (var fk in summary.ReferencedBy)
            {
                if (shown++ >= MaxRelationsShown) break;
                var cols = string.Join(", ", fk.Pairs.Select(p => p.Column).Where(n => n is not null));
                var refs = string.Join(", ", fk.Pairs.Select(p => p.ReferencedColumn).Where(n => n is not null));
                var source = $"{(fk.Table.Schema is { Length: > 0 } ss ? ss + "." : "")}{fk.Table.Name}";
                sb.Append("\n- ← ").Append(TsqlCatalog.EscapeMarkdown($"{source}({cols}) → ({refs})"));
            }
        }

        return sb.ToString();
    }

    private static string? FormatSourceHover(TsqlSourceRef source, IndexLookup? lookup, string? activeDb)
    {
        if (source.ObjectRef is not null && lookup is not null)
        {
            var obj = TsqlCompletionService.ResolveCatalogObjectForSource(source, lookup, activeDb, out _);
            if (obj is { } found && lookup.ObjectSummary(found.Database, found.Schema, found.Name) is { } summary)
            {
                var body = FormatObjectSummaryMarkdown(summary);
                return source.HasExplicitAlias
                    ? $"**{TsqlCatalog.EscapeMarkdown(source.ExposureName)}** · Alias\n\n{body}"
                    : body;
            }
        }
        var (cols, _, _) = TsqlCompletionService.ResolveSourceColumns(source, lookup, activeDb, 0);
        if (cols.Count == 0 && source.Kind == "table") return null;
        var kindLabel = source.Kind switch
        {
            "cte" => "Common table expression (WITH)",
            "temp" => "Temporary table",
            "tableVar" => "Table variable",
            "derived" => "Derived table",
            "pivot" => "PIVOT result",
            "unpivot" => "UNPIVOT result",
            "output" => "OUTPUT virtual table",
            "openjson" => "OPENJSON rowset",
            _ => "Alias"
        };
        return FormatInlineColumnsMarkdown(source.ExposureName, kindLabel, cols);
    }

    private static string? FormatColumnHover(
        TsqlSourceRef source,
        string columnName,
        IndexLookup? lookup,
        string? activeDb,
        Func<string, string, bool> same)
    {
        var (cols, _, catalogObj) = TsqlCompletionService.ResolveSourceColumns(source, lookup, activeDb, 0);
        var col = cols.FirstOrDefault(c => same(c.Name, columnName));
        if (col is null) return null;

        var parts = new List<string> { $"**{TsqlCatalog.EscapeMarkdown(col.Name)}**" };
        if (!string.IsNullOrEmpty(col.TypeText)) parts.Add($"`{TsqlCatalog.EscapeMarkdown(col.TypeText)}`");
        if (col.Nullable == false) parts.Add("NOT NULL");
        if (!string.IsNullOrEmpty(col.Markers)) parts.Add(TsqlCatalog.EscapeMarkdown(col.Markers));

        var sb = new StringBuilder(160);
        sb.Append(string.Join(" · ", parts));
        var owner = catalogObj is { } obj
            ? TsqlCatalog.FormatObjectPath(obj.Database, obj.Schema, obj.Name)
            : source.ExposureName;
        sb.Append("\n\nColumn in ").Append(TsqlCatalog.EscapeMarkdown(owner));
        if (!string.IsNullOrEmpty(col.ForeignKeyTarget))
            sb.Append("\n\nReferences ").Append(TsqlCatalog.EscapeMarkdown(col.ForeignKeyTarget));
        return sb.ToString();
    }

    private static string FormatLocalTableMarkdown(LocalTable table, IndexLookup? lookup, string? activeDb)
    {
        var kindLabel = table.IsTableVariable ? "Table variable"
            : table.Name.StartsWith("##", StringComparison.Ordinal) ? "Global temporary table" : "Temporary table";
        var src = new TsqlSourceRef(table.Name, table.Name, false, table.IsTableVariable ? "tableVar" : "temp",
            ObjectRef: table.TableTypeRef, InlineColumns: table.Columns, HasStar: table.SelectIntoStar, StarSources: table.SelectIntoSources);
        var (cols, _, _) = TsqlCompletionService.ResolveSourceColumns(src, lookup, activeDb, 0);
        return FormatInlineColumnsMarkdown(table.Name, kindLabel, cols);
    }

    private static string FormatCteMarkdown(TsqlCteInfo cte, IndexLookup? lookup, string? activeDb)
    {
        var src = new TsqlSourceRef(cte.Name, cte.Name, false, "cte", InlineColumns: cte.Columns, HasStar: cte.HasStar, StarSources: cte.StarSources);
        var (cols, _, _) = TsqlCompletionService.ResolveSourceColumns(src, lookup, activeDb, 0);
        return FormatInlineColumnsMarkdown(cte.Name, "Common table expression (WITH)", cols);
    }

    private static string FormatInlineColumnsMarkdown(string name, string kindLabel, IReadOnlyList<TsqlCompletionService.ResolvedColumn> cols)
    {
        var sb = new StringBuilder(256);
        sb.Append("**").Append(TsqlCatalog.EscapeMarkdown(name)).Append("** · ").Append(TsqlCatalog.EscapeMarkdown(kindLabel));
        if (cols.Count > 0)
        {
            sb.Append("\n\n| Column | Type |\n| --- | --- |");
            foreach (var c in cols.Take(MaxColumnsShown))
            {
                var typePart = !string.IsNullOrEmpty(c.TypeText) ? TsqlCatalog.EscapeMarkdown(c.TypeText) : "";
                if (c.Nullable == false) typePart += (typePart.Length > 0 ? " · " : "") + "NOT NULL";
                sb.Append("\n| ").Append(TsqlCatalog.EscapeMarkdown(c.Name)).Append(" | ").Append(typePart).Append(" |");
            }
            if (cols.Count > MaxColumnsShown)
                sb.Append($"\n\nand {cols.Count - MaxColumnsShown:N0} more columns");
        }
        return sb.ToString();
    }

    private static string FormatFunctionMarkdown(TsqlCatalog.FunctionInfo fn)
    {
        var sb = new StringBuilder(256);
        sb.Append("**").Append(TsqlCatalog.EscapeMarkdown(fn.Name)).Append("** · Built-in function · `")
            .Append(TsqlCatalog.EscapeMarkdown(fn.ReturnType)).Append("`\n\n")
            .Append(TsqlCatalog.EscapeMarkdown(fn.Summary));
        if (fn.Signatures.Length > 0)
        {
            sb.Append('\n');
            foreach (var sig in fn.Signatures)
                sb.Append("\n- `").Append(TsqlCatalog.EscapeMarkdown(sig)).Append('`');
        }
        return sb.ToString();
    }
}
