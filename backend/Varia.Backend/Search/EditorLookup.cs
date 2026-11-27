using System.Text;
using Varia.Backend.BigQuery;

namespace Varia.Backend.Search;

/// <summary>language.lookup's bounds (languageLookupLimits in src/shared/language-lookup.ts).</summary>
internal static class EditorLookupLimits
{
    public const int Requests = 16, Segments = 3, SegmentChars = 1024, PrefixChars = 4608, Items = 2000, DefaultItems = 500, TotalItems = 4000, TotalBytes = 12582912;
}

internal static class EditorLookup
{
    private static RequestException Invalid(string what) => new("INVALID_PARAMS", "Invalid language lookup: " + what);
    private static long? SafeCount(long? value) => value is >= 0 and <= BigQueryLimits.MaxSafeInteger ? value : null;
    private static int StrBytes(string? value) => value is null ? 0 : 5 + Encoding.UTF8.GetByteCount(value);
    private static int ShardsBytes(BigQueryShardsDto? shards) =>
        shards is null ? 0 : 48 + StrBytes(shards.Prefix) + StrBytes(shards.First) + StrBytes(shards.Last);

    private static int ItemBytes(LanguageLookupItem item) =>
        3 + 5 + StrBytes(item.Name) + 5 + StrBytes(item.Kind)
        + (item.Subtype is null ? 0 : 8 + StrBytes(item.Subtype))
        + (item.Type is null ? 0 : 5 + StrBytes(item.Type))
        + (item.Nullable is null ? 0 : 10)
        + (item.Detail is null ? 0 : 7 + StrBytes(item.Detail))
        + (item.Description is null ? 0 : 12 + StrBytes(item.Description))
        + ShardsBytes(item.Shards)
        + (item.Tier is null ? 0 : 5 + StrBytes(item.Tier))
        + (item.NamesOnly is null ? 0 : 11)
        + (item.Partial is null ? 0 : 9)
        + (item.Rows is null ? 0 : 14)
        + (item.Bytes is null ? 0 : 15)
        + (item.Partitioning is null ? 0 : 13 + StrBytes(item.Partitioning))
        + (item.Clustering is null ? 0 : 11 + StrBytes(item.Clustering));

    private static int ObjectBytes(LanguageLookupObject? shown) => shown is null ? 0 :
        10 + 5 + StrBytes(shown.Name) + 5 + StrBytes(shown.Kind)
        + (shown.Subtype is null ? 0 : 8 + StrBytes(shown.Subtype))
        + 10
        + (shown.Rows is null ? 0 : 14)
        + (shown.Bytes is null ? 0 : 15)
        + (shown.Partitioning is null ? 0 : 13 + StrBytes(shown.Partitioning))
        + (shown.Clustering is null ? 0 : 11 + StrBytes(shown.Clustering))
        + (shown.Signature is null ? 0 : 10 + StrBytes(shown.Signature))
        + ShardsBytes(shown.Shards)
        + (shown.ColumnsCut is null ? 0 : 12)
        + (shown.Modified is null ? 0 : 48)
        + (shown.Description is null ? 0 : 12 + StrBytes(shown.Description));

    private static int AnswerOverheadBytes(IReadOnlyList<string> path, string? skip, LanguageLookupObject? shown = null)
    {
        var bytes = 64 + (skip is null ? 0 : 5 + StrBytes(skip)) + ObjectBytes(shown);
        for (var i = 0; i < path.Count; i++) bytes += StrBytes(path[i]);
        return bytes;
    }

    public static void Validate(LanguageLookupArgs args)
    {
        if (!Guid.TryParse(args.ConnectionId, out _)) throw Invalid("connectionId.");
        if (args.Requests is not { Count: > 0 and <= EditorLookupLimits.Requests }) throw Invalid("requests.");
        foreach (var request in args.Requests)
        {
            if (request is null) throw Invalid("requests.");
            if (request.Path is not { Count: <= EditorLookupLimits.Segments } || request.Path.Any(segment => segment is not { Length: > 0 and <= EditorLookupLimits.SegmentChars })) throw Invalid("path.");
            if (request.Prefix is { Length: > EditorLookupLimits.PrefixChars }) throw Invalid("prefix.");
            if (request.Exact == true && string.IsNullOrEmpty(request.Prefix)) throw Invalid("exact needs a prefix.");
            if (request.Limit is < 1 or > EditorLookupLimits.Items) throw Invalid("limit.");
        }
    }

    private static int ReserveBytes(LanguageLookupPath request) =>
        request.Path.Count * (5 + EditorLookupLimits.SegmentChars * 3) + 640;

    /// <summary>Answers every request from one snapshot of a BigQuery connection's index.</summary>
    public static LanguageLookupResult Answer(BigQueryLookup lookup, LanguageLookupArgs args)
    {
        Validate(args);
        var left = EditorLookupLimits.TotalItems;
        var bytesLeft = EditorLookupLimits.TotalBytes - 64;
        var reserveForLater = 0;
        for (var i = 1; i < args.Requests.Count; i++) reserveForLater += ReserveBytes(args.Requests[i]);
        var answers = new List<LanguageLookupAnswer>(args.Requests.Count);
        for (var i = 0; i < args.Requests.Count; i++)
        {
            if (i > 0) reserveForLater -= ReserveBytes(args.Requests[i]);
            answers.Add(One(lookup, args.Requests[i], ref left, ref bytesLeft, reserveForLater));
        }
        return new(lookup.Index, answers);
    }

    /// <summary>Answers every request from one snapshot of a SQL Server connection's Search Objects index (in-process RAM read).</summary>
    public static LanguageLookupResult Answer(IndexLookup? lookup, LanguageLookupArgs args)
    {
        Validate(args);
        if (lookup is null)
            return new("none", [.. args.Requests.Select(request => new LanguageLookupAnswer("absent", [.. request.Path], [], false))]);
        var left = EditorLookupLimits.TotalItems;
        var bytesLeft = EditorLookupLimits.TotalBytes - 64;
        var reserveForLater = 0;
        for (var i = 1; i < args.Requests.Count; i++) reserveForLater += ReserveBytes(args.Requests[i]);
        var answers = new List<LanguageLookupAnswer>(args.Requests.Count);
        for (var i = 0; i < args.Requests.Count; i++)
        {
            if (i > 0) reserveForLater -= ReserveBytes(args.Requests[i]);
            answers.Add(OneSql(lookup, args.Requests[i], ref left, ref bytesLeft, reserveForLater));
        }
        return new(lookup.IndexState, answers);
    }

    private const int SqlSummaryDetailChars = 512;
    private static string ClipDetail(string text) => text.Length <= SqlSummaryDetailChars ? text : text[..(SqlSummaryDetailChars - 1)] + "…";

    private static LanguageLookupAnswer OneSql(IndexLookup lookup, LanguageLookupPath request, ref int left, ref int bytesLeft, int reserveForLater)
    {
        var path = request.Path;
        var prefix = request.Prefix ?? "";
        var exact = request.Exact == true;
        var limit = Math.Min(request.Limit ?? EditorLookupLimits.DefaultItems, left);
        bool Keeps(string name) => exact ? string.Equals(name, prefix, StringComparison.OrdinalIgnoreCase) : name.StartsWith(prefix, StringComparison.OrdinalIgnoreCase);
        (List<LanguageLookupItem> Items, bool Truncated) Take(IEnumerable<LanguageLookupItem> items, ref int remaining, ref int remainingBytes, int overheadBytes)
        {
            var available = Math.Max(0, remainingBytes - reserveForLater - overheadBytes);
            var spentOnItems = 0;
            var list = new List<LanguageLookupItem>();
            var truncated = false;
            foreach (var item in items)
            {
                if (list.Count >= limit) { truncated = true; break; }
                var itemBytes = ItemBytes(item);
                if (itemBytes > available) { truncated = true; break; }
                available -= itemBytes;
                spentOnItems += itemBytes;
                list.Add(item);
            }
            remainingBytes = Math.Max(0, remainingBytes - overheadBytes - spentOnItems);
            remaining -= list.Count;
            return (list, truncated);
        }
        switch (path.Count)
        {
            case 0:
            {
                var names = lookup.Databases().Where(Keeps);
                var (items, truncated) = Take(names.Select(name =>
                {
                    var db = lookup.Database(name);
                    return new LanguageLookupItem(name, "database", Partial: db.State == LookupState.Partial ? true : null);
                }), ref left, ref bytesLeft, AnswerOverheadBytes([], null));
                return new(lookup.IndexState == "building" ? "building" : "ready", [], items, truncated);
            }
            case 1:
            {
                var db = lookup.Database(path[0]);
                var resolvedPath = new List<string> { db.Database };
                if (db.State is LookupState.Absent or LookupState.Skipped)
                {
                    bytesLeft = Math.Max(0, bytesLeft - AnswerOverheadBytes(resolvedPath, db.Skip?.Code));
                    return new(State(db.State), resolvedPath, [], false, Skip: db.Skip?.Code);
                }
                var schemas = lookup.Schemas(db.Database).Where(Keeps);
                var (items, truncated) = Take(schemas.Select(schema => new LanguageLookupItem(schema, "schema")), ref left, ref bytesLeft, AnswerOverheadBytes(resolvedPath, db.Skip?.Code));
                return new(State(db.State), resolvedPath, items, truncated, Skip: db.Skip?.Code);
            }
            case 2:
            {
                var db = lookup.Database(path[0]);
                var resolvedPath = new List<string> { db.Database, path[1] };
                if (db.State is LookupState.Absent or LookupState.Skipped)
                {
                    bytesLeft = Math.Max(0, bytesLeft - AnswerOverheadBytes(resolvedPath, db.Skip?.Code));
                    return new(State(db.State), resolvedPath, [], false, Skip: db.Skip?.Code);
                }
                var objects = lookup.ObjectsInSchema(db.Database, path[1]).Where(entry => Keeps(entry.Name));
                var (items, truncated) = Take(objects.Select(entry => new LanguageLookupItem(entry.Name, entry.Kind, entry.Subtype,
                    Partial: db.Gaps.HasFlag(LookupGaps.ChildrenLeftOut) ? true : null)), ref left, ref bytesLeft, AnswerOverheadBytes(resolvedPath, db.Skip?.Code));
                return new(State(db.State), resolvedPath, items, truncated, Skip: db.Skip?.Code);
            }
            default:
            {
                var db = lookup.Database(path[0]);
                var summary = path[1] == "*"
                    ? lookup.ObjectSummary(path[0], "*", path[2]) ?? lookup.ObjectSummary(path[0], null, path[2])
                    : lookup.ObjectSummary(path[0], path[1], path[2]);
                if (summary is null)
                {
                    var earlyPath = new List<string> { db.Database, path[1] };
                    bytesLeft = Math.Max(0, bytesLeft - AnswerOverheadBytes(earlyPath, db.Skip?.Code));
                    return new(State(db.State), earlyPath, [], false, Skip: db.Skip?.Code);
                }
                var entry = summary.Object;
                var resolvedSchema = entry.Schema is { Length: > 0 } s ? s : path[1];
                var resolvedPath = new List<string> { summary.Database.Database, resolvedSchema, entry.Name };
                var detailed = !summary.Database.Gaps.HasFlag(LookupGaps.ChildrenLeftOut);
                var signature = SqlSignature(summary);
                var shown = new LanguageLookupObject(entry.Name, entry.Kind, entry.Subtype, detailed,
                    Signature: signature is null ? null : ClipDetail(signature), Modified: entry.Table.Modified(entry.At));
                var baseOverhead = AnswerOverheadBytes(resolvedPath, summary.Database.Skip?.Code);
                var availableForObject = Math.Max(0, bytesLeft - reserveForLater - baseOverhead);
                if (ObjectBytes(shown) > availableForObject)
                {
                    bytesLeft = Math.Max(0, bytesLeft - baseOverhead);
                    return new(State(summary.Database.State), resolvedPath, [], true, null, summary.Database.Skip?.Code);
                }
                var (items, truncated) = Take(SqlSummaryItems(summary).Where(item => string.IsNullOrEmpty(prefix) || Keeps(item.Name)),
                    ref left, ref bytesLeft, baseOverhead + ObjectBytes(shown));
                return new(State(summary.Database.State), resolvedPath, items, truncated, shown, summary.Database.Skip?.Code);
            }
        }
    }

    private static string? SqlSignature(LookupObjectSummary summary)
    {
        if (summary.Object.Kind is not ("procedure" or "function")) return null;
        var parts = summary.Parameters.Take(24).Select(parameter =>
        {
            var type = parameter.Type?.TypeText;
            var flags = parameter.Type?.Flags ?? TypedFlags.None;
            var suffix = (flags & TypedFlags.Output) != 0 ? " OUTPUT" : (flags & TypedFlags.ReadOnly) != 0 ? " READONLY" : "";
            return type is null ? parameter.Name : $"{parameter.Name} {type}{suffix}";
        }).ToList();
        var more = summary.Parameters.Count > 24 ? ", …" : "";
        var ret = summary.Object.Type?.TypeText is { Length: > 0 } returnType ? $" RETURNS {returnType}" : "";
        return parts.Count == 0 && ret.Length == 0 ? null : $"({string.Join(", ", parts)}{more}){ret}";
    }

    private static IEnumerable<LanguageLookupItem> SqlSummaryItems(LookupObjectSummary summary)
    {
        var comparer = summary.Database.CaseSensitive == true ? StringComparer.Ordinal : StringComparer.OrdinalIgnoreCase;
        var pkColumnIds = new HashSet<short>();
        var ukColumnIds = new HashSet<short>();
        var pkColumns = new HashSet<string>(comparer);
        var ukColumns = new HashSet<string>(comparer);
        var fkColumns = new HashSet<string>(comparer);
        foreach (var index in summary.Indexes)
        {
            if (index.Kind == "key" && index.Subtype == "primary")
            {
                foreach (var keyCol in index.Columns)
                {
                    if (keyCol.Included) continue;
                    if (keyCol.ColumnId > 0) pkColumnIds.Add(keyCol.ColumnId);
                    else if (keyCol.Name is { Length: > 0 }) pkColumns.Add(keyCol.Name);
                }
            }
            else if (index.Kind == "key" && index.Subtype == "unique")
            {
                foreach (var keyCol in index.Columns)
                {
                    if (keyCol.Included) continue;
                    if (keyCol.ColumnId > 0) ukColumnIds.Add(keyCol.ColumnId);
                    else if (keyCol.Name is { Length: > 0 }) ukColumns.Add(keyCol.Name);
                }
            }
        }
        foreach (var fk in summary.ForeignKeys)
            foreach (var (column, _) in fk.Pairs) if (column is { Length: > 0 }) fkColumns.Add(column);

        foreach (var column in summary.Columns)
        {
            var markers = new List<string>();
            if ((column.Ordinal > 0 && pkColumnIds.Contains(column.Ordinal)) || pkColumns.Contains(column.Name)) markers.Add("PK");
            if ((column.Ordinal > 0 && ukColumnIds.Contains(column.Ordinal)) || ukColumns.Contains(column.Name)) markers.Add("UK");
            if (fkColumns.Contains(column.Name)) markers.Add("FK");
            var flags = column.Type?.Flags ?? TypedFlags.None;
            if ((flags & TypedFlags.Identity) != 0) markers.Add("IDENTITY");
            if ((flags & TypedFlags.Computed) != 0) markers.Add("COMPUTED");
            if ((flags & TypedFlags.Default) != 0) markers.Add("DEFAULT");
            yield return new LanguageLookupItem(
                column.Name, "column", column.Entry.Subtype,
                Type: column.Type?.TypeText,
                Nullable: column.Type is { } type ? (type.Flags & TypedFlags.Nullable) != 0 : null,
                Detail: markers.Count > 0 ? ClipDetail(string.Join(" · ", markers)) : null);
        }
        foreach (var parameter in summary.Parameters)
        {
            var markers = new List<string>();
            var flags = parameter.Type?.Flags ?? TypedFlags.None;
            if ((flags & TypedFlags.Output) != 0) markers.Add("OUTPUT");
            if ((flags & TypedFlags.ReadOnly) != 0) markers.Add("READONLY");
            if ((flags & TypedFlags.Default) != 0) markers.Add("DEFAULT");
            yield return new LanguageLookupItem(
                parameter.Name, "parameter", parameter.Entry.Subtype,
                Type: parameter.Type?.TypeText,
                Nullable: parameter.Type is { } type ? (type.Flags & TypedFlags.Nullable) != 0 : null,
                Detail: markers.Count > 0 ? ClipDetail(string.Join(" · ", markers)) : null);
        }
        foreach (var index in summary.Indexes)
        {
            var keys = index.Columns.Where(c => !c.Included && c.Name is { Length: > 0 }).Select(c => c.Descending ? c.Name + " DESC" : c.Name!).ToList();
            var included = index.Columns.Where(c => c.Included && c.Name is { Length: > 0 }).Select(c => c.Name!).ToList();
            var text = keys.Count > 0 ? "(" + string.Join(", ", keys) + ")" : "";
            if (included.Count > 0) text += (text.Length > 0 ? " " : "") + "INCLUDE (" + string.Join(", ", included) + ")";
            yield return new LanguageLookupItem(index.Entry.Name, index.Kind, index.Subtype, Detail: text.Length > 0 ? ClipDetail(text) : null);
        }
        foreach (var fk in summary.ForeignKeys)
        {
            var cols = fk.Pairs.Select(p => p.Column).Where(n => n is { Length: > 0 }).ToList();
            var refs = fk.Pairs.Select(p => p.ReferencedColumn).Where(n => n is { Length: > 0 }).ToList();
            var target = fk.Referenced is { } r ? (r.Schema is { Length: > 0 } s ? $"{s}.{r.Name}" : r.Name) : "?";
            var detail = $"({string.Join(", ", cols)}) → {target}" + (refs.Count > 0 ? $"({string.Join(", ", refs)})" : "");
            yield return new LanguageLookupItem(fk.Entry.Name, "foreignKey", "outgoing", Detail: ClipDetail(detail));
        }
        foreach (var fk in summary.ReferencedBy)
        {
            var cols = fk.Pairs.Select(p => p.Column).Where(n => n is { Length: > 0 }).ToList();
            var refs = fk.Pairs.Select(p => p.ReferencedColumn).Where(n => n is { Length: > 0 }).ToList();
            var source = fk.Table.Schema is { Length: > 0 } s ? $"{s}.{fk.Table.Name}" : fk.Table.Name;
            var detail = $"{source}({string.Join(", ", cols)}) → ({string.Join(", ", refs)})";
            yield return new LanguageLookupItem(fk.Entry.Name, "foreignKey", "incoming", Detail: ClipDetail(detail));
        }
    }

    private static string State(LookupState state) => state switch
    {
        LookupState.Ready => "ready", LookupState.Partial => "partial", LookupState.Building => "building", LookupState.Skipped => "skipped", _ => "absent"
    };

    private static LanguageLookupAnswer One(BigQueryLookup lookup, LanguageLookupPath request, ref int left, ref int bytesLeft, int reserveForLater)
    {
        var path = request.Path;
        var prefix = request.Prefix ?? "";
        var exact = request.Exact == true;
        var limit = Math.Min(request.Limit ?? EditorLookupLimits.DefaultItems, left);
        bool Keeps(string name) => exact ? string.Equals(name, prefix, StringComparison.OrdinalIgnoreCase) : name.StartsWith(prefix, StringComparison.OrdinalIgnoreCase);
        // Names that tell case apart keep the one an exact request resolves to: the exact spelling, else the only one that differs in case.
        static IEnumerable<string> Resolved(IEnumerable<string> names, string name)
        {
            var close = names.Where(known => string.Equals(known, name, StringComparison.OrdinalIgnoreCase)).ToList();
            return close.Contains(name, StringComparer.Ordinal) ? [name] : close.Count == 1 ? close : [];
        }
        (List<LanguageLookupItem> Items, bool Truncated) Take(IEnumerable<LanguageLookupItem> items, ref int remaining, ref int remainingBytes, int overheadBytes)
        {
            var available = Math.Max(0, remainingBytes - reserveForLater - overheadBytes);
            var spentOnItems = 0;
            var list = new List<LanguageLookupItem>();
            var truncated = false;
            foreach (var item in items)
            {
                if (list.Count >= limit) { truncated = true; break; }
                var itemBytes = ItemBytes(item);
                if (itemBytes > available) { truncated = true; break; }
                available -= itemBytes;
                spentOnItems += itemBytes;
                list.Add(item);
            }
            remainingBytes = Math.Max(0, remainingBytes - overheadBytes - spentOnItems);
            remaining -= list.Count;
            return (list, truncated);
        }
        switch (path.Count)
        {
            case 0:
            {
                var names = exact ? Resolved(lookup.Projects, prefix) : lookup.Projects.Where(Keeps);
                var (items, truncated) = Take(names.Select(name => new LanguageLookupItem(name, "bqProject", Detail: lookup.NamesOnly(name) ? "names" : null,
                    Tier: lookup.ProjectTier(name), NamesOnly: lookup.NamesOnly(name) ? true : null,
                    Partial: lookup.ProjectState(name) == LookupState.Partial ? true : null)), ref left, ref bytesLeft, AnswerOverheadBytes([], null));
                return new("ready", [], items, truncated);
            }
            case 1:
            {
                var project = lookup.Project(path[0]);
                if (project is null)
                {
                    bytesLeft = Math.Max(0, bytesLeft - AnswerOverheadBytes(path, null));
                    return new("absent", [.. path], [], false);
                }
                var datasets = lookup.Datasets(project);
                var names = exact ? Resolved(datasets, prefix) : datasets.Where(Keeps);
                var resolvedPath = new List<string> { project };
                var (items, truncated) = Take(names.Select(name => new LanguageLookupItem(name, "bqDataset",
                    Partial: lookup.Dataset(project, name).State == LookupState.Partial ? true : null)), ref left, ref bytesLeft, AnswerOverheadBytes(resolvedPath, null));
                return new(State(lookup.ProjectState(project)), resolvedPath, items, truncated);
            }
            case 2:
            {
                var dataset = lookup.Dataset(path[0], path[1]);
                var resolved = dataset.State == LookupState.Absent && lookup.Project(path[0]) is null ? [.. path] : new List<string> { dataset.Project, dataset.Dataset };
                IEnumerable<LookupObject> objects;
                if (exact) objects = lookup.Object(dataset, prefix) is { } one ? [one] : [];
                else objects = lookup.Objects(dataset).Where(entry => Keeps(entry.Name)).OrderBy(entry => entry.Name, StringComparer.OrdinalIgnoreCase).ThenBy(entry => entry.Name, StringComparer.Ordinal);
                var details = request.Details == true;
                var (items, truncated) = Take(objects.Select(entry =>
                {
                    var facts = BigQueryLookup.Facts(entry);
                    return new LanguageLookupItem(entry.Name, entry.Kind, entry.Subtype, Detail: facts?.Signature,
                        Description: details ? facts?.Description : null, Shards: BigQueryLookup.Shards(entry),
                        Partial: !IsDetailed(lookup, dataset, entry, facts) || facts?.ColumnsCut == true ? true : null,
                        Rows: SafeCount(facts?.Rows), Bytes: SafeCount(facts?.Bytes),
                        Partitioning: facts?.Partitioning, Clustering: facts?.Clustering);
                }), ref left, ref bytesLeft, AnswerOverheadBytes(resolved, dataset.Skip?.Code));
                return new(State(dataset.State), resolved, items, truncated, Skip: dataset.Skip?.Code);
            }
            default:
            {
                var dataset = lookup.Dataset(path[0], path[1]);
                var owner = lookup.Object(dataset, path[2]);
                if (owner is not { } entry)
                {
                    var earlyPath = lookup.Project(path[0]) is null ? [.. path] : new List<string> { dataset.Project, dataset.Dataset };
                    bytesLeft = Math.Max(0, bytesLeft - AnswerOverheadBytes(earlyPath, dataset.Skip?.Code));
                    return new(State(dataset.State), earlyPath, [], false, Skip: dataset.Skip?.Code);
                }
                var facts = BigQueryLookup.Facts(entry);
                var detailed = IsDetailed(lookup, dataset, entry, facts);
                var shown = new LanguageLookupObject(entry.Name, entry.Kind, entry.Subtype, detailed, SafeCount(facts?.Rows), SafeCount(facts?.Bytes), facts?.Partitioning, facts?.Clustering,
                    facts?.Signature, BigQueryLookup.Shards(entry), facts?.ColumnsCut == true ? true : null, entry.Table.Modified(entry.At), facts?.Description);
                var details = request.Details == true;
                var columns = lookup.Columns(entry).Where(column => Keeps(column.Name));
                var resolvedPath = new List<string> { dataset.Project, dataset.Dataset, entry.Name };
                var baseOverhead = AnswerOverheadBytes(resolvedPath, dataset.Skip?.Code);
                var availableForObject = Math.Max(0, bytesLeft - reserveForLater - baseOverhead);
                if (ObjectBytes(shown) > availableForObject)
                {
                    bytesLeft = Math.Max(0, bytesLeft - baseOverhead);
                    return new(State(dataset.State), resolvedPath, [], true, null, dataset.Skip?.Code);
                }
                var (items, truncated) = Take(columns.Select(column => new LanguageLookupItem(column.Name, "bqColumn", column.Entry.Subtype, column.Type?.TypeName,
                    column.Type is { } type ? (type.Flags & TypedFlags.Nullable) != 0 : null, Description: details ? BigQueryLookup.Description(column) : null)),
                    ref left, ref bytesLeft, baseOverhead + ObjectBytes(shown));
                return new(State(dataset.State), resolvedPath, items, truncated, shown, dataset.Skip?.Code);
            }
        }
    }

    // Columns the budget left out make the object's details incomplete, whatever its facts say.
    // A model has no columns for the second pass to read: outside a project read by name only, it is as detailed as it gets.
    // Columns left out take a table's detail; a routine's signature and a model's facts have no children and stay.
    private static bool IsDetailed(BigQueryLookup lookup, BigQueryLookupDataset dataset, LookupObject entry, BigQueryObjectFacts? facts) =>
        (facts?.Detailed == true || entry.Kind == "bqModel" && !lookup.NamesOnly(dataset.Project)) && (entry.Kind is "bqRoutine" or "bqModel" || dataset.Held?.ChildrenLeftOut != true);
}
